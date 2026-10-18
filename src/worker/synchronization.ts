import { syncStatus } from '../shared/domain/synchronizationView';
export { syncStatus, synchronizationView } from '../shared/domain/synchronizationView';
import { Effect } from 'effect';
import { AppError } from '../shared/api/errors';
import { decodeResult } from './api/validation';
import { emptySyncStatus, type ImportParticipant, type PendingParticipant, type Snapshot, type StagedParticipant, type WeeklyInterval } from '../shared/domain/models';
import { normalizeWeeklyIntervals } from '../shared/domain/intervals';
import { normalizeImportEmail, normalizeImportName, parseWhenIsGood, stageParticipants, weeklyAvailabilityByVolunteer, whenIsGoodParserVersion } from '../shared/imports/whenIsGood';
import { whenIsGoodSource, type AppConfig } from './config';
import { canUseOperation } from './api/policies';
import { applyImportedAvailability } from './importAvailability';
import { Database, schedulingInputsChanged, type IdempotencyKey, type CommitInput } from './services/Database';
import { Clock } from './services/Clock';
import { IdGenerator } from './services/IdGenerator';
import { WhenIsGoodClient } from './services/WhenIsGoodClient';

export type SyncActor = { kind: 'system'; id: 'system:whenIsGood' } | { kind: 'administrator'; id: string };
export const synchronizationSystemActor: SyncActor = { kind: 'system', id: 'system:whenIsGood' };
export function freshness(state: Snapshot) {
  const status = syncStatus(state);
  return { lastSuccessAt: status.lastSuccessAt, problem: status.outcome === 'failed' };
}
const content = (participants: StagedParticipant[]) => '[' + participants.map(row => JSON.stringify({
  id: row.id, name: normalizeImportName(row.name), email: normalizeImportEmail(row.email),
  intervals: normalizeWeeklyIntervals(row.intervals), volunteerId: row.volunteerId,
  identityStable: row.identityStable !== false, pendingReason: row.pendingReason ?? null,
})).sort((a, b) => a.localeCompare(b)).join(',') + ']';
const weeklyContent = (intervals: WeeklyInterval[]) => JSON.stringify(normalizeWeeklyIntervals(intervals.map(({ weekday, start, end, timeZone }) => ({ weekday, start, end, timeZone }))));

// Exact parsed-source equality is deliberately narrower than semantic equality.
// Cosmetic/order changes take the normal path, which still avoids extra history.
const sourceContent = (participants: ImportParticipant[]) => JSON.stringify(participants.map(({ id, name, email, intervals, identityStable }) => ({
  id, name, email, intervals, identityStable: identityStable !== false,
})));

export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Shared source application for polls and mapping resolution; no database or authentication tricks. */
export function applySynchronizedParticipants(state: Snapshot, participants: ImportParticipant[], now: Date, actor: SyncActor, checkedSource = true, checkId: string | null = null) {
  return Effect.gen(function* () {
    const ids = yield* IdGenerator;
    const previous = state.synchronizations[0];
    const knownParticipants = [...(previous?.participants ?? []), ...[...state.imports].reverse()
      .filter(run => run.source === 'whenIsGood' && run.status === 'completed' && run.resultId === whenIsGoodSource.resultId)
      .flatMap(run => run.stagedAvailability)];
    const staged = stageParticipants(participants, state.volunteers, state.importMappings, knownParticipants);
    const presentIds = new Set(participants.map(row => row.id));
    const pending: PendingParticipant[] = (previous?.pending ?? []).filter(row => !presentIds.has(row.id)).map(row => ({ ...row, present: false }));
    for (const participant of staged.stagedAvailability) {
      if (participant.volunteerId || pending.some(row => row.id === participant.id)) continue;
      const prior = previous?.pending.find(row => row.id === participant.id);
      const { volunteerId: _id, pendingReason, ...fields } = participant;
      const submissions = staged.stagedAvailability.filter(row => row.id === participant.id).map(({ volunteerId: _id, pendingReason: _reason, ...row }) => row);
      pending.push({ ...fields, ...(submissions.length > 1 ? { conflictingSubmissions: submissions } : {}), resolvable: participant.identityStable !== false && staged.stagedAvailability.filter(row => row.id === participant.id).length === 1, reason: pendingReason ?? 'new', present: true,
        firstSeenAt: prior?.firstSeenAt ?? now.toISOString(), lastSeenAt: now.toISOString() });
    }
    const byVolunteer = weeklyAvailabilityByVolunteer(staged.stagedAvailability);
    const changedVolunteers = new Set([...byVolunteer].filter(([id, intervals]) => weeklyContent(intervals) !== weeklyContent(state.recurringAvailability.filter(row => row.volunteerId === id))).map(([id]) => id));
    const stagedContent = content(staged.stagedAvailability);
    const sourceChanged = stagedContent !== content(previous?.participants ?? []);
    const changed = sourceChanged || changedVolunteers.size > 0;
    if (changed) {
      const runId = yield* ids.next;
      const contentHash = yield* Effect.tryPromise({
        try: () => digest(stagedContent),
        catch: () => new AppError('INTERNAL_ERROR', 'Could not record synchronization content.'),
      });
      state.imports.push({ id: runId, source: 'whenIsGood', resultId: whenIsGoodSource.resultId, contentHash,
        status: 'completed', actorId: actor.id, startedAt: now.toISOString(), completedAt: now.toISOString(),
        promotedAt: now.toISOString(), promotedBy: actor.id, participantCount: participants.length, ...staged, diagnostic: null });
      // An empty replacement is captured in the run even though it has no interval provenance rows.
      yield* applyImportedAvailability(state, { participants: staged.stagedAvailability, runId, now,
        replaceVolunteers: changedVolunteers, recordVolunteers: sourceChanged ? new Set(byVolunteer.keys()) : changedVolunteers });
    }
    state.synchronizations = [{ id: 'whenIsGood', generation: (previous?.generation ?? 0) + 1, checkId: checkedSource ? checkId : previous?.checkId ?? null,
      lastAttemptAt: checkedSource ? now.toISOString() : previous?.lastAttemptAt ?? null, lastSuccessAt: checkedSource ? now.toISOString() : previous?.lastSuccessAt ?? null, effectiveChangeAt: changed ? now.toISOString() : previous?.effectiveChangeAt ?? null,
      outcome: !checkedSource && previous?.outcome === 'failed' ? 'failed' : changed ? 'changed' : 'unchanged', diagnostic: checkedSource ? null : previous?.diagnostic ?? null, participantCount: participants.length,
      matchedCount: staged.matchedCount, pendingCount: pending.length, participants: staged.stagedAvailability, pending }];
    return changed;
  });
}

function syncActorError(actor: SyncActor, state: Snapshot): AppError | null {
  if (actor.kind === 'system') return null;
  const user = state.users.find(row => row.id === actor.id && row.active);
  if (!user) return new AppError('UNAUTHORIZED', 'This account is no longer active.');
  if (!canUseOperation(user, 'admin.sync.now')) return new AppError('FORBIDDEN', 'This account can no longer synchronize availability.');
  return null;
}
export function authorizeSyncActor(actor: SyncActor, state: Snapshot) {
  const error = syncActorError(actor, state);
  return error ? Effect.fail(error) : Effect.void;
}

/** System authority is available only to the scheduled adapter, never decoded from HTTP. */
export function synchronize(config: AppConfig, actor: SyncActor, intent?: { key: IdempotencyKey; fingerprint: string; before?: Snapshot }) {
  return Effect.gen(function* () {
    const database = yield* Database;
    const clock = yield* Clock;
    const ids = yield* IdGenerator;
    const read = database.readSynchronization ?? database.read;
    const readHead = database.readSynchronizationHead ?? read;
    const now = yield* clock.now;
    const key = intent?.key ?? { actorId: actor.id, operation: 'system.sync', idempotencyKey: yield* ids.next };
    const fingerprint = intent?.fingerprint ?? '{}';
    const checked = !intent?.before && database.readSynchronizationCheck
      ? yield* database.readSynchronizationCheck(key, now.toISOString()) : null;
    const started = intent?.before ?? checked?.snapshot ?? (yield* readHead);
    yield* authorizeSyncActor(actor, started);
    // HTTP dispatch already checked the same durable key before handing off its snapshot.
    const replay = intent?.before ? null : checked ? checked.replay : yield* database.findIdempotency(key, now.toISOString());
    if (replay) return replay.response;
    const client = yield* WhenIsGoodClient;
    const downloaded = yield* client.fetchResults(whenIsGoodSource.resultId).pipe(Effect.match({
      onSuccess: html => ({ ok: true as const, html }),
      onFailure: () => ({ ok: false as const, error: 'Could not fetch the results page. It may be unavailable or exceed the size limit.' }),
    }));
    const fetched = downloaded.ok ? yield* Effect.tryPromise({
      try: async () => {
        const sourceHash = `${whenIsGoodParserVersion}:${config.timeZone}:${await digest(downloaded.html)}`;
        const previous = started.synchronizations[0];
        const parsed = previous && started.synchronizedDataRevision === started.dataRevision && started.synchronizedSourceHash === sourceHash
          ? { ok: true as const, participants: previous.participants.map(({ id, name, email, intervals, identityStable }) => ({ id, name, email, intervals, identityStable })) }
          : parseWhenIsGood(downloaded.html, config.timeZone, { strict: true });
        return parsed.ok ? { ...parsed, sourceHash } : parsed;
      },
      catch: () => new AppError('INVALID_REQUEST', 'The source snapshot could not be validated.'),
    }).pipe(Effect.catch(error => Effect.succeed({ ok: false as const, error: error.message }))) : downloaded;
    let before = started;
    let complete = !database.readSynchronizationHead;
    for (let attempt = 0; attempt < 2; attempt++) {
      const unchanged = unchangedSource(before, fetched);
      if (fetched.ok && !unchanged && !complete) {
        before = yield* read;
        complete = true;
      }
      const prepared = yield* prepareSynchronization(actor, fetched, before, started.synchronizations[0]?.checkId ?? null, now, key, fingerprint);
      const committed = yield* database.commit(prepared)
        .pipe(Effect.match({ onSuccess: () => null, onFailure: error => error }));
      if (!committed) return prepared.response;
      const replay = yield* database.findIdempotency(key, now.toISOString());
      if (replay) return replay.response;
      if (committed.code !== 'STALE_REVISION') return yield* Effect.fail(committed);
      if (attempt === 0) { before = yield* readHead; complete = !database.readSynchronizationHead; }
    }
    return yield* Effect.fail(new AppError('CONFLICT', 'Synchronization could not finish because data kept changing. Try Sync now again.'));
  });
}

export type ParsedSource = { ok: true; participants: ImportParticipant[]; sourceHash: string } | { ok: false; error: string };
export function unchangedSource(before: Snapshot, fetched: ParsedSource): boolean {
  return fetched.ok && before.synchronizedDataRevision === before.dataRevision && !!before.synchronizations[0]
    && (fetched.sourceHash === before.synchronizedSourceHash || sourceContent(fetched.participants) === sourceContent(before.synchronizations[0].participants));
}

/** Status-only checks never clone history or acquire Effect services. */
export function prepareSynchronizationStatus(actor: SyncActor, fetched: ParsedSource, before: Snapshot, startedCheckId: string | null, now: Date, key: IdempotencyKey, fingerprint: string): CommitInput | null {
  const superseded = (before.synchronizations[0]?.checkId ?? null) !== startedCheckId;
  const unchanged = unchangedSource(before, fetched);
  if (!superseded && fetched.ok && !unchanged) return null;
  const error = syncActorError(actor, before);
  if (error) throw error;
  const after = { ...before };
  const previous = before.synchronizations[0];
  const checkId = JSON.stringify([key.actorId, key.operation, key.idempotencyKey]);
  if (!superseded) {
    if (unchanged) {
      after.synchronizations = [{ ...previous!, generation: previous!.generation + 1, checkId,
        lastAttemptAt: now.toISOString(), lastSuccessAt: now.toISOString(), outcome: 'unchanged', diagnostic: null,
        pending: previous!.pending.map(row => row.present ? { ...row, lastSeenAt: now.toISOString() } : row) }];
    } else if (!fetched.ok) {
      after.synchronizations = [{ ...emptySyncStatus(), ...previous, id: 'whenIsGood', generation: (previous?.generation ?? 0) + 1, checkId,
        lastAttemptAt: now.toISOString(), outcome: 'failed', diagnostic: fetched.error,
        participants: previous?.participants ?? [], pending: previous?.pending ?? [] }];
    }
  }
  return synchronizationCommit(fetched, before, after, startedCheckId, now, key, fingerprint, false);
}

function synchronizationCommit(fetched: ParsedSource, before: Snapshot, after: Snapshot, startedCheckId: string | null, now: Date, key: IdempotencyKey, fingerprint: string, changed: boolean): CommitInput {
  const dataRevision = before.dataRevision + Number(changed);
  const schedulingInputRevision = before.schedulingInputRevision + Number(changed && schedulingInputsChanged(before, after));
  let data;
  try { data = decodeResult('admin.sync.now', { status: syncStatus(after), dataRevision, schedulingInputRevision }); }
  catch { throw new AppError('INTERNAL_ERROR', 'Invalid synchronization response.'); }
  return { before, after, key, fingerprint, response: JSON.stringify({ ok: true, data }), createdAt: now.toISOString(), advanceDataRevision: changed,
    recordSynchronization: fetched.ok && (before.synchronizations[0]?.checkId ?? null) === startedCheckId,
    ...(fetched.ok ? { synchronizedSourceHash: fetched.sourceHash } : {}) };
}

export function prepareSynchronization(actor: SyncActor, fetched: ParsedSource, before: Snapshot, startedCheckId: string | null, now: Date, key: IdempotencyKey, fingerprint: string) {
  return Effect.gen(function* () {
    const ready = yield* Effect.try({ try: () => prepareSynchronizationStatus(actor, fetched, before, startedCheckId, now, key, fingerprint),
      catch: error => error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'Could not prepare synchronization.') });
    if (ready) return ready;
    yield* authorizeSyncActor(actor, before);
    if (!fetched.ok) return yield* Effect.fail(new AppError('INTERNAL_ERROR', 'Synchronization source is unavailable.'));
    const after = { ...before, imports: [...before.imports], importedAvailability: [...before.importedAvailability] };
    const checkId = JSON.stringify([key.actorId, key.operation, key.idempotencyKey]);
    const changed = yield* applySynchronizedParticipants(after, fetched.participants, now, actor, true, checkId);
    return yield* Effect.try({ try: () => synchronizationCommit(fetched, before, after, startedCheckId, now, key, fingerprint, changed),
      catch: error => error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'Could not prepare synchronization.') });
  });
}
