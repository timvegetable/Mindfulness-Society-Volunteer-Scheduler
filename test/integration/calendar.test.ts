import { afterEach, describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { Bindings } from '../../src/worker/runtime/live';
import { createApplication, addPublishedFixture, type Application } from '../helpers/application';

const apps: Application[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.dispose())); });

async function setup() {
  const app = await createApplication({ instant: '2026-10-04T12:00:00.000Z' });
  apps.push(app);
  await addPublishedFixture(app);
  await app.db.prepare("UPDATE sessions SET date='2099-10-05' WHERE id='session-1'").run();
  const env: Bindings = {
    DB: app.db,
    ASSETS: { fetch: async () => new Response('static asset'), connect() { throw new Error('Synthetic assets do not support sockets'); } },
    SYNC_QUEUE: { send: async () => {} }, SYNC_DEAD_LETTER_QUEUE: 'synthetic-dead',
    TIME_ZONE: 'America/New_York', DISPLAY_INCREMENT_MINUTES: '30', OPERATING_HOURS_START: '09:00', OPERATING_HOURS_END: '21:00',
    OAUTH_CLIENT_ID: 'unused', ADMIN_EMAILS: '', EMAIL_FROM: 'unused@example.test',
  };
  let sequence = 0;
  async function call(operation: string, actor = 'volunteer') {
    const { dataRevision } = await app.read();
    const raw = { operation, payload: {}, credential: actor,
      ...(operation.endsWith('.read') ? {} : { expectedRevision: dataRevision, idempotencyKey: `calendar-${++sequence}` }) };
    return JSON.parse(await app.rawRequest(raw)) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };
  }
  const fetchFeed = (token: string, method = 'GET') => worker.fetch(new Request(`https://scheduler.test/calendar/${token}.ics`, { method }), env);
  return { app, call, fetchFeed };
}

describe('personal calendar subscription', () => {
  it('lets only the linked volunteer retrieve a durable personal link', async () => {
    const { app, call, fetchFeed } = await setup();
    expect(await app.request('volunteer.dashboard', {}, 'volunteer')).toMatchObject({ ok: true, data: { calendarEnabled: false } });
    expect(await call('volunteer.calendar.enable')).toMatchObject({ ok: true, data: { enabled: true } });
    expect(await app.request('volunteer.dashboard', {}, 'volunteer')).toMatchObject({ ok: true, data: { calendarEnabled: true } });
    const owner = await call('volunteer.calendar.read');
    expect(owner).toMatchObject({ ok: true, data: { enabled: true } });
    const token = owner.data?.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await fetchFeed('x'.repeat(42))).status).toBe(404);
    expect((await fetchFeed(String(token), 'POST')).status).toBe(405);

    const response = await fetchFeed(String(token));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/calendar');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const feed = await response.text();
    expect(feed).toContain('SUMMARY:North Center');
    expect(feed).not.toContain('Alex Example');
    expect(feed).not.toContain('Blair Example');
    const stored = await app.db.prepare("SELECT token_hash, token_ciphertext, token_iv FROM calendar_subscriptions WHERE volunteer_id='volunteer-1'").first<{ token_hash: string; token_ciphertext: string; token_iv: string }>();
    expect(stored).toBeTruthy();
    expect(stored!.token_hash).not.toBe(token);
    expect(stored!.token_ciphertext).not.toBe(token);
    expect(stored!.token_iv).not.toBe(token);

    const otherVolunteer = await call('volunteer.calendar.read', 'multi');
    expect(otherVolunteer).toMatchObject({ ok: true, data: { enabled: false, token: null } });
    expect((await call('volunteer.calendar.read', 'contact')).error?.code).toBe('FORBIDDEN');
    expect(JSON.stringify(await app.request('session.me', {}, 'volunteer'))).not.toContain(token);
    const dashboard = await app.request('volunteer.dashboard', {}, 'volunteer');
    expect(JSON.stringify(dashboard)).not.toContain(token);
    expect(dashboard).toMatchObject({ ok: true, data: { calendarEnabled: true } });
  });

  it('returns no assignment data for a revoked link or a deactivated volunteer account', async () => {
    const { app, call, fetchFeed } = await setup();
    await call('volunteer.calendar.enable');
    const oldToken = String((await call('volunteer.calendar.read')).data?.token);
    expect(await call('volunteer.calendar.reset')).toMatchObject({ ok: true, data: { enabled: true } });
    const token = String((await call('volunteer.calendar.read')).data?.token);
    expect(token).not.toBe(oldToken);
    expect((await fetchFeed(oldToken)).status).toBe(404);
    expect((await fetchFeed(token)).status).toBe(200);

    expect(await call('volunteer.calendar.disable')).toMatchObject({ ok: true, data: { enabled: false } });
    expect(await app.request('volunteer.dashboard', {}, 'volunteer')).toMatchObject({ ok: true, data: { calendarEnabled: false } });
    const revoked = await fetchFeed(token);
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).not.toContain('North Example Center');

    await call('volunteer.calendar.enable');
    const secondToken = String((await call('volunteer.calendar.read')).data?.token);
    await app.db.prepare("UPDATE users SET active=0 WHERE id='user-volunteer'").run();
    const inactive = await fetchFeed(secondToken);
    expect(inactive.status).toBe(404);
    expect(await inactive.text()).not.toContain('North Example Center');
  });
});
