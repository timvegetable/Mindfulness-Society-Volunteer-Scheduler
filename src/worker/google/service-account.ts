import { base64UrlEncodeJson, importPkcs8PrivateKey, signRs256, type FetchLike } from './jwt.js';

/**
 * Service-account access tokens for the Sheets API.
 *
 * This is the server-to-server OAuth flow, separate from ID-token verification:
 * the service account signs a JWT assertion with its own private key and
 * exchanges it at Google's token endpoint. Tokens are cached per scope until
 * shortly before they expire, so a burst of requests shares one exchange, and
 * nothing about the key or the token is ever included in a thrown error.
 */

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/** Refresh this many seconds before the token actually expires. */
export const DEFAULT_REFRESH_SKEW_SECONDS = 60;
/** The assertion lifetime Google accepts for this grant. */
export const ASSERTION_LIFETIME_SECONDS = 3600;
/** Longest a token is cached, even if the response claims a longer life. */
export const DEFAULT_MAX_TOKEN_TTL_SECONDS = 3600;
/** Distinct scopes retained at once. */
export const DEFAULT_MAX_CACHED_SCOPES = 4;

export class ServiceAccountTokenError extends Error {
  /** Set when Google answered with a non-success status, so a caller can classify without the body. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ServiceAccountTokenError';
    if (status !== undefined) this.status = status;
  }
}

export type AccessTokenProvider = {
  /** Returns a cached or freshly exchanged access token for one scope. */
  accessToken(scope: string): Promise<string>;
  stats(): Readonly<{ exchanges: number; cacheHits: number }>;
};

type CachedToken = Readonly<{ token: string; expiresAt: number }>;

function readTokenResponse(payload: unknown): { token: string; lifetimeSeconds: number } {
  if (typeof payload !== 'object' || payload === null) throw new ServiceAccountTokenError('Google returned a malformed token response.');
  const record = payload as { access_token?: unknown; expires_in?: unknown };
  if (typeof record.access_token !== 'string' || record.access_token.length === 0) {
    throw new ServiceAccountTokenError('Google returned no access token.');
  }
  if (record.expires_in === undefined || record.expires_in === null) {
    // A token with no stated lifetime is treated as short-lived rather than
    // long-lived: caching an already-dead token for an hour would be worse than
    // one extra exchange.
    return { token: record.access_token, lifetimeSeconds: 0 };
  }
  const claimed = typeof record.expires_in === 'number' ? record.expires_in : Number(record.expires_in);
  if (!Number.isFinite(claimed) || claimed <= 0) {
    // A present-but-invalid lifetime means the response is not trustworthy; a
    // token Google has already declared dead must never be cached.
    throw new ServiceAccountTokenError('Google returned an invalid token lifetime.');
  }
  return { token: record.access_token, lifetimeSeconds: claimed };
}

export function createServiceAccountTokenProvider(options: {
  clientEmail: string;
  privateKeyPem: string;
  fetch: FetchLike;
  /** Milliseconds since the epoch. */
  nowMs?: () => number;
  refreshSkewSeconds?: number;
  maxTokenTtlSeconds?: number;
  maxCachedScopes?: number;
}): AccessTokenProvider {
  if (!options.clientEmail.trim()) throw new Error('A service-account client email is required.');
  const nowMs = options.nowMs ?? (() => Date.now());
  const refreshSkewSeconds = options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS;
  const maxTokenTtlSeconds = options.maxTokenTtlSeconds ?? DEFAULT_MAX_TOKEN_TTL_SECONDS;
  const maxCachedScopes = options.maxCachedScopes ?? DEFAULT_MAX_CACHED_SCOPES;
  if (!Number.isSafeInteger(refreshSkewSeconds) || refreshSkewSeconds < 0) throw new Error('refreshSkewSeconds must be zero or greater.');
  if (!Number.isSafeInteger(maxTokenTtlSeconds) || maxTokenTtlSeconds < 60) throw new Error('maxTokenTtlSeconds must be at least one minute.');
  if (!Number.isSafeInteger(maxCachedScopes) || maxCachedScopes < 1) throw new Error('maxCachedScopes must be a positive integer.');

  const tokens = new Map<string, CachedToken>();
  const pending = new Map<string, Promise<CachedToken>>();
  let signingKey: Promise<CryptoKey> | undefined;
  let exchanges = 0;
  let cacheHits = 0;

  // Importing an RSA key is comparatively expensive, so it is memoized for the
  // isolate's lifetime; the key itself never changes for a staging deployment.
  const privateKey = (): Promise<CryptoKey> => {
    signingKey ??= importPkcs8PrivateKey(options.privateKeyPem);
    return signingKey;
  };

  const exchange = async (scope: string): Promise<CachedToken> => {
    const key = await privateKey();
    const issuedAt = Math.floor(nowMs() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: options.clientEmail,
      scope,
      aud: GOOGLE_TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_SECONDS
    };
    const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}`;
    const assertion = `${signingInput}.${await signRs256(signingInput, key)}`;

    let response: Response;
    try {
      response = await options.fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString()
      });
    } catch {
      throw new ServiceAccountTokenError('The Google token endpoint could not be reached.');
    }
    if (!response.ok) {
      // The response body is deliberately dropped: it can echo request material,
      // and the status is enough to classify a failure.
      throw new ServiceAccountTokenError(`The Google token exchange failed with status ${response.status}.`, response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ServiceAccountTokenError('Google returned a malformed token response.');
    }
    const { token, lifetimeSeconds } = readTokenResponse(payload);
    const effectiveLifetime = Math.min(lifetimeSeconds, maxTokenTtlSeconds);
    exchanges += 1;
    return { token, expiresAt: nowMs() + Math.max(0, effectiveLifetime - refreshSkewSeconds) * 1000 };
  };

  return {
    async accessToken(scope: string): Promise<string> {
      if (!scope.trim()) throw new ServiceAccountTokenError('A scope is required to acquire an access token.');
      const cached = tokens.get(scope);
      if (cached && nowMs() < cached.expiresAt) {
        cacheHits += 1;
        return cached.token;
      }
      // One exchange per scope even under concurrency: without this, a burst of
      // requests would each sign an assertion and call the token endpoint.
      const inFlight = pending.get(scope);
      if (inFlight) {
        cacheHits += 1;
        return (await inFlight).token;
      }
      const request = exchange(scope);
      pending.set(scope, request);
      try {
        const fresh = await request;
        if (tokens.size >= maxCachedScopes && !tokens.has(scope)) {
          const oldest = tokens.keys().next().value;
          if (oldest !== undefined) tokens.delete(oldest);
        }
        tokens.set(scope, fresh);
        return fresh.token;
      } finally {
        pending.delete(scope);
      }
    },
    stats: () => ({ exchanges, cacheHits })
  };
}
