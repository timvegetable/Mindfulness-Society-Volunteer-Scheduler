import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import type { Bindings } from '../../src/worker/runtime/live';
import { MAX_IMPORT_BYTES } from '../../src/worker/services/WhenIsGoodClient';
import { createApplication, success, type Application } from '../helpers/application';

const apps: Application[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(apps.splice(0).map(app => app.dispose())); });
const source = JSON.stringify({ participants: [{ id: 'alex-source', name: 'Alex', email: 'alex@example.test', availability: [[1, '10:00', '12:00']] }] });
async function runtime() {
  const app = await createApplication(); apps.push(app);
  const env: Bindings = { DB: app.db, ASSETS: { fetch: async () => new Response('static asset'), connect() { throw new Error('Synthetic assets do not support sockets'); } },
    TIME_ZONE: 'America/New_York', DISPLAY_INCREMENT_MINUTES: '30', OPERATING_HOURS_START: '09:00', OPERATING_HOURS_END: '21:00',
    OAUTH_CLIENT_ID: 'no-google-session', ADMIN_EMAILS: '', EMAIL_FROM: 'unused@example.test' };
  const event: ScheduledController = { cron: '*/30 * * * *', scheduledTime: Date.parse('2026-10-13T12:00:00Z'), noRetry() {} };
  return { app, env, event };
}

describe('actual Worker scheduled boundary with synthetic external services and local D1', () => {
  it('reaches the shared workflow without Google or email and deduplicates redelivered events', async () => {
    const { app, env, event } = await runtime();
    const legacyConfig = { ...env, TIME_ZONE: 'Europe/London' };
    const clientConfig = await worker.fetch(new Request('https://scheduler.test/client-config'), legacyConfig);
    expect(await clientConfig.json()).toMatchObject({ timeZone: 'America/New_York' });
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toBe('https://whenisgood.net/d7y3d5c/results/mx8t23j');
      return new Response(source);
    });
    await worker.scheduled(event, legacyConfig); await worker.scheduled(event, legacyConfig);
    const dashboard = success(await app.request('volunteer.dashboard', {}, 'volunteer'));
    expect(dashboard.recurringAvailability).toMatchObject([{ weekday: 1, start: '10:00', end: '12:00', timeZone: 'America/New_York' }]);
    const view = success(await app.request('admin.sync.read'));
    expect(view.imports).toHaveLength(1); expect(view.imports[0]?.actorId).toBe('system:whenIsGood');
    expect(view.dataRevision).toBe(1); expect(view.schedulingInputRevision).toBe(1);
  });
  it('rejects oversized streamed source responses and keeps the last valid state', async () => {
    const { app, env, event } = await runtime();
    vi.stubGlobal('fetch', async () => new Response(source)); await worker.scheduled(event, env);
    const before = await app.read();
    vi.stubGlobal('fetch', async () => new Response('x'.repeat(MAX_IMPORT_BYTES + 1)));
    await worker.scheduled({ ...event, scheduledTime: event.scheduledTime + 1_800_000 }, env);
    const view = success(await app.request('admin.sync.read'));
    expect(view.status.outcome).toBe('failed'); expect(view.status.diagnostic).toContain('size limit');
    expect((await app.read()).recurringAvailability).toEqual(before.recurringAvailability);
    expect(view.dataRevision).toBe(before.dataRevision);
  });
  it('does not expose system synchronization authority through the HTTP Worker entry', async () => {
    const { env } = await runtime();
    const response = await worker.fetch(new Request('https://scheduler.test/api', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'system.sync', payload: {}, credential: 'system:whenIsGood' }) }), env);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });
  it('synchronizes a large roster atomically within an emulated free-plan D1 query budget', async () => {
    const { app, env, event } = await runtime();
    const volunteers = Array.from({ length: 100 }, (_, i) => ({ id: `quota-v${i}`, name: `Quota Person ${i}`, email: `quota${i}@example.test` }));
    await app.db.batch(volunteers.map(person => app.db.prepare("INSERT INTO volunteers (id,name,email,lifecycle_status,interview_status,readiness_rank) VALUES (?,?,?,'active','complete',1)").bind(person.id, person.name, person.email)));
    let queries = 0;
    const charge = (count: number) => { queries += count; if (queries > 50) throw new Error('Synthetic free-plan SQL query limit'); };
    function statement(value: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(value, { get(target, key) {
        const member = Reflect.get(target, key, target);
        if (key === 'bind') return (...values: unknown[]) => statement(target.bind(...values));
        if (['first', 'all', 'run', 'raw'].includes(String(key))) return (...args: unknown[]) => { charge(1); return member.apply(target, args); };
        return typeof member === 'function' ? member.bind(target) : member;
      } });
    }
    const budgeted = new Proxy(app.db, { get(target, key) {
      const member = Reflect.get(target, key, target);
      if (key === 'prepare') return (sql: string) => statement(target.prepare(sql));
      if (key === 'batch') return (statements: D1PreparedStatement[]) => { charge(statements.length); return target.batch(statements); };
      return typeof member === 'function' ? member.bind(target) : member;
    } });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ participants: volunteers.map(person => ({ ...person,
      availability: [[1,'09:00','10:00'],[2,'09:00','10:00'],[3,'09:00','10:00'],[4,'09:00','10:00'],[5,'09:00','10:00']],
    })) })));
    await worker.scheduled(event, { ...env, DB: budgeted });
    const view = success(await app.request('admin.sync.read'));
    expect(view.status).toMatchObject({ participantCount: 100, matchedCount: 100, pendingCount: 0, outcome: 'changed' });
    expect((await app.read()).recurringAvailability.filter(row => row.volunteerId.startsWith('quota-v'))).toHaveLength(500);
    expect((await app.read()).schedulingInputRevision).toBe(1);
  });

});
