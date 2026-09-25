import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_JWKS_URL,
  GOOGLE_TOKEN_ENDPOINT,
  SHEETS_READONLY_SCOPE,
  SigningKeyError,
  ServiceAccountTokenError,
  base64UrlEncodeJson,
  createGoogleIdTokenVerifier,
  createGoogleKeyStore,
  createGoogleDependencies,
  createServiceAccountTokenProvider,
  decodeJoseHeader,
  signRs256,
  type FetchLike
} from './index.js';

/**
 * These tests run in workerd against real WebCrypto. Every token is genuinely
 * signed and every signature genuinely verified, so a broken algorithm pin or a
 * skipped verification step fails here rather than in staging. No test contacts
 * Google.
 */

const SIGNING_KEY_ID = 'test-key-a';
const ROTATED_KEY_ID = 'test-key-b';
const AUDIENCE = 'staging-client.apps.googleusercontent.com';
const CLIENT_EMAIL = 'staging-reader@example-project.iam.gserviceaccount.com';

type TestJwk = JsonWebKey & { kid: string; alg?: string; use?: string };
type KeyPair = { privateKey: CryptoKey; publicJwk: TestJwk };

async function generateKey(kid: string): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' } as TestJwk };
}

async function pkcs8Pem(key: CryptoKey): Promise<string> {
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key) as ArrayBuffer);
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines = btoa(binary).replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

async function signToken(claims: Record<string, unknown>, key: CryptoKey, kid: string, header: Record<string, unknown> = {}): Promise<string> {
  const signingInput = `${base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT', kid, ...header })}.${base64UrlEncodeJson(claims)}`;
  return `${signingInput}.${await signRs256(signingInput, key)}`;
}

function jwtClaims(overrides: Record<string, unknown> = {}, now = 1_700_000_000): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    sub: '112233445566778899',
    email: 'Volunteer@Example.test',
    email_verified: true,
    exp: now + 3600,
    iat: now,
    ...overrides
  };
}

const NOW = 1_700_000_000_000;
let PEM_FOR_TESTS = '';

let primary: KeyPair;
let other: KeyPair;
let rotated: KeyPair;

beforeAll(async () => {
  [primary, other, rotated] = await Promise.all([generateKey(SIGNING_KEY_ID), generateKey('test-key-other'), generateKey(ROTATED_KEY_ID)]);
  PEM_FOR_TESTS = await pkcs8Pem(primary.privateKey);
});

function jwksResponse(keys: JsonWebKey[], headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ keys }), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A `fetch` double that records the URLs it was asked for. */
function jwksFetch(keys: () => JsonWebKey[]): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (input: string) => {
      calls.push(String(input));
      return jwksResponse(keys());
    }
  };
}

describe('Google ID-token verification', () => {
  const verifierWith = (fetchImpl: FetchLike, nowMs: () => number = () => NOW, ttlSeconds = 3600) =>
    createGoogleIdTokenVerifier({
      audience: AUDIENCE,
      nowMs,
      keys: createGoogleKeyStore({ fetch: fetchImpl, nowMs, ttlSeconds, minReloadIntervalMs: 0 })
    });

  it('accepts a correctly signed token and normalises the claims', async () => {
    const { fetchImpl, calls } = jwksFetch(() => [primary.publicJwk]);
    const verifier = verifierWith(fetchImpl);
    const claims = await verifier.verify(await signToken(jwtClaims(), primary.privateKey, SIGNING_KEY_ID));
    expect(claims.email).toBe('volunteer@example.test');
    expect(claims.email_verified).toBe(true);
    expect(claims.sub).toBe('112233445566778899');
    expect(calls).toEqual([GOOGLE_JWKS_URL]);
  });

  it('rejects a token signed by a different key', async () => {
    const verifier = verifierWith(async () => jwksResponse([primary.publicJwk]));
    // Same key id in the header, but signed with another private key.
    await expect(verifier.verify(await signToken(jwtClaims(), other.privateKey, SIGNING_KEY_ID))).rejects.toThrow(/signature is invalid/);
  });

  it('rejects tampered claims even when the signature block is genuine', async () => {
    const verifier = verifierWith(async () => jwksResponse([primary.publicJwk]));
    const token = await signToken(jwtClaims(), primary.privateKey, SIGNING_KEY_ID);
    const [header, , signature] = token.split('.');
    const tampered = `${header}.${base64UrlEncodeJson(jwtClaims({ email: 'attacker@example.test' }))}.${signature}`;
    await expect(verifier.verify(tampered)).rejects.toThrow(/signature is invalid/);
  });

  it('refuses an unsigned or non-RSA algorithm without fetching keys', async () => {
    const { fetchImpl, calls } = jwksFetch(() => [primary.publicJwk]);
    const verifier = verifierWith(fetchImpl);
    const unsigned = `${base64UrlEncodeJson({ alg: 'none', typ: 'JWT' })}.${base64UrlEncodeJson(jwtClaims())}.`;
    await expect(verifier.verify(unsigned)).rejects.toThrow(/algorithm is not accepted/);
    const hmac = `${base64UrlEncodeJson({ alg: 'HS256', typ: 'JWT' })}.${base64UrlEncodeJson(jwtClaims())}.${base64UrlEncodeJson('sig')}`;
    await expect(verifier.verify(hmac)).rejects.toThrow(/algorithm is not accepted/);
    expect(calls).toEqual([]);
  });

  it('rejects expired, future-issued, wrongly-addressed and unverified tokens', async () => {
    const verifier = verifierWith(async () => jwksResponse([primary.publicJwk]));
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['expired', jwtClaims({ exp: 1_699_999_000 }), /expired/],
      ['future iat', jwtClaims({ iat: 1_700_009_000 }), /issued in the future/],
      ['wrong audience', jwtClaims({ aud: 'someone-else.apps.googleusercontent.com' }), /audience is invalid/],
      ['wrong issuer', jwtClaims({ iss: 'https://evil.example.test' }), /issuer is invalid/],
      ['email not verified', jwtClaims({ email_verified: false }), /not verified/],
      ['email_verified absent', jwtClaims({ email_verified: undefined }), /not verified/],
      ['missing subject', jwtClaims({ sub: '' }), /not a valid JWT|claim shape/]
    ];
    for (const [label, claims, expected] of cases) {
      await expect(verifier.verify(await signToken(claims, primary.privateKey, SIGNING_KEY_ID)), label).rejects.toThrow(expected);
    }
  });

  it('rejects malformed credentials without treating them as valid', async () => {
    const verifier = verifierWith(async () => jwksResponse([primary.publicJwk]));
    for (const token of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', '!!.!!.!!', `${base64UrlEncodeJson({ typ: 'JWT' })}.e30.sig`]) {
      await expect(verifier.verify(token), token).rejects.toThrow();
    }
  });

  it('survives key rotation by reloading once for an unknown key id', async () => {
    let served = [primary.publicJwk];
    const { fetchImpl } = jwksFetch(() => served);
    const keys = createGoogleKeyStore({ fetch: fetchImpl, nowMs: () => NOW, minReloadIntervalMs: 0 });
    const verifier = createGoogleIdTokenVerifier({ audience: AUDIENCE, nowMs: () => NOW, keys });

    expect((await verifier.verify(await signToken(jwtClaims(), primary.privateKey, SIGNING_KEY_ID))).sub).toBe('112233445566778899');
    // Rotation: the new key appears only on the second fetch.
    served = [rotated.publicJwk];
    expect((await verifier.verify(await signToken(jwtClaims(), rotated.privateKey, ROTATED_KEY_ID))).sub).toBe('112233445566778899');
    expect(keys.stats()).toMatchObject({ loads: 2, rotationReloads: 1 });
  });

  it('bounds how often an unknown key id can force a key-set reload', async () => {
    let now = NOW;
    const { fetchImpl, calls } = jwksFetch(() => [primary.publicJwk]);
    const keys = createGoogleKeyStore({ fetch: fetchImpl, nowMs: () => now, minReloadIntervalMs: 5_000 });
    const verifier = createGoogleIdTokenVerifier({ audience: AUDIENCE, nowMs: () => now, keys });
    const forged = await signToken(jwtClaims(), other.privateKey, 'forged-key-id');

    // Warm the cache with a real key, then present the forged key id.
    await keys.verificationKeys(SIGNING_KEY_ID);
    await expect(verifier.verify(forged)).rejects.toThrow(/unknown key/);
    await expect(verifier.verify(forged)).rejects.toThrow(/unknown key/);
    expect(calls).toHaveLength(1);
    expect(keys.stats()).toMatchObject({ loads: 1, rotationReloads: 0 });

    // Once the window has passed, one reload is attempted — and only one.
    now += 6_000;
    await expect(verifier.verify(forged)).rejects.toThrow(/unknown key/);
    await expect(verifier.verify(forged)).rejects.toThrow(/unknown key/);
    expect(calls).toHaveLength(2);
    expect(keys.stats()).toMatchObject({ loads: 2, rotationReloads: 1 });
  });

  it('expires the cached key set and reloads after the lifetime', async () => {
    let now = NOW;
    const { fetchImpl } = jwksFetch(() => [primary.publicJwk]);
    const keys = createGoogleKeyStore({ fetch: fetchImpl, nowMs: () => now, ttlSeconds: 60, minReloadIntervalMs: 0 });
    await keys.verificationKeys(SIGNING_KEY_ID);
    await keys.verificationKeys(SIGNING_KEY_ID);
    expect(keys.stats().loads).toBe(1);
    now += 61_000;
    await keys.verificationKeys(SIGNING_KEY_ID);
    expect(keys.stats().loads).toBe(2);
  });

  it('honours cache-control max-age and never exceeds its own ceiling', async () => {
    let now = NOW;
    const fetchImpl: FetchLike = async () => jwksResponse([primary.publicJwk], { 'Cache-Control': 'public, max-age=10' });
    const keys = createGoogleKeyStore({ fetch: fetchImpl, nowMs: () => now, ttlSeconds: 3600, minReloadIntervalMs: 0 });
    await keys.verificationKeys(SIGNING_KEY_ID);
    now += 11_000;
    await keys.verificationKeys(SIGNING_KEY_ID);
    expect(keys.stats().loads).toBe(2);

    const capped = createGoogleKeyStore({ fetch: async () => jwksResponse([primary.publicJwk], { 'Cache-Control': 'max-age=99999' }), nowMs: () => now, ttlSeconds: 60 });
    await capped.verificationKeys(SIGNING_KEY_ID);
    now += 61_000;
    await capped.verificationKeys(SIGNING_KEY_ID);
    expect(capped.stats().loads).toBe(2);
  });

  it('reports a key-set failure without leaking the response body', async () => {
    const failing: FetchLike[] = [
      async () => { throw new Error('socket hang up'); },
      async () => new Response('{"error":"secret-detail"}', { status: 500 }),
      async () => new Response('not json', { status: 200 }),
      async () => new Response(JSON.stringify({ keys: [] }), { status: 200 }),
      async () => new Response(JSON.stringify({ keys: [{ kid: 'x', use: 'enc', kty: 'RSA' }] }), { status: 200 })
    ];
    for (const fetchImpl of failing) {
      const keys = createGoogleKeyStore({ fetch: fetchImpl, nowMs: () => NOW });
      await expect(keys.verificationKeys('anything')).rejects.toThrow(SigningKeyError);
      await expect(keys.verificationKeys('anything')).rejects.not.toThrow(/secret-detail/);
    }
  });

  it('decodes a JOSE header only from a structurally valid token', () => {
    expect(decodeJoseHeader(`${base64UrlEncodeJson({ alg: 'RS256', kid: 'abc' })}.e30.sig`)).toEqual({ alg: 'RS256', kid: 'abc' });
    for (const bad of ['a', 'a.b', 'a.b.c.d', 'e30.e30.sig', 'x.y.z']) expect(() => decodeJoseHeader(bad), bad).toThrow();
  });
});

describe('service-account access tokens', () => {
  type Exchange = { assertion: string };

  function tokenEndpoint(options: { status?: number; body?: unknown; verify?: boolean } = {}) {
    const seen: Exchange[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      if (String(input) !== GOOGLE_TOKEN_ENDPOINT) throw new Error(`unexpected url ${String(input)}`);
      const body = new URLSearchParams(String(init?.body));
      const assertion = body.get('assertion') ?? '';
      seen.push({ assertion });
      if (options.status !== undefined && options.status >= 400) return new Response('{"error":"invalid_grant"}', { status: options.status });
      if (options.verify === true) {
        const [header, payload, signature] = assertion.split('.');
        if (!header || !payload || !signature) throw new Error('assertion is not a compact JWS');
        const key = await crypto.subtle.importKey('jwk', primary.publicJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(signature.length / 4) * 4, '=')), (character) => character.charCodeAt(0));
        if (!(await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, bytes, new TextEncoder().encode(`${header}.${payload}`)))) {
          throw new Error('assertion signature did not verify');
        }
      }
      return new Response(JSON.stringify(options.body ?? { access_token: 'token-value', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return { fetchImpl, seen };
  }

  async function provider(fetchImpl: FetchLike, nowMs: () => number = () => NOW, extra: Record<string, unknown> = {}) {
    return createServiceAccountTokenProvider({
      clientEmail: CLIENT_EMAIL,
      privateKeyPem: await pkcs8Pem(primary.privateKey),
      fetch: fetchImpl,
      nowMs,
      ...extra
    });
  }

  function decodeAssertion(assertion: string): Record<string, unknown> {
    const payload = assertion.split('.')[1] ?? '';
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='))) as Record<string, unknown>;
  }

  it('signs a verifiable assertion and returns the access token', async () => {
    const { fetchImpl, seen } = tokenEndpoint({ verify: true });
    const tokens = await provider(fetchImpl);
    expect(await tokens.accessToken(SHEETS_READONLY_SCOPE)).toBe('token-value');
    expect(seen).toHaveLength(1);
    const claims = decodeAssertion(seen[0]!.assertion);
    expect(claims).toMatchObject({ iss: CLIENT_EMAIL, scope: SHEETS_READONLY_SCOPE, aud: GOOGLE_TOKEN_ENDPOINT });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600);
  });

  it('caches one token per scope and refreshes before expiry', async () => {
    let now = NOW;
    const { fetchImpl } = tokenEndpoint({ body: { access_token: 'token-value', expires_in: 3600 } });
    const tokens = await provider(fetchImpl, () => now, { refreshSkewSeconds: 60 });
    await tokens.accessToken(SHEETS_READONLY_SCOPE);
    await tokens.accessToken(SHEETS_READONLY_SCOPE);
    expect(tokens.stats()).toEqual({ exchanges: 1, cacheHits: 1 });
    // Inside the refresh skew the cached token is considered spent.
    now += 3600_000 - 30_000;
    await tokens.accessToken(SHEETS_READONLY_SCOPE);
    expect(tokens.stats()).toEqual({ exchanges: 2, cacheHits: 1 });
  });

  it('performs one exchange for concurrent callers', async () => {
    const { fetchImpl } = tokenEndpoint({ body: { access_token: 'token-value', expires_in: 3600 } });
    const tokens = await provider(fetchImpl);
    const results = await Promise.all([tokens.accessToken(SHEETS_READONLY_SCOPE), tokens.accessToken(SHEETS_READONLY_SCOPE), tokens.accessToken(SHEETS_READONLY_SCOPE)]);
    expect(results).toEqual(['token-value', 'token-value', 'token-value']);
    expect(tokens.stats().exchanges).toBe(1);
  });

  it('keeps distinct scopes separate and bounds the cache', async () => {
    const { fetchImpl } = tokenEndpoint({ body: { access_token: 'token-value', expires_in: 3600 } });
    const tokens = await provider(fetchImpl, () => NOW, { maxCachedScopes: 2 });
    await tokens.accessToken('scope-a');
    await tokens.accessToken('scope-b');
    await tokens.accessToken('scope-c');
    await tokens.accessToken('scope-a');
    expect(tokens.stats()).toEqual({ exchanges: 4, cacheHits: 0 });
  });

  it('never exceeds its own token lifetime ceiling', async () => {
    let now = NOW;
    const { fetchImpl } = tokenEndpoint({ body: { access_token: 'token-value', expires_in: 99999 } });
    const tokens = await provider(fetchImpl, () => now, { maxTokenTtlSeconds: 600, refreshSkewSeconds: 0 });
    await tokens.accessToken(SHEETS_READONLY_SCOPE);
    now += 599_000;
    await tokens.accessToken(SHEETS_READONLY_SCOPE);
    expect(tokens.stats().exchanges).toBe(1);
    now += 2_000;
    await tokens.accessToken(SHEETS_READONLY_SCOPE);
    expect(tokens.stats().exchanges).toBe(2);
  });

  it('reports exchange failures without echoing request material', async () => {
    const { fetchImpl } = tokenEndpoint({ status: 400 });
    const tokens = await provider(fetchImpl);
    const error = await tokens.accessToken(SHEETS_READONLY_SCOPE).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ServiceAccountTokenError);
    expect((error as ServiceAccountTokenError).status).toBe(400);
    expect((error as Error).message).not.toContain('assertion');
    expect((error as Error).message).not.toContain('invalid_grant');

    const unreachable = await provider(async () => { throw new Error('dns failure: token-value'); });
    await expect(unreachable.accessToken(SHEETS_READONLY_SCOPE)).rejects.toThrow(/could not be reached/);

    for (const body of [{}, { access_token: '' }, { access_token: 42 }]) {
      const malformed = await provider(tokenEndpoint({ body }).fetchImpl);
      await expect(malformed.accessToken(SHEETS_READONLY_SCOPE)).rejects.toThrow(/no access token/);
    }
    const notJson = await provider(async () => new Response('<html>nope</html>', { status: 200 }));
    await expect(notJson.accessToken(SHEETS_READONLY_SCOPE)).rejects.toThrow(/malformed token response/);
    await expect((await provider(async () => new Response('{}', { status: 200 }))).accessToken('')).rejects.toThrow(/scope is required/);
  });

  it('refuses a private key that is not a usable PKCS#8 PEM without echoing it', async () => {
    for (const pem of ['not a pem', '-----BEGIN PRIVATE KEY-----\nnot base64!!\n-----END PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----']) {
      const tokens = createServiceAccountTokenProvider({ clientEmail: CLIENT_EMAIL, privateKeyPem: pem, fetch: tokenEndpoint().fetchImpl, nowMs: () => NOW });
      const error = await tokens.accessToken(SHEETS_READONLY_SCOPE).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('not base64!!');
      expect((error as Error).message).not.toContain('AAAA');
    }
  });
});

describe('assembled Google dependencies', () => {
  function decodePayload(compact: string): Record<string, unknown> {
    const payload = compact.split('.')[1] ?? '';
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='))) as Record<string, unknown>;
  }

  it('serves ID-token verification and the service-account exchange from one injected fetch', async () => {
    const urls: string[] = [];
    let assertionClaims: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url === GOOGLE_JWKS_URL) return jwksResponse([primary.publicJwk]);
      if (url !== GOOGLE_TOKEN_ENDPOINT) throw new Error(`unexpected url ${url}`);
      const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? '';
      assertionClaims = decodePayload(assertion);
      return new Response(JSON.stringify({ access_token: 'sa-token', expires_in: 3600 }), { status: 200 });
    };
    const dependencies = createGoogleDependencies(
      { audience: AUDIENCE, clientEmail: CLIENT_EMAIL, privateKeyPem: await pkcs8Pem(primary.privateKey) },
      { fetch: fetchImpl, nowMs: () => NOW }
    );

    // The browser credential and the server credential are separate flows that
    // must not share a cache or an endpoint.
    const claims = await dependencies.verifier.verify(await signToken(jwtClaims(), primary.privateKey, SIGNING_KEY_ID));
    expect(claims.email).toBe('volunteer@example.test');
    expect(await dependencies.sheetsTokens.accessToken(SHEETS_READONLY_SCOPE)).toBe('sa-token');
    expect(urls).toEqual([GOOGLE_JWKS_URL, GOOGLE_TOKEN_ENDPOINT]);
    expect(assertionClaims).toMatchObject({ iss: CLIENT_EMAIL, scope: SHEETS_READONLY_SCOPE });
  });
});

describe('key store concurrency and edge cases', () => {
  const NOW_MS = NOW;
  const fetchCounter = (keys: () => JsonWebKey[]) => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input: string) => {
      calls.push(String(input));
      return jwksResponse(keys());
    };
    return { fetchImpl, calls };
  };

  it('shares one load between concurrent callers on a cold cache', async () => {
    const { fetchImpl, calls } = fetchCounter(() => [primary.publicJwk]);
    const keys = createGoogleKeyStore({ fetch: fetchImpl, nowMs: () => NOW_MS, minReloadIntervalMs: 0 });
    await Promise.all(Array.from({ length: 10 }, () => keys.verificationKeys(SIGNING_KEY_ID)));
    expect(calls).toHaveLength(1);
    expect(keys.stats().loads).toBe(1);
  });

  it('performs at most one rotation reload for concurrent unknown key ids', async () => {
    let now = NOW_MS;
    const { fetchImpl, calls } = fetchCounter(() => [primary.publicJwk]);
    const keys = createGoogleKeyStore({ fetch: fetchImpl, nowMs: () => now, minReloadIntervalMs: 5_000 });
    await keys.verificationKeys(SIGNING_KEY_ID);
    expect(calls).toHaveLength(1);
    now += 6_000;
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => keys.verificationKeys('forged-key-id')));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    // One reload attempt for the whole burst, not one per request.
    expect(calls).toHaveLength(2);
    expect(keys.stats()).toMatchObject({ loads: 2, rotationReloads: 1 });
  });

  it('verifies a token without a key id against every retained key and skips unusable entries', async () => {
    const unusable: TestJwk = { kty: 'RSA', n: 'AQAB', e: 'AQAB', kid: 'unusable', alg: 'RS256', use: 'sig' };
    const keys = createGoogleKeyStore({ fetch: async () => jwksResponse([unusable, rotated.publicJwk, primary.publicJwk]), nowMs: () => NOW_MS, minReloadIntervalMs: 0 });
    const candidates = await keys.verificationKeys(undefined);
    // The unusable entry is dropped rather than denying the whole key set.
    expect(candidates).toHaveLength(2);
    const verifier = createGoogleIdTokenVerifier({ audience: AUDIENCE, nowMs: () => NOW_MS, keys });
    const token = `${base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlEncodeJson(jwtClaims())}`;
    const signed = `${token}.${await signRs256(token, primary.privateKey)}`;
    expect((await verifier.verify(signed)).email).toBe('volunteer@example.test');
  });

  it('stops accepting a retired key once the cached key set expires, and not before', async () => {
    let now = NOW_MS;
    let served = [primary.publicJwk];
    const { fetchImpl } = fetchCounter(() => served);
    const keys = createGoogleKeyStore({ fetch: fetchImpl, nowMs: () => now, ttlSeconds: 60, minReloadIntervalMs: 0 });
    const verifier = createGoogleIdTokenVerifier({ audience: AUDIENCE, nowMs: () => now, keys });
    const retired = await signToken(jwtClaims(), primary.privateKey, SIGNING_KEY_ID);
    expect((await verifier.verify(retired)).sub).toBe('112233445566778899');

    // Google publishes an overlapping set without the retired key, but the cache
    // is still inside its lifetime: this is the documented cost of caching, and
    // the reason the lifetime is capped at an hour.
    served = [rotated.publicJwk, other.publicJwk];
    expect((await verifier.verify(retired)).sub).toBe('112233445566778899');

    // Once the cache expires the retired key is gone for good.
    now += 61_000;
    await expect(verifier.verify(retired)).rejects.toThrow(/unknown key/);
    expect((await verifier.verify(await signToken(jwtClaims(), rotated.privateKey, ROTATED_KEY_ID))).sub).toBe('112233445566778899');
  });
});

describe('token lifetime edge cases', () => {
  function providerWith(body: unknown, nowMs: () => number) {
    return createServiceAccountTokenProvider({
      clientEmail: CLIENT_EMAIL,
      privateKeyPem: PEM_FOR_TESTS,
      fetch: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      nowMs
    });
  }

  it('refuses a token Google has already declared dead instead of caching it for an hour', async () => {
    for (const body of [{ access_token: 'tok', expires_in: 0 }, { access_token: 'tok', expires_in: -5 }, { access_token: 'tok', expires_in: 'nonsense' }]) {
      const tokens = providerWith(body, () => NOW);
      await expect(tokens.accessToken(SHEETS_READONLY_SCOPE)).rejects.toThrow(/invalid token lifetime/);
      expect(tokens.stats().exchanges).toBe(0);
    }
  });

  it('treats a missing lifetime as short-lived rather than as an hour', async () => {
    let exchanges = 0;
    const tokens = createServiceAccountTokenProvider({
      clientEmail: CLIENT_EMAIL,
      privateKeyPem: PEM_FOR_TESTS,
      fetch: async () => {
        exchanges += 1;
        return new Response(JSON.stringify({ access_token: `tok-${exchanges}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
      nowMs: () => NOW
    });
    expect(await tokens.accessToken(SHEETS_READONLY_SCOPE)).toBe('tok-1');
    expect(await tokens.accessToken(SHEETS_READONLY_SCOPE)).toBe('tok-2');
    expect(exchanges).toBe(2);
  });
});
