import { Effect } from 'effect';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeReadSessionAuth } from '../../src/worker/services/ReadSessionAuth';
import { makeGoogleAuth } from '../../src/worker/services/AuthService';
const now = Date.parse('2026-10-04T12:00:00Z');
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: string;
beforeAll(async () => {
  pair = await generateKeyPair('RS256');
  jwks = JSON.stringify({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }] });
});
async function token(overrides: Record<string, unknown> = {}, signingPair = pair) {
  return new SignJWT({ email: ' ALICE@example.test ', email_verified: true, iss: 'https://accounts.google.com', aud: 'test-client', exp: now / 1000 + 600, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(signingPair.privateKey);
}
describe('Google authentication', () => {
  it('verifies signature and normalized email and reuses fresh JWKS', async () => {
    let calls = 0;
    const auth = makeGoogleAuth({ audience: 'test-client', now: () => now, fetch: async () => { calls++; return new Response(jwks, { headers: { 'Cache-Control': 'public, max-age=600' } }); } });
    const credential = await token();
    expect(await Effect.runPromise(auth.verify(credential))).toEqual({ email: 'alice@example.test', expiresAt: now / 1000 + 600 });
    await Effect.runPromise(auth.verify(credential));
    expect(calls).toBe(1);
  });
  it.each([
    { iss: 'https://attacker.example' }, { aud: 'other-client' }, { exp: now / 1000 - 1 }, { exp: undefined }, { email_verified: false }, { email_verified: 'true' }, { email: 'invalid' },
  ])('rejects invalid claims %j', async overrides => {
    const auth = makeGoogleAuth({ audience: 'test-client', now: () => now, fetch: async () => new Response(jwks) });
    const exit = await Effect.runPromise(Effect.result(auth.verify(await token(overrides))));
    expect(exit._tag).toBe('Failure');
  });
  it('rejects malformed tokens and forged signatures', async () => {
    const auth = makeGoogleAuth({ audience: 'test-client', now: () => now, fetch: async () => new Response(jwks) });
    await expect(Effect.runPromise(auth.verify('not-a-jwt'))).rejects.toThrow();
    await expect(Effect.runPromise(auth.verify(await token({}, await generateKeyPair('RS256'))))).rejects.toThrow();
  });
  it('refreshes stale keys using HTTP age and shares in-flight fetches', async () => {
    let current = now;
    let calls = 0;
    const auth = makeGoogleAuth({ audience: 'test-client', now: () => current, fetch: async () => { calls++; return new Response(jwks, { headers: { 'Cache-Control': 'max-age=600', Age: '590' } }); } });
    const credential = await token();
    await Promise.all([Effect.runPromise(auth.verify(credential)), Effect.runPromise(auth.verify(credential))]);
    expect(calls).toBe(1);
    current += 11_000;
    await Effect.runPromise(auth.verify(credential));
    expect(calls).toBe(2);
  });
  it('retries after a signing-key fetch failure', async () => {
    let calls = 0;
    const auth = makeGoogleAuth({ audience: 'test-client', now: () => now, fetch: async () => ++calls === 1 ? new Response('', { status: 503 }) : new Response(jwks) });
    const credential = await token();
    await expect(Effect.runPromise(auth.verify(credential))).rejects.toThrow();
    expect(await Effect.runPromise(auth.verify(credential))).toEqual({ email: 'alice@example.test', expiresAt: now / 1000 + 600 });
  });
});


describe('private read-session authentication boundary', () => {
  it('requires a verified account ID and performs verification for each request', async () => {
    let calls = 0;
    const identity = { accountId: 'account', email: 'admin@example.test', expiresAt: Math.floor(Date.now()/1000)+60 };
    const auth = makeReadSessionAuth({ fetch: async () => { calls++; return Response.json({ ok: true, kind: 'api.read', identity }); } });
    expect(await Effect.runPromise(auth.verify('r2.ticket'))).toEqual(identity);
    expect(await Effect.runPromise(auth.verify('r2.ticket'))).toEqual(identity);
    expect(calls).toBe(2);
  });
  it('rejects unavailable, malformed and expired verification results without trusting partial identity', async () => {
    for (const identity of [{ email: 'admin@example.test', expiresAt: Math.floor(Date.now()/1000)+60 },
      { accountId: '', email: 'admin@example.test', expiresAt: Math.floor(Date.now()/1000)+60 },
      { accountId: 'account', email: ' ADMIN@example.test ', expiresAt: Math.floor(Date.now()/1000)+60 },
      { accountId: 'account', email: 'admin@example.test', expiresAt: 0 }]) {
      const auth = makeReadSessionAuth({ fetch: async () => Response.json({ ok: true, kind: 'api.read', identity }) });
      await expect(Effect.runPromise(auth.verify('r2.ticket'))).rejects.toThrow('invalid response');
    }
    await expect(Effect.runPromise(makeReadSessionAuth({ fetch: async () => new Response('', { status: 401 }) }).verify('r2.bad'))).rejects.toThrow('expired or is invalid');
    await expect(Effect.runPromise(makeReadSessionAuth({ fetch: async () => { throw Error('network'); } }).verify('r2.ticket'))).rejects.toThrow('temporarily unavailable');
  });
});
