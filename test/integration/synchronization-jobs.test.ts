import { readFile } from 'node:fs/promises';
import { applySql } from '../helpers/database';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { dispatchResponse } from '../../src/worker/api/dispatch';
import { testConfig } from '../../src/worker/config';
import { makeSynchronizationJobs, SynchronizationJobs, type SyncMessage } from '../../src/worker/synchronizationJobs';
import { readJob, saveStage } from '../../src/worker/repositories/synchronizationJobs';
import { createApplication, type Application } from '../helpers/application';

const apps: Application[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.dispose())); });
const source = (start = '10:00') => JSON.stringify({ participants: [{ id: 'alex-source', name: 'Alex', email: 'alex@example.test', availability: [[1, start, '12:00']] }] });
async function runtime() {
  const app = await createApplication(); apps.push(app);
  const messages: SyncMessage[] = [];
  let html = source(), now = new Date('2026-10-04T12:00:00.000Z'), transportFails = false;
  const queue = { send: async (message: SyncMessage) => { if (transportFails) throw new Error('Synthetic delivery failure'); messages.push(message); } };
  const jobs = makeSynchronizationJobs({ db: app.db, config: testConfig, queue, now: () => now, fetchSource: async () => html });
  let sequence = 0;
  async function request(operation = 'admin.sync.now', credential = 'admin', key = `intent-${++sequence}`) {
    const body = await Effect.runPromise(dispatchResponse({ operation, credential, payload: {}, expectedRevision: (await app.read()).dataRevision,
      idempotencyKey: key }, testConfig).pipe(Effect.provide(app.layer), Effect.provideService(SynchronizationJobs, jobs)));
    return JSON.parse(body);
  }
  async function drain() { for (let n = 0; messages.length; n++) { if (n > 30) throw new Error('Queue did not settle'); await jobs.consume(messages.shift()!); } }
  async function until(phase: string) { while (messages[0]?.phase !== phase) { if (!messages.length) throw new Error('Missing stage'); await jobs.consume(messages.shift()!); } }
  return { app, jobs, messages, request, drain, until, setHtml: (value: string) => { html = value; }, setNow: (value: string) => { now = new Date(value); app.setNow(value); }, setTransportFails: (value: boolean) => { transportFails = value; } };
}

describe('durable queued synchronization through authenticated API and real local D1', () => {
  it('adds and reapplies the job migration without modifying the existing roster or staged imports', async () => {
    const r = await runtime(); expect((await r.app.request('admin.import.whenIsGood.preview')).ok).toBe(true);
    const before = await r.app.read();
    await r.app.db.batch(['synchronization_artifacts','synchronization_outbox','synchronization_jobs'].map(table => r.app.db.prepare(`DROP TABLE ${table}`)));
    const migration = await readFile(new URL('../../migrations/0003_synchronization_jobs.sql', import.meta.url), 'utf8');
    await applySql(r.app.db, migration); await applySql(r.app.db, migration);
    expect(await r.app.read()).toEqual(before);
    await r.request(); await r.drain();
    expect((await r.app.read()).imports.some(row => row.id === before.imports[0]!.id)).toBe(true);
    expect(await r.jobs.latest()).toMatchObject({ state: 'succeeded' });
  });
  it('authorizes once, returns a durable intent, applies only at commit, and replays without duplicate history', async () => {
    const r = await runtime();
    expect(await r.request('admin.sync.now', 'volunteer')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(r.messages).toHaveLength(0);
    const accepted = await r.request('admin.sync.now', 'admin', 'same');
    expect(accepted).toMatchObject({ ok: true, data: { job: { state: 'queued' }, dataRevision: 0 } });
    await r.until('commit');
    expect((await r.app.read()).imports).toHaveLength(0);
    const commit = r.messages[0]!;
    await r.drain(); await r.jobs.consume(commit);
    expect((await r.app.read()).imports).toHaveLength(1);
    expect((await r.app.read()).recurringAvailability.filter(row => row.volunteerId === 'volunteer-1')).toMatchObject([{ start: '10:00', end: '12:00' }]);
    expect(await r.request('admin.sync.now', 'admin', 'same')).toEqual(accepted);
    expect(r.messages).toHaveLength(0);
    expect(await r.request('admin.sync.read')).toMatchObject({ data: { job: { state: 'succeeded' }, status: { outcome: 'changed' } } });
  });
  it('skips storing and parsing unchanged HTML and preserves revisions/history', async () => {
    const r = await runtime(); await r.request(); await r.drain(); const before = await r.app.read();
    expect(before.synchronizedSourceHash).toContain('America/New_York:');
    expect(before.synchronizedDataRevision).toBe(before.dataRevision);
    r.setNow('2026-10-04T12:05:00.000Z'); await r.request();
    await r.jobs.consume(r.messages.shift()!);
    expect(r.messages[0]?.phase).toBe('prepare');
    expect(await r.app.db.prepare("SELECT COUNT(*) AS count FROM synchronization_artifacts WHERE kind='source'").first()).toMatchObject({ count: 0 });
    await r.drain(); const after = await r.app.read();
    expect(after.dataRevision).toBe(before.dataRevision); expect(after.schedulingInputRevision).toBe(before.schedulingInputRevision);
    expect(after.imports).toEqual(before.imports); expect(after.importedAvailability).toEqual(before.importedAvailability);
    expect(after.synchronizations[0]).toMatchObject({ outcome: 'unchanged', lastSuccessAt: '2026-10-04T12:05:00.000Z' });
  });
  it('records administrator revocation before preparation as terminal failure', async () => {
    const r = await runtime(); await r.request(); await r.until('reconcile');
    await r.app.db.prepare("UPDATE users SET active=0 WHERE id='user-admin'").run();
    await r.drain();
    expect(await r.jobs.latest()).toMatchObject({ state: 'failed', diagnostic: expect.stringContaining('administrator') });
    expect((await r.app.read()).imports).toHaveLength(0);
  });
  it('rechecks administrator authority in the final transaction', async () => {
    const r = await runtime(); await r.request(); await r.until('commit');
    await r.app.db.prepare("UPDATE users SET roles='[]' WHERE id='user-admin'").run();
    await r.drain();
    expect(await r.jobs.latest()).toMatchObject({ state: 'failed' });
    expect((await r.app.read()).imports).toHaveLength(0);
  });
  it('recalculates after a human write without losing dated exceptions', async () => {
    const r = await runtime(); await r.request(); await r.until('commit');
    const changed = await r.app.request('volunteer.availability.exception.create', { date: '2026-10-06', kind: 'unavailable', start: '10:00', end: '11:00', timeZone: 'America/New_York', reason: 'Preserve me' }, 'volunteer');
    expect(changed.ok).toBe(true); const before = await r.app.read();
    await r.drain(); const after = await r.app.read();
    expect(after.availabilityExceptions).toEqual(before.availabilityExceptions); expect(after.imports).toHaveLength(1);
    expect(await r.jobs.latest()).toMatchObject({ state: 'succeeded' });
  });
  it('a newer check finishing first supersedes an older queued source snapshot', async () => {
    const r = await runtime(); await r.request(); await r.until('reconcile'); const older = r.messages.shift()!;
    r.setNow('2026-10-04T12:01:00.000Z'); r.setHtml(source('11:00')); await r.request(); await r.drain();
    await r.jobs.consume(older); await r.drain(); const state = await r.app.read();
    expect(state.imports).toHaveLength(1);
    expect(state.recurringAvailability.find(row => row.volunteerId === 'volunteer-1')?.start).toBe('11:00');
  });
  it('retains an accepted job when enqueue fails and recovers its outbox', async () => {
    const r = await runtime(); r.setTransportFails(true);
    expect(await r.request()).toMatchObject({ ok: true, data: { job: { state: 'queued' } } });
    r.setTransportFails(false); r.setNow('2026-10-04T12:06:00.000Z'); await r.jobs.consume({ jobId: 'maintenance', phase: 'recover', version: 0 }); await r.drain();
    expect(await r.jobs.latest()).toMatchObject({ state: 'succeeded' });
  });
  it('redelivers the next durable stage after sending failed following a committed transition', async () => {
    const r = await runtime(); await r.request(); const fetch = r.messages.shift()!;
    r.setTransportFails(true); await expect(r.jobs.consume(fetch)).rejects.toThrow('Synthetic delivery failure');
    expect(await r.jobs.latest()).toMatchObject({ state: 'running' });
    r.setTransportFails(false); await r.jobs.consume(fetch); await r.drain();
    expect((await r.app.read()).imports).toHaveLength(1); expect(await r.jobs.latest()).toMatchObject({ state: 'succeeded' });
  });
  it('dead-letters only the failed stage version and cleans private artifacts', async () => {
    const r = await runtime(); await r.request(); const first = r.messages[0]!; await r.until('commit');
    await r.jobs.deadLetter(first); expect(await r.jobs.latest()).toMatchObject({ state: 'running' });
    await r.jobs.deadLetter(r.messages.shift()!);
    expect(await r.jobs.latest()).toMatchObject({ state: 'failed' });
    expect(await r.app.db.prepare('SELECT COUNT(*) AS count FROM synchronization_artifacts').first()).toMatchObject({ count: 0 });
    expect((await r.app.read()).imports).toHaveLength(0);
  });
  it('reuses an expired intent key after terminal-job and replay retention expires', async () => {
    const r = await runtime(); await r.request('admin.sync.now', 'admin', 'expires'); await r.drain();
    r.setNow('2026-10-05T12:00:01.000Z');
    expect(await r.request('admin.sync.now', 'admin', 'expires')).toMatchObject({ ok: true, data: { job: { state: 'queued' } } });
    await r.drain(); expect(await r.jobs.latest()).toMatchObject({ state: 'succeeded' });
  });
  it('expires stalled jobs after one hour without applying prepared changes', async () => {
    const r = await runtime(); await r.request(); await r.until('commit'); const stale = r.messages.shift()!;
    r.setNow('2026-10-04T13:01:00.000Z'); await r.jobs.consume({ jobId: 'maintenance', phase: 'recover', version: 0 });
    await r.jobs.consume(stale);
    expect(await r.jobs.latest()).toMatchObject({ state: 'failed', diagnostic: expect.stringContaining('expired') });
    expect((await r.app.read()).imports).toHaveLength(0);
  });
  it('rolls back every availability/history write after a final transaction failure, then safely retries', async () => {
    const r = await runtime(); await r.request(); await r.until('commit'); const commit = r.messages.shift()!;
    await r.app.db.prepare("CREATE TRIGGER synthetic_failure BEFORE INSERT ON imports BEGIN SELECT RAISE(ABORT, 'Synthetic failure'); END").run();
    const before = await r.app.read();
    await expect(r.jobs.consume(commit)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(await r.app.read()).toEqual(before); expect(await r.jobs.latest()).toMatchObject({ state: 'running' });
    await r.app.db.prepare('DROP TRIGGER synthetic_failure').run();
    await r.jobs.consume(commit); await r.drain(); await r.jobs.consume(commit);
    expect((await r.app.read()).imports).toHaveLength(1); expect(await r.jobs.latest()).toMatchObject({ state: 'succeeded' });
  });
  it('fences a stage whose job was removed between reading and committing', async () => {
    const r = await runtime(); await r.request(); await r.until('commit'); const message = r.messages.shift()!;
    const job = (await readJob(r.app.db, message.jobId))!;
    await r.app.db.prepare('DELETE FROM synchronization_jobs WHERE id=?').bind(job.id).run();
    await expect(saveStage(r.app.db, job, 'done', '2026-10-04T12:01:00Z', undefined,
      [{ sql: "UPDATE volunteers SET name='Must not change'", values: [] }])).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect((await r.app.read()).volunteers.some(row => row.name === 'Must not change')).toBe(false);
  });
  it('processes competing deliveries without applying duplicate history', async () => {
    const r = await runtime(); await r.request(); const message = r.messages.shift()!;
    await Promise.all([r.jobs.consume(message), r.jobs.consume(message)]); await r.drain();
    expect((await r.app.read()).imports).toHaveLength(1); expect(await r.jobs.latest()).toMatchObject({ state: 'succeeded' });
  });
  it('reconciles the cached source after a human edit between fetch and preparation', async () => {
    const r = await runtime(); await r.request(); await r.drain(); await r.request(); await r.until('prepare');
    await r.app.request('volunteer.availability.recurring.update', { intervals: [{ weekday: 2, start: '13:00', end: '14:00', timeZone: 'America/New_York' }] }, 'volunteer');
    await r.drain();
    expect((await r.app.read()).recurringAvailability.filter(row => row.volunteerId === 'volunteer-1')).toMatchObject([{ weekday: 1, start: '10:00', end: '12:00' }]);
  });
  it('rejects a malformed source without changing the last good availability', async () => {
    const r = await runtime(); await r.request(); await r.drain(); const before = await r.app.read();
    r.setHtml('<html>broken source</html>'); await r.request(); await r.drain(); const after = await r.app.read();
    expect(after.recurringAvailability).toEqual(before.recurringAvailability); expect(after.imports).toEqual(before.imports);
    expect(after.synchronizations[0]?.outcome).toBe('failed'); expect(await r.jobs.latest()).toMatchObject({ state: 'failed' });
  });
  it('stores a full 2 MiB source snapshot across bounded rows and preserves Unicode', async () => {
    const r = await runtime(); const html = source().replace('"Alex"', '"Alex 😀"');
    const snapshot = html + ' '.repeat(2 * 1024 * 1024 - new TextEncoder().encode(html).byteLength);
    r.setHtml(snapshot);
    await r.request(); await r.jobs.consume(r.messages.shift()!);
    const rows = await r.app.db.prepare("SELECT body FROM synchronization_artifacts WHERE kind='source' ORDER BY part").all<{ body: string }>();
    expect(rows.results.map(row => row.body).join('')).toBe(snapshot);
    expect(rows.results.every(row => row.body.length <= 16384)).toBe(true);
    await r.drain(); expect((await r.app.read()).imports).toHaveLength(1);
  });

});
