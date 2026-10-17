import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeReadTickets, makeReadSessionTickets } from '../../src/worker/scheduleRead/tickets';

const secret = '17'.repeat(32), now = Date.parse('2026-10-17T20:00:00Z');
const options = { secret, audience: 'synthetic:client' };
const user = { id: 'account', email: ' ADMIN@example.test ' };
function signed(claims: Record<string, unknown>) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `r1.${payload}.${createHmac('sha256', Buffer.from(secret, 'hex')).update(`r1.${payload}`).digest('base64url')}`;
}
const claims = { iss: 'umd-scheduler-read-v1', aud: options.audience, purpose: 'admin.schedule.read', sub: 'account',
  email: 'admin@example.test', iat: now / 1000, exp: now / 1000 + 600 };
describe('schedule read ticket boundary', () => {
  it('binds normalized account identity and clamps expiry to both Google expiry and fifteen minutes', async () => {
    const tickets = makeReadTickets(options);
    const short = await tickets.issue(user, now / 1000 + 60, now);
    expect(short.expiresAt).toBe(now + 60000);
    expect(await tickets.verify(short.credential, now)).toEqual({ accountId: 'account', email: 'admin@example.test', expiresAt: short.expiresAt });
    const long = await tickets.issue(user, now / 1000 + 3600, now);
    expect(long.expiresAt).toBe(now + 900000);
    await expect(tickets.verify(short.credential, short.expiresAt)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(tickets.issue(user, now / 1000, now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('rejects tampered, malformed, oversized and differently scoped tokens', async () => {
    const tickets = makeReadTickets(options); const issued = await tickets.issue(user, now / 1000 + 600, now);
    const parts = issued.credential.split('.'); parts[2] = (parts[2]![0] === 'a' ? 'b' : 'a') + parts[2]!.slice(1);
    for (const bad of ['', 'r1.x.y', issued.credential + '.extra', issued.credential.replace(/^r1/,'r2'), parts.join('.'), 'r1.'+'x'.repeat(8192)]) {
      await expect(tickets.verify(bad, now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    await expect(makeReadTickets({ ...options, audience: 'other:client' }).verify(issued.credential, now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it.each([{ iss: 'other' }, { aud: 'other' }, { purpose: 'admin.schedule.rerun' }, { sub: '' }, { email: ' ADMIN@example.test ' },
    { iat: now / 1000 + 1 }, { exp: now / 1000 }, { exp: now / 1000 + 901 }, { exp: 1.5 }, { iat: 'invalid' }, { extra: true }])('rejects signed malformed claims %j', async change => {
    await expect(makeReadTickets(options).verify(signed({ ...claims, ...change }), now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('accepts a previous key only within an explicitly bounded rotation window', async () => {
    const old = await makeReadTickets(options).issue(user, now / 1000 + 600, now);
    const rotated = makeReadTickets({ secret: '29'.repeat(32), audience: options.audience,
      previousSecret: secret, previousFrom: now + 1000, previousUntil: now + 120000 });
    await expect(rotated.verify(old.credential, now)).rejects.toThrow();
    expect((await rotated.verify(old.credential, now + 1000)).accountId).toBe(user.id);
    await expect(rotated.verify(old.credential, now + 120000)).rejects.toThrow();
    expect(() => makeReadTickets({ ...options, previousSecret: secret, previousFrom: now, previousUntil: now + 901000 })).toThrow();
    expect(() => makeReadTickets({ ...options, secret: 'short' })).toThrow();
  });
});


it('isolates general read sessions from legacy schedule tickets and binds expiry/environment', async () => {
  const sessions = makeReadSessionTickets(options), schedules = makeReadTickets(options);
  const session = await sessions.issue(user, now / 1000 + 60, now);
  const schedule = await schedules.issue(user, now / 1000 + 600, now);
  expect(session.credential).toMatch(/^r2\./);
  expect(await sessions.verify(session.credential, now)).toMatchObject({ accountId: user.id, email: 'admin@example.test', expiresAt: now + 60000 });
  await expect(sessions.verify(schedule.credential, now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(schedules.verify(session.credential, now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(sessions.verify(session.credential, now + 60000)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(makeReadSessionTickets({ ...options, audience: 'other:client' }).verify(session.credential, now)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});
