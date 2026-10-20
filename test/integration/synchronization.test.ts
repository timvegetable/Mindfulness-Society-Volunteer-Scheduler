import { applySql } from '../helpers/database';
import { readFile } from 'node:fs/promises';
import { Effect, Schema } from 'effect';
import { synchronize, synchronizationSystemActor } from '../../src/worker/synchronization';
import { testConfig } from '../../src/worker/config';
import { resultSchemas } from '../../src/shared/api/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplication, addPublishedFixture, success, type Application } from '../helpers/application';

const apps: Application[] = [];
async function application(options: Parameters<typeof createApplication>[0] = {}) {
  const app = await createApplication(options); apps.push(app); return app;
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.dispose())); });
const source = (availability: unknown = [[1, '10:00', '12:00']]) => JSON.stringify({ participants: [
  { id: 'alex-source', name: 'Alex', email: 'alex@example.test', availability },
] });
const sync = async (app: Application) => {
  const result = await app.request('admin.sync.now');
  return result.ok ? app.request('admin.sync.read') : result;
};

describe('automatic availability synchronization through local D1', () => {
  it('keeps legacy interval-shaped import history readable before and after a scheduled check', async () => {
    const app = await application(); app.setHtml(source());
    const legacy = [
      { id: 'old-slot-1', volunteerId: 'volunteer-1', sourceParticipantId: 'alex-source', source: 'whenIsGood', weekday: 1, start: '10:00', end: '11:00', timeZone: 'America/New_York', importedAt: '2026-10-01T12:00:00Z', importRunId: 'old-run' },
      { id: 'old-slot-2', volunteerId: 'volunteer-1', sourceParticipantId: 'alex-source', source: 'whenIsGood', weekday: 1, start: '11:00', end: '12:00', timeZone: 'America/New_York', importedAt: '2026-10-01T12:00:00Z', importRunId: 'old-run' },
      { id: 'old-slot-3', volunteerId: 'volunteer-1', sourceParticipantId: 'other-source', source: 'whenIsGood', weekday: 2, start: '13:00', end: '14:00', timeZone: 'America/New_York', importedAt: '2026-10-01T12:00:00Z', importRunId: 'old-run' },
    ];
    await app.db.prepare("INSERT INTO imports (id,source,content_hash,status,result_id,unmatched,staged_availability) VALUES ('old-run','whenIsGood','old-hash','completed','mx8t23j','[]',?)").bind(JSON.stringify(legacy)).run();
    const before = success(await app.request('admin.sync.read'));
    expect((await app.read()).imports[0]?.stagedAvailability).toEqual([
      { id: 'alex-source', name: '', email: null, volunteerId: 'volunteer-1', intervals: [
        { weekday: 1, start: '10:00', end: '11:00', timeZone: 'America/New_York' },
        { weekday: 1, start: '11:00', end: '12:00', timeZone: 'America/New_York' },
      ] },
      { id: 'other-source', name: '', email: null, volunteerId: 'volunteer-1', intervals: [{ weekday: 2, start: '13:00', end: '14:00', timeZone: 'America/New_York' }] },
    ]);
    expect(before.imports[0]?.participantCount).toBe(2);
    await Effect.runPromise(synchronize(testConfig, synchronizationSystemActor).pipe(Effect.provide(app.layer)));
    const after = success(await app.request('admin.sync.read'));
    expect(after.status.outcome).toBe('changed');
    expect(after.imports.find(row => row.id === 'old-run')).toEqual(before.imports[0]);
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toMatchObject([{ weekday: 1, start: '10:00', end: '12:00' }]);
  });
  it('treats normalized unchanged checks as successful without adding history, provenance or revisions', async () => {
    const app = await application(); app.setHtml(source());
    success(await sync(app)); const first = await app.read();
    expect(success(await sync(app)).status.outcome).toBe('unchanged');
    app.setNow('2026-10-04T12:05:00.000Z');
    app.setHtml(source([[1, '11:00', '12:00'], [1, '10:00', '11:00']]));
    const checked = success(await sync(app)); const after = await app.read();
    expect(checked.status).toMatchObject({ outcome: 'unchanged', lastSuccessAt: '2026-10-04T12:05:00.000Z', effectiveChangeAt: '2026-10-04T12:00:00.000Z' });
    expect(after.dataRevision).toBe(first.dataRevision);
    expect(after.schedulingInputRevision).toBe(first.schedulingInputRevision);
    expect(after.imports).toEqual(first.imports); expect(after.importedAvailability).toEqual(first.importedAvailability);
    expect(after.recurringAvailability).toEqual(first.recurringAvailability);
    expect(app.fetches).toHaveLength(3);
  });
  it('rechecks identical source content after a human edit and repairs only recurring availability', async () => {
    const app = await application(); app.setHtml(source());
    success(await sync(app));
    // Exercise the small unchanged check before invalidating its synchronized revision.
    app.setNow('2026-10-04T12:05:00.000Z'); success(await sync(app));
    success(await app.request('volunteer.availability.recurring.update', { intervals: [
      { weekday: 2, start: '13:00', end: '14:00', timeZone: 'America/New_York' },
    ] }, 'volunteer'));
    success(await app.request('volunteer.availability.exception.create', { date: '2026-10-06', kind: 'unavailable', start: '10:00', end: '11:00', timeZone: 'America/New_York', reason: 'Keep this dated exception' }, 'volunteer'));
    const before = await app.read();
    const checked = success(await sync(app)); const after = await app.read();
    expect(checked.status.outcome).toBe('changed');
    expect(after.recurringAvailability.filter(row => row.volunteerId === 'volunteer-1')).toMatchObject([{ weekday: 1, start: '10:00', end: '12:00' }]);
    expect(after.availabilityExceptions).toEqual(before.availabilityExceptions);
    expect(after.dataRevision).toBe(before.dataRevision + 1);
    expect(after.schedulingInputRevision).toBe(before.schedulingInputRevision + 1);
    expect(after.imports).toHaveLength(before.imports.length + 1);
    const unchanged = success(await sync(app));
    expect(unchanged.status.outcome).toBe('unchanged');
    expect((await app.read()).imports).toEqual(after.imports);
  });
  it('reinterprets identical source bytes after a stored parser-version change', async () => {
    const app = await application(); app.setHtml(source()); success(await sync(app));
    const first = await app.read();
    // Simulate persisted output from an older parser that interpreted the day differently.
    const participants = first.synchronizations[0]!.participants.map(row => ({ ...row,
      intervals: row.intervals.map(interval => ({ ...interval, weekday: 2 })),
    }));
    await app.db.batch([
      app.db.prepare("UPDATE meta SET value='legacy-parser:' || value WHERE key='synchronizedSourceHash'"),
      app.db.prepare("UPDATE synchronizations SET participants=? WHERE id='whenIsGood'").bind(JSON.stringify(participants)),
      app.db.prepare("UPDATE recurring_availability SET weekday=2 WHERE volunteer_id='volunteer-1'"),
    ]);
    expect(success(await sync(app)).status.outcome).toBe('changed');
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toMatchObject([{ weekday: 1, start: '10:00', end: '12:00' }]);
    const corrected = await app.read();
    expect(corrected.imports).toHaveLength(first.imports.length + 1);
    expect(success(await sync(app)).status.outcome).toBe('unchanged');
    expect((await app.read()).imports).toEqual(corrected.imports);
  });
  it('refreshes present pending timestamps on identical checks while retaining disappeared submissions', async () => {
    const app = await application();
    const person = (id: string) => ({ id, name: id, email: `${id}@example.test`, availability: [] });
    app.setHtml(JSON.stringify({ participants: [person('first-new'), person('second-new')] }));
    success(await sync(app));
    app.setNow('2026-10-04T12:05:00.000Z');
    app.setHtml(JSON.stringify({ participants: [person('first-new')] }));
    const before = success(await sync(app));
    app.setNow('2026-10-04T12:10:00.000Z');
    const after = success(await sync(app));
    expect(after.status.outcome).toBe('unchanged');
    expect(after.pending.find(row => row.id === 'first-new')).toMatchObject({ present: true, firstSeenAt: '2026-10-04T12:00:00.000Z', lastSeenAt: '2026-10-04T12:10:00.000Z' });
    expect(after.pending.find(row => row.id === 'second-new')).toEqual(before.pending.find(row => row.id === 'second-new'));
    expect(after.dataRevision).toBe(before.dataRevision);
  });
  it('clears only explicitly empty participant availability and preserves missing volunteers', async () => {
    const app = await application(); const before = await app.read();
    app.setHtml(source([])); success(await sync(app));
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toEqual([]);
    expect((await app.read()).recurringAvailability.filter(row => row.volunteerId !== 'volunteer-1')).toEqual(before.recurringAvailability.filter(row => row.volunteerId !== 'volunteer-1'));
    app.setHtml(JSON.stringify({ participants: [{ id: 'new', name: 'New Participant', email: 'new@example.test', availability: [] }] }));
    success(await sync(app));
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toEqual([]);
  });
  it('queues new and missing-email participants, links immediately and preserves mappings on later polls', async () => {
    const app = await application();
    const html = (end: string) => JSON.stringify({ participants: [
      { id: 'new', name: 'New Person', email: 'new@example.test', availability: [[2, '13:00', end]] },
      { id: 'no-email', name: 'Interested Person', availability: [] },
    ] });
    app.setHtml(html('14:00')); const first = success(await sync(app));
    expect(first.pending.map(row => [row.id, row.reason])).toEqual([['new', 'new'], ['no-email', 'missing-identity']]);
    const before = await app.read();
    app.setNow('2026-10-04T12:05:00.000Z'); success(await sync(app));
    expect(success(await app.request('admin.sync.read')).pending).toHaveLength(2);
    expect((await app.read()).users).toEqual(before.users); expect((await app.read()).volunteers).toEqual(before.volunteers);
    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'new', volunteerId: 'volunteer-1' }));
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toMatchObject([{ weekday: 2, start: '13:00', end: '14:00' }]);
    expect(success(await app.request('admin.sync.read')).pending.map(row => row.id)).toEqual(['no-email']);
    app.setHtml(html('15:00')); success(await sync(app));
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toMatchObject([{ weekday: 2, end: '15:00' }]);
    expect((await app.read()).importMappings).toHaveLength(1);
  });
  it.each([
    '<script>{"participants":[]}</script>',
    '<html>temporarily unavailable private-body</html>',
    source([[1, '10:00', '12:00'], [1, 'invalid', '13:00']]),
    source([[1, '10:00', '12:00', 'Europe/London']]),
    JSON.stringify({ timeZone: 'UTC', participants: [{ id: 'alex-source', name: 'Alex', email: 'alex@example.test', availability: [] }] }),
    JSON.stringify({ participants: [{ id: 'alex-source', name: 'Alex', email: 'alex@example.test' }] }),
  ])('rejects an invalid complete snapshot and recovers without losing valid domain state: %s', async html => {
    const app = await application(); app.setHtml(source()); success(await sync(app)); const before = await app.read();
    app.setNow('2026-10-04T12:05:00.000Z'); app.setHtml(html);
    const failed = success(await sync(app));
    expect(failed.status).toMatchObject({ outcome: 'failed', lastSuccessAt: '2026-10-04T12:00:00.000Z' });
    expect(JSON.stringify(failed.status)).not.toContain('private-body');
    const after = await app.read();
    expect(after.recurringAvailability).toEqual(before.recurringAvailability); expect(after.imports).toEqual(before.imports);
    expect(after.dataRevision).toBe(before.dataRevision); expect(after.schedulingInputRevision).toBe(before.schedulingInputRevision);
    app.setHtml(source([[3, '13:00', '14:00']]));
    expect(success(await sync(app)).status).toMatchObject({ outcome: 'changed', diagnostic: null });
  });
  it('records sanitized fetch failures without invalidating a human revision and recovers', async () => {
    const app = await application(); app.setHtml(source()); success(await sync(app)); const before = await app.read();
    app.setFetchFails(true); const failed = success(await sync(app));
    expect(failed.status.outcome).toBe('failed'); expect(failed.status.diagnostic).toContain('fetch');
    expect((await app.read()).recurringAvailability).toEqual(before.recurringAvailability);
    expect((await app.read()).dataRevision).toBe(before.dataRevision);
    app.setFetchFails(false); expect(success(await sync(app)).status.outcome).toBe('unchanged');
  });
  it('restricts queue and diagnostics to administrators and cannot decode a system actor from HTTP', async () => {
    const app = await application(); app.setHtml(source()); success(await sync(app));
    for (const actor of ['volunteer', 'contact'] as const) for (const operation of ['admin.sync.read', 'admin.sync.now', 'admin.import.mapping.upsert'] as const) {
      expect(await app.request(operation, operation === 'admin.import.mapping.upsert' ? { sourceParticipantId: 'alex-source', volunteerId: 'volunteer-1' } : {}, actor)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    const dashboard = success(await app.request('volunteer.dashboard', {}, 'volunteer'));
    expect(dashboard.freshness).toEqual({ lastSuccessAt: '2026-10-04T12:00:00.000Z', problem: false });
    expect(dashboard).not.toHaveProperty('pending');
    expect(dashboard).not.toHaveProperty('diagnostic');
    expect(JSON.parse(await app.rawRequest({ operation: 'system.sync', payload: {}, credential: 'admin' }))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await app.request('admin.sync.now', { actor: { kind: 'system' } })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });
  it('prevents an obsolete staged promotion after automatic synchronization advances', async () => {
    const app = await application(); success(await app.request('admin.import.whenIsGood.preview'));
    app.setHtml(source()); success(await sync(app)); const before = await app.read();
    expect(await app.request('admin.import.whenIsGood.promote')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect((await app.read()).recurringAvailability).toEqual(before.recurringAvailability);
    expect(success(await app.request('admin.sync.read')).imports.some(row => row.status === 'staged')).toBe(true);
  });
  it('runs overlapping system checks without Google and applies one durable effective update', async () => {
    const app = await application(); app.setHtml(source());
    const results = await Promise.all([0, 1].map(() => Effect.runPromise(synchronize(testConfig, synchronizationSystemActor).pipe(Effect.provide(app.layer)))));
    for (const response of results) Schema.decodeUnknownSync(resultSchemas['admin.sync.now'])(JSON.parse(response).data);
    const after = await app.read(); expect(after.dataRevision).toBe(1); expect(after.schedulingInputRevision).toBe(1);
    expect(after.imports).toHaveLength(1); expect(after.importedAvailability).toHaveLength(1);
    expect(app.notifications).toHaveLength(0);
  });

  it('updates matched weekly availability and preserves exceptions and published commitments', async () => {
    const app = await application(); await addPublishedFixture(app);
    success(await app.request('volunteer.availability.exception.create', { date: '2026-10-06', kind: 'unavailable', start: '10:00', end: '11:00', timeZone: 'America/New_York' }, 'volunteer'));
    success(await app.request('volunteer.assignment.cancel', { assignmentId: 'assignment-1' }, 'volunteer'));
    app.setHtml(source()); const before = await app.read();
    const result = await sync(app);
    expect(result.ok).toBe(true);
    const dashboard = success(await app.request('volunteer.dashboard', {}, 'volunteer'));
    expect(dashboard.recurringAvailability).toMatchObject([{ weekday: 1, start: '10:00', end: '12:00' }]);
    const after = await app.read();
    expect(after.availabilityExceptions).toEqual(before.availabilityExceptions);
    expect(after.assignments).toEqual(before.assignments);
    expect(after.backups).toEqual(before.backups);
    expect(after.candidateSchedules).toEqual(before.candidateSchedules);
    expect(after.recurringAvailability.filter(row => row.volunteerId !== 'volunteer-1')).toEqual(before.recurringAvailability.filter(row => row.volunteerId !== 'volunteer-1'));
    expect(success(await app.request('admin.schedule.read')).stale).toBe(true);
    expect(app.notifications).toHaveLength(2); // Only human exception/cancellation actions generated email.
    expect(after.schedulingInputRevision).toBe(before.schedulingInputRevision + 1);
  });
  it('keeps the last successful fetch time and unresolved source failure when linking saved participants', async () => {
    const app = await application(); app.setHtml(JSON.stringify({ participants: [{ id: 'new', name: 'New Person', email: 'new@example.test', availability: [[2, '13:00', '14:00']] }] }));
    success(await sync(app)); app.setNow('2026-10-04T12:05:00.000Z'); app.setFetchFails(true); success(await sync(app));
    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'new', volunteerId: 'volunteer-1' }));
    expect(success(await app.request('admin.sync.read')).status).toMatchObject({ lastSuccessAt: '2026-10-04T12:00:00.000Z', outcome: 'failed' });
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toMatchObject([{ weekday: 2, start: '13:00' }]);
  });

  it('rejects a snapshot containing a malformed participant beside valid records', async () => {
    const app = await application(); app.setHtml(source()); success(await sync(app)); const before = await app.read();
    app.setHtml(JSON.stringify({ participants: [JSON.parse(source([[2, '10:00', '12:00']])).participants[0], 'invalid participant'] }));
    expect(success(await sync(app)).status.outcome).toBe('failed');
    expect((await app.read()).recurringAvailability).toEqual(before.recurringAvailability);
  });

  it('queues duplicate identities without merging people and persists distinct ID mappings', async () => {
    const app = await application();
    const html = (end: string) => JSON.stringify({ participants: [
      { id: 'p1', name: ' Alex Lee ', email: ' SHARED@example.test ', availability: [[1, '09:00', '10:00']] },
      { id: 'p2', name: 'alex lee', email: 'shared@example.test', availability: [[3, '13:00', end]] },
      { id: 'no-name', name: '', email: null, availability: [] },
    ] });
    app.setHtml(html('14:00')); const before = await app.read();
    const view = success(await sync(app));
    expect(view.pending.map(row => [row.id, row.reason])).toEqual([['p1', 'ambiguous'], ['p2', 'ambiguous'], ['no-name', 'missing-identity']]);
    expect((await app.read()).recurringAvailability).toEqual(before.recurringAvailability);
    for (const [sourceParticipantId, volunteerId] of [['p1', 'volunteer-1'], ['p2', 'volunteer-2']]) success(await app.request('admin.import.mapping.upsert', { sourceParticipantId, sourceEmail: 'shared@example.test', sourceName: 'Alex Lee', volunteerId }));
    app.setHtml(html('15:00')); success(await sync(app));
    expect((await app.read()).importMappings).toHaveLength(2);
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toMatchObject([{ weekday: 1, start: '09:00', end: '10:00' }]);
    expect((await app.read()).recurringAvailability.filter(row => row.volunteerId === 'volunteer-2')).toMatchObject([{ weekday: 3, start: '13:00', end: '15:00' }]);
    expect(success(await app.request('admin.sync.read')).pending.map(row => row.id)).toEqual(['no-name']);
  });
  it('keeps unstable and conflicting source IDs pending until their source identities are corrected', async () => {
    const app = await application(); const before = await app.read();
    app.setHtml(JSON.stringify({ participants: [
      { name: 'Alex', email: 'alex@example.test', availability: [[1, '12:00', '13:00']] },
      { id: 'collision', name: 'First Person', email: 'first@example.test', availability: [[1, '13:00', '14:00']] },
      { id: 'collision', name: 'Second Person', email: 'second@example.test', availability: [[2, '13:00', '14:00']] },
    ] }));
    const view = success(await sync(app));
    expect(view.pending).toHaveLength(2); expect(view.pending.every(row => !row.resolvable)).toBe(true);
    expect(view.pending.find(row => row.id === 'collision')).toHaveProperty('conflictingSubmissions', expect.arrayContaining([
      expect.objectContaining({ name: 'First Person', intervals: [{ weekday: 1, start: '13:00', end: '14:00', timeZone: 'America/New_York' }] }),
      expect.objectContaining({ name: 'Second Person', intervals: [{ weekday: 2, start: '13:00', end: '14:00', timeZone: 'America/New_York' }] }),
    ]));
    expect((await app.read()).recurringAvailability).toEqual(before.recurringAvailability);
    for (const participant of view.pending) expect(await app.request('admin.import.mapping.upsert', { sourceParticipantId: participant.id, volunteerId: 'volunteer-1' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    app.setHtml(source()); success(await sync(app));
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toMatchObject([{ start: '10:00', end: '12:00' }]);
  });
  it('keeps disappeared pending submissions visible without applying their old availability', async () => {
    const app = await application();
    app.setHtml(JSON.stringify({ participants: [{ id: 'new', name: 'New Person', email: 'new@example.test', availability: [[2, '13:00', '14:00']] }] }));
    const first = success(await sync(app)).pending[0]!;
    app.setNow('2026-10-04T12:30:00.000Z'); app.setHtml(source()); success(await sync(app));
    const disappeared = success(await app.request('admin.sync.read')).pending[0]!;
    expect(disappeared).toMatchObject({ id: 'new', present: false, firstSeenAt: first.firstSeenAt, lastSeenAt: first.lastSeenAt });
    expect(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'new', volunteerId: 'volunteer-2' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });
  it.each([false, true])('retries against a concurrent human update without losing dated exceptions (previous sync: %s)', async previouslySynced => {
    let arrived!: () => void; let release!: (html: string) => void;
    const fetching = new Promise<void>(resolve => { arrived = resolve; });
    const response = new Promise<string>(resolve => { release = resolve; });
    let delay = false;
    const app = await application({ fetchResults: async () => { if (!delay) return source(); arrived(); return response; } });
    if (previouslySynced) success(await sync(app));
    const revision = (await app.read()).dataRevision;
    delay = true;
    const syncing = sync(app); await fetching;
    success(await app.request('volunteer.availability.exception.create', { date: '2026-10-06', kind: 'unavailable', start: '10:00', end: '11:00', timeZone: 'America/New_York', reason: 'Human change' }, 'volunteer'));
    release(source()); success(await syncing);
    const dashboard = success(await app.request('volunteer.dashboard', {}, 'volunteer'));
    expect(dashboard.availabilityExceptions).toMatchObject([{ reason: 'Human change' }]);
    expect(dashboard.recurringAvailability).toMatchObject([{ start: '10:00', end: '12:00' }]);
    expect(dashboard.dataRevision).toBe(revision + 1 + Number(!previouslySynced));
  });
  it.each([false, true])('does not overwrite a newer source check when an older fetch finishes last (previous sync: %s)', async previouslySynced => {
    let arrived!: () => void; let release!: (html: string) => void; let delayed = true;
    const fetching = new Promise<void>(resolve => { arrived = resolve; });
    const response = new Promise<string>(resolve => { release = resolve; });
    let priming = previouslySynced;
    const app = await application({ fetchResults: async () => { if (priming) return source(); if (delayed) { delayed = false; arrived(); return response; } return source([[4, '14:00', '15:00']]); } });
    if (previouslySynced) { success(await sync(app)); priming = false; }
    const older = Effect.runPromise(synchronize(testConfig, synchronizationSystemActor).pipe(Effect.provide(app.layer))); await fetching;
    success(await sync(app)); release(source()); await older;
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toMatchObject([{ weekday: 4, start: '14:00', end: '15:00' }]);
    expect((await app.read()).imports).toHaveLength(previouslySynced ? 2 : 1);
  });
  it('rolls back an interrupted transaction and safely retries the same intent once storage recovers', async () => {
    const app = await application(); app.setHtml(source()); const before = await app.read();
    // A synthetic storage failure partway through an actual D1 transaction.
    await app.db.prepare("CREATE TRIGGER fail_sync BEFORE INSERT ON recurring_availability BEGIN SELECT RAISE(ABORT, 'Synthetic interrupted write'); END").run();
    const metadata = { expectedRevision: 0, idempotencyKey: 'recoverable-sync' };
    expect(await app.request('admin.sync.now', {}, 'admin', metadata)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(await app.read()).toEqual(before);
    await app.db.prepare('DROP TRIGGER fail_sync').run();
    const result = success(await app.request('admin.sync.now', {}, 'admin', metadata));
    expect(success(await app.request('admin.sync.now', {}, 'admin', metadata))).toEqual(result);
    expect((await app.read()).imports).toHaveLength(1); expect((await app.read()).importedAvailability).toHaveLength(1);
  });
  it('compares normalized participant content so cosmetic edits leave history and revisions unchanged', async () => {
    const app = await application(); app.setHtml(source()); success(await sync(app)); const before = await app.read();
    app.setHtml(JSON.stringify({ participants: [{ id: 'alex-source', name: '  ALEX  ', email: ' ALEX@EXAMPLE.TEST ', availability: [[1, '10:00', '12:00']] }] }));
    expect(success(await sync(app)).status.outcome).toBe('unchanged');
    expect((await app.read()).imports).toEqual(before.imports); expect((await app.read()).dataRevision).toBe(before.dataRevision);
  });

  it('remembers a resolved source identity across disappearance and flags a conflicting return', async () => {
    const app = await application(); app.setHtml(source()); success(await sync(app));
    app.setHtml(JSON.stringify({ participants: [{ id: 'other', name: 'Other Person', email: 'other@example.test', availability: [] }] })); success(await sync(app));
    const before = await app.read();
    app.setHtml(JSON.stringify({ participants: [{ id: 'alex-source', name: 'Blair Example', email: 'blair@example.test', availability: [[2, '14:00', '15:00']] }] }));
    const view = success(await sync(app));
    expect(view.pending).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'alex-source', reason: 'ambiguous' })]));
    expect((await app.read()).recurringAvailability).toEqual(before.recurringAvailability);
    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'alex-source', volunteerId: 'volunteer-2' }));
    expect((await app.read()).recurringAvailability.filter(row => row.volunteerId === 'volunteer-2')).toMatchObject([{ weekday: 2, start: '14:00' }]);
  });

  it('queues a native submission with insufficient identity while retaining its submitted times', async () => {
    const app = await application();
    const html = await readFile(new URL('../fixtures/import-native.html', import.meta.url), 'utf8');
    app.setHtml(html.replace('r1.name = "Alice";', 'r1.name = "";'));
    const view = success(await sync(app));
    expect(view.status.outcome).toBe('changed');
    expect(view.pending).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'a', name: '', reason: 'missing-identity', intervals: [{ weekday: 1, start: '09:00', end: '11:00', timeZone: 'America/New_York' }] })]));
  });

  it.each(['14:00', '15:00'])('uses a mapping saved during a source fetch and still applies the newest valid source times (end: %s)', async end => {
    const html = (end: string) => JSON.stringify({ participants: [{ id: 'new', name: 'New Person', email: 'new@example.test', availability: [[2, '13:00', end]] }] });
    let first = true; let arrived!: () => void; let release!: (value: string) => void;
    const fetching = new Promise<void>(resolve => { arrived = resolve; });
    const response = new Promise<string>(resolve => { release = resolve; });
    const app = await application({ fetchResults: async () => { if (first) { first = false; return html('14:00'); } arrived(); return response; } });
    success(await sync(app));
    const checking = Effect.runPromise(synchronize(testConfig, synchronizationSystemActor).pipe(Effect.provide(app.layer))); await fetching;
    success(await app.request('admin.import.mapping.upsert', { sourceParticipantId: 'new', volunteerId: 'volunteer-1' }));
    release(html(end)); await checking;
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toMatchObject([{ weekday: 2, end }]);
    expect(success(await app.request('admin.sync.read')).pending).toEqual([]);
  });

  it('rejects partial native respondent snapshots instead of silently dropping a broken respondent', async () => {
    const app = await application(); const before = await app.read();
    const html = await readFile(new URL('../fixtures/import-native.html', import.meta.url), 'utf8');
    app.setHtml(html.replace('respondents["participant-2"] = r2;', 'respondents["participant-2"] = missingRespondent;'));
    expect(success(await sync(app)).status.outcome).toBe('failed');
    expect((await app.read()).recurringAvailability).toEqual(before.recurringAvailability);
    expect((await app.read()).imports).toEqual(before.imports);
  });

  it('preserves an existing roster and staged import history when the additive migration is applied', async () => {
    const app = await application(); success(await app.request('admin.import.whenIsGood.preview')); const before = await app.read();
    await app.db.prepare('DROP TABLE synchronizations').run();
    const migration = await readFile(new URL('../../migrations/0002_synchronization.sql', import.meta.url), 'utf8');
    await applySql(app.db, migration);
    expect(await app.read()).toEqual(before);
    app.setHtml(source()); success(await sync(app));
    expect(success(await app.request('admin.sync.read')).imports.some(row => row.id === before.imports[0]!.id)).toBe(true);
  });
  it('aggregates participants mapped to one volunteer and clears only when their combined availability is empty', async () => {
    const app = await application();
    const html = (availability: unknown[]) => JSON.stringify({ participants: [
      { id: 'p1', name: 'First Submission', email: 'first@example.test', availability },
      { id: 'p2', name: 'Second Submission', email: 'second@example.test', availability: [] },
    ] });
    app.setHtml(html([[1, '09:00', '10:00'], [1, '10:00', '11:00']])); success(await sync(app));
    for (const sourceParticipantId of ['p1', 'p2']) success(await app.request('admin.import.mapping.upsert', { sourceParticipantId, volunteerId: 'volunteer-1' }));
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toMatchObject([{ start: '09:00', end: '11:00' }]);
    app.setHtml(html([])); success(await sync(app));
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toEqual([]);
  });

  it('preserves every unresolved submission when weak name and email identities coincide', async () => {
    const app = await application();
    app.setHtml(JSON.stringify({ participants: [
      { name: 'Same Name', email: 'shared@example.test', availability: [[1, '09:00', '10:00']] },
      { name: 'Same Name', email: 'shared@example.test', availability: [[2, '13:00', '14:00']] },
    ] }));
    const view = success(await sync(app));
    expect(view.status.participantCount).toBe(2);
    expect(view.pending[0]).toMatchObject({ resolvable: false, conflictingSubmissions: [
      { intervals: [{ weekday: 1, start: '09:00', end: '10:00' }] },
      { intervals: [{ weekday: 2, start: '13:00', end: '14:00' }] },
    ] });
  });

  it('retains separate identical-looking submissions rather than inferring one person from equal weak fields', async () => {
    const app = await application();
    const submission = { name: 'Same Name', email: 'shared@example.test', availability: [] };
    app.setHtml(JSON.stringify({ participants: [submission, submission] }));
    const view = success(await sync(app));
    expect(view.status.participantCount).toBe(2);
    expect(view.pending[0]).toMatchObject({ resolvable: false });
    expect(view.pending[0]?.conflictingSubmissions).toHaveLength(2);
  });

  it('prefers a known stable source identity over a conflicting weak mapping and saves resolution by source ID', async () => {
    const app = await application();
    success(await app.request('admin.import.mapping.upsert', { sourceEmail: 'alex@example.test', volunteerId: 'volunteer-1' }));
    app.setHtml(JSON.stringify({ participants: [
      { id: 'alex-source', name: 'Alex Example', email: 'alex@example.test', availability: [[1, '10:00', '12:00']] },
      { id: 'blair-source', name: 'Blair Example', email: 'blair@example.test', availability: [[2, '13:00', '14:00']] },
    ] })); success(await sync(app)); const before = await app.read();
    app.setHtml(JSON.stringify({ participants: [{ id: 'blair-source', name: 'Blair Example', email: 'alex@example.test', availability: [[4, '16:00', '17:00']] }] }));
    expect(success(await sync(app)).pending).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'blair-source', reason: 'ambiguous' })]));
    expect((await app.read()).recurringAvailability).toEqual(before.recurringAvailability);
    const linked = success(await app.request('admin.import.mapping.upsert', { sourceEmail: 'alex@example.test', volunteerId: 'volunteer-2' }));
    expect(linked.mapping.sourceParticipantId).toBe('blair-source');
    expect((await app.read()).importMappings).toHaveLength(2);
    expect((await app.read()).recurringAvailability.filter(row => row.volunteerId === 'volunteer-2')).toMatchObject([{ weekday: 4, start: '16:00', end: '17:00' }]);
  });

  it.each([false, true])('rechecks administrator authority after conflicting account changes while scheduled authority remains independent (previous sync: %s)', async previouslySynced => {
    let arrived!: () => void; let release!: (html: string) => void;
    const fetching = new Promise<void>(resolve => { arrived = resolve; });
    const response = new Promise<string>(resolve => { release = resolve; });
    let delay = false;
    const app = await application({ fetchResults: async () => { if (!delay) return source(); arrived(); return response; } });
    if (previouslySynced) success(await sync(app));
    delay = true;
    const before = await app.read(); const manual = sync(app); await fetching;
    // Operator account administration is an external boundary, simulated only in this disposable D1.
    await app.db.batch([
      app.db.prepare("UPDATE users SET roles='[]' WHERE id='user-admin'"),
      app.db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='dataRevision'"),
    ]);
    release(source());
    expect(await manual).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect((await app.read()).recurringAvailability).toEqual(before.recurringAvailability);
    await Effect.runPromise(synchronize(testConfig, synchronizationSystemActor).pipe(Effect.provide(app.layer)));
    expect(success(await app.request('volunteer.dashboard', {}, 'volunteer')).recurringAvailability).toMatchObject([{ start: '10:00', end: '12:00' }]);
  });
  it('matches a participant to a volunteer on the next check after an administrator corrects the email', async () => {
    const app = await application();
    app.setHtml(JSON.stringify({ participants: [{ id: 'casey-source', name: 'Casey', email: ' Casey.New@Example.test', availability: [[3, '13:00', '14:00']] }] }));
    expect(success(await sync(app)).pending.map(row => [row.id, row.reason])).toEqual([['casey-source', 'new']]);
    success(await app.request('admin.volunteer.update', { volunteerId: 'volunteer-3', name: 'Casey Example', email: 'casey.new@example.test' }));
    app.setNow('2026-10-04T12:05:00.000Z');
    const checked = success(await sync(app));
    expect(checked.pending).toEqual([]);
    expect(checked.status).toMatchObject({ participantCount: 1, matchedCount: 1, pendingCount: 0 });
    expect((await app.read()).recurringAvailability.filter(row => row.volunteerId === 'volunteer-3')).toMatchObject([{ weekday: 3, start: '13:00', end: '14:00' }]);
  });

});
