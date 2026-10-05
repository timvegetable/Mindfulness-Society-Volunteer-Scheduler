import { afterEach, describe, expect, it } from 'vitest';
import { operations, isMutation, type Operation } from '../../src/shared/api/operations';
import { createApplication, addPublishedFixture, success, interval, candidateInput, type Application, type Actor } from '../helpers/application';

const apps: Application[] = [];
async function application(options: Parameters<typeof createApplication>[0] = {}) {
  const app = await createApplication(options); apps.push(app); return app;
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.dispose())); });
const payloads: Record<Operation, unknown> = {
  'session.me': {}, 'volunteer.dashboard': {},
  'volunteer.availability.recurring.update': { intervals: [interval] },
  'volunteer.availability.exception.create': { date: '2026-10-06', kind: 'unavailable', start: '10:00', end: '11:00', timeZone: interval.timeZone },
  'volunteer.assignment.cancel': { assignmentId: 'assignment-1' },
  'admin.schedule.read': {}, 'admin.schedule.preview': {}, 'admin.schedule.rerun': {},
  'admin.import.whenIsGood.preview': { resultsCode: 'fixture-code' },
  'admin.import.whenIsGood.promote': { resultsCode: 'fixture-code' },
  'admin.import.mapping.upsert': { sourceParticipantId: 'a', volunteerId: 'volunteer-1' },
  'admin.insights.read': {}, 'center.candidate.read': {},
  'center.candidate.update': { ...candidateInput, centerId: 'center-1' },
  'admin.center.candidate.confirm': { candidateId: 'candidate-1' },
};
// Independent expected policy, deliberately not calculated using the implementation.
const volunteerAllowed = new Set<Operation>(['session.me', 'volunteer.dashboard', 'volunteer.availability.recurring.update', 'volunteer.availability.exception.create', 'volunteer.assignment.cancel']);
const contactAllowed = new Set<Operation>(['session.me', 'center.candidate.read', 'center.candidate.update']);
const matrix = (['volunteer', 'contact', 'admin'] as const).flatMap(actor => operations.map(operation => ({ actor, operation, allowed: actor === 'admin' || (actor === 'volunteer' ? volunteerAllowed : contactAllowed).has(operation) })));

describe('every role against every public operation on local D1', () => {
  it.each(matrix)('$actor $operation allowed=$allowed', async ({ actor, operation, allowed }) => {
    const app = await application();
    await addPublishedFixture(app);
    if (operation === 'admin.import.whenIsGood.promote') success(await app.request('admin.import.whenIsGood.preview', { resultsCode: 'fixture-code' }));
    const before = await app.read();
    const result = await app.request(operation, payloads[operation], actor);
    if (allowed) expect(result.ok, JSON.stringify(result)).toBe(true);
    else { expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } }); expect(await app.read()).toEqual(before); }
  });
});

describe('authorization, revisions and durable idempotency', () => {
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
  it('cancels, stores the dated exception, promotes an eligible backup and reorders remaining backups', async () => {
    const app = await application(); await addPublishedFixture(app);
    const result = success(await app.request('volunteer.assignment.cancel', { assignmentId: 'assignment-1', reason: 'Away' }, 'volunteer'));
    expect(result.assignment).toMatchObject({ status: 'cancelled', cancelledAt: '2026-10-04T12:00:00.000Z', cancellationReason: 'Away' });
    expect(result.exception).toMatchObject({ volunteerId: 'volunteer-1', date: '2026-10-05', kind: 'unavailable', start: '10:00', end: '11:00' });
    expect(result.promotedAssignment?.volunteerId).toBe('volunteer-2'); expect(result.shortfall).toBeNull();
    const state = await app.read(); expect(state.backups.find(row => row.id === 'backup-2')?.status).toBe('promoted'); expect(state.backups.find(row => row.id === 'backup-3')?.position).toBe(1);
    expect(state.schedulingInputRevision).toBe(1); expect(state.dataRevision).toBe(1); expect(app.notifications).toHaveLength(1);
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
  it('matches email, tracks unmatched participants, reuses identical staging, restages mapping overrides and promotes provenance', async () => {
    const app = await application(); await app.db.prepare("UPDATE volunteers SET email='alice@example.test' WHERE id='volunteer-1'").run();
    const original = await app.read();
    const staged = success(await app.request('admin.import.whenIsGood.preview', { resultsCode: 'normal' }));
    expect(staged.import).toMatchObject({ status: 'staged', participantCount: 2, matchedCount: 1 }); expect(staged.import.unmatched).toHaveLength(1);
    expect(staged.import.stagedAvailability.find(row => row.id === 'a')?.volunteerId).toBe('volunteer-1');
    const reused = success(await app.request('admin.import.whenIsGood.preview', { resultsCode: 'normal' })); expect(reused.import.id).toBe(staged.import.id); expect((await app.read()).imports).toHaveLength(1);
    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'a', volunteerId: 'volunteer-2' }));
    const restaged = (await app.read()).imports[0]!; expect(restaged.stagedAvailability.find(row => row.id === 'a')?.volunteerId).toBe('volunteer-2');
    expect((await app.read()).recurringAvailability).toEqual(original.recurringAvailability);
    const promoted = success(await app.request('admin.import.whenIsGood.promote', { resultsCode: 'normal' }));
    expect(promoted.import).toMatchObject({ status: 'completed', promotedBy: 'user-admin', promotedAt: '2026-10-04T12:00:00.000Z' }); expect(promoted.schedulingInputRevision).toBe(1);
    const state = await app.read();
    expect(state.recurringAvailability.filter(row => row.volunteerId === 'volunteer-2')).toMatchObject([{ weekday: 1, start: '09:00', end: '11:00', source: 'whenIsGood' }]);
    expect(state.recurringAvailability.filter(row => row.volunteerId !== 'volunteer-2')).toEqual(original.recurringAvailability.filter(row => row.volunteerId !== 'volunteer-2'));
    expect(state.importedAvailability).toMatchObject([{ volunteerId: 'volunteer-2', sourceParticipantId: 'a', importRunId: staged.import.id }]);
    expect(await app.request('admin.import.whenIsGood.promote', { resultsCode: 'normal' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
  it('promotes reviewed content when a results page changes A to B and back to A', async () => {
    const app = await application();
    await app.db.prepare("UPDATE volunteers SET email='alice@example.test' WHERE id='volunteer-1'").run();
    const html = (end: string) => `<script>{"participants":[{"id":"a","name":"Alice","email":"alice@example.test","availability":[{"weekday":1,"start":"09:00","end":"${end}"}]}]}</script>`;
    app.setHtml(html('10:00'));
    const original = success(await app.request('admin.import.whenIsGood.preview', { resultsCode: 'reverted' }));
    app.setHtml(html('11:00'));
    const changed = success(await app.request('admin.import.whenIsGood.preview', { resultsCode: 'reverted' }));
    app.setHtml(html('10:00'));
    const reviewed = success(await app.request('admin.import.whenIsGood.preview', { resultsCode: 'reverted' }));
    expect(reviewed.import.id).not.toBe(original.import.id);
    expect(reviewed.import.contentHash).toBe(original.import.contentHash);
    expect(reviewed.import.contentHash).not.toBe(changed.import.contentHash);
    const promoted = success(await app.request('admin.import.whenIsGood.promote', { resultsCode: 'reverted' }, 'admin', { expectedRevision: reviewed.dataRevision }));
    expect(promoted.import.id).toBe(reviewed.import.id);
    expect((await app.read()).recurringAvailability.filter(row => row.volunteerId === 'volunteer-1')).toMatchObject([{ start: '09:00', end: '10:00' }]);
  });
  it('promotes the newest staged content for one results code even when timestamps tie', async () => {
    const app = await application();
    await app.db.prepare("UPDATE volunteers SET email='alice@example.test' WHERE id='volunteer-1'").run();
    const stagedIds: string[] = [];
    for (let index = 0; index < 10; index++) {
      app.setHtml(`<script>{"participants":[{"id":"a","name":"Alice","email":"alice@example.test","availability":[{"weekday":1,"start":"09:00","end":"10:0${index}"}]}]}</script>`);
      stagedIds.push(success(await app.request('admin.import.whenIsGood.preview', { resultsCode: 'changing' })).import.id);
    }
    const promoted = success(await app.request('admin.import.whenIsGood.promote', { resultsCode: 'changing' }));
    expect(promoted.import.id).toBe(stagedIds.at(-1));
    expect((await app.read()).recurringAvailability.filter(row => row.volunteerId === 'volunteer-1')).toMatchObject([{ start: '09:00', end: '10:09' }]);
  });
  it('restages the latest applicable import rather than a newer unrelated import', async () => {
    const app = await application();
    const applicable = success(await app.request('admin.import.whenIsGood.preview', { resultsCode: 'applicable' }));
    app.setHtml('<script>{"participants":[{"id":"unrelated","name":"Other Person","email":"other-person@example.test","availability":[{"weekday":2,"start":"09:00","end":"10:00"}]}]}</script>');
    const unrelated = success(await app.request('admin.import.whenIsGood.preview', { resultsCode: 'unrelated' }));
    await app.db.prepare("UPDATE imports SET started_at='2026-10-04T12:01:00.000Z' WHERE id=?").bind(unrelated.import.id).run();
    const unrelatedBefore = (await app.read()).imports.find(row => row.id === unrelated.import.id);
    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'a', volunteerId: 'volunteer-2' }));
    const state = await app.read();
    expect(state.imports.find(row => row.id === applicable.import.id)?.stagedAvailability.find(row => row.id === 'a')?.volunteerId).toBe('volunteer-2');
    expect(state.imports.find(row => row.id === unrelated.import.id)).toEqual(unrelatedBefore);
  });
  it('parses alternate field names and preserves their normalized intervals during staging', async () => {
    const app = await application({ fixture: 'import-alternate.html' });
    const staged = success(await app.request('admin.import.whenIsGood.preview', { resultsCode: 'alternate' }));
    expect(staged.import.status).toBe('staged');
    expect(staged.import.stagedAvailability[0]).toMatchObject({ id: 'p1', name: 'Dana & Lee', email: 'dana@example.test' });
    expect(staged.import.stagedAvailability[0]!.intervals).toEqual(expect.arrayContaining([{ weekday: 1, start: '09:00', end: '11:00', timeZone: interval.timeZone }, { weekday: 2, start: '13:30', end: '15:00', timeZone: interval.timeZone }]));
  });
  it.each(['parse', 'fetch'] as const)('persists a failed %s import while leaving availability unchanged', async failure => {
    const app = await application(failure === 'parse' ? { fixture: 'import-invalid.html' } : { fetchFails: true }); const before = await app.read();
    const result = success(await app.request('admin.import.whenIsGood.preview', { resultsCode: failure }));
    expect(result.import.status).toBe('failed'); expect(result.import.diagnostic).toBeTruthy();
    const state = await app.read(); expect(state.recurringAvailability).toEqual(before.recurringAvailability); expect(state.schedulingInputRevision).toBe(0);
    expect(await app.request('admin.import.whenIsGood.promote', { resultsCode: failure })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
  it('rejects an entire promotion if any matched participant uses another time zone', async () => {
    const app = await application({ fixture: 'import-alternate.html' });
    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'p1', volunteerId: 'volunteer-1' }));
    success(await app.request('admin.import.whenIsGood.preview', { resultsCode: 'wrong-zone' }));
    const before = await app.read();
    expect(await app.request('admin.import.whenIsGood.promote', { resultsCode: 'wrong-zone' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await app.read()).toEqual(before); expect((await app.read()).importedAvailability).toHaveLength(0);
  });
});
