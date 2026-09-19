import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TokenVerifier, VerifiedIdentityClaims } from './auth.js';
import { createAppsScriptDigest, createCachingTokenVerifier, type AppsScriptDigestService, type ClaimCache, type ClaimsDigest } from './claim-cache.js';

const AUDIENCE = '716719981089-example.apps.googleusercontent.com';
const CREDENTIAL = 'credential.that-is-never-stored';
const START = 1_700_000_000;

/** Mirrors the production digest: the wrapper only requires that a digest is injected. */
const digest: ClaimsDigest = (value: string): string => createHash('sha256').update(value).digest('hex');

const baseClaims: VerifiedIdentityClaims = {
  iss: 'https://accounts.google.com',
  aud: AUDIENCE,
  sub: 'sub-1',
  email: 'tcai5958@terpmail.umd.edu',
  email_verified: true,
  exp: START + 600
};

/**
 * Script cache double that honours the expiration it was given, because the
 * verifier relies on the cache dropping entries once their TTL elapses.
 */
class FakeClaimCache implements ClaimCache {
  readonly entries = new Map<string, { value: string; expiresAt: number }>();
  puts = 0;

  constructor(private readonly clock: () => number) {}

  get(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  put(key: string, value: string, seconds: number): void {
    this.puts += 1;
    this.entries.set(key, { value, expiresAt: this.clock() + seconds });
  }

  /** Rewrites the stored payload while keeping the entry live, as tampering or corruption would. */
  tamper(value: string): void {
    const key = [...this.entries.keys()][0]!;
    this.entries.set(key, { value, expiresAt: this.clock() + 300 });
  }
}

function setup(claims: VerifiedIdentityClaims) {
  const state: { now: number; calls: number; failure?: Error } = { now: START, calls: 0 };
  const clock = (): number => state.now;
  const cache = new FakeClaimCache(clock);
  const verifier = createCachingTokenVerifier({
    verifier: {
      verify: (): VerifiedIdentityClaims => {
        state.calls += 1;
        if (state.failure) throw state.failure;
        return claims;
      }
    },
    cache,
    digest,
    audience: AUDIENCE,
    clock
  });
  return { state, cache, verifier };
}

describe('verified-claim caching', () => {
  it('verifies once and serves the second read of the same credential from the cache', () => {
    const { state, cache, verifier } = setup(baseClaims);

    expect(verifier.verify(CREDENTIAL)).toEqual(baseClaims);
    expect(verifier.verify(CREDENTIAL)).toEqual(baseClaims);

    expect(state.calls).toBe(1);
    expect(cache.puts).toBe(1);
    expect([...cache.entries.keys()].join('|')).not.toContain(CREDENTIAL);
    expect([...cache.entries.values()][0]!.expiresAt - START).toBe(300);
  });

  it('re-verifies once the cached entry reaches its expiry', () => {
    const { state, cache, verifier } = setup(baseClaims);

    verifier.verify(CREDENTIAL);
    state.now = START + 300;
    verifier.verify(CREDENTIAL);

    expect(state.calls).toBe(2);
    expect(cache.puts).toBe(2);
  });

  it('bounds the cached lifetime by the credential expiry when that is shorter', () => {
    const { cache, verifier } = setup({ ...baseClaims, exp: START + 40 });

    verifier.verify(CREDENTIAL);

    expect([...cache.entries.values()][0]!.expiresAt - START).toBe(40);
  });

  it('skips the write when the claim leaves no positive lifetime', () => {
    const { cache, verifier } = setup({ ...baseClaims, exp: START });

    verifier.verify(CREDENTIAL);

    expect(cache.puts).toBe(0);
    expect(cache.entries.size).toBe(0);
  });

  it('does not cache a failed verification and retries the verifier on the next read', () => {
    const { state, cache, verifier } = setup(baseClaims);

    state.failure = new Error('Google credential verification failed.');
    expect(() => verifier.verify(CREDENTIAL)).toThrow('Google credential verification failed.');
    expect(cache.puts).toBe(0);
    expect(cache.entries.size).toBe(0);

    state.failure = undefined;
    expect(verifier.verify(CREDENTIAL)).toEqual(baseClaims);
    expect(state.calls).toBe(2);
    expect(cache.puts).toBe(1);
  });

  it('falls back to verification when the cached entry is corrupt', () => {
    const { state, cache, verifier } = setup(baseClaims);

    verifier.verify(CREDENTIAL);
    cache.tamper('{"email": "truncated"');

    expect(verifier.verify(CREDENTIAL)).toEqual(baseClaims);
    expect(state.calls).toBe(2);
  });

  it('re-verifies a cached claim whose own expiry has passed', () => {
    const { state, cache, verifier } = setup(baseClaims);

    verifier.verify(CREDENTIAL);
    cache.tamper(JSON.stringify({ ...baseClaims, exp: state.now - 1 }));

    expect(verifier.verify(CREDENTIAL)).toEqual(baseClaims);
    expect(state.calls).toBe(2);
  });

  it('re-verifies a cached claim minted for another audience', () => {
    const { state, cache, verifier } = setup(baseClaims);

    verifier.verify(CREDENTIAL);
    cache.tamper(JSON.stringify({ ...baseClaims, aud: 'someone-elses-client-id' }));

    expect(verifier.verify(CREDENTIAL)).toEqual(baseClaims);
    expect(state.calls).toBe(2);
  });

  it('rejects a configuration without an audience', () => {
    expect(() => createCachingTokenVerifier({ verifier: { verify: () => baseClaims }, cache: new FakeClaimCache(() => START), digest, audience: '  ' })).toThrow(/audience/);
  });
});

describe('Apps Script SHA-256 digest', () => {
  it('hashes the credential through Utilities.computeDigest and returns canonical hex octets', () => {
    const calls: Array<readonly [unknown, string]> = [];
    const utilities: AppsScriptDigestService = {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: ((algorithm: unknown, value: string) => {
        calls.push([algorithm, value]);
        // Apps Script returns signed bytes and the high byte must still render as ff.
        return [0x00, 0x0f, 0xa5, 0xff, -1];
      }) as AppsScriptDigestService['computeDigest']
    };

    expect(createAppsScriptDigest(utilities)(CREDENTIAL)).toBe('000fa5ffff');
    expect(calls).toEqual([['SHA_256', CREDENTIAL]]);
  });
});
