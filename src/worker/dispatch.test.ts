import { beforeAll, describe, expect, it } from 'vitest';
import { INTEGRATION_OPERATIONS } from '../server/integration/request-policy.js';
import { createStagingDispatch, isolateDependencyCache } from './dispatch.js';
import { GOOGLE_JWKS_URL, base64UrlEncodeJson, createGoogleDependencies, signRs256, type FetchLike } from './google/index.js';

/**
 * The staging composition applies the shared envelope and read-only policy,
 * verifies the caller's Google ID token, and then refuses the served operations
 * because the workbook composition does not exist yet. These assertions pin that
 * boundary so a later milestone cannot quietly start serving unauthenticated
 * data. The signatures here are real; only `fetch` is a double.
 */

const NOW = 1_700_000_000_000;
const NOW_SECONDS = 1_700_000_000;
const AUDIENCE = 'staging-client.apps.googleusercontent.com';
const CLIENT_EMAIL = 'staging-reader@example-project.iam.gserviceaccount.com';
const KEY_ID = 'dispatch-test-key';

type TestJwk = JsonWebKey & { kid: string; alg?: string; use?: string };

let signingKey: CryptoKey;
let publicJwk: TestJwk;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair;
  signingKey = pair.privateKey;
  publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' } as TestJwk;
});

async function idToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const signingInput = `${base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT', kid: KEY_ID })}.${base64UrlEncodeJson({
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    sub: '112233445566778899',
    email: 'admin@example.test',
    email_verified: true,
    exp: NOW_SECONDS + 3600,
    iat: NOW_SECONDS,
    ...overrides
  })}`;
  return `${signingInput}.${await signRs256(signingInput, signingKey)}`;
}

function jwtClaimsForUnknownKid(): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    sub: '112233445566778899',
    email: 'admin@example.test',
    email_verified: true,
    exp: NOW_SECONDS + 3600,
    iat: NOW_SECONDS
  };
}

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END PRIVATE KEY-----';
const BINDINGS = {
  STAGING_OAUTH_AUDIENCE: AUDIENCE,
  GOOGLE_SERVICE_ACCOUNT_EMAIL: CLIENT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: PEM
};

function jwksFetch(keys: () => JsonWebKey[]): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (input: string) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ keys: keys() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  };
}

function envelopeRequest(operation: string, credential: string | undefined) {
  return {
    operation,
    payload: {},
    idempotencyKey: 'dispatch-probe-1',
    ...(credential === undefined ? {} : { credential })
  };
}

describe('staging dispatch seam', () => {
  const dispatch = createStagingDispatch();

  it('refuses the three served operations until authentication and workbook access are configured', async () => {
    for (const operation of [INTEGRATION_OPERATIONS.me, INTEGRATION_OPERATIONS.adminSchedule, INTEGRATION_OPERATIONS.adminInsights]) {
      const response = await dispatch(envelopeRequest(operation, 'unused-credential'));
      expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    }
  });

  it('refuses a mutating operation with the shared read-only policy', async () => {
    const response = await dispatch(envelopeRequest(INTEGRATION_OPERATIONS.adminScheduleRerun, 'unused-credential'));
    expect(response).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('rejects an unsupported request field instead of ignoring it', async () => {
    const response = await dispatch({ ...envelopeRequest(INTEGRATION_OPERATIONS.me, 'unused-credential'), spreadsheetId: 'x' });
    expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('rejects payloads that name a Sheet range or query', async () => {
    const response = await dispatch({ operation: INTEGRATION_OPERATIONS.me, payload: { range: 'A1:B2' }, idempotencyKey: 'dispatch-probe-4', credential: 'unused' });
    expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('rejects a structurally invalid envelope and an oversized one', async () => {
    expect(await dispatch({ operation: INTEGRATION_OPERATIONS.me, payload: [], idempotencyKey: 'dispatch-probe-5' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await dispatch({ operation: INTEGRATION_OPERATIONS.me, payload: {}, idempotencyKey: 'short' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await dispatch({ operation: INTEGRATION_OPERATIONS.me, payload: { filler: 'x'.repeat(70 * 1024) }, idempotencyKey: 'dispatch-probe-6' }))
      .toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(await dispatch('not an object')).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('refuses an operation that is not registered at all', async () => {
    expect(await dispatch({ operation: 'admin.anything.else', payload: {}, idempotencyKey: 'dispatch-probe-7' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });
});

describe('staging dispatch identity gate', () => {
  /** A private client cache, so one test's key set cannot leak into another's. */
  function privateCache() {
    const entries = new Map<string, ReturnType<typeof createGoogleDependencies>>();
    return { get: (key: string) => entries.get(key), set: (key: string, value: ReturnType<typeof createGoogleDependencies>) => { entries.set(key, value); } };
  }

  function dispatchWith(keys: () => JsonWebKey[]) {
    const { fetchImpl, calls } = jwksFetch(keys);
    const dispatch = createStagingDispatch(BINDINGS, { fetch: fetchImpl, nowMs: () => NOW, dependencyCache: privateCache() });
    return { dispatch, calls };
  }

  it('verifies a genuinely signed ID token against the key set before refusing', async () => {
    const { dispatch, calls } = dispatchWith(() => [publicJwk]);
    const response = await dispatch(envelopeRequest(INTEGRATION_OPERATIONS.me, await idToken()));
    // Identity succeeded; the workbook composition is what is still missing.
    expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(calls).toEqual([GOOGLE_JWKS_URL]);
  });

  it('rejects a forged, expired or wrongly-addressed token as unauthorized', async () => {
    const { dispatch } = dispatchWith(() => [publicJwk]);
    const other = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    ) as CryptoKeyPair;
    const forgedInput = `${base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT', kid: KEY_ID })}.${base64UrlEncodeJson({ iss: 'https://accounts.google.com', aud: AUDIENCE, sub: 'x', email: 'a@b.test', email_verified: true, exp: NOW_SECONDS + 60 })}`;
    const forged = `${forgedInput}.${await signRs256(forgedInput, other.privateKey)}`;

    for (const [label, credential] of [
      ['forged signature', forged],
      // Beyond the 60-second clock skew the validator allows.
      ['expired', await idToken({ exp: NOW_SECONDS - 120 })],
      ['wrong audience', await idToken({ aud: 'someone-else.apps.googleusercontent.com' })],
      ['unverified email', await idToken({ email_verified: false })]
    ] as Array<[string, string]>) {
      const response = await dispatch(envelopeRequest(INTEGRATION_OPERATIONS.me, credential));
      expect(response, label).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED', details: { reason: 'invalid' } } });
    }
  });

  it('reports a missing credential as missing rather than as a bad token', async () => {
    const { dispatch, calls } = dispatchWith(() => [publicJwk]);
    const response = await dispatch(envelopeRequest(INTEGRATION_OPERATIONS.me, undefined));
    expect(response).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED', details: { reason: 'missing' } } });
    expect(calls).toEqual([]);
  });

  it('refuses a mutation before verifying anything, so a rejected write cannot reach a handler or Google', async () => {
    const { dispatch, calls } = dispatchWith(() => [publicJwk]);
    const response = await dispatch(envelopeRequest(INTEGRATION_OPERATIONS.adminScheduleRerun, await idToken()));
    expect(response).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(calls).toEqual([]);
  });

  it('refuses to serve when identity configuration is absent or malformed', async () => {
    for (const bindings of [{}, { ...BINDINGS, STAGING_OAUTH_AUDIENCE: '' }, { ...BINDINGS, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'not-a-pem' }]) {
      const dispatch = createStagingDispatch(bindings, { nowMs: () => NOW });
      const response = await dispatch(envelopeRequest(INTEGRATION_OPERATIONS.me, await idToken()));
      expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    }
  });

  it('reports an identity-provider outage as unavailable rather than as a bad credential', async () => {
    for (const fetchImpl of [
      (async () => { throw new Error('network down'); }) as FetchLike,
      (async () => new Response('{"error":"boom"}', { status: 500 })) as FetchLike,
      (async () => new Response('{"error":"quota"}', { status: 429 })) as FetchLike,
      (async () => new Response(JSON.stringify({ keys: [] }), { status: 200 })) as FetchLike
    ]) {
      const dispatch = createStagingDispatch(BINDINGS, { fetch: fetchImpl, nowMs: () => NOW, dependencyCache: privateCache() });
      const response = await dispatch(envelopeRequest(INTEGRATION_OPERATIONS.me, await idToken()));
      // A client must not be told to re-authenticate because Google is down.
      expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
      expect(JSON.stringify(response)).not.toContain('boom');
      expect(JSON.stringify(response)).not.toContain('500');
    }
  });

  it('reuses one assembled key store across requests instead of refetching per request', async () => {
    const { fetchImpl, calls } = jwksFetch(() => [publicJwk]);
    const bindings = { ...BINDINGS, STAGING_OAUTH_AUDIENCE: 'cache-test.apps.googleusercontent.com' };
    const token = await idToken({ aud: bindings.STAGING_OAUTH_AUDIENCE });
    // A dispatcher per request, exactly as the entry point builds it, sharing the
    // isolate-scoped cache the deployed Worker uses.
    for (let request = 0; request < 3; request += 1) {
      const dispatch = createStagingDispatch(bindings, { fetch: fetchImpl, nowMs: () => NOW, dependencyCache: isolateDependencyCache });
      await dispatch(envelopeRequest(INTEGRATION_OPERATIONS.me, token));
    }
    expect(calls).toEqual([GOOGLE_JWKS_URL]);
  });

  it('keeps a separate cache entry per identity configuration', async () => {
    const { fetchImpl, calls } = jwksFetch(() => [publicJwk]);
    const first = { ...BINDINGS, STAGING_OAUTH_AUDIENCE: 'config-one.apps.googleusercontent.com' };
    const second = { ...BINDINGS, STAGING_OAUTH_AUDIENCE: 'config-two.apps.googleusercontent.com' };
    const cache = privateCache();
    await createStagingDispatch(first, { fetch: fetchImpl, nowMs: () => NOW, dependencyCache: cache })(envelopeRequest(INTEGRATION_OPERATIONS.me, await idToken({ aud: first.STAGING_OAUTH_AUDIENCE })));
    await createStagingDispatch(second, { fetch: fetchImpl, nowMs: () => NOW, dependencyCache: cache })(envelopeRequest(INTEGRATION_OPERATIONS.me, await idToken({ aud: second.STAGING_OAUTH_AUDIENCE })));
    // Each configuration builds its own clients, so neither can verify the
    // other's audience.
    expect(calls).toEqual([GOOGLE_JWKS_URL, GOOGLE_JWKS_URL]);
    const wrongAudience = await createStagingDispatch(second, { fetch: fetchImpl, nowMs: () => NOW, dependencyCache: cache })(
      envelopeRequest(INTEGRATION_OPERATIONS.me, await idToken({ aud: first.STAGING_OAUTH_AUDIENCE }))
    );
    expect(wrongAudience).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('classifies an unknown key id as a bad credential, not as an outage', async () => {
    const { dispatch } = dispatchWith(() => [publicJwk]);
    const unknownKid = `${base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT', kid: 'retired-key' })}.${base64UrlEncodeJson(jwtClaimsForUnknownKid())}`;
    const response = await dispatch(envelopeRequest(INTEGRATION_OPERATIONS.me, `${unknownKid}.${await signRs256(unknownKid, signingKey)}`));
    // A client must re-authenticate rather than retry against a service it is
    // told is merely unavailable.
    expect(response).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED', details: { reason: 'invalid' } } });
  });

  it('bounds retries while the key endpoint is failing instead of fetching once per request', async () => {
    let attempts = 0;
    const failing: FetchLike = async () => {
      attempts += 1;
      throw new Error('key endpoint down');
    };
    const cache = privateCache();
    const dispatch = createStagingDispatch(BINDINGS, { fetch: failing, nowMs: () => NOW, dependencyCache: cache });
    const token = await idToken();
    for (let request = 0; request < 5; request += 1) {
      const response = await dispatch(envelopeRequest(INTEGRATION_OPERATIONS.me, token));
      expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    }
    // One attempt for the window, not one per request.
    expect(attempts).toBe(1);
  });

  it('never echoes the submitted credential in a rejection', async () => {
    const { dispatch } = dispatchWith(() => [publicJwk]);
    const marker = 'SUPERSECRET-CREDENTIAL-MARKER';
    for (const credential of [marker, `${marker}.${marker}.${marker}`, `e30.${marker}.${marker}`]) {
      const response = await dispatch(envelopeRequest(INTEGRATION_OPERATIONS.me, credential));
      expect(response).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
      expect(JSON.stringify(response)).not.toContain(marker);
    }
  });
});
