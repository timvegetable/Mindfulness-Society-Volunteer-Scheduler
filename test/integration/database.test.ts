import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { commit, findIdempotency, readSnapshot, schedulingInputsChanged, type CommitInput } from '../../src/worker/repositories/database';
import { makeDatabase } from '../../src/worker/services/Database';
import { currentRun } from '../../src/shared/domain/scheduler';
import type { Snapshot } from '../../src/shared/domain/models';

const now = '2026-10-04T12:00:00.000Z';
const databases: TestDatabase[] = [];
async function database(seed = true): Promise<TestDatabase> {
  const result = await createTestDatabase({ seed });
  databases.push(result);
  return result;
}
afterEach(async () => { await Promise.all(databases.splice(0).map(item => item.dispose())); });
function input(before: Snapshot, after: Snapshot, key = 'request-1', createdAt = now): CommitInput {
  return { before, after, key: { actorId: 'user-admin', operation: 'test.mutation', idempotencyKey: key }, fingerprint: 'normalized-payload', response: JSON.stringify({ ok: true, data: { dataRevision: before.dataRevision + 1 } }), createdAt };
}

describe('local D1 database transactions', () => {
  it('loads the schema and synthetic seed through the Effect service', async () => {
    const { service } = await database();
    const snapshot = await Effect.runPromise(service.read);
    expect(snapshot.volunteers.map(item => item.id)).toEqual(['volunteer-1', 'volunteer-2', 'volunteer-3', 'volunteer-4', 'volunteer-5']);
    expect(snapshot.users.find(item => item.id === 'user-contact')?.centerIds).toEqual(['center-1']);
    expect(snapshot.centers.every(item => item.active)).toBe(true);
    expect(snapshot.dataRevision).toBe(0);
    expect(snapshot.schedulingInputRevision).toBe(0);
  });

  it('reads missing revision rows as zero and creates them on the first advance', async () => {
    const { db } = await database();
    await db.prepare('DELETE FROM meta').run();
    const before = await readSnapshot(db);
    expect(before.dataRevision).toBe(0);
    expect(before.schedulingInputRevision).toBe(0);
    const after = structuredClone(before);
    after.recurringAvailability[0]!.end = '18:00';
    await commit(db, input(before, after));
    const snapshot = await readSnapshot(db);
    expect(snapshot.dataRevision).toBe(1);
    expect(snapshot.schedulingInputRevision).toBe(1);
  });

  it('allows at most one competing mutation at the same revision', async () => {
    const { db } = await database();
    const before = await readSnapshot(db);
    const a = structuredClone(before);
    const b = structuredClone(before);
    a.centers[0]!.name = 'First contender';
    b.centers[0]!.name = 'Second contender';
    const outcomes = await Promise.allSettled([commit(db, input(before, a, 'first')), commit(db, input(before, b, 'second'))]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find(item => item.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason.code).toBe('STALE_REVISION');
    const snapshot = await readSnapshot(db);
    expect(snapshot.dataRevision).toBe(1);
    expect(snapshot.schedulingInputRevision).toBe(0);
    expect(['First contender', 'Second contender']).toContain(snapshot.centers[0]!.name);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM idempotency').first<{ count: number }>())?.count).toBe(1);
  });

  it('rolls back domain writes, both revisions, retention cleanup and response on a later SQL failure', async () => {
    const { db } = await database();
    await db.prepare('INSERT INTO idempotency VALUES (?, ?, ?, ?, ?, ?)').bind('old', 'test', 'old', 'old', '{}', '2026-10-01T12:00:00.000Z').run();
    const before = await readSnapshot(db);
    const after = structuredClone(before);
    after.recurringAvailability[0]!.end = '18:00';
    after.assignments.push({ id: 'bad-assignment', sessionId: 'missing-session', volunteerId: 'volunteer-1', scheduleRevision: 1, status: 'assigned' });
    await expect(commit(db, input(before, after))).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(await readSnapshot(db)).toEqual(before);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM idempotency').first<{ count: number }>())?.count).toBe(1);
    expect(await findIdempotency(db, input(before, after).key, now)).toBeNull();
  });

  it('retains a durable response after another mutation advances the revision', async () => {
    const { db } = await database();
    const before = await readSnapshot(db);
    const first = input(before, structuredClone(before));
    await commit(db, first);
    const next = await readSnapshot(db);
    await commit(db, input(next, structuredClone(next), 'another-request'));
    const record = await Effect.runPromise(makeDatabase(db).findIdempotency(first.key, now));
    expect(record?.response).toBe(first.response);
    expect(record?.fingerprint).toBe(first.fingerprint);
    expect((await readSnapshot(db)).dataRevision).toBe(2);
  });

  it('keeps the exact 24-hour boundary and removes older records atomically', async () => {
    const { db } = await database();
    const before = await readSnapshot(db);
    const oldest = input(before, before, 'oldest', '2026-10-03T11:59:59.999Z');
    await commit(db, oldest);
    const next = await readSnapshot(db);
    const boundary = input(next, next, 'boundary', '2026-10-03T12:00:00.000Z');
    await commit(db, boundary);
    expect(await findIdempotency(db, oldest.key, now)).toBeNull();
    expect(await findIdempotency(db, boundary.key, now)).not.toBeNull();
    const latest = await readSnapshot(db);
    await commit(db, input(latest, latest, 'latest'));
    const records = await db.prepare('SELECT idempotency_key FROM idempotency ORDER BY idempotency_key').all();
    expect(records.results.map(item => item.idempotency_key)).toEqual(['boundary', 'latest']);
  });

  it('rolls back a duplicate-key commit including retention cleanup and preserves the original response', async () => {
    const { db } = await database();
    const before = await readSnapshot(db);
    const first = input(before, before);
    await commit(db, first);
    await db.prepare('INSERT INTO idempotency VALUES (?, ?, ?, ?, ?, ?)').bind('old', 'test', 'old', 'old', '{}', '2026-10-01T12:00:00.000Z').run();
    const next = await readSnapshot(db);
    const after = structuredClone(next);
    after.recurringAvailability[0]!.end = '19:00';
    await expect(commit(db, input(next, after))).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
    expect(await readSnapshot(db)).toEqual(next);
    expect((await findIdempotency(db, first.key, now))?.response).toBe(first.response);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM idempotency').first<{ count: number }>())?.count).toBe(2);
  });

  it('persists history and selects the greatest completed output rather than staged or failed runs', async () => {
    const { db } = await database();
    const before = await readSnapshot(db);
    const after = structuredClone(before);
    after.schedulingRuns.push(...[
      { id: 'old', outputRevision: 2, status: 'completed' as const },
      { id: 'current', outputRevision: 4, status: 'completed' as const },
      { id: 'staged', outputRevision: 5, status: 'staged' as const },
      { id: 'failed', outputRevision: 6, status: 'failed' as const },
    ].map(run => ({ ...run, inputRevision: 0, assignmentIds: [], backupIds: [], shortfalls: [] })));
    expect(schedulingInputsChanged(before, after)).toBe(false);
    await commit(db, input(before, after));
    const snapshot = await readSnapshot(db);
    expect(snapshot.schedulingRuns).toHaveLength(4);
    expect(currentRun(snapshot)?.id).toBe('current');
    expect(snapshot.schedulingInputRevision).toBe(0);
  });
});
