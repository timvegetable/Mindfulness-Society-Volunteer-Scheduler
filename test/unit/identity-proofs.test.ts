import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { makeIdentityProofs } from '../../src/worker/scheduleRead/proofs';
import { makeReadTickets, makeReadSessionTickets } from '../../src/worker/scheduleRead/tickets';
const now = Date.parse('2026-10-17T20:00:00Z');
const options = { secret: '17'.repeat(32), audience: 'synthetic:client' };
const identity = { email: 'admin@example.test', expiresAt: now / 1000 + 3600 };
function signed(overrides: Record<string, unknown>) {
  const payload = Buffer.from(JSON.stringify({ iss: 'umd-scheduler-google-proof-v1', aud: options.audience,
    purpose: 'session.exchange', email: identity.email, iat: now / 1000, exp: now / 1000 + 60, googleExp: identity.expiresAt, ...overrides })).toString('base64url');
  return `g1.${payload}.${createHmac('sha256', Buffer.from(options.secret, 'hex')).update(`g1.${payload}`).digest('base64url')}`;
}
it('limits a proof to sixty seconds while preserving the original Google expiry for a fifteen-minute read session', async () => {
  const proofs = makeIdentityProofs(options), reads = makeReadSessionTickets(options);
  const proof = await proofs.issue(identity, now);
  expect(proof.expiresAt).toBe(now + 60000);
  const verified = await proofs.verify(proof.credential, now + 59000);
  expect(verified).toEqual(identity);
  const session = await reads.issue({ id: 'current-account', email: verified.email }, verified.expiresAt, now + 59000);
  expect(session.expiresAt).toBe(now + 959000);
  await expect(proofs.verify(proof.credential, now + 60000)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  const short = await proofs.issue({ ...identity, expiresAt: now / 1000 + 10 }, now);
  expect(short.expiresAt).toBe(now + 10000);
});
it('isolates identity proofs from both read protocols and other application audiences', async () => {
  const proofs = makeIdentityProofs(options), proof = await proofs.issue(identity, now);
  for (const reads of [makeReadTickets(options), makeReadSessionTickets(options)]) {
    await expect(reads.verify(proof.credential, now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const read = await reads.issue({ id: 'account', email: identity.email }, identity.expiresAt, now);
    await expect(proofs.verify(read.credential, now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  }
  await expect(makeIdentityProofs({ ...options, audience: 'other:client' }).verify(proof.credential, now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});
it('rejects malformed, extended, future, unnormalized and incorrectly scoped signed proofs', async () => {
  const proofs = makeIdentityProofs(options), proof = await proofs.issue(identity, now);
  const cases = [signed({ purpose: 'api.read' }), signed({ iss: 'other' }), signed({ extra: 1 }), signed({ email: ' ADMIN@example.test ' }),
    signed({ exp: now / 1000 + 61 }), signed({ iat: now / 1000 + 1 }), signed({ exp: now / 1000 }), signed({ googleExp: now / 1000 + 59 }),
    signed({ googleExp: '3600' }), signed({ exp: 1.5 }), proof.credential + '.extra', proof.credential + '=', 'g1.x.y', 'x'.repeat(8193)];
  for (const credential of cases) await expect(proofs.verify(credential, now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(proofs.issue({ ...identity, expiresAt: now / 1000 }, now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(proofs.verify(proof.credential, NaN)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});
it('accepts a previous proof key only during the bounded configured rotation interval', async () => {
  const old = await makeIdentityProofs(options).issue(identity, now);
  const rotated = makeIdentityProofs({ ...options, secret: '18'.repeat(32), previousSecret: options.secret, previousFrom: now + 1000, previousUntil: now + 30000 });
  await expect(rotated.verify(old.credential, now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(await rotated.verify(old.credential, now + 1000)).toEqual(identity);
  await expect(rotated.verify(old.credential, now + 30000)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});
