import type { ApiResponse } from '../shared/domain.js';
import { AuthenticationError, MemoryUserDirectory, authenticateCredential, type VerifiedIdentityClaims } from '../server/integration/auth.js';
import { createIntegrationDispatcher, type IntegrationDispatcher } from '../server/integration/dispatcher.js';
import { ALLOWED_INTEGRATION_OPERATIONS, INTEGRATION_OPERATIONS, failure, mapUnknownError, validateRequestEnvelope, type ValidatedRequest } from '../server/integration/request-policy.js';
import { BATCH_READ_PLANS, type BatchReadPlan } from '../server/workbook/batch-read.js';
import type { SpreadsheetLike } from '../server/workbook/initializer.js';
import type { WorkbookBatchReader } from '../server/workbook/batch-read.js';
import { createProductionRuntime, type ScriptProperties } from '../server/runtime.js';
import { googleIdentityConfiguration, workbookConfiguration, type StagingBindings } from './config.js';
import { SigningKeyError, createGoogleDependencies, type FetchLike, type GoogleDependencies } from './google/index.js';
import { READ_API_MAX_REQUEST_BYTES } from './read-api.js';
import { SheetsReadError, createSheetsReadClient } from './workbook/sheets.js';
import { createSnapshotBatchReader, createWorkbookSnapshot } from './workbook/snapshot.js';

/**
 * The composed staging read service.
 *
 * Order is the security property, not an implementation detail: the envelope and
 * read-only policy are applied first, then the caller's identity is verified,
 * then the authorization table is read *fresh* from the workbook, and only then
 * are the domain ranges for the requested operation fetched. A denied caller
 * therefore never causes a domain read, and no cached client data can authorize
 * anything.
 *
 * The domain work itself is the existing synchronous production runtime replayed
 * over the fetched snapshot, so the three served operations return exactly what
 * Apps Script returns for the same rows.
 */

/**
 * The operations this endpoint serves. The transport enforces the same list
 * before dispatch; repeating it here means the composition cannot serve a
 * registered-but-unintended operation even if it is called directly, which is
 * how the non-routed benchmark and tests reach it.
 */
export const SERVED_OPERATIONS: ReadonlySet<string> = new Set([
  INTEGRATION_OPERATIONS.me,
  INTEGRATION_OPERATIONS.adminSchedule,
  INTEGRATION_OPERATIONS.adminInsights
]);

/** The read plan each served operation needs, beyond the always-fresh Users read. */
const OPERATION_PLANS: Readonly<Record<string, BatchReadPlan | undefined>> = {
  [INTEGRATION_OPERATIONS.me]: undefined,
  [INTEGRATION_OPERATIONS.adminSchedule]: 'publishedSchedule',
  [INTEGRATION_OPERATIONS.adminInsights]: 'insightCacheMiss'
};

export type StagingServiceStats = Readonly<{
  sheetsReads: number;
  requests: number;
  denied: number;
  /** Digest of the rows this request read; recorded with every measured result. */
  digest: string | undefined;
}>;

/** One-slot cache of assembled clients, keyed by the resolved identity configuration. */
export type DependencyCache = Readonly<{
  get(key: string): GoogleDependencies | undefined;
  set(key: string, value: GoogleDependencies): void;
}>;

export type StagingServiceOptions = Readonly<{
  fetch?: FetchLike;
  nowMs?: () => number;
  /** Overrides for tests that need to drive the assembled Google clients. */
  google?: (configuration: ReturnType<typeof googleIdentityConfiguration>) => GoogleDependencies;
  /** Replaces the isolate-scoped client cache; tests use a private one. */
  dependencyCache?: DependencyCache;
}>;

let isolateEntry: { key: string; dependencies: GoogleDependencies } | undefined;

/**
 * The isolate-scoped client cache. Exported so a test can exercise the real
 * sharing behaviour while still injecting its own transport.
 */
export const isolateDependencyCache: DependencyCache = {
  get: (key) => (isolateEntry?.key === key ? isolateEntry.dependencies : undefined),
  set: (key, value) => { isolateEntry = { key, dependencies: value }; }
};

function privateCache(): DependencyCache {
  const entries = new Map<string, GoogleDependencies>();
  return { get: (key) => entries.get(key), set: (key, value) => { entries.set(key, value); } };
}

/**
 * The key store and the token provider are expiring caches that only pay off if
 * they outlive one request, so the assembled clients are memoized for the
 * isolate. The identity is built structurally rather than by joining fields, so
 * two configurations can never collide onto one entry; a caller that injects its
 * own transport or clock gets a private cache unless it asks for the shared one.
 */
function configurationKey(configuration: ReturnType<typeof googleIdentityConfiguration>): string {
  return JSON.stringify([configuration.audience, configuration.clientEmail, configuration.privateKeyPem]);
}

export type StagingReadService = Readonly<{
  handle(input: unknown): Promise<ApiResponse<unknown>>;
  stats(): StagingServiceStats;
}>;

function unauthorized(reason: AuthenticationError['reason'], detail: string): ApiResponse<never> {
  const mapped = mapUnknownError(new AuthenticationError(reason, 'Authentication is required.', detail));
  return failure(mapped.code, mapped.message, mapped.details);
}

export function createStagingReadService(bindings: StagingBindings, options: StagingServiceOptions = {}): StagingReadService {
  const outbound: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const nowMs = options.nowMs ?? (() => Date.now());
  let requests = 0;
  let denied = 0;
  let sheetsReads = 0;
  let digest: string | undefined;

  const injectedTransport = options.fetch !== undefined || options.nowMs !== undefined;
  const cache = options.dependencyCache ?? (injectedTransport ? privateCache() : isolateDependencyCache);

  const googleFor = (): GoogleDependencies => {
    const configuration = googleIdentityConfiguration(bindings);
    if (options.google) return options.google(configuration);
    const key = configurationKey(configuration);
    const cached = cache.get(key);
    if (cached) return cached;
    const dependencies = createGoogleDependencies(configuration, { fetch: outbound, nowMs });
    cache.set(key, dependencies);
    return dependencies;
  };

  return {
    async handle(input: unknown): Promise<ApiResponse<unknown>> {
      requests += 1;
      let sheets: ReturnType<typeof createSheetsReadClient> | undefined;
      try {
        return await serve(input, (client) => { sheets = client; });
      } finally {
        if (sheets) sheetsReads += sheets.readCount();
      }
    },
    stats: () => ({ sheetsReads, requests, denied, digest })
  };

  async function serve(input: unknown, onSheetsClient: (client: ReturnType<typeof createSheetsReadClient>) => void): Promise<ApiResponse<unknown>> {

      // 1. The operation allowlist first, so an operation this endpoint does not
      //    serve is refused whatever its payload looks like — the same order the
      //    transport uses.
      const rawOperation = typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as { operation?: unknown }).operation
        : undefined;
      // An operation that is not registered at all stays the shared gate's
      // INVALID_REQUEST; a registered one this endpoint does not serve is
      // refused as FORBIDDEN.
      if (typeof rawOperation === 'string' && ALLOWED_INTEGRATION_OPERATIONS.has(rawOperation) && !SERVED_OPERATIONS.has(rawOperation)) {
        denied += 1;
        return failure('FORBIDDEN', 'This staging endpoint only serves the allowlisted read operations.');
      }

      // 2. Envelope and policy, with the shared rules the Apps Script dispatcher
      //    uses. A mutation is refused here, before anything else happens.
      const validation = validateRequestEnvelope(input, { readOnly: true, maxPayloadBytes: READ_API_MAX_REQUEST_BYTES });
      if (!validation.ok) {
        denied += 1;
        return validation.response;
      }
      const request: ValidatedRequest = validation.value;
      if (!SERVED_OPERATIONS.has(request.operation)) {
        denied += 1;
        return failure('FORBIDDEN', 'This staging endpoint only serves the allowlisted read operations.');
      }

      // 3. Identity configuration, then the credential itself.
      let dependencies: GoogleDependencies;
      try {
        dependencies = googleFor();
      } catch {
        console.warn('staging request refused: identity configuration is missing or invalid');
        return failure('UNAVAILABLE', 'The staging read service is not configured.', { reason: 'identity-configuration' });
      }

      const credential = request.credential;
      if (credential === undefined || credential.trim().length === 0) {
        denied += 1;
        console.warn('staging sign-in rejected (missing): the request carried no credential');
        return unauthorized('missing', 'the request carried no credential');
      }
      let claims: VerifiedIdentityClaims;
      try {
        claims = await dependencies.verifier.verify(credential);
      } catch (error) {
        denied += 1;
        const detail = error instanceof Error ? error.message : String(error);
        if (error instanceof SigningKeyError && error.unavailable) {
          console.warn(`staging verification unavailable: ${detail}`);
          return failure('UNAVAILABLE', 'The staging read service could not verify credentials.', { reason: 'key-set' });
        }
        console.warn(`staging sign-in rejected (invalid): token verification failed: ${detail}`);
        return unauthorized('invalid', `token verification failed: ${detail}`);
      }

      // 3. Workbook configuration. It is checked only after the caller is known
      //    to be a real Google identity, and before any workbook data is read.
      let workbook: ReturnType<typeof workbookConfiguration>;
      try {
        workbook = workbookConfiguration(bindings);
      } catch {
        console.warn('staging request refused: workbook configuration is missing or invalid');
        return failure('UNAVAILABLE', 'The staging read service is not configured.', { reason: 'workbook-configuration' });
      }

      const sheets = createSheetsReadClient({
        spreadsheetId: workbook.spreadsheetId,
        accessToken: () => dependencies.sheetsTokens.accessToken('https://www.googleapis.com/auth/spreadsheets.readonly'),
        fetch: outbound
      });
      onSheetsClient(sheets);

      // 4. Fresh authorization table, before any domain range is requested.
      const snapshot = createWorkbookSnapshot(workbook.workbookTimeZone);
      // One runtime for the whole request: it decodes the authorization table
      // first and later serves the handlers from the same snapshot, with the
      // fetched map filled in after authorization.
      const fetched = new Map<string, readonly (readonly unknown[])[]>();
      let runtime: ReturnType<typeof createProductionRuntime>;
      let users;
      try {
        snapshot.setTab('Users', await sheets.readTab('Users'));
        runtime = createProductionRuntime(snapshot.spreadsheet, workbook.properties, {
          batchReader: createSnapshotBatchReader(fetched)
        });
        users = runtime.users;
      } catch (error) {
        denied += 1;
        console.warn(`staging authorization table could not be read: ${error instanceof Error ? error.message : String(error)}`);
        // The reason names the failure class: a staging operator needs to tell a
        // Sheets outage from a token problem without server log access, and none
        // of these names carries a row value or a credential.
        return failure('UNAVAILABLE', 'The staging read service could not read the authorization table.', {
          reason: error instanceof SheetsReadError && error.status !== undefined ? `users-read-${error.status}` : 'users-read'
        });
      }

      let principal;
      try {
        // The credential was verified above; the shared authenticator still owns
        // the email lookup and the inactive-row refusal, so authorization
        // semantics are identical to the Apps Script path.
        principal = authenticateCredential(credential, { verify: () => claims }, new MemoryUserDirectory(users));
      } catch (error) {
        denied += 1;
        const mapped = mapUnknownError(error);
        console.warn(`staging sign-in rejected (${error instanceof AuthenticationError ? error.reason : 'unknown'})`);
        return failure(mapped.code, mapped.message, mapped.details);
      }
      if (!request.policy.roles.some((role) => principal.user.roles.includes(role))) {
        denied += 1;
        console.warn(`staging request refused (role): ${request.operation} requires another role`);
        return failure('FORBIDDEN', 'Your account is not authorized for this operation.');
      }

      // 5. Domain ranges, only for an authorized caller and only the tabs the
      //    operation's named plan allowlists.
      const plan = OPERATION_PLANS[request.operation];
      if (plan) {
        try {
          const rows = await sheets.readTabs(BATCH_READ_PLANS[plan]);
          for (const [tab, tabRows] of rows) {
            fetched.set(tab, tabRows);
            snapshot.setTab(tab, tabRows);
          }
        } catch (error) {
          console.warn(`staging workbook read failed: ${error instanceof SheetsReadError ? error.message : String(error)}`);
          return failure('UNAVAILABLE', 'The staging read service could not read the workbook.', {
            reason: error instanceof SheetsReadError && error.status !== undefined ? `workbook-read-${error.status}` : 'workbook-read'
          });
        }
      }

      // 6. The existing synchronous runtime, over the fetched snapshot. The
      //    digest is recorded on the response so a measurement run can prove
      //    which rows produced a result without trusting the operator.
      digest = await snapshot.digest();
      const dispatcher: IntegrationDispatcher = createIntegrationDispatcher({
        verifier: { verify: () => claims },
        users: new MemoryUserDirectory(users),
        handlers: runtime.handlers,
        revision: { current: () => Number(workbook.properties.getProperty('DATA_REVISION') ?? '0') },
        clock: () => new Date(nowMs()).toISOString()
      });
      const response = dispatcher.dispatchReadOnly(input);
      if (!response.ok) denied += 1;
      return response;
  }
}

/**
 * Non-routed benchmark for `admin.schedule.preview`, which the slice deliberately
 * does not serve. It runs the real scheduler over an already-primed snapshot, so
 * the measurement milestone can time the computation without exposing a route.
 */
export function runSchedulingPreviewBenchmark(input: Readonly<{
  spreadsheet: SpreadsheetLike;
  properties: ScriptProperties;
  batchReader: WorkbookBatchReader;
  now: string;
}>): unknown {
  const runtime = createProductionRuntime(input.spreadsheet, input.properties, { batchReader: input.batchReader });
  const handler = runtime.handlers[INTEGRATION_OPERATIONS.adminSchedulePreview];
  if (!handler) throw new Error('The scheduling preview handler is unavailable.');
  return handler({
    actor: { claims: { iss: 'https://accounts.google.com', aud: 'staging', sub: 'benchmark', email: 'benchmark@example.test', exp: 0 }, user: { id: 'benchmark', email: 'benchmark@example.test', roles: ['administrator'], active: true, revision: 0 }, email: 'benchmark@example.test' },
    operation: INTEGRATION_OPERATIONS.adminSchedulePreview,
    idempotencyKey: 'staging-preview-benchmark',
    now: input.now
  }, {});
}
