import { z } from 'zod';
import type { Clock, TokenVerifier, VerifiedIdentityClaims } from './auth.js';

/**
 * The script-cache surface this module needs. Apps Script's
 * `CacheService.getScriptCache()` satisfies it directly; tests supply a plain
 * object. Cache contents are never guaranteed to persist, so every read is
 * treated as a possible miss.
 */
export type ClaimCache = {
  get(key: string): string | null;
  put(key: string, value: string, seconds: number): void;
};

/** Turns a credential into the cache key; the credential itself is never stored. */
export type ClaimsDigest = (value: string) => string;

export type CachingTokenVerifierOptions = Readonly<{
  verifier: TokenVerifier;
  cache: ClaimCache;
  digest: ClaimsDigest;
  audience: string;
  clock?: Clock;
  /** Ceiling on the cache lifetime, in seconds. Defaults to five minutes. */
  maxTtlSeconds?: number;
}>;

const DEFAULT_MAX_TTL_SECONDS = 300;

/** Keeps cached claims from colliding with any other script-cache consumer. */
const CLAIM_KEY_PREFIX = 'verified-claims:';

const CachedClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  sub: z.string().min(1),
  email: z.string().min(1),
  email_verified: z.boolean().optional(),
  exp: z.number().finite(),
  iat: z.number().finite().optional(),
  name: z.string().max(200).optional()
});

/**
 * Accepts a cached claim only when it parses, was minted for the configured
 * audience, and has not expired. Anything else is a miss, so an entry that
 * cannot be validated is re-verified instead of trusted.
 */
function readCachedClaims(raw: string, audience: string, now: number): VerifiedIdentityClaims | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const parsed = CachedClaimsSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.exp <= now) return undefined;
  const { aud } = parsed.data;
  if (typeof aud === 'string' ? aud !== audience : !aud.includes(audience)) return undefined;
  return parsed.data;
}

/**
 * Verifies each credential at most once per cache lifetime. Only successfully
 * verified claims are stored; a verification failure propagates and writes
 * nothing, so the next read retries the verifier.
 */
export function createCachingTokenVerifier(options: CachingTokenVerifierOptions): TokenVerifier {
  if (!options.audience.trim()) throw new Error('A token audience is required.');
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  const maxTtlSeconds = options.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
  if (!Number.isFinite(maxTtlSeconds) || maxTtlSeconds <= 0) throw new Error('A positive claim cache lifetime is required.');

  return {
    verify(credential: string): VerifiedIdentityClaims {
      const key = `${CLAIM_KEY_PREFIX}${options.digest(credential)}`;
      const cached = options.cache.get(key);
      if (cached !== null) {
        const claims = readCachedClaims(cached, options.audience, clock());
        if (claims) return claims;
      }
      const claims = options.verifier.verify(credential);
      const ttlSeconds = Math.floor(Math.min(maxTtlSeconds, claims.exp - clock()));
      if (ttlSeconds > 0) options.cache.put(key, JSON.stringify(claims), ttlSeconds);
      return claims;
    }
  };
}

/**
 * The subset of Apps Script's `Utilities` service used to hash a credential.
 * The method is typed as accepting any argument list so the real service, whose
 * `computeDigest` is overloaded for several value types, satisfies this
 * boundary as written.
 *
 * The runtime injects the ambient `Utilities` object unchanged; this module
 * never reads a global itself.
 */
export type AppsScriptDigestService = {
  readonly DigestAlgorithm: { readonly SHA_256: unknown };
  computeDigest(...args: never[]): readonly number[];
};

/**
 * Builds the SHA-256 hex digest used as the cache key from Apps Script's
 * `Utilities.computeDigest`. The service is passed in rather than read from a
 * global so the runtime injects the real one and tests inject a double.
 */
export function createAppsScriptDigest(utilities: AppsScriptDigestService): ClaimsDigest {
  const algorithm = utilities.DigestAlgorithm.SHA_256;
  const computeDigest = utilities.computeDigest as (algorithm: unknown, value: string) => readonly number[];
  return (value: string): string =>
    computeDigest(algorithm, value)
      // Apps Script returns signed bytes; masking yields the canonical hex octet.
      .map((byte) => (byte & 0xff).toString(16).padStart(2, '0'))
      .join('');
}
