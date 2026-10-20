import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { operations, isMutation, type Operation } from '../../src/shared/api/operations';
import { applySql } from '../helpers/database';
import { createApplication, addPublishedFixture, success, interval, candidateInput, type Application } from '../helpers/application';

const apps: Application[] = [];
async function application(options: Parameters<typeof createApplication>[0] = {}) {
  const app = await createApplication(options); apps.push(app); return app;
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.dispose())); });
const payloads: Record<Operation, unknown> = {
  'admin.sync.read': {}, 'admin.sync.now': {},
  'session.me': {}, 'volunteer.dashboard': {},
  'volunteer.availability.recurring.update': { intervals: [interval] },
  'volunteer.availability.exception.create': { date: '2026-10-06', kind: 'unavailable', start: '10:00', end: '11:00', timeZone: interval.timeZone },
  'volunteer.assignment.cancel': { assignmentId: 'assignment-1' },
  'volunteer.calendar.read': {}, 'volunteer.calendar.enable': {}, 'volunteer.calendar.reset': {}, 'volunteer.calendar.disable': {},
  'admin.schedule.read': {}, 'admin.schedule.preview': {}, 'admin.schedule.rerun': {},
  'admin.import.whenIsGood.preview': {},
  'admin.import.whenIsGood.promote': {},
  'admin.import.mapping.upsert': { sourceParticipantId: 'a', volunteerId: 'volunteer-1' },
  'admin.insights.read': {}, 'center.candidate.read': {},
  'center.candidate.update': { ...candidateInput, centerId: 'center-1' },
  'admin.center.candidate.confirm': { candidateId: 'candidate-1' },
  'admin.volunteer.read': {}, 'admin.volunteer.create': { name: 'Frankie Example', email: 'frankie@example.test' },
  'admin.volunteer.update': { volunteerId: 'volunteer-3', name: 'Casey Example', email: 'casey.updated@example.test' },
  'admin.volunteer.remove': { volunteerId: 'volunteer-3' },
};
// Independent expected policy, deliberately not calculated using the implementation.
const volunteerAllowed = new Set<Operation>(['session.me', 'volunteer.dashboard', 'volunteer.availability.recurring.update', 'volunteer.availability.exception.create', 'volunteer.assignment.cancel', 'volunteer.calendar.read', 'volunteer.calendar.enable', 'volunteer.calendar.reset', 'volunteer.calendar.disable']);
const contactAllowed = new Set<Operation>(['session.me', 'center.candidate.read', 'center.candidate.update']);
const calendarOperations = new Set<Operation>(['volunteer.calendar.read', 'volunteer.calendar.enable', 'volunteer.calendar.reset', 'volunteer.calendar.disable']);
const matrix = (['volunteer', 'contact', 'admin'] as const).flatMap(actor => operations.map(operation => ({ actor, operation, allowed: actor === 'admin' ? !calendarOperations.has(operation) : (actor === 'volunteer' ? volunteerAllowed : contactAllowed).has(operation) })));

describe('every role against every public operation on local D1', () => {
  it.each(matrix)('$actor $operation allowed=$allowed', async ({ actor, operation, allowed }) => {
    const app = await application();
    await addPublishedFixture(app);
    if (operation === 'admin.import.whenIsGood.promote') success(await app.request('admin.import.whenIsGood.preview', {}));
    if (actor === 'volunteer' && (operation === 'volunteer.calendar.reset' || operation === 'volunteer.calendar.disable')) success(await app.request('volunteer.calendar.enable', {}, 'volunteer'));
    const before = await app.read();
    const result = await app.request(operation, payloads[operation], actor);
    if (allowed) expect(result.ok, JSON.stringify(result)).toBe(true);
    else { expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } }); expect(await app.read()).toEqual(before); }
  });
});

describe('authorization, revisions and durable idempotency', () => {
  it('rejects malformed stored authority without granting role or center access', async () => {
    const app = await application();
    await app.db.prepare("UPDATE users SET roles='\"administrator\"' WHERE id='user-admin'").run();
    expect(await app.request('admin.sync.read')).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    await app.db.prepare("UPDATE users SET center_ids='\"center-1 center-2\"' WHERE id='user-contact'").run();
    expect(await app.request('center.candidate.read', {}, 'contact')).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(await app.request('volunteer.dashboard', {}, 'volunteer')).toMatchObject({ ok: true });
  });

  it('rejects inactive, unknown and unverifiable identities', async () => {
    const app = await application();
    for (const credential of ['inactive', 'missing', 'invalid']) {
      expect(JSON.parse(await app.rawRequest({ operation: 'session.me', payload: {}, credential }))).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    }
  });
  it('rejects unknown operations and requires mutation metadata for every mutating operation', async () => {
    const app = await application(); const before = await app.read();
    expect(JSON.parse(await app.rawRequest({ operation: 'tables.delete', payload: {}, credential: 'admin' }))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    for (const operation of operations.filter(isMutation)) {
      expect(JSON.parse(await app.rawRequest({ operation, payload: payloads[operation], credential: 'admin' }))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    }
    expect(await app.read()).toEqual(before); expect(app.notifications).toHaveLength(0);
  });
  it('rejects invalid dates and application time-zone substitutions without writes', async () => {
    const app = await application(); const before = await app.read();
    for (const payload of [
      { date: '2026-02-30', kind: 'available', start: '10:00', end: '11:00', timeZone: interval.timeZone },
      { date: '2026-10-05', kind: 'available', start: '11:00', end: '10:00', timeZone: interval.timeZone },
      { date: '2026-10-05', kind: 'available', start: '10:00', end: '11:00', timeZone: 'Europe/London' },
    ]) expect(await app.request('volunteer.availability.exception.create', payload, 'volunteer')).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await app.read()).toEqual(before);
  });
  it('supports every surface for a caller with multiple roles', async () => {
    const app = await application();
    for (const operation of ['volunteer.dashboard', 'admin.schedule.read', 'center.candidate.read'] as const) success(await app.request(operation, {}, 'multi'));
  });
  it('returns only centers referenced by the displayed sessions at each read boundary', async () => {
    const app = await application();
    const volunteer = success(await app.request('volunteer.dashboard', {}, 'volunteer'));
    expect(volunteer.centers).toEqual([{ id: 'center-1', name: 'North Center' }]);
    const schedule = success(await app.request('admin.schedule.read', {}, 'admin'));
    expect(schedule.centers).toEqual([{ id: 'center-1', name: 'North Center' }]);
  });
  it('hides started assignments while retaining future cancelled assignment details', async () => {
    const app = await application(); await addPublishedFixture(app);
    await app.db.batch([
      app.db.prepare("UPDATE centers SET name='Opal Senior Center' WHERE id='center-1'"),
      app.db.prepare("UPDATE sessions SET title='opal-senior-center',date='2026-10-04',start_time='07:00',end_time='08:00' WHERE id='session-1'"),
      app.db.prepare("INSERT INTO sessions (id,kind,title,date,start_time,end_time,time_zone,required_staff_count,status) VALUES ('session-univ','univ100','UNIV100: Professor Ada Example (Department: Biology, Room 110, Section 0123)','2026-10-04','07:00','08:00','America/New_York',1,'confirmed')"),
      app.db.prepare("INSERT INTO sessions (id,kind,center_id,title,date,start_time,end_time,time_zone,required_staff_count,status) VALUES ('session-future','center','center-1','opal-senior-center','2026-10-05','10:00','11:00','America/New_York',1,'locked')"),
      app.db.prepare("UPDATE sessions SET status='cancelled' WHERE id='session-future'"),
      app.db.prepare("INSERT INTO assignments (id,session_id,volunteer_id,schedule_revision,status) VALUES ('assignment-future','session-future','volunteer-1',1,'assigned')"),
      app.db.prepare("INSERT INTO assignments (id,session_id,volunteer_id,schedule_revision,status) VALUES ('assignment-univ','session-univ','volunteer-1',1,'assigned')"),
    ]);

    const dashboard = success(await app.request('volunteer.dashboard', {}, 'volunteer'));
    expect(dashboard.assignments.map(row => row.id)).toEqual(['assignment-future']);
    expect(dashboard.sessions).toEqual([]);
    expect(dashboard.assignmentSessions?.map(row => row.id)).toEqual(['session-future']);
    expect(dashboard.centers).toEqual([{ id: 'center-1', name: 'Opal Senior Center' }]);
  });
  it('rejects caller-controlled volunteer IDs and only edits the authenticated volunteer', async () => {
    const app = await application(); const before = await app.read();
    expect(await app.request('volunteer.availability.recurring.update', { intervals: [interval], volunteerId: 'volunteer-2' }, 'volunteer')).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await app.read()).toEqual(before);
    const saved = success(await app.request('volunteer.availability.recurring.update', { intervals: [{ ...interval, end: '18:00' }] }, 'volunteer'));
    expect(saved.intervals.every(row => row.volunteerId === 'volunteer-1')).toBe(true);
    expect((await app.read()).recurringAvailability.filter(row => row.volunteerId === 'volunteer-2')).toEqual(before.recurringAvailability.filter(row => row.volunteerId === 'volunteer-2'));
  });
  it('scopes candidate reads, creates, edits and cancellations to authorized centers', async () => {
    const app = await application(); await addPublishedFixture(app); const before = await app.read();
    const view = success(await app.request('center.candidate.read', {}, 'contact'));
    expect(view.centers.map(row => row.id)).toEqual(['center-1']); expect(view.candidates).toHaveLength(0);
    for (const payload of [candidateInput, { candidateId: 'candidate-1', start: '13:00' }, { candidateId: 'candidate-1', status: 'cancelled' }]) {
      expect(await app.request('center.candidate.update', payload, 'contact')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    expect(await app.read()).toEqual(before);
    const created = success(await app.request('center.candidate.update', { ...candidateInput, centerId: 'center-1' }, 'contact'));
    success(await app.request('center.candidate.update', { candidateId: created.candidate.id, status: 'cancelled' }, 'contact'));
    expect((await app.read()).candidateSchedules.find(row => row.id === created.candidate.id)?.status).toBe('cancelled');
  });
  it('rejects cancellation of another volunteer assignment', async () => {
    const app = await application(); await addPublishedFixture(app);
    expect(await app.request('volunteer.assignment.cancel', { assignmentId: 'assignment-1' }, 'multi')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
  it('requires both mutation metadata fields and rejects stale revisions without writes', async () => {
    const app = await application(); const before = await app.read();
    for (const metadata of [{ expectedRevision: 0 }, { idempotencyKey: 'missing-revision' }, {}]) {
      expect(JSON.parse(await app.rawRequest({ operation: 'volunteer.availability.recurring.update', payload: { intervals: [] }, credential: 'volunteer', ...metadata }))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    }
    success(await app.request('volunteer.availability.recurring.update', { intervals: [] }, 'volunteer'));
    const changed = await app.read();
    expect(await app.request('volunteer.availability.recurring.update', { intervals: [interval] }, 'volunteer', { expectedRevision: before.dataRevision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(await app.read()).toEqual(changed);
  });
  it('replays the exact normalized response after the global revision advances and rejects changed input', async () => {
    const app = await application();
    const raw = { operation: 'volunteer.availability.recurring.update', payload: { intervals: [{ ...interval, end: '12:00' }, { ...interval, start: '12:00' }] }, credential: 'volunteer', expectedRevision: 0, idempotencyKey: 'durable' };
    const first = await app.rawRequest(raw); expect(JSON.parse(first).ok).toBe(true);
    success(await app.request('center.candidate.update', candidateInput));
    const before = await app.read();
    expect(await app.rawRequest({ ...raw, payload: { intervals: [interval] } })).toBe(first);
    expect(await app.read()).toEqual(before); expect(app.notifications).toHaveLength(1);
    expect(app.notifications[0]).toMatchObject({ subject: 'Weekly availability updated: Alex Example' });
    expect(app.notifications[0]!.text).toContain('Monday: 9:00 AM–5:00 PM (Eastern Time)');
    expect(app.notifications[0]!.text).not.toMatch(/volunteer\.availability|Data revision/);
    expect(JSON.parse(await app.rawRequest({ ...raw, payload: { intervals: [] } }))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });
  it('allows only one different request to commit at a competing revision', async () => {
    const app = await application();
    const raw = { operation: 'center.candidate.update', payload: candidateInput, credential: 'admin', expectedRevision: 0 };
    const results = (await Promise.all([app.rawRequest({ ...raw, idempotencyKey: 'a' }), app.rawRequest({ ...raw, idempotencyKey: 'b' })])).map(value => JSON.parse(value));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toMatchObject({ error: { code: 'STALE_REVISION' } });
    const state = await app.read(); expect(state.dataRevision).toBe(1); expect(state.candidateSchedules).toHaveLength(1);
  });
  it('returns the same response for concurrent identical requests and sends one email', async () => {
    const app = await application();
    const raw = { operation: 'volunteer.availability.recurring.update', payload: { intervals: [] }, credential: 'volunteer', expectedRevision: 0, idempotencyKey: 'same' };
    const results = await Promise.all([app.rawRequest(raw), app.rawRequest(raw)]);
    expect(JSON.parse(results[0]!).ok).toBe(true); expect(results[1]).toBe(results[0]);
    expect((await app.read()).dataRevision).toBe(1); expect(app.notifications).toHaveLength(1);
  });
});

describe('schedule publication and cancellation', () => {
  it('shows only sessions that start strictly after now with matching published staffing', async () => {
    const app = await application({ instant: '2026-10-04T12:00:00.000Z' }); await addPublishedFixture(app);
    await app.db.batch([
      app.db.prepare("UPDATE sessions SET date='2026-10-04',start_time='07:59',end_time='08:30' WHERE id='session-1'"),
      app.db.prepare(`INSERT INTO sessions (id,kind,center_id,title,date,start_time,end_time,time_zone,required_staff_count,status) VALUES
        ('session-boundary','center','center-1','Boundary session','2026-10-04','08:00','08:30','America/New_York',1,'locked'),
        ('session-later-today','center','center-1','Later today','2026-10-04','08:01','08:30','America/New_York',1,'locked'),
        ('session-next-day','center','center-1','Next day','2026-10-05','09:00','10:00','America/New_York',1,'locked'),
        ('session-cancelled','center','center-1','Cancelled future session','2026-10-05','11:00','12:00','America/New_York',1,'cancelled')`),
      app.db.prepare(`INSERT INTO assignments (id,session_id,volunteer_id,schedule_revision,status) VALUES
        ('boundary-assignment','session-boundary','volunteer-1',1,'assigned'),
        ('later-assignment','session-later-today','volunteer-1',1,'assigned'),
        ('next-assignment','session-next-day','volunteer-1',1,'assigned')`),
      app.db.prepare(`INSERT INTO backups (id,session_id,volunteer_id,schedule_revision,position,status) VALUES
        ('boundary-backup','session-boundary','volunteer-2',1,1,'available'),
        ('later-backup','session-later-today','volunteer-2',1,1,'available'),
        ('next-backup','session-next-day','volunteer-2',1,1,'available')`),
      app.db.prepare("UPDATE scheduling_runs SET shortfalls='[{\"sessionId\":\"session-1\",\"required\":1,\"assigned\":0,\"missing\":1},{\"sessionId\":\"session-later-today\",\"required\":1,\"assigned\":0,\"missing\":1}]' WHERE id='fixture-run'"),
    ]);

    const schedule = success(await app.request('admin.schedule.read'));
    expect(schedule.sessions.map(session => session.id).sort()).toEqual(['session-cancelled', 'session-later-today', 'session-next-day']);
    expect(schedule.sessions.find(session => session.id === 'session-cancelled')?.status).toBe('cancelled');
    expect(schedule.assignments.map(assignment => assignment.id)).toEqual(['later-assignment', 'next-assignment']);
    expect(schedule.backups.map(backup => backup.id)).toEqual(['later-backup', 'next-backup']);
    expect(schedule.shortfalls.map(shortfall => shortfall.sessionId)).toEqual(['session-later-today']);
    expect(schedule.run?.shortfalls.map(shortfall => shortfall.sessionId)).toEqual(['session-later-today']);
    expect(schedule.centers).toEqual([{ id: 'center-1', name: 'North Center' }]);
    expect((await app.read()).sessions).toHaveLength(5);
  });

  it('keeps volunteer assignments and upcoming sessions on the same strict start cutoff', async () => {
    const app = await application({ instant: '2026-10-04T12:00:00.000Z' }); await addPublishedFixture(app);
    await app.db.batch([
      app.db.prepare("UPDATE sessions SET date='2026-10-04',start_time='07:59',end_time='08:30' WHERE id='session-1'"),
      app.db.prepare(`INSERT INTO sessions (id,kind,center_id,title,date,start_time,end_time,time_zone,required_staff_count,status) VALUES
        ('session-boundary','center','center-1','Boundary session','2026-10-04','08:00','08:30','America/New_York',1,'locked'),
        ('session-later-today','center','center-1','Later today','2026-10-04','08:01','08:30','America/New_York',1,'locked'),
        ('session-next-day','center','center-1','Next day','2026-10-05','09:00','10:00','America/New_York',1,'locked')`),
      app.db.prepare(`INSERT INTO assignments (id,session_id,volunteer_id,schedule_revision,status) VALUES
        ('boundary-assignment','session-boundary','volunteer-1',1,'assigned'),
        ('later-assignment','session-later-today','volunteer-1',1,'assigned'),
        ('next-assignment','session-next-day','volunteer-1',1,'assigned')`),
    ]);

    const dashboard = success(await app.request('volunteer.dashboard', {}, 'volunteer'));
    expect(dashboard.sessions.map(session => session.id)).toEqual(['session-later-today', 'session-next-day']);
    expect(dashboard.assignments.map(assignment => assignment.id)).toEqual(['later-assignment', 'next-assignment']);
    expect(dashboard.assignmentSessions?.map(session => session.id)).toEqual(['session-later-today', 'session-next-day']);
    expect(dashboard.centers).toEqual([{ id: 'center-1', name: 'North Center' }]);
    expect((await app.read()).assignments).toHaveLength(4);
  });

  it('returns preview sessions and generated staffing from the same future instant', async () => {
    const app = await application({ instant: '2026-10-04T12:00:00.000Z' });
    await app.db.batch([
      app.db.prepare("UPDATE sessions SET date='2026-10-04',start_time='07:59',end_time='08:30' WHERE id='session-1'"),
      app.db.prepare(`INSERT INTO sessions (id,kind,center_id,title,date,start_time,end_time,time_zone,required_staff_count,status) VALUES
        ('session-boundary','center','center-1','Boundary session','2026-10-04','08:00','08:30','America/New_York',1,'locked'),
        ('session-later-today','center','center-1','Later today','2026-10-04','08:01','08:30','America/New_York',1,'locked'),
        ('session-next-day','center','center-1','Next day','2026-10-05','09:00','10:00','America/New_York',1,'locked'),
        ('session-cancelled','center','center-1','Cancelled','2026-10-05','11:00','12:00','America/New_York',1,'cancelled')`),
    ]);

    const preview = await app.request('admin.schedule.preview');
    expect(preview).toMatchObject({ ok: true, data: { sessions: [
      { id: 'session-later-today' }, { id: 'session-next-day' },
    ] } });
    if (preview.ok) expect(preview.data.output.assignments.every(row => ['session-later-today', 'session-next-day'].includes(row.sessionId))).toBe(true);
  });

  it('uses the latest completed publication across reads, continuity, insights and cancellation', async () => {
    const app = await application(); await addPublishedFixture(app);
    await app.db.batch([
      app.db.prepare("UPDATE volunteers SET readiness_rank=1 WHERE id IN ('volunteer-1','volunteer-2','volunteer-3')"),
      ...[
        { id: 'z-current', revision: 2, status: 'completed' },
        { id: 'a-current', revision: 2, status: 'completed' },
        { id: 'staged', revision: 3, status: 'staged' },
        { id: 'failed', revision: 4, status: 'failed' },
      ].map(run => app.db.prepare('INSERT INTO scheduling_runs (id,input_revision,output_revision,status) VALUES (?,0,?,?)').bind(run.id, run.revision, run.status)),
      app.db.prepare("INSERT INTO assignments (id,session_id,volunteer_id,schedule_revision,status) VALUES ('current-assignment','session-1','volunteer-2',2,'assigned'),('staged-assignment','session-1','volunteer-1',3,'assigned'),('failed-assignment','session-1','volunteer-1',4,'assigned')"),
      app.db.prepare("INSERT INTO backups (id,session_id,volunteer_id,schedule_revision,position,status) VALUES ('current-backup','session-1','volunteer-3',2,1,'available'),('staged-backup','session-1','volunteer-1',3,1,'available'),('failed-backup','session-1','volunteer-1',4,1,'available')"),
    ]);
    const before = await app.read();
    const schedule = success(await app.request('admin.schedule.read'));
    expect(schedule.run?.id).toBe('a-current');
    expect(schedule.assignments.map(row => row.id)).toEqual(['current-assignment']);
    expect(schedule.backups.map(row => row.id)).toEqual(['current-backup']);
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).assignments).toEqual([]);
    const preview = success(await app.request('admin.schedule.preview'));
    expect(preview.output.assignments.find(row => row.sessionId === 'session-1')?.volunteerId).toBe('volunteer-2');
    const insights = success(await app.request('admin.insights.read'));
    expect(insights.leftoverVolunteers.map(row => row.id)).toContain('volunteer-1');
    expect(insights.leftoverVolunteers.map(row => row.id)).not.toContain('volunteer-2');
    expect(await app.read()).toEqual(before);
    expect(await app.request('volunteer.assignment.cancel', { assignmentId: 'assignment-1' }, 'volunteer')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const cancelled = success(await app.request('volunteer.assignment.cancel', { assignmentId: 'current-assignment' }, 'multi'));
    expect(cancelled.promotedAssignment).toMatchObject({ volunteerId: 'volunteer-3', scheduleRevision: 2 });
    const after = await app.read();
    expect(after.schedulingRuns).toHaveLength(5);
    expect(after.assignments.filter(row => row.scheduleRevision !== 2)).toEqual(before.assignments.filter(row => row.scheduleRevision !== 2));
    expect(after.backups.filter(row => row.scheduleRevision !== 2)).toEqual(before.backups.filter(row => row.scheduleRevision !== 2));
  });
  it('reports an absent schedule when publications are only staged or failed', async () => {
    const app = await application(); await addPublishedFixture(app);
    await app.db.batch([
      app.db.prepare("UPDATE scheduling_runs SET status='staged'"),
      app.db.prepare("INSERT INTO scheduling_runs (id,input_revision,output_revision,status) VALUES ('failed',0,2,'failed')"),
    ]);
    const before = await app.read();
    expect(success(await app.request('admin.schedule.read'))).toMatchObject({ run: null, assignments: [], backups: [], shortfalls: [], stale: true });
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).assignments).toEqual([]);
    expect(await app.request('volunteer.assignment.cancel', { assignmentId: 'assignment-1' }, 'volunteer')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await app.read()).toEqual(before);
  });
  it('previews without writes, publishes matching output, retains history and reports stale inputs', async () => {
    const app = await application(); const before = await app.read();
    const preview = success(await app.request('admin.schedule.preview'));
    expect(await app.read()).toEqual(before); expect(await app.db.prepare('SELECT COUNT(*) AS count FROM idempotency').first()).toEqual({ count: 0 });
    const published = success(await app.request('admin.schedule.rerun'));
    expect(published.assignments.map(({ sessionId, volunteerId }) => ({ sessionId, volunteerId }))).toEqual(preview.output.assignments);
    expect(published.backups.map(({ sessionId, volunteerId, position }) => ({ sessionId, volunteerId, position }))).toEqual(preview.output.backups);
    expect(published.stale).toBe(false); expect(published.schedulingInputRevision).toBe(0);
    const rerun = success(await app.request('admin.schedule.rerun')); expect(rerun.run!.outputRevision).toBeGreaterThan(published.run!.outputRevision);
    expect((await app.read()).schedulingRuns).toHaveLength(2);
    success(await app.request('volunteer.availability.exception.create', { date: '2026-10-05', kind: 'unavailable', start: '10:00', end: '11:00', timeZone: interval.timeZone }, 'volunteer'));
    expect(success(await app.request('admin.schedule.read')).stale).toBe(true); expect(app.notifications).toHaveLength(1);
  });
  it('publishes balanced preview assignments consistently across reruns and volunteer views', async () => {
    const app = await application();
    await app.db.batch([
      app.db.prepare("UPDATE volunteers SET lifecycle_status='active', interview_status='complete', readiness_rank=1 WHERE id IN ('volunteer-1','volunteer-2','volunteer-3')"),
      ...['2026-10-12', '2026-10-19', '2026-10-26'].map((date, index) => app.db.prepare(`INSERT INTO sessions (id,kind,center_id,title,date,start_time,end_time,time_zone,required_staff_count,status)
        VALUES ('session-${index + 2}','center','center-1','North mindfulness',?,'10:00','11:00','America/New_York',1,'locked')`).bind(date)),
    ]);

    const preview = success(await app.request('admin.schedule.preview'));
    const first = success(await app.request('admin.schedule.rerun'));
    const second = success(await app.request('admin.schedule.rerun'));
    const rows = (assignments: typeof first.assignments) => assignments.map(({ sessionId, volunteerId }) => ({ sessionId, volunteerId }));
    expect(preview.output.assignments).toEqual([
      { sessionId: 'session-1', volunteerId: 'volunteer-1' }, { sessionId: 'session-2', volunteerId: 'volunteer-2' },
      { sessionId: 'session-3', volunteerId: 'volunteer-3' }, { sessionId: 'session-4', volunteerId: 'volunteer-1' },
    ]);
    expect(rows(first.assignments)).toEqual(preview.output.assignments);
    expect(rows(second.assignments)).toEqual(preview.output.assignments);
    const dashboard = success(await app.request('volunteer.dashboard', {}, 'volunteer'));
    expect(dashboard.assignments.map(({ sessionId }) => sessionId).sort()).toEqual(['session-1', 'session-4']);
  });
  it('cancels, stores the dated exception, promotes an eligible backup and reorders remaining backups', async () => {
    const app = await application(); await addPublishedFixture(app);
    const result = success(await app.request('volunteer.assignment.cancel', { assignmentId: 'assignment-1', reason: 'Away' }, 'volunteer'));
    expect(result.assignment).toMatchObject({ status: 'cancelled', cancelledAt: '2026-10-04T12:00:00.000Z', cancellationReason: 'Away' });
    expect(result.exception).toMatchObject({ volunteerId: 'volunteer-1', date: '2026-10-05', kind: 'unavailable', start: '10:00', end: '11:00' });
    expect(result.promotedAssignment?.volunteerId).toBe('volunteer-2'); expect(result.shortfall).toBeNull();
    const state = await app.read(); expect(state.backups.find(row => row.id === 'backup-2')?.status).toBe('promoted'); expect(state.backups.find(row => row.id === 'backup-3')?.position).toBe(1);
    expect(state.schedulingInputRevision).toBe(1); expect(state.dataRevision).toBe(1); expect(app.notifications).toHaveLength(1);
    expect(app.notifications[0]).toMatchObject({ subject: 'Assignment cancelled: Alex Example' });
    expect(app.notifications[0]!.text).toContain('Session: North Center');
    expect(app.notifications[0]!.text).toContain('Monday, October 5, 2026');
    expect(app.notifications[0]!.text).toContain('10:00 AM–11:00 AM (Eastern Time)');
    expect(app.notifications[0]!.text).toContain('Reason: Away');
    expect(app.notifications[0]!.text).toContain('Review the schedule for current staffing and backup coverage.');
  });
  it.each(['lifecycle', 'availability', 'exception', 'overlap'] as const)('rechecks backup %s eligibility at cancellation time', async reason => {
    const app = await application(); await addPublishedFixture(app);
    if (reason === 'lifecycle') await app.db.prepare("UPDATE volunteers SET lifecycle_status='inactive' WHERE id='volunteer-2'").run();
    if (reason === 'availability') await app.db.prepare("DELETE FROM recurring_availability WHERE volunteer_id='volunteer-2'").run();
    if (reason === 'exception') await app.db.prepare("INSERT INTO availability_exceptions (id,volunteer_id,date,kind,start_time,end_time,time_zone) VALUES ('away','volunteer-2','2026-10-05','unavailable','10:00','11:00','America/New_York')").run();
    if (reason === 'overlap') await app.db.batch([
      app.db.prepare("INSERT INTO sessions (id,kind,center_id,title,date,start_time,end_time,time_zone,status) VALUES ('overlap','center','center-2','Other','2026-10-05','10:30','11:30','America/New_York','locked')"),
      app.db.prepare("INSERT INTO assignments (id,session_id,volunteer_id,schedule_revision,status) VALUES ('other-assignment','overlap','volunteer-2',1,'assigned')"),
    ]);
    const result = success(await app.request('volunteer.assignment.cancel', { assignmentId: 'assignment-1' }, 'volunteer'));
    expect(result.promotedAssignment?.volunteerId).toBe('volunteer-3'); expect((await app.read()).backups.find(row => row.id === 'backup-2')?.status).toBe('skipped');
  });
  it('returns explicit understaffing when every backup is ineligible', async () => {
    const app = await application(); await addPublishedFixture(app);
    await app.db.prepare("UPDATE volunteers SET interview_status='incomplete' WHERE id IN ('volunteer-2','volunteer-3')").run();
    const result = success(await app.request('volunteer.assignment.cancel', { assignmentId: 'assignment-1' }, 'volunteer'));
    expect(result.promotedAssignment).toBeNull(); expect(result.shortfall).toEqual({ sessionId: 'session-1', required: 1, assigned: 0, missing: 1 });
    expect(success(await app.request('admin.schedule.read')).shortfalls).toEqual([result.shortfall]);
  });
  it('keeps mutations committed when email fails and does not repeat notification on replay', async () => {
    const app = await application({ emailFails: true });
    const metadata = { expectedRevision: 0, idempotencyKey: 'email-failure' };
    const result = success(await app.request('volunteer.availability.recurring.update', { intervals: [] }, 'volunteer', metadata));
    expect(result.dataRevision).toBe(1); expect((await app.read()).recurringAvailability.some(row => row.volunteerId === 'volunteer-1')).toBe(false);
    expect(await app.request('volunteer.availability.recurring.update', { intervals: [] }, 'volunteer', metadata)).toEqual({ ok: true, data: result }); expect(app.notifications).toHaveLength(1);
    expect(app.notifications[0]!.text).toContain('No weekly availability is currently saved.');
  });
  it.each(['available', 'unavailable'] as const)('notifies coordinators of an %s date exception in readable local terms', async kind => {
    const app = await application();
    const metadata = { expectedRevision: 0, idempotencyKey: `notification-${kind}` };
    const payload = { date: '2026-11-02', kind, start: '00:00', end: '12:30', timeZone: interval.timeZone, reason: 'Travel plans' };
    const result = success(await app.request('volunteer.availability.exception.create', payload, 'volunteer', metadata));
    expect(app.notifications).toHaveLength(1);
    expect(app.notifications[0]).toMatchObject({ to: ['admin@example.invalid'], subject: 'Availability updated: Alex Example' });
    expect(app.notifications[0]!.text).toContain(`${kind === 'available' ? 'Available' : 'Unavailable'}: Monday, November 2, 2026`);
    expect(app.notifications[0]!.text).toContain('12:00 AM–12:30 PM (Eastern Time)');
    expect(app.notifications[0]!.text).toContain('Reason: Travel plans');
    expect(app.notifications[0]!.text).toContain('Submitted by: alex@example.test');
    expect(app.notifications[0]!.text).not.toMatch(/volunteer\.availability|Data revision/);
    expect(await app.request('volunteer.availability.exception.create', payload, 'volunteer', metadata)).toEqual({ ok: true, data: result });
    expect(app.notifications).toHaveLength(1);
  });
});

describe('candidate confirmation', () => {
  it('creates exactly one dated locked session and makes confirmed candidates immutable', async () => {
    const app = await application(); const created = success(await app.request('center.candidate.update', candidateInput));
    const confirmed = success(await app.request('admin.center.candidate.confirm', { candidateId: created.candidate.id }));
    expect(confirmed.session).toMatchObject({ id: `session-${created.candidate.id}-2026-10-05`, date: '2026-10-05', status: 'locked', sourceCandidateId: created.candidate.id });
    expect(confirmed.schedulingInputRevision).toBe(1);
    for (const payload of [{ candidateId: created.candidate.id, start: '14:00' }, { candidateId: created.candidate.id, status: 'cancelled' }]) expect(await app.request('center.candidate.update', payload)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await app.request('admin.center.candidate.confirm', { candidateId: created.candidate.id })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect((await app.read()).sessions.filter(row => row.sourceCandidateId === created.candidate.id)).toHaveLength(1);
  });
  it('uses the following week when confirmation is after the same weekday start time', async () => {
    const app = await application({ instant: '2026-10-05T16:01:00.000Z' });
    const created = success(await app.request('center.candidate.update', candidateInput));
    const confirmed = success(await app.request('admin.center.candidate.confirm', { candidateId: created.candidate.id }));
    expect(confirmed.session.date).toBe('2026-10-12');
  });
  it.each(['coverage', 'locked-session', 'dated-exception', 'assignment-overlap'] as const)('rejects %s conflicts without writes', async reason => {
    const app = await application();
    const payload = reason === 'locked-session' ? { ...candidateInput, centerId: 'center-1', start: '10:00', end: '11:00' } : candidateInput;
    const created = success(await app.request('center.candidate.update', payload));
    if (reason === 'coverage') await app.db.prepare('DELETE FROM recurring_availability').run();
    if (reason === 'dated-exception') await app.db.batch(['volunteer-1','volunteer-2','volunteer-3'].map((id, index) => app.db.prepare("INSERT INTO availability_exceptions (id,volunteer_id,date,kind,start_time,end_time,time_zone) VALUES (?,?,'2026-10-05','unavailable','12:00','13:00','America/New_York')").bind(`exception-${index}`, id)));
    if (reason === 'assignment-overlap') {
      await app.db.batch([
        app.db.prepare("INSERT INTO sessions (id,kind,center_id,title,date,start_time,end_time,time_zone,required_staff_count,status) VALUES ('other','center','center-3','Other','2026-10-05','12:00','13:00','America/New_York',2,'locked')"),
        app.db.prepare("INSERT INTO scheduling_runs (id,input_revision,output_revision,status) VALUES ('existing',0,1,'completed')"),
        ...['volunteer-1','volunteer-2','volunteer-3'].map((id,index) => app.db.prepare("INSERT INTO assignments (id,session_id,volunteer_id,schedule_revision,status) VALUES (?,'other',?,1,'assigned')").bind(`other-${index}`,id)),
      ]);
    }
    const before = await app.read();
    expect(await app.request('admin.center.candidate.confirm', { candidateId: created.candidate.id })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await app.read()).toEqual(before);
  });
});

describe('WhenIsGood staging, mappings and atomic promotion', () => {
  it('uses the fixed society page and rejects caller-selected results pages without writes', async () => {
    const app = await application(); const before = await app.read();
    for (const operation of ['admin.import.whenIsGood.preview', 'admin.import.whenIsGood.promote', 'admin.sync.now'] as const) {
      expect(await app.request(operation, { resultsCode: 'another-page' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    }
    expect(await app.read()).toEqual(before); expect(app.fetches).toEqual([]);
    const staged = success(await app.request('admin.import.whenIsGood.preview'));
    expect(app.fetches).toEqual(['mx8t23j']); expect(staged.import.resultId).toBe('mx8t23j');
  });
  it('matches email, tracks unmatched participants, reuses identical staging, restages mapping overrides and promotes provenance', async () => {
    const app = await application(); await app.db.prepare("UPDATE volunteers SET email='alice@example.test' WHERE id='volunteer-1'").run();
    const original = await app.read();
    const staged = success(await app.request('admin.import.whenIsGood.preview', {}));
    expect(staged.import).toMatchObject({ status: 'staged', participantCount: 2, matchedCount: 1 }); expect(staged.import.unmatched).toHaveLength(1);
    expect(staged.import.stagedAvailability.find(row => row.id === 'a')?.volunteerId).toBe('volunteer-1');
    const reused = success(await app.request('admin.import.whenIsGood.preview', {})); expect(reused.import.id).toBe(staged.import.id); expect((await app.read()).imports).toHaveLength(1);
    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'a', volunteerId: 'volunteer-2' }));
    const restaged = (await app.read()).imports[0]!; expect(restaged.stagedAvailability.find(row => row.id === 'a')?.volunteerId).toBe('volunteer-2');
    expect((await app.read()).recurringAvailability).toEqual(original.recurringAvailability);
    const promoted = success(await app.request('admin.import.whenIsGood.promote', {}));
    expect(promoted.import).toMatchObject({ status: 'completed', promotedBy: 'user-admin', promotedAt: '2026-10-04T12:00:00.000Z' }); expect(promoted.schedulingInputRevision).toBe(1);
    const state = await app.read();
    expect(state.recurringAvailability.filter(row => row.volunteerId === 'volunteer-2')).toMatchObject([{ weekday: 1, start: '09:00', end: '11:00', source: 'whenIsGood' }]);
    expect(state.recurringAvailability.filter(row => row.volunteerId !== 'volunteer-2')).toEqual(original.recurringAvailability.filter(row => row.volunteerId !== 'volunteer-2'));
    expect(state.importedAvailability).toMatchObject([{ volunteerId: 'volunteer-2', sourceParticipantId: 'a', importRunId: staged.import.id }]);
    expect(await app.request('admin.import.whenIsGood.promote', {})).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
  it('preserves distinct participant ID mappings for same-name participants through re-staging and promotion', async () => {
    const app = await application();
    app.setHtml(`<script>${JSON.stringify({ participants: [
      { id: 'p1', name: 'Alex Lee', email: 'shared@example.test', availability: [{ weekday: 1, start: '09:00', end: '10:00' }] },
      { id: 'p2', name: 'alex lee', email: ' SHARED@example.test ', availability: [{ weekday: 3, start: '13:00', end: '14:00' }] },
    ] })}</script>`);
    const staged = success(await app.request('admin.import.whenIsGood.preview', {}));
    expect(staged.import.stagedAvailability.map(({ id, volunteerId }) => [id, volunteerId])).toEqual([['p1', null], ['p2', null]]);

    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'p1', sourceEmail: 'shared@example.test', sourceName: 'Alex Lee', volunteerId: 'volunteer-1' }));
    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'p2', sourceEmail: 'shared@example.test', sourceName: 'alex lee', volunteerId: 'volunteer-2' }));
    const mapped = await app.read();
    expect(mapped.importMappings).toHaveLength(2);
    expect(mapped.importMappings.map(({ sourceParticipantId, volunteerId }) => [sourceParticipantId, volunteerId])).toEqual(expect.arrayContaining([['p1', 'volunteer-1'], ['p2', 'volunteer-2']]));

    const refreshed = success(await app.request('admin.import.whenIsGood.preview', {}));
    expect(refreshed.import.id).toBe(staged.import.id);
    expect(refreshed.import.stagedAvailability.map(({ id, volunteerId }) => [id, volunteerId])).toEqual([['p1', 'volunteer-1'], ['p2', 'volunteer-2']]);
    const promoted = success(await app.request('admin.import.whenIsGood.promote', {}));
    expect(promoted.import.status).toBe('completed');

    const state = await app.read();
    expect(state.importedAvailability.map(({ sourceParticipantId, volunteerId, weekday, start, end }) => [sourceParticipantId, volunteerId, weekday, start, end])).toEqual([
      ['p1', 'volunteer-1', 1, '09:00', '10:00'], ['p2', 'volunteer-2', 3, '13:00', '14:00'],
    ]);
    expect(state.recurringAvailability.filter(({ volunteerId }) => volunteerId === 'volunteer-1' || volunteerId === 'volunteer-2').map(({ volunteerId, weekday, start, end }) => [volunteerId, weekday, start, end])).toEqual([
      ['volunteer-1', 1, '09:00', '10:00'], ['volunteer-2', 3, '13:00', '14:00'],
    ]);
  });
  it('normalizes name-only mapping keys consistently for upsert, re-staging and promotion', async () => {
    const app = await application();
    app.setHtml(`<script>${JSON.stringify({ participants: [
      { id: 'legacy-id', name: 'Jamie  Doe', email: null, availability: [{ weekday: 5, start: '15:00', end: '16:00' }] },
    ] })}</script>`);
    const staged = success(await app.request('admin.import.whenIsGood.preview', {}));
    const first = success(await app.request('admin.import.mapping.upsert', { sourceName: '  JAMIE DOE ', volunteerId: 'volunteer-1' }));
    const updated = success(await app.request('admin.import.mapping.upsert', { sourceName: 'jamie   doe', volunteerId: 'volunteer-2' }));
    expect(updated.mapping.id).toBe(first.mapping.id);
    expect((await app.read()).importMappings).toHaveLength(1);

    const refreshed = success(await app.request('admin.import.whenIsGood.preview', {}));
    expect(refreshed.import.id).toBe(staged.import.id);
    expect(refreshed.import.stagedAvailability[0]?.volunteerId).toBe('volunteer-2');
    success(await app.request('admin.import.whenIsGood.promote', {}));
    expect((await app.read()).importedAvailability).toMatchObject([{ sourceParticipantId: 'legacy-id', volunteerId: 'volunteer-2', weekday: 5, start: '15:00', end: '16:00' }]);
  });
  it('promotes reviewed content when a results page changes A to B and back to A', async () => {
    const app = await application();
    await app.db.prepare("UPDATE volunteers SET email='alice@example.test' WHERE id='volunteer-1'").run();
    const html = (end: string) => `<script>{"participants":[{"id":"a","name":"Alice","email":"alice@example.test","availability":[{"weekday":1,"start":"09:00","end":"${end}"}]}]}</script>`;
    app.setHtml(html('10:00'));
    const original = success(await app.request('admin.import.whenIsGood.preview', {}));
    app.setHtml(html('11:00'));
    const changed = success(await app.request('admin.import.whenIsGood.preview', {}));
    app.setHtml(html('10:00'));
    const reviewed = success(await app.request('admin.import.whenIsGood.preview', {}));
    expect(reviewed.import.id).not.toBe(original.import.id);
    expect(reviewed.import.contentHash).toBe(original.import.contentHash);
    expect(reviewed.import.contentHash).not.toBe(changed.import.contentHash);
    const promoted = success(await app.request('admin.import.whenIsGood.promote', {}, 'admin', { expectedRevision: reviewed.dataRevision }));
    expect(promoted.import.id).toBe(reviewed.import.id);
    expect((await app.read()).recurringAvailability.filter(row => row.volunteerId === 'volunteer-1')).toMatchObject([{ start: '09:00', end: '10:00' }]);
  });
  it('promotes the newest staged content for one results code even when timestamps tie', async () => {
    const app = await application();
    await app.db.prepare("UPDATE volunteers SET email='alice@example.test' WHERE id='volunteer-1'").run();
    const stagedIds: string[] = [];
    for (let index = 0; index < 10; index++) {
      app.setHtml(`<script>{"participants":[{"id":"a","name":"Alice","email":"alice@example.test","availability":[{"weekday":1,"start":"09:00","end":"10:0${index}"}]}]}</script>`);
      stagedIds.push(success(await app.request('admin.import.whenIsGood.preview', {})).import.id);
    }
    const promoted = success(await app.request('admin.import.whenIsGood.promote', {}));
    expect(promoted.import.id).toBe(stagedIds.at(-1));
    expect((await app.read()).recurringAvailability.filter(row => row.volunteerId === 'volunteer-1')).toMatchObject([{ start: '09:00', end: '10:09' }]);
  });
  it('restages the latest applicable import rather than a newer unrelated import', async () => {
    const app = await application();
    const applicable = success(await app.request('admin.import.whenIsGood.preview', {}));
    app.setHtml('<script>{"participants":[{"id":"unrelated","name":"Other Person","email":"other-person@example.test","availability":[{"weekday":2,"start":"09:00","end":"10:00"}]}]}</script>');
    const unrelated = success(await app.request('admin.import.whenIsGood.preview', {}));
    await app.db.prepare("UPDATE imports SET result_id='unrelated', started_at='2026-10-04T12:01:00.000Z' WHERE id=?").bind(unrelated.import.id).run();
    const unrelatedBefore = (await app.read()).imports.find(row => row.id === unrelated.import.id);
    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'a', volunteerId: 'volunteer-2' }));
    const state = await app.read();
    expect(state.imports.find(row => row.id === applicable.import.id)?.stagedAvailability.find(row => row.id === 'a')?.volunteerId).toBe('volunteer-2');
    expect(state.imports.find(row => row.id === unrelated.import.id)).toEqual(unrelatedBefore);
  });
  it('parses alternate field names and preserves their normalized intervals during staging', async () => {
    const app = await application({ fixture: 'import-alternate.html' });
    const staged = success(await app.request('admin.import.whenIsGood.preview', {}));
    expect(staged.import.status).toBe('staged');
    expect(staged.import.stagedAvailability[0]).toMatchObject({ id: 'p1', name: 'Dana & Lee', email: 'dana@example.test' });
    expect(staged.import.stagedAvailability[0]!.intervals).toEqual(expect.arrayContaining([{ weekday: 1, start: '09:00', end: '11:00', timeZone: interval.timeZone }, { weekday: 2, start: '13:30', end: '15:00', timeZone: interval.timeZone }]));
  });
  it.each(['parse', 'fetch'] as const)('persists a failed %s import while leaving availability unchanged', async failure => {
    const app = await application(failure === 'parse' ? { fixture: 'import-invalid.html' } : { fetchFails: true }); const before = await app.read();
    const result = success(await app.request('admin.import.whenIsGood.preview', {}));
    expect(result.import.status).toBe('failed'); expect(result.import.diagnostic).toBeTruthy();
    const state = await app.read(); expect(state.recurringAvailability).toEqual(before.recurringAvailability); expect(state.schedulingInputRevision).toBe(0);
    expect(await app.request('admin.import.whenIsGood.promote', {})).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
  it('rejects an entire import before promotion if any matched participant uses another time zone', async () => {
    const app = await application();
    app.setHtml(JSON.stringify({ participants: [{ id: 'p1', name: 'Dana & Lee', email: 'dana@example.test', availability: [
      [1, '09:00', '11:00', interval.timeZone], [2, '13:30', '15:00', 'Europe/London'],
    ] }] }));
    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'p1', volunteerId: 'volunteer-1' }));
    const availabilityBefore = (await app.read()).recurringAvailability;
    const preview = success(await app.request('admin.import.whenIsGood.preview', {}));
    expect(preview.import.status).toBe('failed');
    expect(preview.import.stagedAvailability).toEqual([]);
    const before = await app.read();
    expect(before.recurringAvailability).toEqual(availabilityBefore);
    expect(await app.request('admin.import.whenIsGood.promote', {})).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await app.read()).toEqual(before); expect((await app.read()).importedAvailability).toHaveLength(0);
  });
});

describe('administrator volunteer creation', () => {
  it('creates a newly-joined volunteer silently, lists it, and offers it as a roster link', async () => {
    const app = await application();
    const created = success(await app.request('admin.volunteer.create', { name: '  Frankie Example ', email: ' frankie@example.test ' }));
    expect(created.volunteer).toMatchObject({ name: 'Frankie Example', email: 'frankie@example.test', lifecycleStatus: 'newly-joined', interviewStatus: 'incomplete', readinessRank: null });
    expect(created.dataRevision).toBe(1);
    const view = success(await app.request('admin.volunteer.read'));
    expect(view.volunteers.find(row => row.id === created.volunteer.id)).toEqual(created.volunteer);
    expect(success(await app.request('admin.sync.read')).volunteers.map(row => row.id)).toContain(created.volunteer.id);
    expect(app.notifications).toHaveLength(0);
  });
  it.each([
    { name: '   ', email: 'frankie@example.test', code: 'INVALID_REQUEST', message: 'Enter the volunteer’s name.' },
    { name: 'Frankie Example', email: 'frankie.example.test', code: 'INVALID_REQUEST', message: 'Enter a valid email address.' },
    { name: 'Frankie Example', email: 'blair@example.test', code: 'CONFLICT', message: 'Another volunteer already uses this email.' },
    { name: 'Frankie Example', email: ' BLAIR@Example.Test ', code: 'CONFLICT', message: 'Another volunteer already uses this email.' },
  ])('rejects name $name and email $email without writes', async ({ name, email, code, message }) => {
    const app = await application(); const before = await app.read();
    expect(await app.request('admin.volunteer.create', { name, email })).toEqual({ ok: false, error: { code, message } });
    expect(await app.read()).toEqual(before);
  });
  it('rejects an email that a saved roster link sends to another volunteer, without writes', async () => {
    const app = await application();
    success(await app.request('admin.import.mapping.upsert', { sourceEmail: 'frankie@example.test', volunteerId: 'volunteer-1' }));
    const before = await app.read();
    expect(await app.request('admin.volunteer.create', { name: 'Frankie Example', email: 'frankie@example.test' })).toEqual({ ok: false, error: { code: 'CONFLICT', message: 'A saved roster link sends this email to another volunteer.' } });
    expect(await app.read()).toEqual(before);
  });
  it('rejects a stale revision and replays a repeated idempotency key without another write', async () => {
    const app = await application();
    const raw = { operation: 'admin.volunteer.create', payload: { name: 'Frankie Example', email: 'frankie@example.test' }, credential: 'admin', expectedRevision: 0, idempotencyKey: 'volunteer-create' };
    const first = await app.rawRequest(raw); expect(JSON.parse(first).ok).toBe(true);
    const saved = await app.read();
    expect(await app.rawRequest(raw)).toBe(first);
    expect(JSON.parse(await app.rawRequest({ ...raw, payload: { name: 'Gale Example', email: 'gale@example.test' }, idempotencyKey: 'volunteer-create-2' }))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(await app.read()).toEqual(saved);
    expect(app.notifications).toHaveLength(0);
  });
  it('is refused for non-administrators', async () => {
    const app = await application();
    for (const credential of ['volunteer', 'contact'] as const) expect(await app.request('admin.volunteer.create', { name: 'Frankie Example', email: 'frankie@example.test' }, credential)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});

describe('administrator volunteer record edits', () => {
  it('lists every volunteer with name, email and lifecycle status', async () => {
    const app = await application();
    const view = success(await app.request('admin.volunteer.read'));
    expect(view.volunteers.map(({ id, name, email, lifecycleStatus }) => ({ id, name, email, lifecycleStatus }))).toEqual([
      { id: 'volunteer-1', name: 'Alex Example', email: 'alex@example.test', lifecycleStatus: 'active' },
      { id: 'volunteer-2', name: 'Blair Example', email: 'blair@example.test', lifecycleStatus: 'active' },
      { id: 'volunteer-3', name: 'Casey Example', email: 'casey@example.test', lifecycleStatus: 'newly-joined' },
      { id: 'volunteer-4', name: 'Devon Example', email: 'devon@example.test', lifecycleStatus: 'inactive' },
      { id: 'volunteer-5', name: 'Ellis Example', email: 'ellis@example.test', lifecycleStatus: 'active' },
    ]);
  });
  it('saves a corrected name and email silently and returns them on the next read', async () => {
    const app = await application();
    const saved = success(await app.request('admin.volunteer.update', { volunteerId: 'volunteer-3', name: '  Casey Corrected ', email: ' casey.new@example.test ' }));
    expect(saved.volunteer).toMatchObject({ id: 'volunteer-3', name: 'Casey Corrected', email: 'casey.new@example.test', lifecycleStatus: 'newly-joined', interviewStatus: 'complete', readinessRank: 3 });
    expect(saved.dataRevision).toBe(1);
    const view = success(await app.request('admin.volunteer.read'));
    expect(view.volunteers.find(row => row.id === 'volunteer-3')).toMatchObject({ name: 'Casey Corrected', email: 'casey.new@example.test' });
    expect(view.volunteers.filter(row => row.id !== 'volunteer-3').map(row => row.email)).toEqual(['alex@example.test', 'blair@example.test', 'devon@example.test', 'ellis@example.test']);
    expect(app.notifications).toHaveLength(0);
  });
  it.each([
    { name: '   ', email: 'casey@example.test', message: 'Enter the volunteer’s name.' },
    { name: 'Casey Example', email: '', message: 'Enter a valid email address.' },
    { name: 'Casey Example', email: 'casey.example.test', message: 'Enter a valid email address.' },
    { name: 'Casey Example', email: 'casey@example', message: 'Enter a valid email address.' },
    { name: 'Casey Example', email: 'casey example@example.test', message: 'Enter a valid email address.' },
  ])('rejects name $name and email $email without writes', async ({ name, email, message }) => {
    const app = await application(); const before = await app.read();
    expect(await app.request('admin.volunteer.update', { volunteerId: 'volunteer-3', name, email })).toEqual({ ok: false, error: { code: 'INVALID_REQUEST', message } });
    expect(await app.read()).toEqual(before);
  });
  it.each(['blair@example.test', ' BLAIR@Example.Test '])('rejects %j because it matches another volunteer after import normalization', async email => {
    const app = await application(); const before = await app.read();
    expect(await app.request('admin.volunteer.update', { volunteerId: 'volunteer-3', name: 'Casey Example', email })).toEqual({ ok: false, error: { code: 'CONFLICT', message: 'Another volunteer already uses this email.' } });
    expect(await app.read()).toEqual(before);
  });
  it('allows a volunteer to keep their own email with different capitalization', async () => {
    const app = await application();
    expect(success(await app.request('admin.volunteer.update', { volunteerId: 'volunteer-3', name: 'Casey Example', email: 'Casey@Example.test' })).volunteer.email).toBe('Casey@Example.test');
  });
  it('rejects an email that a saved email roster link sends to another volunteer, without writes', async () => {
    const app = await application();
    success(await app.request('admin.import.mapping.upsert', { sourceEmail: 'casey.new@example.test', volunteerId: 'volunteer-1' }));
    const before = await app.read();
    expect(await app.request('admin.volunteer.update', { volunteerId: 'volunteer-3', name: 'Casey Example', email: ' Casey.New@Example.test ' })).toEqual({ ok: false, error: { code: 'CONFLICT', message: 'A saved roster link sends this email to another volunteer.' } });
    expect(await app.read()).toEqual(before);
  });
  it('rejects an email whose synchronized participant has a source-ID roster link to another volunteer, without writes', async () => {
    const app = await application();
    app.setHtml(`<script>${JSON.stringify({ participants: [{ id: 'p-new', name: 'Someone Else', email: 'CASEY.NEW@example.test', availability: [{ weekday: 2, start: '09:00', end: '10:00' }] }] })}</script>`);
    success(await app.request('admin.sync.now'));
    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'p-new', volunteerId: 'volunteer-1' }));
    expect((await app.read()).importMappings.map(({ sourceParticipantId, sourceEmail, volunteerId }) => ({ sourceParticipantId, sourceEmail, volunteerId }))).toEqual([{ sourceParticipantId: 'p-new', sourceEmail: null, volunteerId: 'volunteer-1' }]);
    const before = await app.read();
    expect(await app.request('admin.volunteer.update', { volunteerId: 'volunteer-3', name: 'Casey Example', email: 'casey.new@example.test' })).toEqual({ ok: false, error: { code: 'CONFLICT', message: 'A saved roster link sends this email to another volunteer.' } });
    expect(await app.read()).toEqual(before);
  });
  it('accepts an email whose saved roster link already points to the edited volunteer', async () => {
    const app = await application();
    success(await app.request('admin.import.mapping.upsert', { sourceEmail: 'casey.new@example.test', volunteerId: 'volunteer-3' }));
    expect(success(await app.request('admin.volunteer.update', { volunteerId: 'volunteer-3', name: 'Casey Example', email: 'casey.new@example.test' })).volunteer.email).toBe('casey.new@example.test');
  });
  it('updates the linked sign-in account email in the same write and leaves other accounts alone', async () => {
    const app = await application(); const before = await app.read();
    const saved = success(await app.request('admin.volunteer.update', { volunteerId: 'volunteer-1', name: 'Alex Example', email: 'alex.new@example.test' }));
    expect(saved.dataRevision).toBe(1);
    const state = await app.read();
    expect(state.volunteers.find(row => row.id === 'volunteer-1')?.email).toBe('alex.new@example.test');
    expect(state.users.find(row => row.id === 'user-volunteer')?.email).toBe('alex.new@example.test');
    expect(state.users.filter(row => row.id !== 'user-volunteer')).toEqual(before.users.filter(row => row.id !== 'user-volunteer'));
  });
  it.each(['contact@example.test', ' Contact@Example.TEST '])('rejects %j for a linked volunteer because another sign-in account uses it, without writes', async email => {
    const app = await application(); const before = await app.read();
    expect(await app.request('admin.volunteer.update', { volunteerId: 'volunteer-1', name: 'Alex Example', email })).toEqual({ ok: false, error: { code: 'CONFLICT', message: 'Another sign-in account already uses this email.' } });
    expect(await app.read()).toEqual(before);
  });
  it('rejects a stale revision and replays a repeated idempotency key without another write', async () => {
    const app = await application();
    const raw = { operation: 'admin.volunteer.update', payload: { volunteerId: 'volunteer-3', name: 'Casey First', email: 'casey@example.test' }, credential: 'admin', expectedRevision: 0, idempotencyKey: 'volunteer-edit' };
    const first = await app.rawRequest(raw); expect(JSON.parse(first).ok).toBe(true);
    const saved = await app.read();
    expect(await app.rawRequest(raw)).toBe(first);
    expect(JSON.parse(await app.rawRequest({ ...raw, payload: { ...raw.payload, name: 'Casey Second' }, idempotencyKey: 'volunteer-edit-2' }))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(await app.read()).toEqual(saved);
    expect(app.notifications).toHaveLength(0);
  });
  it('removes a volunteer by marking them inactive, silently, keeping every row and past schedule output', async () => {
    const app = await application();
    success(await app.request('admin.schedule.rerun')); const published = success(await app.request('admin.schedule.read'));
    expect(published.assignments.some(row => row.volunteerId === 'volunteer-1')).toBe(true);
    const before = await app.read(); const notified = app.notifications.length;
    const removed = success(await app.request('admin.volunteer.remove', { volunteerId: 'volunteer-1' }));
    expect(removed.volunteer).toMatchObject({ id: 'volunteer-1', lifecycleStatus: 'inactive' });
    const after = await app.read();
    expect(after.volunteers.find(row => row.id === 'volunteer-1')?.lifecycleStatus).toBe('inactive');
    expect(after.volunteers.map(row => row.id)).toEqual(before.volunteers.map(row => row.id));
    const { volunteers: _after, volunteerChanges: _log, dataRevision: _a, schedulingInputRevision: _b, ...otherAfter } = after; const { volunteers: _before, volunteerChanges: _prior, dataRevision: _c, schedulingInputRevision: _d, ...otherBefore } = before;
    expect(otherAfter).toEqual(otherBefore);
    expect(after.volunteers.filter(row => row.id !== 'volunteer-1')).toEqual(before.volunteers.filter(row => row.id !== 'volunteer-1'));
    const view = success(await app.request('admin.schedule.read'));
    expect(view.stale).toBe(true);
    expect(view.assignments).toEqual(published.assignments); expect(view.backups).toEqual(published.backups);
    expect(app.notifications).toHaveLength(notified);
  });
  it('excludes a removed volunteer from the next schedule preview and publication', async () => {
    const app = await application();
    const first = success(await app.request('admin.schedule.preview'));
    const removedId = first.output.assignments[0]!.volunteerId;
    success(await app.request('admin.volunteer.remove', { volunteerId: removedId }));
    const preview = success(await app.request('admin.schedule.preview'));
    expect([...preview.output.assignments, ...preview.output.backups].some(row => row.volunteerId === removedId)).toBe(false);
    const published = success(await app.request('admin.schedule.rerun'));
    expect([...published.assignments, ...published.backups].some(row => row.volunteerId === removedId)).toBe(false);
  });
  it('rejects removing an unknown or already inactive volunteer without writes', async () => {
    const app = await application(); const before = await app.read();
    expect(await app.request('admin.volunteer.remove', { volunteerId: 'missing' })).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Volunteer not found.' } });
    expect(await app.request('admin.volunteer.remove', { volunteerId: 'volunteer-4' })).toEqual({ ok: false, error: { code: 'CONFLICT', message: 'This volunteer is already inactive.' } });
    expect(await app.read()).toEqual(before);
  });
  it('rejects a stale removal and replays a repeated removal key without another write', async () => {
    const app = await application();
    const raw = { operation: 'admin.volunteer.remove', payload: { volunteerId: 'volunteer-3' }, credential: 'admin', expectedRevision: 0, idempotencyKey: 'volunteer-remove' };
    const first = await app.rawRequest(raw); expect(JSON.parse(first).ok).toBe(true);
    const saved = await app.read();
    expect(await app.rawRequest(raw)).toBe(first);
    expect(JSON.parse(await app.rawRequest({ ...raw, payload: { volunteerId: 'volunteer-2' }, idempotencyKey: 'volunteer-remove-2' }))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(await app.read()).toEqual(saved);
    expect(app.notifications).toHaveLength(0);
  });
});

describe('volunteer change history', () => {
  const edit = { volunteerId: 'volunteer-3', name: 'Casey Corrected', email: 'casey@example.test' };
  it('records an edit with time, administrator, volunteer and before/after values of each changed field only', async () => {
    const app = await application(); app.setNow('2026-10-04T13:30:00.000Z');
    success(await app.request('admin.volunteer.update', edit));
    expect(success(await app.request('admin.volunteer.read')).changes).toEqual([{
      id: expect.any(String), occurredAt: '2026-10-04T13:30:00.000Z', actorId: 'user-admin', actorEmail: 'admin@example.test',
      volunteerId: 'volunteer-3', volunteerName: 'Casey Corrected', kind: 'updated',
      fields: [{ field: 'name', before: 'Casey Example', after: 'Casey Corrected' }],
    }]);
  });
  it('records an addition with every initial field', async () => {
    const app = await application();
    const { volunteer } = success(await app.request('admin.volunteer.create', { name: 'Frankie Example', email: 'frankie@example.test' }));
    expect(success(await app.request('admin.volunteer.read')).changes).toMatchObject([{
      actorEmail: 'admin@example.test', volunteerId: volunteer.id, volunteerName: 'Frankie Example', kind: 'added',
      fields: [{ field: 'name', before: null, after: 'Frankie Example' }, { field: 'email', before: null, after: 'frankie@example.test' }, { field: 'status', before: null, after: 'newly-joined' }],
    }]);
  });
  it('records a removal as a status change', async () => {
    const app = await application();
    success(await app.request('admin.volunteer.remove', { volunteerId: 'volunteer-1' }));
    expect(success(await app.request('admin.volunteer.read')).changes).toMatchObject([{
      volunteerId: 'volunteer-1', volunteerName: 'Alex Example', kind: 'removed', fields: [{ field: 'status', before: 'active', after: 'inactive' }],
    }]);
  });
  it('lists newest first', async () => {
    const app = await application();
    app.setNow('2026-10-04T13:00:00.000Z'); success(await app.request('admin.volunteer.update', edit));
    app.setNow('2026-10-04T14:00:00.000Z'); success(await app.request('admin.volunteer.remove', { volunteerId: 'volunteer-2' }));
    expect(success(await app.request('admin.volunteer.read')).changes.map(row => [row.occurredAt, row.kind])).toEqual([['2026-10-04T14:00:00.000Z', 'removed'], ['2026-10-04T13:00:00.000Z', 'updated']]);
  });
  it('adds no entry for a save that changes nothing or a rejected change', async () => {
    const app = await application();
    success(await app.request('admin.volunteer.update', { volunteerId: 'volunteer-3', name: 'Casey Example', email: 'casey@example.test' }));
    expect(await app.request('admin.volunteer.update', { ...edit, email: 'blair@example.test' })).toMatchObject({ ok: false });
    expect(success(await app.request('admin.volunteer.read')).changes).toEqual([]);
  });
  it('is added by an idempotent migration that leaves existing volunteers alone, and then records changes', async () => {
    const app = await application(); const before = await app.read();
    await app.db.prepare('DROP TABLE volunteer_changes').run();
    const migration = await readFile(new URL('../../migrations/0006_volunteer_changes.sql', import.meta.url), 'utf8');
    await applySql(app.db, migration); await applySql(app.db, migration);
    expect(await app.read()).toEqual(before);
    success(await app.request('admin.volunteer.update', edit));
    expect((await app.read()).volunteerChanges).toHaveLength(1);
  });
  it('commits the entry with the change: a failed commit leaves neither', async () => {
    const app = await application();
    await app.db.prepare("CREATE TRIGGER refuse_history BEFORE INSERT ON volunteer_changes BEGIN SELECT RAISE(ABORT, 'refused'); END").run();
    expect(await app.request('admin.volunteer.update', edit)).toMatchObject({ ok: false });
    expect((await app.read()).volunteers.find(row => row.id === 'volunteer-3')?.name).toBe('Casey Example');
  });
  it('adds no entry for a stale or replayed request and no extra revision', async () => {
    const app = await application();
    const raw = { operation: 'admin.volunteer.update', payload: edit, credential: 'admin', expectedRevision: 0, idempotencyKey: 'history-edit' };
    const first = await app.rawRequest(raw); expect(JSON.parse(first).ok).toBe(true);
    const saved = await app.read();
    expect(await app.rawRequest(raw)).toBe(first);
    expect(JSON.parse(await app.rawRequest({ ...raw, payload: { ...edit, name: 'Casey Stale' }, idempotencyKey: 'history-edit-2' }))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    const after = await app.read();
    expect(after).toEqual(saved); expect(after.volunteerChanges).toHaveLength(1);
    expect(after.dataRevision).toBe(1); expect(after.schedulingInputRevision).toBe(1);
    expect(app.notifications).toHaveLength(0);
  });
});
