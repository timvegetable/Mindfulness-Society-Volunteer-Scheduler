import { Context, Effect } from 'effect';
import { AppError } from '../shared/api/errors';
import type { Snapshot, SyncJobSummary } from '../shared/domain/models';
import { parseWhenIsGood, whenIsGoodParserVersion } from '../shared/imports/whenIsGood';
import type { AppConfig } from './config';
import { IdGenerator } from './services/IdGenerator';
import { findIdempotency, prepareCommit, readSynchronizationHead, readSynchronizationSnapshot, type CommitStatement, type IdempotencyKey } from './repositories/database';
import { artifact, insertJob, jobSummary, latestJob, markSent, pendingDelivery, readJob, saveStage, type SyncJob, type SyncMessage } from './repositories/synchronizationJobs';
import { digest, prepareSynchronization, syncStatus, unchangedSource, type ParsedSource, type SyncActor } from './synchronization';

export type { SyncMessage } from './repositories/synchronizationJobs';
export interface StartSynchronization { actor: SyncActor; key: IdempotencyKey; fingerprint: string; before: Snapshot; now: Date }
export class SynchronizationJobs extends Context.Service<SynchronizationJobs, {
  readonly start: (input: StartSynchronization) => Promise<string>;
  readonly latest: () => Promise<SyncJobSummary | null>;
}>()('SynchronizationJobs') {}

interface PreparedJob { statements: CommitStatement[]; failure: string | null }
interface Options {
  db: D1Database;
  queue: { send: (message: SyncMessage) => Promise<unknown> };
  config: AppConfig;
  fetchSource: () => Promise<string>;
  now?: () => Date;
}

/** A delivery executes one durable stage. D1 owns progress; Queue messages contain only references. */
export function makeSynchronizationJobs(options: Options) {
  const { db, config, queue } = options;
  const now = options.now ?? (() => new Date());
  async function publish(jobId?: string) {
    const message = await pendingDelivery(db, jobId, new Date(now().getTime() - 300000).toISOString());
    if (!message) return;
    await queue.send(message);
    await markSent(db, message, now().toISOString());
  }
  async function start(input: StartSynchronization): Promise<string> {
    const job: SyncJob = { id: crypto.randomUUID(), actor_id: input.actor.id, actor_kind: input.actor.kind,
      operation: input.key.operation, intent_key: input.key.idempotencyKey, fingerprint: input.fingerprint,
      started_check_id: input.before.synchronizations[0]?.checkId ?? null, phase: 'fetch', version: 0,
      prepare_attempts: 0, created_at: input.now.toISOString(), updated_at: input.now.toISOString(), diagnostic: null };
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
    // A committed intent survives a transport failure; cron recovers its outbox.
    try { await publish(job.id); } catch { console.warn('Synchronization delivery is pending recovery.'); }
    return response;
  }

  async function run(job: SyncJob) {
    const at = now();
    if (job.phase === 'fetch') {
      let html: string;
      try { html = await options.fetchSource(); }
      catch {
        await saveStage(db, job, 'prepare', at.toISOString(), { kind: 'parsed', body: JSON.stringify({ ok: false,
          error: 'Could not fetch the results page. It may be unavailable or exceed the size limit.' }) });
        return;
      }
      await saveStage(db, job, 'parse', at.toISOString(), { kind: 'source', body: html });
    } else if (job.phase === 'parse') {
      const html = await artifact(db, job, 'source');
      const head = await readSynchronizationHead(db);
      let fetched: ParsedSource;
      try {
        const sourceHash = `${whenIsGoodParserVersion}:${config.timeZone}:${await digest(html)}`;
        const previous = head.synchronizations[0];
        const parsed = previous && head.synchronizedDataRevision === head.dataRevision && head.synchronizedSourceHash === sourceHash
          ? { ok: true as const, participants: previous.participants.map(({ id, name, email, intervals, identityStable }) => ({ id, name, email, intervals, identityStable })) }
          : parseWhenIsGood(html, config.timeZone, { strict: true });
        fetched = parsed.ok ? { ...parsed, sourceHash } : parsed;
      } catch { fetched = { ok: false, error: 'The source snapshot could not be validated.' }; }
      await saveStage(db, job, 'prepare', at.toISOString(), { kind: 'parsed', body: JSON.stringify(fetched) });
    } else if (job.phase === 'prepare') {
      const fetched: ParsedSource = JSON.parse(await artifact(db, job, 'parsed'));
      let before = await readSynchronizationHead(db);
      if (fetched.ok && !unchangedSource(before, fetched)) before = await readSynchronizationSnapshot(db);
      const actor: SyncActor = job.actor_kind === 'system' ? { kind: 'system', id: 'system:whenIsGood' } : { kind: 'administrator', id: job.actor_id };
      const input = await Effect.runPromise(prepareSynchronization(actor, fetched, before, job.started_check_id, new Date(job.created_at),
        { actorId: job.actor_id, operation: 'system.sync.apply', idempotencyKey: job.id }, job.fingerprint)
        .pipe(Effect.provideService(IdGenerator, { next: Effect.sync(() => crypto.randomUUID()) })));
      const prepared: PreparedJob = { statements: prepareCommit(input), failure: fetched.ok ? null : fetched.error };
      await saveStage(db, job, 'commit', at.toISOString(), { kind: 'prepared', body: JSON.stringify(prepared) });
    } else if (job.phase === 'commit') {
      const prepared: PreparedJob = JSON.parse(await artifact(db, job, 'prepared'));
      // Progress, domain changes, fences, history and durable replay commit together.
      await saveStage(db, job, prepared.failure ? 'failed' : 'done', at.toISOString(), undefined, prepared.statements, prepared.failure);
    }
  }
  async function consume(message: unknown): Promise<void> {
    if (!isSyncMessage(message)) return;
    const job = await readJob(db, message.jobId);
    if (!job || job.phase === 'done' || job.phase === 'failed') return;
    if (message.version !== job.version || message.phase !== job.phase) { await publish(job.id); return; }
    try { await run(job); }
    catch (error) {
      const current = await readJob(db, job.id);
      if (!current || current.version !== job.version || current.phase !== job.phase) { await publish(job.id); return; }
      if (error instanceof AppError && error.code === 'STALE_REVISION' && job.phase === 'commit') {
        if (job.prepare_attempts < 3) await saveStage(db, job, 'prepare', now().toISOString());
        else await saveStage(db, job, 'failed', now().toISOString(), undefined, [], 'Data kept changing. Start another availability check.');
      } else if (error instanceof AppError && (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')) {
        await saveStage(db, job, 'failed', now().toISOString(), undefined, [], 'The administrator account can no longer synchronize availability.');
      } else throw error;
    }
    await publish(job.id);
  }
  return { start, latest: () => latestJob(db), consume, recover: () => publish() };
}

export function isSyncMessage(value: unknown): value is SyncMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.jobId === 'string' && v.jobId.length <= 100 && Number.isSafeInteger(v.version) && Number(v.version) >= 0
    && ['fetch', 'parse', 'prepare', 'commit'].includes(String(v.phase));
}

