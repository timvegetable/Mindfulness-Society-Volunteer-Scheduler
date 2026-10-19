import { afterEach, describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { resultSchemas } from '../../src/shared/api/schemas';
import { readSchedule } from '../../src/worker/scheduleRead/reader';
import { makeReadTickets } from '../../src/worker/scheduleRead/tickets';
import { executeCommit, prepareScheduleBackfill } from '../../src/worker/repositories/database';
import { createApplication, addPublishedFixture, success, type Application } from '../helpers/application';

const secret = 'ab'.repeat(32);
const envConfig = { SCHEDULE_READ_MODE: 'enabled' as const, SCHEDULE_READ_KEY: secret,
  SCHEDULE_READ_AUDIENCE: 'synthetic', OAUTH_CLIENT_ID: 'client' };
const tickets = makeReadTickets({ secret, audience: 'synthetic:client' });
const applications: Application[] = [];
const applicationReadTime = Date.parse('2026-10-04T12:00:00.000Z');
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.dispose())); });
async function application(published = true) {
  const app = await createApplication({ scheduleReads: true }); applications.push(app);
  if (published) await addPublishedFixture(app);
  await executeCommit(app.db, await prepareScheduleBackfill(app.db));
  return app;
}
async function read(app: Application, credential?: string, readAt = credential ? Date.now() : applicationReadTime) {
  credential ??= (await tickets.issue({ id: 'user-admin', email: 'admin@example.test' }, Math.floor(readAt / 1000) + 3600, readAt)).credential;
  const response = await readSchedule(new Request('https://app.invalid/api/schedule', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'admin.schedule.read', credential, payload: {} }) }), { ...envConfig, DB: app.db }, readAt);
  const body = await response.json();
  return { response, body };
}
async function view(app: Application, readAt = applicationReadTime) {
  const { response, body } = await read(app, undefined, readAt); expect(response.status).toBe(200);
  const parsed = Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Literal(true), data: resultSchemas['admin.schedule.read'] }))(body);
  return parsed.data;
}

describe('prepared schedule public read workflow', () => {
  it('applies the current cutoff to older prepared output as time passes', async () => {
    const app = await application();
    await app.db.batch([
      app.db.prepare("UPDATE sessions SET date='2026-10-04',start_time='08:01',end_time='08:30' WHERE id='session-1'"),
      app.db.prepare("INSERT INTO sessions (id,kind,center_id,title,date,start_time,end_time,time_zone,required_staff_count,status) VALUES ('prepared-boundary','center','center-1','Boundary','2026-10-04','08:00','08:30','America/New_York',1,'locked')"),
      app.db.prepare("INSERT INTO assignments (id,session_id,volunteer_id,schedule_revision,status) VALUES ('prepared-boundary-assignment','prepared-boundary','volunteer-2',1,'assigned')"),
    ]);
    await executeCommit(app.db, await prepareScheduleBackfill(app.db));
    const beforeStart = await view(app, Date.parse('2026-10-04T12:00:00.000Z'));
    expect(beforeStart.sessions.map(session => session.id)).toEqual(['session-1']);
    expect(beforeStart.assignments.map(assignment => assignment.id)).toEqual(['assignment-1']);

    const atStart = Date.parse('2026-10-04T12:01:00.000Z');
    app.setNow(new Date(atStart).toISOString());
    const prepared = await view(app, atStart);
    const ordinary = success(await app.request('admin.schedule.read'));
    expect(prepared).toEqual(ordinary);
    expect(prepared.sessions).toEqual([]);
    expect(prepared.assignments).toEqual([]);
    expect((await app.read()).sessions).toHaveLength(2);
    expect((await app.read()).assignments).toHaveLength(2);
  });

  it('matches the existing response, preserves live revisions/stale metadata, and reuses core bytes for availability changes', async () => {
    const app = await application();
    expect(await view(app)).toEqual(success(await app.request('admin.schedule.read')));
    const originalParts = await app.db.prepare('SELECT * FROM schedule_read_parts ORDER BY part').all();
    success(await app.request('volunteer.availability.recurring.update', { intervals: [] }, 'volunteer'));
    const changed = await view(app);
    expect(changed).toEqual(success(await app.request('admin.schedule.read'))); expect(changed.stale).toBe(true);
    expect((await app.db.prepare('SELECT * FROM schedule_read_parts ORDER BY part').all()).results).toEqual(originalParts.results);
    app.setHtml(JSON.stringify({ participants: [{ id: 'p1', name: 'Alex', email: 'alex@example.test', availability: [[1, '10:00', '12:00']] }] }));
    success(await app.request('admin.sync.now'));
    expect(await view(app)).toEqual(success(await app.request('admin.schedule.read')));
    expect((await app.db.prepare('SELECT * FROM schedule_read_parts ORDER BY part').all()).results).toEqual(originalParts.results);
  });
  it('returns the current referenced center name outside the prepared session records', async () => {
    const app = await application();
    const before = await view(app);
    const originalParts = await app.db.prepare('SELECT * FROM schedule_read_parts ORDER BY part').all();
    expect(before.centers).toContainEqual({ id: 'center-1', name: 'North Center' });
    expect(JSON.stringify(originalParts.results)).not.toContain('centers');
    await app.db.prepare("UPDATE centers SET name='Renamed North Center' WHERE id='center-1'").run();

    const refreshed = await view(app);
    expect(refreshed.centers).toContainEqual({ id: 'center-1', name: 'Renamed North Center' });
    expect(refreshed.sessions.find(session => session.id === 'session-1')?.title).toBe('North mindfulness');
    expect((await app.db.prepare('SELECT title FROM sessions WHERE id=?').bind('session-1').first<{ title: string }>())?.title).toBe('North mindfulness');
    expect((await app.db.prepare('SELECT * FROM schedule_read_parts ORDER BY part').all()).results).toEqual(originalParts.results);
    expect(refreshed).toEqual(success(await app.request('admin.schedule.read')));
  });
  it.each([
    ['Schedule change 😀', 'Schedule change 😀'],
    ['Lone high \ud800', 'Lone high �'],
    ['Lone low \udc00', 'Lone low �'],
    ['Existing ���', 'Existing ���'],
  ])('atomically updates cancellation and publication with stored reason %j', async (reason, storedReason) => {
    const app = await application();
    const metadata = { expectedRevision: 0, idempotencyKey: 'cancel-once' };
    const result = success(await app.request('volunteer.assignment.cancel', { assignmentId: 'assignment-1', reason }, 'volunteer', metadata));
    expect(result.promotedAssignment).not.toBeNull();
    const cancelled = await view(app); expect(cancelled).toEqual(success(await app.request('admin.schedule.read')));
    expect(cancelled.assignments.find(row => row.id === 'assignment-1')?.cancellationReason).toBe(storedReason);
    expect(await app.request('volunteer.assignment.cancel', { assignmentId: 'assignment-1', reason }, 'volunteer', metadata)).toEqual({ ok: true, data: result });
    expect(await view(app)).toEqual(cancelled);
    success(await app.request('admin.schedule.rerun'));
    const published = await view(app); expect(published).toEqual(success(await app.request('admin.schedule.read')));
    expect(published.run!.outputRevision).toBeGreaterThan(cancelled.run!.outputRevision); expect(published.stale).toBe(false);
  });
  it('includes a confirmed dated session immediately', async () => {
    const app = await application();
    success(await app.request('admin.center.candidate.confirm', { candidateId: 'candidate-1' }));
    const prepared = await view(app); expect(prepared).toEqual(success(await app.request('admin.schedule.read')));
    expect(prepared.sessions.some(row => row.sourceCandidateId === 'candidate-1')).toBe(true);
  });
  it('keeps empty schedules, equal-revision tie selection and legacy shortfalls equivalent', async () => {
    const app = await application(false);
    expect((await view(app)).run).toBeNull();
    await app.db.batch(['a','z'].map(id => app.db.prepare(`INSERT INTO scheduling_runs(id,input_revision,output_revision,status,assignment_ids,backup_ids,shortfalls)
      VALUES (?,0,4,'completed','[]','[]','[{"sessionId":"session-1","required":1,"assigned":0,"unfilled":1}]')`).bind(id)));
    await executeCommit(app.db, await prepareScheduleBackfill(app.db));
    const prepared = await view(app); expect(prepared).toEqual(success(await app.request('admin.schedule.read')));
    expect(prepared.run?.id).toBe('a'); expect(prepared.shortfalls[0]?.missing).toBe(1);
  });
  it('rejects stale/corrupt representations and restores a valid one only through a fenced backfill', async () => {
    const app = await application();
    await app.db.prepare("UPDATE volunteers SET name='Changed' WHERE id='volunteer-1'").run();
    expect((await read(app)).response.status).toBe(500);
    const stalePlan = await prepareScheduleBackfill(app.db);
    await app.db.prepare("UPDATE volunteers SET name='Changed again' WHERE id='volunteer-1'").run();
    await expect(executeCommit(app.db, stalePlan)).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await executeCommit(app.db, await prepareScheduleBackfill(app.db)); expect((await view(app)).volunteers[0]?.name).toBe('Changed again');
    await app.db.prepare("UPDATE schedule_read_parts SET body=body||' ' WHERE part=0").run();
    expect((await read(app)).response.status).toBe(500);
    await executeCommit(app.db, await prepareScheduleBackfill(app.db));
    await app.db.prepare('UPDATE schedule_read_manifest SET input_revision=12').run();
    expect((await read(app)).response.status).toBe(500);
  });
  it('rolls back domain changes when prepared storage fails', async () => {
    const app = await application(); const before = await app.read(); const prepared = await view(app);
    await app.db.prepare(`CREATE TRIGGER reject_prepared BEFORE INSERT ON schedule_read_parts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`).run();
    expect(await app.request('admin.schedule.rerun')).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(await app.read()).toEqual(before); expect(await view(app)).toEqual(prepared);
  });
  it('checks revocation, deactivation, replacement IDs and malformed stored roles on every read with the same ticket', async () => {
    const app = await application();
    const { credential } = await tickets.issue({ id: 'user-admin', email: 'admin@example.test' }, Math.floor(Date.now()/1000)+3600, Date.now());
    await app.db.prepare("UPDATE users SET center_ids=NULL WHERE id='user-admin'").run();
    expect((await read(app, credential)).response.status).toBe(200);
    await app.db.prepare("UPDATE users SET roles='[]' WHERE id='user-admin'").run();
    expect((await read(app, credential)).response.status).toBe(403);
    await app.db.prepare("UPDATE users SET roles='\"administrator\"' WHERE id='user-admin'").run();
    expect((await read(app, credential)).response.status).toBe(500);
    await app.db.prepare("UPDATE users SET roles='[\"administrator\"]',active=0 WHERE id='user-admin'").run();
    expect((await read(app, credential)).response.status).toBe(401);
    await app.db.prepare("UPDATE users SET active=1,id='replacement-admin' WHERE id='user-admin'").run();
    expect((await read(app, credential)).response.status).toBe(401);
  });
  it('keeps the winning publication and prepared representation consistent under concurrent writes', async () => {
    const app = await application();
    const results = await Promise.all(['one','two'].map(key => app.request('admin.schedule.rerun', {}, 'admin',
      { expectedRevision: 0, idempotencyKey: `concurrent-${key}` })));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toMatchObject([{ ok: false, error: { code: 'STALE_REVISION' } }]);
    expect(await view(app)).toEqual(success(await app.request('admin.schedule.read')));
    expect((await app.read()).schedulingRuns).toHaveLength(2);
  });

  it('chunks large Unicode responses without truncation or broken surrogate pairs', async () => {
    const app = await application();
    await app.db.batch(Array.from({ length: 50 }, (_, i) => app.db.prepare("INSERT INTO volunteers(id,name,email,lifecycle_status,interview_status) VALUES (?,?,?,'active','complete')")
      .bind(`large-${i}`, 'Volunteer 😀 漢'.repeat(400), `large-${i}@example.test`)));
    await executeCommit(app.db, await prepareScheduleBackfill(app.db));
    expect(await view(app)).toEqual(success(await app.request('admin.schedule.read')));
    const sizes = await app.db.prepare('SELECT MAX(length(body)) AS maximum,COUNT(*) AS parts FROM schedule_read_parts').first<{ maximum: number; parts: number }>();
    expect(sizes!.maximum).toBeLessThanOrEqual(16384); expect(sizes!.parts).toBeGreaterThan(16);
  });
});
