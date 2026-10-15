import { Effect, Schema } from 'effect';
import { AppError } from '../shared/api/errors';
import { resultSchemas } from '../shared/api/schemas';
import { emptySyncStatus, type ImportParticipant, type PendingParticipant, type Snapshot, type StagedParticipant, type WeeklyInterval } from '../shared/domain/models';
import { normalizeWeeklyIntervals } from '../shared/domain/intervals';
import { normalizeImportEmail, normalizeImportName, parseWhenIsGood, stageParticipants, weeklyAvailabilityByVolunteer } from '../shared/imports/whenIsGood';
import { whenIsGoodSource, type AppConfig } from './config';
import { canUseOperation } from './api/policies';
import { applyImportedAvailability } from './importAvailability';
import { Database, schedulingInputsChanged, type IdempotencyKey } from './services/Database';
import { Clock } from './services/Clock';
import { IdGenerator } from './services/IdGenerator';
import { WhenIsGoodClient } from './services/WhenIsGoodClient';

export type SyncActor = { kind: 'system'; id: 'system:whenIsGood' } | { kind: 'administrator'; id: string };
export const synchronizationSystemActor: SyncActor = { kind: 'system', id: 'system:whenIsGood' };
export function syncStatus(state: Snapshot) {
  const row = state.synchronizations[0];
  if (!row) return emptySyncStatus();
  const { id: _id, generation: _generation, checkId: _checkId, participants: _participants, pending: _pending, ...status } = row;
  return status;
}
export function freshness(state: Snapshot) {
  const status = syncStatus(state);
  return { lastSuccessAt: status.lastSuccessAt, problem: status.outcome === 'failed' };
}
export function synchronizationView(state: Snapshot) {
  return { status: syncStatus(state), pending: state.synchronizations[0]?.pending ?? [],
    imports: state.imports, volunteers: state.volunteers, mappings: state.importMappings };
}
const content = (participants: StagedParticipant[]) => JSON.stringify(participants.map(row => ({
  id: row.id, name: normalizeImportName(row.name), email: normalizeImportEmail(row.email),
  intervals: normalizeWeeklyIntervals(row.intervals), volunteerId: row.volunteerId,
  identityStable: row.identityStable !== false, pendingReason: row.pendingReason ?? null,
})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
const weeklyContent = (intervals: WeeklyInterval[]) => JSON.stringify(normalizeWeeklyIntervals(intervals.map(({ weekday, start, end, timeZone }) => ({ weekday, start, end, timeZone }))));

/** Shared source application for polls and mapping resolution; no database or authentication tricks. */
export function applySynchronizedParticipants(state: Snapshot, participants: ImportParticipant[], config: AppConfig, now: Date, actor: SyncActor, checkedSource = true, checkId: string | null = null) {
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
    const sourceChanged = content(staged.stagedAvailability) !== content(previous?.participants ?? []);
    const changed = sourceChanged || changedVolunteers.size > 0;
    if (changed) {
      const runId = yield* ids.next;
      const contentHash = yield* Effect.tryPromise({
        try: async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content(staged.stagedAvailability)))))
          .map(byte => byte.toString(16).padStart(2, '0')).join(''),
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

function authorizeSyncActor(actor: SyncActor, state: Snapshot) {
  if (actor.kind === 'system') return Effect.void;
  const user = state.users.find(row => row.id === actor.id && row.active);
  if (!user) return Effect.fail(new AppError('UNAUTHORIZED', 'This account is no longer active.'));
  if (!canUseOperation(user, 'admin.sync.now')) return Effect.fail(new AppError('FORBIDDEN', 'This account can no longer synchronize availability.'));
  return Effect.void;
}

/** System authority is available only to the scheduled adapter, never decoded from HTTP. */
export function synchronize(config: AppConfig, actor: SyncActor, intent?: { key: IdempotencyKey; fingerprint: string; before?: Snapshot }) {
  return Effect.gen(function* () {
    const database = yield* Database;
    const clock = yield* Clock;
    const ids = yield* IdGenerator;
    const read = database.readSynchronization ?? database.read;
    const started = intent?.before ?? (yield* read);
    yield* authorizeSyncActor(actor, started);
    const now = yield* clock.now;
    const key = intent?.key ?? { actorId: actor.id, operation: 'system.sync', idempotencyKey: yield* ids.next };
    const fingerprint = intent?.fingerprint ?? '{}';
    const replay = yield* database.findIdempotency(key, now.toISOString());
    if (replay) return replay.response;
    const checkId = JSON.stringify([key.actorId, key.operation, key.idempotencyKey]);
    const client = yield* WhenIsGoodClient;
    const fetched = yield* client.fetchResults(whenIsGoodSource.resultId).pipe(Effect.match({
      onSuccess: html => {
        try { return parseWhenIsGood(html, config.timeZone, { strict: true }); }
        catch { return { ok: false as const, error: 'The source snapshot could not be validated.' }; }
      },
      onFailure: () => ({ ok: false as const, error: 'Could not fetch the results page. It may be unavailable or exceed the size limit.' }),
    }));
    let before = started;
    for (let attempt = 0; attempt < 2; attempt++) {
      yield* authorizeSyncActor(actor, before);
      const after = structuredClone(before);
      // Another poll completed while this response was in flight. Keep the newer snapshot.
      const superseded = (before.synchronizations[0]?.checkId ?? null) !== (started.synchronizations[0]?.checkId ?? null);
      let changed = false;
      if (!superseded) {
        if (fetched.ok) changed = yield* applySynchronizedParticipants(after, fetched.participants, config, now, actor, true, checkId);
        else {
          const previous = before.synchronizations[0];
          after.synchronizations = [{ ...emptySyncStatus(), ...previous, id: 'whenIsGood', generation: (previous?.generation ?? 0) + 1, checkId,
            lastAttemptAt: now.toISOString(), outcome: 'failed', diagnostic: fetched.error,
            participants: previous?.participants ?? [], pending: previous?.pending ?? [] }];
        }
      }
      const dataRevision = before.dataRevision + Number(changed);
      const schedulingInputRevision = before.schedulingInputRevision + Number(schedulingInputsChanged(before, after));
      const data = yield* Effect.try({ try: () => Schema.decodeUnknownSync(resultSchemas['admin.sync.now'])({ status: syncStatus(after), dataRevision, schedulingInputRevision }),
        catch: () => new AppError('INTERNAL_ERROR', 'Invalid synchronization response.') });
      const response = JSON.stringify({ ok: true, data });
      const committed = yield* database.commit({ before, after, key, fingerprint, response, createdAt: now.toISOString(), advanceDataRevision: changed })
        .pipe(Effect.match({ onSuccess: () => null, onFailure: error => error }));
      if (!committed) return response;
      const replay = yield* database.findIdempotency(key, now.toISOString());
      if (replay) return replay.response;
      if (committed.code !== 'STALE_REVISION') return yield* Effect.fail(committed);
      if (attempt === 0) before = yield* read;
    }
    return yield* Effect.fail(new AppError('CONFLICT', 'Synchronization could not finish because data kept changing. Try Sync now again.'));
  });
}
