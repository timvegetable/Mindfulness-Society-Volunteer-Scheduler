import type { ApiResponse } from '../shared/domain.js';
import { AuthenticationError, type VerifiedIdentityClaims } from '../server/integration/auth.js';
import { failure, mapUnknownError, validateRequestEnvelope } from '../server/integration/request-policy.js';
import { googleIdentityConfiguration, type GoogleIdentityConfiguration, type StagingBindings } from './config.js';
import { SigningKeyError, createGoogleDependencies, type FetchLike, type GoogleDependencies } from './google/index.js';
import { READ_API_MAX_REQUEST_BYTES } from './read-api.js';

/**
 * Composition seam for the staging slice.
 *
 * The transport is generic; this function decides what a well-formed request to
 * an allowlisted operation actually does. It applies the shared envelope and
 * read-only policy — so a mutation is refused by the same rule the Apps Script
 * dispatcher uses — and then verifies the caller's Google ID token against
 * Google's published keys before doing anything else.
 *
 * A caller whose token verifies is still refused: the fresh `Users` read, the
 * workbook ranges and the composed handlers arrive in the next milestone.
 * Refusing is deliberate — an endpoint that cannot read the authorization table
 * must not serve workbook data, and it must not pretend to succeed.
 */

/** One-slot cache of assembled clients, keyed by the resolved identity configuration. */
export type DependencyCache = Readonly<{
  get(key: string): GoogleDependencies | undefined;
  set(key: string, value: GoogleDependencies): void;
}>;

export type StagingDispatchOptions = Readonly<{
  /** Outbound `fetch`; injected so tests never contact Google. */
  fetch?: FetchLike;
  nowMs?: () => number;
  /** Overrides for tests that need to drive the assembled Google clients. */
  google?: (configuration: GoogleIdentityConfiguration) => GoogleDependencies;
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
 * isolate. Without this every request would fetch the key set and exchange a
 * service-account token, which is both slower and more quota-hungry than the
 * design assumes.
 *
 * The identity is built structurally rather than by joining fields, so two
 * configurations can never collide onto one entry. A caller that injects its own
 * transport or clock gets a private cache unless it asks for the shared one, so
 * one injected client can never be observed by another.
 */
function configurationKey(configuration: GoogleIdentityConfiguration): string {
  return JSON.stringify([configuration.audience, configuration.clientEmail, configuration.privateKeyPem]);
}

function unauthorized(reason: AuthenticationError['reason'], detail: string): ApiResponse<never> {
  // One mapping for both runtimes: the staging slice must report the same
  // envelope and the same non-sensitive reason the dispatcher reports.
  const mapped = mapUnknownError(new AuthenticationError(reason, 'Authentication is required.', detail));
  return failure(mapped.code, mapped.message, mapped.details);
}

export function createStagingDispatch(
  bindings: StagingBindings = {},
  options: StagingDispatchOptions = {}
): (input: unknown) => Promise<ApiResponse<unknown>> {
  const outbound: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const injectedTransport = options.fetch !== undefined || options.nowMs !== undefined;
  const cache = options.dependencyCache ?? (injectedTransport ? privateCache() : isolateDependencyCache);

  const resolveDependencies = (configuration: GoogleIdentityConfiguration): GoogleDependencies => {
    if (options.google) return options.google(configuration);
    const key = configurationKey(configuration);
    const cached = cache.get(key);
    if (cached) return cached;
    const dependencies = createGoogleDependencies(configuration, {
      fetch: outbound,
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs })
    });
    cache.set(key, dependencies);
    return dependencies;
  };

  return async (input) => {
    const validation = validateRequestEnvelope(input, { readOnly: true, maxPayloadBytes: READ_API_MAX_REQUEST_BYTES });
    if (!validation.ok) return validation.response;

    let dependencies: GoogleDependencies;
    try {
      dependencies = resolveDependencies(googleIdentityConfiguration(bindings));
    } catch {
      // Missing or malformed identity configuration is not a caller error, and
      // the detail can name bindings, so it stays server-side.
      console.warn('staging request refused: identity configuration is missing or invalid');
      return failure('UNAVAILABLE', 'The staging read service is not configured.');
    }

    const credential = validation.value.credential;
    if (credential === undefined || credential.trim().length === 0) {
      console.warn('staging sign-in rejected (missing): the request carried no credential');
      return unauthorized('missing', 'the request carried no credential');
    }

    let claims: VerifiedIdentityClaims;
    try {
      claims = await dependencies.verifier.verify(credential);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof SigningKeyError && error.unavailable) {
        // Google's key set being unavailable is not the caller's fault and must
        // not be reported as an invalid credential, or clients will discard a
        // perfectly good session during an outage.
        console.warn(`staging verification unavailable: ${detail}`);
        return failure('UNAVAILABLE', 'The staging read service could not verify credentials.');
      }
      console.warn(`staging sign-in rejected (invalid): token verification failed: ${detail}`);
      return unauthorized('invalid', `token verification failed: ${detail}`);
    }

    // Identity is now established. Authorization needs the workbook's `Users`
    // tab and the response needs the composed read handlers, both of which the
    // next milestone adds; until then the endpoint refuses rather than leaking
    // workbook data to an unverified caller.
    void claims;
    return failure('UNAVAILABLE', 'The staging read service is not configured.');
  };
}
