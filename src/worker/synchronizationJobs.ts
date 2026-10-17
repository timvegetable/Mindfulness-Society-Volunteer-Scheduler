import { Context, Effect } from 'effect';
import { AppError } from '../shared/api/errors';
import type { Snapshot, SyncJobSummary } from '../shared/domain/models';
import { parseWhenIsGood, whenIsGoodParserVersion } from '../shared/imports/whenIsGood';
import type { AppConfig } from './config';
import { IdGenerator } from './services/IdGenerator';
import { findIdempotency, prepareCommit, type CommitStatement, type IdempotencyKey } from './repositories/database';
import { claimDelivery, insertJob, insertScheduledJob, jobSummary, latestJob, maintainJobs, readJob, readStage, saveStage,
  type SyncJob, type SyncMessage, type SyncQueue, type SyncStage } from './repositories/synchronizationJobs';
import { digest, prepareSynchronization, prepareSynchronizationStatus, syncStatus, unchangedSource, type ParsedSource, type SyncActor } from './synchronization';

export type { SyncMessage } from './repositories/synchronizationJobs';
export interface StartSynchronization { actor: SyncActor; key: IdempotencyKey; fingerprint: string; before: Snapshot; now: Date }
export class SynchronizationJobs extends Context.Service<SynchronizationJobs, {
  readonly start: (input: StartSynchronization) => Promise<string>;
  readonly latest: () => Promise<SyncJobSummary | null>;
}>()('SynchronizationJobs') {}

interface PreparedJob { statements: CommitStatement[]; failure: string | null }
interface Options {
  db: D1Database;
  queue: SyncQueue;
  config: AppConfig;
  fetchSource: () => Promise<string>;
  now?: () => Date;
}

/** A delivery executes one durable stage. D1 owns progress; Queue messages contain only references. */
export function makeSynchronizationJobs(options: Options) {
  const { db, config, queue } = options;
  const now = options.now ?? (() => new Date());
  async function publishCurrent(job: SyncJob | null) {
    if (job && job.phase !== 'done' && job.phase !== 'failed') await queue.send({ jobId: job.id, phase: job.phase, version: job.version });
  }
  async function start(input: StartSynchronization): Promise<string> {
    const job: SyncJob = { id: crypto.randomUUID(), actor_id: input.actor.id, actor_kind: input.actor.kind,
      operation: input.key.operation, intent_key: input.key.idempotencyKey, fingerprint: input.fingerprint,
      started_check_id: input.before.synchronizations[0]?.checkId ?? null, source_hash: null, phase: 'fetch', version: 0,
      reconcile_attempts: 0, created_at: input.now.toISOString(), updated_at: input.now.toISOString(), diagnostic: null };
    const response = JSON.stringify({ ok: true, data: { status: syncStatus(input.before), dataRevision: input.before.dataRevision,
      schedulingInputRevision: input.before.schedulingInputRevision, job: jobSummary(job) } });
    try {
      await insertJob(db, { before: input.before, after: input.before, key: input.key, fingerprint: input.fingerprint,
        response, createdAt: input.now.toISOString(), advanceDataRevision: false }, job);
    } catch (error) {
      const replay = await findIdempotency(db, input.key, input.now.toISOString());
      if (replay) {
        if (replay.fingerprint !== input.fingerprint) throw new AppError('INVALID_REQUEST', 'This idempotency key was used with different input.');
        return replay.response;
      }
      throw error;
    }
    // Attempt timestamps commit with the outbox. A failed send is recoverable;
    // redelivery of the previous stage republishes the current durable version.
    try { await publishCurrent(job); } catch { console.warn('Synchronization delivery is pending recovery.'); }
    return response;
  }

  async function run(stage: SyncStage): Promise<SyncMessage | null> {
    const job = stage.job!;
    const at = now().toISOString();
    if (job.phase === 'fetch') {
      let html: string;
      try { html = await options.fetchSource(); }
      catch {
        return saveStage(db, job, 'prepare', at, { kind: 'parsed', body: JSON.stringify({ ok: false,
          error: 'Could not fetch the results page. It may be unavailable or exceed the size limit.' }) });
      }
      const sourceHash = `${whenIsGoodParserVersion}:${config.timeZone}:${await digest(html)}`;
      return sourceHash === stage.cachedHash
        ? saveStage(db, job, 'prepare', at, { kind: 'parsed', body: '{"cached":true}' }, [], null, sourceHash)
        : saveStage(db, job, 'parse', at, { kind: 'source', body: html }, [], null, sourceHash);
    }
    if (!stage.body) throw new AppError('INTERNAL_ERROR', 'Synchronization input is unavailable.');
    if (job.phase === 'parse') {
      let fetched: ParsedSource;
      try {
        const parsed = parseWhenIsGood(stage.body, config.timeZone, { strict: true });
        fetched = parsed.ok ? { ...parsed, sourceHash: job.source_hash! } : parsed;
      } catch { fetched = { ok: false, error: 'The source snapshot could not be validated.' }; }
      // A fingerprint miss may be cosmetic. Compare the parsed participants
      // against the small head before loading roster/history for reconciliation.
      return saveStage(db, job, 'prepare', at, { kind: 'parsed', body: JSON.stringify(fetched) });
    }
    if (job.phase === 'prepare' || job.phase === 'reconcile') {
      const stored: ParsedSource | { cached: true } = JSON.parse(stage.body);
      const before = stage.snapshot!;
      // Human edits invalidate reconciliation, not the cached source participants.
      // A different completed source check supersedes this older intent.
      const fetched: ParsedSource = 'cached' in stored ? { ok: true, sourceHash: job.source_hash!,
        participants: before.synchronizations[0]?.participants ?? [] } : stored;
      const superseded = (before.synchronizations[0]?.checkId ?? null) !== job.started_check_id;
      if ('cached' in stored && before.synchronizedSourceHash !== job.source_hash && !superseded) {
        throw new AppError('INTERNAL_ERROR', 'Cached synchronization input is unavailable.');
      }
      if (job.phase === 'prepare' && fetched.ok && !superseded && !unchangedSource(before, fetched)) {
        return saveStage(db, job, 'reconcile', at);
      }
      const actor: SyncActor = job.actor_kind === 'system' ? { kind: 'system', id: 'system:whenIsGood' } : { kind: 'administrator', id: job.actor_id };
      const key = { actorId: job.actor_id, operation: 'system.sync.apply', idempotencyKey: job.id };
      const ready = prepareSynchronizationStatus(actor, fetched, before, job.started_check_id, new Date(job.created_at), key, job.fingerprint);
      if (ready) return saveStage(db, job, 'commit', at, { kind: 'prepared', body: JSON.stringify({
        statements: prepareCommit(ready), failure: fetched.ok ? null : fetched.error } satisfies PreparedJob) });
      const input = await Effect.runPromise(prepareSynchronization(actor, fetched, before, job.started_check_id, new Date(job.created_at),
        { actorId: job.actor_id, operation: 'system.sync.apply', idempotencyKey: job.id }, job.fingerprint)
        .pipe(Effect.provideService(IdGenerator, { next: Effect.sync(() => crypto.randomUUID()) }),
          Effect.match({ onSuccess: value => ({ ok: true as const, value }), onFailure: error => ({ ok: false as const, error }) })));
      if (!input.ok) throw input.error;
      const prepared: PreparedJob = { statements: prepareCommit(input.value), failure: fetched.ok ? null : fetched.error };
      return saveStage(db, job, 'commit', at, { kind: 'prepared', body: JSON.stringify(prepared) });
    }
    const prepared: PreparedJob = JSON.parse(stage.body);
    // Progress, domain changes, fences, history and durable replay commit together.
    return saveStage(db, job, prepared.failure ? 'failed' : 'done', at, undefined, prepared.statements, prepared.failure);
  }

  async function consume(message: unknown): Promise<void> {
    if (!isSyncMessage(message)) return;
    console.info('Availability sync stage:', message.phase);
    if (message.phase === 'start') {
      const scheduledTime = Number(message.jobId.slice('scheduled-'.length));
      if (scheduledTime < now().getTime() - 86400000 || scheduledTime > now().getTime() + 60000) return;
      await insertScheduledJob(db, message.jobId, now().toISOString());
      await queue.send({ jobId: message.jobId, phase: 'fetch', version: 0 });
      return;
    }
    if (message.phase === 'recover') {
      await maintainJobs(db, now().toISOString());
      const next = await claimDelivery(db, now().toISOString());
      if (next) { await queue.send(next); await queue.send({ jobId: 'maintenance', phase: 'recover', version: 0 }); }
      return;
    }
    const stage = await readStage(db, message);
    const job = stage.job;
    if (!job || job.phase === 'done' || job.phase === 'failed') return;
    if (message.version !== job.version || message.phase !== job.phase) return publishCurrent(job);
    let next: SyncMessage | null;
    try { next = await run(stage); }
    catch (error) {
      const current = await readJob(db, job.id);
      if (!current || current.version !== job.version || current.phase !== job.phase) return publishCurrent(current);
      if (error instanceof AppError && error.code === 'STALE_REVISION' && job.phase === 'commit') {
        next = job.reconcile_attempts < 3 ? await saveStage(db, job, 'reconcile', now().toISOString())
          : await saveStage(db, job, 'failed', now().toISOString(), undefined, [], 'Data kept changing. Start another availability check.');
      } else if (error instanceof AppError && (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')) {
        next = await saveStage(db, job, 'failed', now().toISOString(), undefined, [], 'The administrator account can no longer synchronize availability.');
      } else throw error;
    }
    if (next) await queue.send(next);
  }
  async function deadLetter(message: unknown): Promise<void> {
    if (!isSyncMessage(message) || message.phase === 'start' || message.phase === 'recover') return;
    console.info('Availability sync dead letter:', message.phase);
    const job = await readJob(db, message.jobId);
    if (!job || job.version !== message.version || job.phase !== message.phase) return;
    try {
      await saveStage(db, job, 'failed', now().toISOString(), undefined, [], 'The availability check could not finish after retries. Start another check.');
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'STALE_REVISION') throw error;
    }
  }
  return { start, latest: () => latestJob(db), consume, deadLetter };
}

export function isSyncMessage(value: unknown): value is SyncMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.jobId === 'string' && v.jobId.length <= 100 && Number.isSafeInteger(v.version) && Number(v.version) >= 0
    && (['fetch', 'parse', 'prepare', 'reconcile', 'commit'].includes(String(v.phase))
      || (v.phase === 'start' && /^scheduled-\d{13}$/.test(v.jobId) && v.version === 0)
      || (v.phase === 'recover' && v.jobId === 'maintenance' && v.version === 0));
}
