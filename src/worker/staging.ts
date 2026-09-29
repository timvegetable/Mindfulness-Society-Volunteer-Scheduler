import type { ApiResponse } from '../shared/domain.js';
import { AuthenticationError, MemoryUserDirectory, authenticateCredential, type VerifiedIdentityClaims } from '../server/integration/auth.js';
import { createIntegrationDispatcher, type IntegrationDispatcher } from '../server/integration/dispatcher.js';
import { ALLOWED_INTEGRATION_OPERATIONS, INTEGRATION_OPERATIONS, failure, mapUnknownError, validateRequestEnvelope, type ValidatedRequest } from '../server/integration/request-policy.js';
import { BATCH_READ_PLANS, type BatchReadPlan } from '../server/workbook/batch-read.js';
import type { SpreadsheetLike } from '../server/workbook/initializer.js';
import type { BatchReadRows, WorkbookBatchReader } from '../server/workbook/batch-read.js';
import { createProductionRuntime, type ScriptProperties } from '../server/runtime.js';
import { controlAuthority, googleIdentityConfiguration, workbookConfiguration, type StagingBindings } from './config.js';
import { CONTROL_COLUMNS, ControlError, controlFailureCode, controlRecordFromRows, type ControlAuthority } from '../server/workbook/control.js';
import { PortableSession } from '../server/workbook/portable-session.js';
import type { SheetLike } from '../server/workbook/initializer.js';
import { withCompletedSnapshotAsync } from '../server/workbook/completed-snapshot.js';
import { SigningKeyError, createGoogleDependencies, type FetchLike, type GoogleDependencies } from './google/index.js';
import { READ_API_MAX_REQUEST_BYTES, type ReadRoute } from './read-api.js';
import { SheetsReadError, createSheetsReadClient } from './workbook/sheets.js';
import { createSnapshotBatchReader, createWorkbookSnapshot } from './workbook/snapshot.js';

/**
 * Hydrate one named plan. With the portable authority activated the read is
 * bracketed by control reads, so a mutation that begins, completes or recovers
 * while the ranges are in flight rejects the snapshot instead of serving rows
 * from two different generations. The two extra reads are visible in the
 * response's Sheets read count, which is what task 4.1 measures.
 */
async function readPlanRows(
  sheets: ReturnType<typeof createSheetsReadClient>,
  plan: BatchReadPlan,
  authority: ControlAuthority,
  publishControlRows: (rows: readonly (readonly unknown[])[]) => void
): Promise<BatchReadRows> {
  if (authority !== 'workbook-control') return await sheets.readTabs(BATCH_READ_PLANS[plan]);
  const snapshot = await withCompletedSnapshotAsync({
    readControl: async () => {
      const rows = await sheets.readTab('WorkbookControl');
      // The request's session reports its revisions from these rows, so the
      // bracketed read is the only control fetch a served read pays for.
      publishControlRows(rows);
      return controlRecordFromRows(rows);
    },
    hydrate: () => sheets.readTabs(BATCH_READ_PLANS[plan]),
    tabs: BATCH_READ_PLANS[plan],
    authority: 'workbook-control'
  });
  return snapshot.data;
}

/**
 * A `SheetLike` over rows already fetched from the control tab. The Worker reads
 * over REST, so the session cannot fetch for itself; it serves what the bracket
 * read, and fails closed if nothing has been fetched when a revision is needed.
 */
function controlSheetFromRows(rows: () => readonly (readonly unknown[])[] | undefined) {
  const data = (): readonly (readonly unknown[])[] => {
    const fetched = rows();
    if (fetched === undefined) throw new ControlError('MISSING', 'The control record has not been read in this request');
    return fetched;
  };
  return {
    getName: () => 'WorkbookControl',
    getLastColumn: () => CONTROL_COLUMNS.length,
    getLastRow: () => data().length + 1,
    getRange: () => ({
      getValues: () => data().map((row) => [...row]),
      setValues: () => { throw new ControlError('GATE_CLOSED', 'The staging reader never writes control state'); },
      setValue: () => { throw new ControlError('GATE_CLOSED', 'The staging reader never writes control state'); },
      getValue: () => data()[0]?.[0] ?? '',
      protect: () => ({ setDescription: () => undefined, setWarningOnly: () => undefined })
    }),
    appendRow: () => { throw new ControlError('GATE_CLOSED', 'The staging reader never writes control state'); }
  } as unknown as SheetLike;
}

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

/**
 * The benchmark route serves exactly the schedule preview, and only for a
 * service constructed with `benchmarkPreview`. A preview request that arrives
 * through `/exec` still hits `SERVED_OPERATIONS` and stays refused: the two
 * routes' allowlists are disjoint even when the benchmark is enabled.
 */
export const BENCHMARK_SERVED_OPERATIONS: ReadonlySet<string> = new Set([INTEGRATION_OPERATIONS.adminSchedulePreview]);

/** The read plan each served operation needs, beyond the always-fresh Users read. */
const OPERATION_PLANS: Readonly<Record<string, BatchReadPlan | undefined>> = {
  [INTEGRATION_OPERATIONS.me]: undefined,
  [INTEGRATION_OPERATIONS.adminSchedule]: 'publishedSchedule',
  [INTEGRATION_OPERATIONS.adminInsights]: 'insightCacheMiss',
  // Served only through the benchmark route's own allowlist, never through /exec.
  [INTEGRATION_OPERATIONS.adminSchedulePreview]: 'schedulePreview'
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
  /** Serves the schedule preview on the benchmark route; default false keeps it refused everywhere. */
  benchmarkPreview?: boolean;
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
  /** `route` selects the transport route's allowlist; default keeps `/exec` behaviour. */
  handle(input: unknown, route?: ReadRoute): Promise<ApiResponse<unknown>>;
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
    async handle(input: unknown, route: ReadRoute = 'exec'): Promise<ApiResponse<unknown>> {
      requests += 1;
      let sheets: ReturnType<typeof createSheetsReadClient> | undefined;
      try {
        return await serve(input, (client) => { sheets = client; }, route);
      } finally {
        if (sheets) sheetsReads += sheets.readCount();
      }
    },
    stats: () => ({ sheetsReads, requests, denied, digest })
  };

  async function serve(input: unknown, onSheetsClient: (client: ReturnType<typeof createSheetsReadClient>) => void, route: ReadRoute): Promise<ApiResponse<unknown>> {

      const benchmarkRoute = route === 'benchmark';
      // The benchmark route serves the preview only for a service constructed
      // with `benchmarkPreview`; a direct call that skips the transport still
      // cannot reach it otherwise. `/exec` always uses the three-op allowlist,
      // so the preview is refused there even when the benchmark is enabled.
      const served = benchmarkRoute
        ? (options.benchmarkPreview === true ? BENCHMARK_SERVED_OPERATIONS : undefined)
        : SERVED_OPERATIONS;
      const forbiddenMessage = benchmarkRoute
        ? 'This staging benchmark endpoint only serves the schedule preview operation.'
        : 'This staging endpoint only serves the allowlisted read operations.';

      // 1. The operation allowlist first, so an operation this endpoint does not
      //    serve is refused whatever its payload looks like — the same order the
      //    transport uses.
      const rawOperation = typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as { operation?: unknown }).operation
        : undefined;
      // An operation that is not registered at all stays the shared gate's
      // INVALID_REQUEST; a registered one this endpoint does not serve is
      // refused as FORBIDDEN.
      if (typeof rawOperation === 'string' && ALLOWED_INTEGRATION_OPERATIONS.has(rawOperation) && (served === undefined || !served.has(rawOperation))) {
        denied += 1;
        return failure('FORBIDDEN', forbiddenMessage);
      }

      // 2. Envelope and policy, with the shared rules the Apps Script dispatcher
      //    uses. A mutation is refused here, before anything else happens.
      const validation = validateRequestEnvelope(input, { readOnly: true, maxPayloadBytes: READ_API_MAX_REQUEST_BYTES });
      if (!validation.ok) {
        denied += 1;
        return validation.response;
      }
      const request: ValidatedRequest = validation.value;
      if (served === undefined || !served.has(request.operation)) {
        denied += 1;
        return failure('FORBIDDEN', forbiddenMessage);
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

      let authority: ControlAuthority;
      try {
        authority = controlAuthority(bindings);
      } catch {
        console.warn('staging request refused: the control authority binding is invalid');
        return failure('UNAVAILABLE', 'The staging read service is not configured.', { reason: 'control-authority' });
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
      let controlRows: readonly (readonly unknown[])[] | undefined;
      let session: PortableSession | undefined;
      let runtime: ReturnType<typeof createProductionRuntime>;
      let users;
      try {
        // The authorization read and, under the portable authority, the control
        // record travel in one validated batch: the session needs the record
        // before the runtime reads a tab revision, and combining them keeps a
        // served read at the count the read plan pins.
        const authorizationRows = await sheets.readNamedTabs(authority === 'workbook-control' ? ['Users', 'WorkbookControl'] : ['Users']);
        snapshot.setTab('Users', authorizationRows.get('Users') ?? []);
        controlRows = authorizationRows.get('WorkbookControl');
        // Under the portable authority the runtime's revisions come from the
        // control record, not from the staging properties, which stop advancing.
        session = authority === 'workbook-control'
          ? new PortableSession({
              control: controlSheetFromRows(() => controlRows),
              journal: controlSheetFromRows(() => controlRows),
              writeEnabled: () => false
            })
          : undefined;
        runtime = createProductionRuntime(snapshot.spreadsheet, workbook.properties, {
          batchReader: createSnapshotBatchReader(fetched),
          ...(session ? { session } : {})
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
          const rows = await readPlanRows(sheets, plan, authority, (rows) => { controlRows = rows; });
          for (const [tab, tabRows] of rows) {
            fetched.set(tab, tabRows);
            snapshot.setTab(tab, tabRows);
          }
        } catch (error) {
          if (error instanceof ControlError) {
            // The completed-snapshot check refused the read: a mutation was
            // pending or a generation moved while the ranges were in flight.
            console.warn(`staging control check refused a read: ${error.code}`);
            return failure(controlFailureCode(error.code, 'read'), 'The workbook did not hold still while it was read; retry.', {
              reason: `control-${error.code.toLowerCase()}`
            });
          }
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
        revision: { current: () => (session ? session.dataRevision() : Number(workbook.properties.getProperty('DATA_REVISION') ?? '0')) },
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
