import type { Snapshot, SyncJobSummary } from '../../shared/domain/models';
import type { SyncActor } from '../synchronization';
import { executeCommit, prepareCommit, readSynchronizationStage, type CommitInput, type CommitStatement } from './database';

export type JobPhase = 'fetch' | 'parse' | 'prepare' | 'reconcile' | 'commit' | 'done' | 'failed';
export interface SyncMessage { jobId: string; phase: JobPhase | 'start' | 'recover'; version: number }
export interface SyncQueue { send: (message: SyncMessage) => Promise<unknown> }
export interface SyncJob {
  id: string; actor_id: string; actor_kind: SyncActor['kind']; operation: string; intent_key: string; fingerprint: string;
  started_check_id: string | null; source_hash: string | null; phase: JobPhase; version: number; reconcile_attempts: number;
  created_at: string; updated_at: string; diagnostic: string | null;
}
const sql = (sql: string, ...values: CommitStatement['values']): CommitStatement => ({ sql, values });
const active = `EXISTS (SELECT 1 FROM users, json_each(users.roles) role WHERE users.id=? AND users.active=1 AND role.value='administrator')`;

export function jobSummary(job: SyncJob): SyncJobSummary {
  return { id: job.id, state: job.phase === 'done' ? 'succeeded' : job.phase === 'failed' ? 'failed' : job.phase === 'fetch' ? 'queued' : 'running',
    createdAt: job.created_at, updatedAt: job.updated_at, diagnostic: job.diagnostic };
}
export async function readJob(db: D1Database, id: string): Promise<SyncJob | null> {
  return db.prepare('SELECT * FROM synchronization_jobs WHERE id=?').bind(id).first<SyncJob>();
}
export function latestJobStatement(db: D1Database): D1PreparedStatement {
  return db.prepare('SELECT * FROM synchronization_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1');
}
export async function latestJob(db: D1Database): Promise<SyncJobSummary | null> {
  const job = await latestJobStatement(db).first<SyncJob>();
  return job ? jobSummary(job) : null;
}
export async function insertJob(db: D1Database, input: CommitInput, job: SyncJob): Promise<void> {
  await executeCommit(db, [
    sql(`DELETE FROM synchronization_jobs WHERE actor_id=? AND operation=? AND intent_key=? AND created_at<?`,
      job.actor_id, job.operation, job.intent_key, new Date(new Date(job.created_at).getTime() - 86400000).toISOString()),
    ...expiredJobs(job.created_at),
    ...prepareCommit(input),
    sql(`INSERT INTO synchronization_jobs (id,actor_id,actor_kind,operation,intent_key,fingerprint,started_check_id,phase,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,CASE WHEN ?='system' OR ${active} THEN 'fetch' ELSE NULL END,?,?)`,
      job.id, job.actor_id, job.actor_kind, job.operation, job.intent_key, job.fingerprint, job.started_check_id,
      job.actor_kind, job.actor_id, job.created_at, job.updated_at),
    sql("INSERT INTO synchronization_outbox (job_id,version,phase,last_delivery_attempt_at) VALUES (?,0,'fetch',?)", job.id, job.created_at),
  ]);
}

function advance(job: SyncJob, next: JobPhase, now: string, diagnostic: string | null, authorize: boolean, sourceHash: string | null): CommitStatement {
  return sql(`UPDATE synchronization_jobs SET version=CASE WHEN version=? AND phase=? THEN version+1 ELSE NULL END,
    phase=CASE WHEN ?=0 OR actor_kind='system' OR ${active} THEN ? ELSE NULL END,
    reconcile_attempts=reconcile_attempts+?,updated_at=?,diagnostic=?,source_hash=COALESCE(?,source_hash) WHERE id=?`,
    job.version, job.phase, Number(authorize), job.actor_id, next, Number(next === 'reconcile'), now, diagnostic, sourceHash, job.id);
}
export async function saveStage(db: D1Database, job: SyncJob, next: JobPhase, now: string,
  data?: { kind: string; body: string }, plan: CommitStatement[] = [], diagnostic: string | null = null, sourceHash: string | null = null): Promise<SyncMessage | null> {
  const statements = [
    // Domain writes require an explicit existence fence. Other advances insert
    // artifacts/outbox rows whose foreign keys also reject a deleted job.
    ...(job.phase === 'commit' ? [sql(`INSERT INTO meta (key,value) VALUES ('syncJobFence', CASE WHEN EXISTS
      (SELECT 1 FROM synchronization_jobs WHERE id=? AND version=? AND phase=?) THEN 'ok' ELSE NULL END)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, job.id, job.version, job.phase)] : []),
    advance(job, next, now, diagnostic, job.phase === 'commit' && plan.length > 0, sourceHash), ...plan,
  ];
  if (data) {
    // Small rows also support the full 2 MiB source cap without one oversized D1 row.
    const parts: [string, string, number, string][] = [];
    for (let offset = 0; offset < data.body.length;) {
      let end = Math.min(offset + 16384, data.body.length);
      if (end < data.body.length && /[\uD800-\uDBFF]/.test(data.body[end - 1]!) && /[\uDC00-\uDFFF]/.test(data.body[end]!)) end--;
      parts.push([job.id, data.kind, parts.length, data.body.slice(offset, end)]); offset = end;
    }
    if (!parts.length) parts.push([job.id, data.kind, 0, '']);
    // Source/parsed snapshots are inserted once. Only a retried reconciliation
    // replaces an earlier plan. Progress fencing rejects duplicate insertions.
    if (data.kind === 'prepared') statements.push(sql('DELETE FROM synchronization_artifacts WHERE job_id=? AND kind=?', job.id, data.kind));
    // Keep each bound value comfortably below D1's per-value limit.
    for (let offset = 0; offset < parts.length; offset += 8) statements.push(sql(`INSERT INTO synchronization_artifacts (job_id,kind,part,body)
      SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]') FROM json_each(?)`, JSON.stringify(parts.slice(offset, offset + 8))));
  }
  if (next === 'done' || next === 'failed') {
    statements.push(sql('DELETE FROM synchronization_outbox WHERE job_id=?', job.id), sql('DELETE FROM synchronization_artifacts WHERE job_id=?', job.id));
  } else statements.push(sql(`INSERT INTO synchronization_outbox (job_id,version,phase,last_delivery_attempt_at) VALUES (?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET version=excluded.version,phase=excluded.phase,last_delivery_attempt_at=excluded.last_delivery_attempt_at`, job.id, job.version + 1, next, now));
  await executeCommit(db, statements);
  return next === 'done' || next === 'failed' ? null : { jobId: job.id, version: job.version + 1, phase: next };
}
/** Record an attempt before sending; an interrupted send remains eligible for recovery. */
export async function claimDelivery(db: D1Database, now: string): Promise<SyncMessage | null> {
  const row = await db.prepare(`UPDATE synchronization_outbox SET last_delivery_attempt_at=? WHERE job_id=(
    SELECT o.job_id FROM synchronization_outbox o JOIN synchronization_jobs j ON j.id=o.job_id
    WHERE o.version=j.version AND o.phase=j.phase AND (o.last_delivery_attempt_at IS NULL OR o.last_delivery_attempt_at<?)
    ORDER BY j.updated_at LIMIT 1) RETURNING job_id,version,phase`)
    .bind(now, new Date(new Date(now).getTime() - 300000).toISOString()).first<{ job_id: string; version: number; phase: JobPhase }>();
  return row ? { jobId: row.job_id, version: row.version, phase: row.phase } : null;
}

/** Scheduled intents use SQL projections; no roster or participant JSON is decoded. */
export async function insertScheduledJob(db: D1Database, id: string, now: string): Promise<void> {
  await executeCommit(db, [
    sql(`INSERT OR IGNORE INTO synchronization_jobs (id,actor_id,actor_kind,operation,intent_key,fingerprint,started_check_id,phase,created_at,updated_at)
      SELECT ?,'system:whenIsGood','system','system.sync',?,'{}',(SELECT check_id FROM synchronizations WHERE id='whenIsGood'),'fetch',?,?
      WHERE NOT EXISTS (SELECT 1 FROM idempotency WHERE actor_id='system:whenIsGood' AND operation='system.sync'
        AND idempotency_key=? AND created_at>=?)`, id, id, now, now, id, new Date(new Date(now).getTime() - 86400000).toISOString()),
    sql(`INSERT OR IGNORE INTO synchronization_outbox (job_id,version,phase,last_delivery_attempt_at)
      SELECT id,version,phase,? FROM synchronization_jobs WHERE id=? AND phase='fetch' AND version=0`, now, id),
  ]);
}

export interface SyncStage {
  job: SyncJob | null;
  body: string;
  snapshot?: Snapshot;
  cachedHash: string | null;
}

export async function readStage(db: D1Database, message: SyncMessage): Promise<SyncStage> {
  const queries = [db.prepare('SELECT * FROM synchronization_jobs WHERE id=?').bind(message.jobId)];
  const preparation = message.phase === 'prepare' || message.phase === 'reconcile';
  if (message.phase === 'fetch') queries.push(db.prepare(`SELECT key,value FROM meta WHERE key IN
    ('synchronizedSourceHash','synchronizedDataRevision','dataRevision') UNION ALL
    SELECT 'hasSync','1' FROM synchronizations WHERE id='whenIsGood'`));
  else queries.push(db.prepare('SELECT body FROM synchronization_artifacts WHERE job_id=? AND kind=? ORDER BY part')
    .bind(message.jobId, message.phase === 'parse' ? 'source' : message.phase === 'commit' ? 'prepared' : 'parsed'));
  const read = preparation ? await readSynchronizationStage(db, message.phase === 'reconcile', queries) : null;
  const results = read?.extra ?? await db.batch<Record<string, unknown>>(queries);
  const job = results[0]?.results[0] as unknown as SyncJob | undefined;
  const rows = results[1]?.results ?? [];
  const meta = message.phase === 'fetch' ? Object.fromEntries(rows.map(row => [String(row.key), String(row.value)])) : {};
  return { job: job ?? null, body: message.phase === 'fetch' ? '' : rows.map(row => row.body).join(''),
    ...(read ? { snapshot: read.snapshot } : {}),
    cachedHash: meta.hasSync && meta.synchronizedDataRevision !== undefined && meta.dataRevision !== undefined
      && Number(meta.synchronizedDataRevision) === Number(meta.dataRevision) ? meta.synchronizedSourceHash ?? null : null };
}

function expiredJobs(now: string): CommitStatement[] {
  const cutoff = new Date(new Date(now).getTime() - 86400000).toISOString();
  return [sql("DELETE FROM synchronization_jobs WHERE id IN (SELECT id FROM synchronization_jobs WHERE phase IN ('done','failed') AND created_at<? LIMIT 20)", cutoff)];
}

/** Expiry also recovers jobs whose consumer died before it could report a failure. */
export async function maintainJobs(db: D1Database, now: string): Promise<void> {
  await executeCommit(db, [
    sql(`UPDATE synchronization_jobs SET phase='failed',version=version+1,updated_at=?,diagnostic='The availability check expired. Start another check.'
      WHERE id IN (SELECT id FROM synchronization_jobs WHERE phase NOT IN ('done','failed') AND created_at<? LIMIT 20)`,
      now, new Date(new Date(now).getTime() - 3600000).toISOString()),
    sql("DELETE FROM synchronization_artifacts WHERE job_id IN (SELECT id FROM synchronization_jobs WHERE phase IN ('done','failed'))"),
    sql("DELETE FROM synchronization_outbox WHERE job_id IN (SELECT id FROM synchronization_jobs WHERE phase IN ('done','failed'))"),
    ...expiredJobs(now),
  ]);
}
