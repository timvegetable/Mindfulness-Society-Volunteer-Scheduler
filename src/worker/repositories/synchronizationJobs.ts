import { AppError } from '../../shared/api/errors';
import type { SyncJobSummary } from '../../shared/domain/models';
import type { SyncActor } from '../synchronization';
import { executeCommit, prepareCommit, type CommitInput, type CommitStatement } from './database';

export type JobPhase = 'fetch' | 'parse' | 'prepare' | 'commit' | 'done' | 'failed';
export interface SyncMessage { jobId: string; phase: JobPhase; version: number }
export interface SyncJob {
  id: string; actor_id: string; actor_kind: SyncActor['kind']; operation: string; intent_key: string; fingerprint: string;
  started_check_id: string | null; phase: JobPhase; version: number; prepare_attempts: number;
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
export async function latestJob(db: D1Database): Promise<SyncJobSummary | null> {
  const job = await db.prepare('SELECT * FROM synchronization_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1').first<SyncJob>();
  return job ? jobSummary(job) : null;
}
export async function insertJob(db: D1Database, input: CommitInput, job: SyncJob): Promise<void> {
  await executeCommit(db, [...prepareCommit(input),
    sql(`INSERT INTO synchronization_jobs (id,actor_id,actor_kind,operation,intent_key,fingerprint,started_check_id,phase,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,CASE WHEN ?='system' OR ${active} THEN 'fetch' ELSE NULL END,?,?)`,
      job.id, job.actor_id, job.actor_kind, job.operation, job.intent_key, job.fingerprint, job.started_check_id,
      job.actor_kind, job.actor_id, job.created_at, job.updated_at),
    sql("INSERT INTO synchronization_outbox (job_id,version,phase) VALUES (?,0,'fetch')", job.id),
    sql("DELETE FROM synchronization_jobs WHERE id IN (SELECT id FROM synchronization_jobs WHERE phase IN ('done','failed') AND created_at<? LIMIT 20)",
      new Date(new Date(job.created_at).getTime() - 86400000).toISOString()),
  ]);
}

function advance(job: SyncJob, next: JobPhase, now: string, diagnostic: string | null, authorize: boolean): CommitStatement {
  return sql(`UPDATE synchronization_jobs SET version=CASE WHEN version=? AND phase=? THEN version+1 ELSE NULL END,
    phase=CASE WHEN ?=0 OR actor_kind='system' OR ${active} THEN ? ELSE NULL END,
    prepare_attempts=prepare_attempts+?,updated_at=?,diagnostic=? WHERE id=?`,
    job.version, job.phase, Number(authorize), job.actor_id, next, Number(next === 'prepare'), now, diagnostic, job.id);
}
export async function artifact(db: D1Database, job: SyncJob, kind: string): Promise<string> {
  const { results } = await db.prepare('SELECT body FROM synchronization_artifacts WHERE job_id=? AND kind=? ORDER BY part').bind(job.id, kind).all<{ body: string }>();
  if (!results.length) throw new AppError('INTERNAL_ERROR', 'Synchronization input is unavailable.');
  return results.map(row => row.body).join('');
}
export async function saveStage(db: D1Database, job: SyncJob, next: JobPhase, now: string,
  data?: { kind: string; body: string }, plan: CommitStatement[] = [], diagnostic: string | null = null): Promise<void> {
  const statements = [advance(job, next, now, diagnostic, job.phase === 'commit' && plan.length > 0), ...plan];
  if (data) {
    // Small rows also support the full 2 MiB source cap without one oversized D1 row.
    const parts: [string, string, number, string][] = [];
    for (let offset = 0; offset < data.body.length;) {
      let end = Math.min(offset + 16384, data.body.length);
      if (end < data.body.length && /[\uD800-\uDBFF]/.test(data.body[end - 1]!) && /[\uDC00-\uDFFF]/.test(data.body[end]!)) end--;
      parts.push([job.id, data.kind, parts.length, data.body.slice(offset, end)]); offset = end;
    }
    if (!parts.length) parts.push([job.id, data.kind, 0, '']);
    statements.push(sql('DELETE FROM synchronization_artifacts WHERE job_id=? AND kind=?', job.id, data.kind));
    // Keep each bound value comfortably below D1's per-value limit.
    for (let offset = 0; offset < parts.length; offset += 8) statements.push(sql(`INSERT INTO synchronization_artifacts (job_id,kind,part,body)
      SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]') FROM json_each(?)`, JSON.stringify(parts.slice(offset, offset + 8))));
  }
  if (next === 'done' || next === 'failed') {
    statements.push(sql('DELETE FROM synchronization_outbox WHERE job_id=?', job.id), sql('DELETE FROM synchronization_artifacts WHERE job_id=?', job.id));
  } else statements.push(sql(`INSERT INTO synchronization_outbox (job_id,version,phase,sent_at) VALUES (?,?,?,NULL)
      ON CONFLICT(job_id) DO UPDATE SET version=excluded.version,phase=excluded.phase,sent_at=NULL`, job.id, job.version + 1, next));
  await executeCommit(db, statements);
}
export async function pendingDelivery(db: D1Database, jobId?: string, before?: string): Promise<SyncMessage | null> {
  const row = await db.prepare(`SELECT o.job_id,o.version,o.phase FROM synchronization_outbox o JOIN synchronization_jobs j ON j.id=o.job_id
    WHERE o.version=j.version AND o.phase=j.phase AND ${jobId ? 'o.job_id=? AND o.sent_at IS NULL' : '(o.sent_at IS NULL OR o.sent_at<?)'}
    ORDER BY j.updated_at LIMIT 1`).bind(jobId ?? before ?? '').first<{ job_id: string; version: number; phase: JobPhase }>();
  return row ? { jobId: row.job_id, version: row.version, phase: row.phase } : null;
}
export async function markSent(db: D1Database, message: SyncMessage, now: string): Promise<void> {
  await db.prepare('UPDATE synchronization_outbox SET sent_at=? WHERE job_id=? AND version=?').bind(now, message.jobId, message.version).run();
}
