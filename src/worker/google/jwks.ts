import { importJwkPublicKey, type FetchLike } from './jwt.js';

/**
 * Google's public signing keys for ID tokens.
 *
 * Keys are cached for the isolate and re-fetched when the cache expires or when
 * a token names a key the cache does not hold — the latter is what makes key
 * rotation survivable. Every bound here is deliberate: the cache lifetime is
 * capped independently of the response headers, one load is shared by all
 * concurrent callers, and a forged key id can trigger at most one reload per
 * window, so an unauthenticated caller cannot turn requests into outbound
 * fetches. Only keys a token actually resolves to are imported.
 */

/** Google's published JWKS endpoint for ID tokens. */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Longest a fetched key set is trusted, regardless of the response cache headers. */
export const DEFAULT_KEY_TTL_SECONDS = 3600;
/** Shortest gap between two key-set reloads triggered by an unknown key id. */
export const DEFAULT_MIN_RELOAD_INTERVAL_MS = 5_000;
/** Ceiling on keys retained from one response. */
export const DEFAULT_MAX_KEYS = 24;

export class SigningKeyError extends Error {
  /**
   * True when the *key set* could not be established (the identity provider is
   * unavailable or returned nothing usable), false when the presented credential
   * is at fault. The distinction is what lets a caller tell an outage from a bad
   * token instead of re-authenticating during a Google incident.
   */
  readonly unavailable: boolean;

  constructor(message: string, unavailable = false) {
    super(message);
    this.name = 'SigningKeyError';
    this.unavailable = unavailable;
  }
}

export type GoogleKeyStoreStats = Readonly<{ loads: number; hits: number; rotationReloads: number }>;

export type GoogleKeyStore = Readonly<{
  /**
   * Verification key candidates for a key id, in preference order. A token with
   * no key id yields every retained key; a token naming an unknown key triggers
   * at most one reload per window and then yields nothing.
   */
  verificationKeys(kid: string | undefined): Promise<readonly CryptoKey[]>;
  stats(): GoogleKeyStoreStats;
}>;

type KeySetEntry = Readonly<{ kid: string; jwk: JsonWebKey }>;

function parseMaxAge(header: string | null): number | undefined {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(header ?? '');
  if (!match?.[1]) return undefined;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function readKeys(payload: unknown, maxKeys: number): KeySetEntry[] {
  if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { keys?: unknown }).keys)) {
    throw new SigningKeyError('The identity provider returned a malformed key set.', true);
  }
  const entries = (payload as { keys: unknown[] }).keys.slice(0, maxKeys);
  return entries.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const jwk = entry as JsonWebKey & { kid?: unknown; alg?: unknown; use?: unknown };
    if (typeof jwk.kid !== 'string' || jwk.kid.length === 0) return [];
    // Only signature keys advertising the expected algorithm are eligible; an
    // entry marked for another use must never become a verification key.
    if (jwk.use !== undefined && jwk.use !== 'sig') return [];
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') return [];
    return [{ kid: jwk.kid, jwk }];
  });
}

export function createGoogleKeyStore(options: {
  fetch: FetchLike;
  url?: string;
  nowMs?: () => number;
  ttlSeconds?: number;
  minReloadIntervalMs?: number;
  maxKeys?: number;
}): GoogleKeyStore {
  const url = options.url ?? GOOGLE_JWKS_URL;
  const nowMs = options.nowMs ?? (() => Date.now());
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_KEY_TTL_SECONDS;
  const minReloadIntervalMs = options.minReloadIntervalMs ?? DEFAULT_MIN_RELOAD_INTERVAL_MS;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error('ttlSeconds must be a positive integer.');
  if (!Number.isSafeInteger(minReloadIntervalMs) || minReloadIntervalMs < 0) throw new Error('minReloadIntervalMs must be zero or greater.');
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new Error('maxKeys must be a positive integer.');

  let entries: KeySetEntry[] = [];
  const imported = new Map<string, CryptoKey>();
  let expiresAt = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let pendingLoad: Promise<void> | undefined;
  let loads = 0;
  let hits = 0;
  let rotationReloads = 0;

  const performLoad = async (): Promise<void> => {
    // Stamped before the request so the window is enforced from the attempt: a
    // failing key endpoint must not license an unbounded retry storm either.
    lastAttemptAt = nowMs();
    let response: Response;
    try {
      response = await options.fetch(url, { headers: { Accept: 'application/json' } });
    } catch {
      throw new SigningKeyError('The identity provider key set could not be retrieved.', true);
    }
    if (!response.ok) throw new SigningKeyError(`The identity provider key set request failed with status ${response.status}.`, true);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SigningKeyError('The identity provider returned a malformed key set.', true);
    }
    const loaded = readKeys(payload, maxKeys);
    if (loaded.length === 0) throw new SigningKeyError('The identity provider key set contained no usable signing key.', true);
    const maxAge = parseMaxAge(response.headers.get('cache-control'));
    entries = loaded;
    imported.clear();
    const lifetime = Math.min(maxAge ?? ttlSeconds, ttlSeconds);
    expiresAt = nowMs() + lifetime * 1000;
    loads += 1;
  };

  /** Concurrent callers share one in-flight load instead of each starting one. */
  const load = (): Promise<void> => {
    pendingLoad ??= performLoad().finally(() => { pendingLoad = undefined; });
    return pendingLoad;
  };

  const matchingEntries = (kid: string | undefined): KeySetEntry[] =>
    kid === undefined ? [...entries] : entries.filter((entry) => entry.kid === kid);

  const importEntries = async (candidates: KeySetEntry[]): Promise<CryptoKey[]> => {
    const keys: CryptoKey[] = [];
    for (const entry of candidates) {
      const existing = imported.get(entry.kid);
      if (existing) {
        keys.push(existing);
        continue;
      }
      try {
        const key = await importJwkPublicKey(entry.jwk);
        imported.set(entry.kid, key);
        keys.push(key);
      } catch {
        // One unusable entry must not deny a token that has another candidate.
      }
    }
    if (keys.length === 0) throw new SigningKeyError('The identity provider returned an unusable signing key.', true);
    return keys;
  };

  return {
    async verificationKeys(kid: string | undefined): Promise<readonly CryptoKey[]> {
      if (entries.length === 0 || nowMs() >= expiresAt) {
        // The same window that bounds rotation also bounds retries after a
        // failed load, so an unavailable key endpoint cannot turn every request
        // into an outbound fetch. A gated attempt fails closed: no stale key is
        // used and no fetch is issued.
        if (nowMs() - lastAttemptAt < minReloadIntervalMs) {
          throw new SigningKeyError('The identity provider key set is not available yet.', true);
        }
        await load();
      }
      const candidates = matchingEntries(kid);
      if (candidates.length > 0) {
        hits += 1;
        return await importEntries(candidates);
      }
      // An unknown key id is how rotation presents itself. Reload at most once
      // per window so a forged id cannot force an outbound fetch per request.
      if (nowMs() - lastAttemptAt < minReloadIntervalMs) {
        throw new SigningKeyError('The credential was signed with an unknown key.');
      }
      rotationReloads += 1;
      await load();
      const reloaded = matchingEntries(kid);
      if (reloaded.length === 0) throw new SigningKeyError('The credential was signed with an unknown key.');
      hits += 1;
      return await importEntries(reloaded);
    },
    stats: () => ({ loads, hits, rotationReloads })
  };
}
