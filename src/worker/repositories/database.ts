import { AppError } from '../../shared/api/errors';
import { emptySnapshot, type Snapshot } from '../../shared/domain/models';
import { decodeRow, tableDiff, tables } from './tables';

export interface IdempotencyKey { actorId: string; operation: string; idempotencyKey: string }
export interface IdempotencyRecord extends IdempotencyKey { fingerprint: string; response: string; createdAt: string }
export interface CommitInput {
  before: Snapshot;
  after: Snapshot;
  key: IdempotencyKey;
  fingerprint: string;
  response: string;
  createdAt: string;
}

export function storageError(): AppError {
  return new AppError('INTERNAL_ERROR', 'The database operation could not be completed.');
}

export function schedulingInputsChanged(before: Snapshot, after: Snapshot): boolean {
  return tables.filter(table => table.schedulingInput).some(table => {
    const diff = tableDiff(table, before, after);
    return diff.removed.length > 0 || diff.changed.length > 0;
  });
}

/** D1 batch runs all reads in one transaction, avoiding mixed-revision snapshots. */
export async function readSnapshot(db: D1Database): Promise<Snapshot> {
  // Import insertion order breaks equal-clock ties without assuming random IDs are chronological.
  const statements = tables.map(table => db.prepare(`SELECT ${table.columns.join(', ')} FROM ${table.name} ORDER BY ${table.key === 'imports' ? 'rowid' : 'id'}`));
  const results = await db.batch<Record<string, unknown>>([...statements, db.prepare('SELECT key, value FROM meta')]);
  const snapshot = emptySnapshot();
  for (const [index, table] of tables.entries()) {
    const rows = results[index]?.results;
    if (!rows) throw storageError();
    (snapshot as unknown as Record<string, unknown>)[table.key] = rows.map(row => decodeRow(table, row));
  }
  for (const row of results[tables.length]?.results ?? []) {
    if (row.key === 'dataRevision' || row.key === 'schedulingInputRevision') {
      const revision = Number(row.value);
      if (!Number.isSafeInteger(revision) || revision < 0) throw storageError();
      snapshot[row.key] = revision;
    }
  }
  return snapshot;
}

function retentionCutoff(now: string): string {
  return new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
}

export async function findIdempotency(db: D1Database, key: IdempotencyKey, now: string): Promise<IdempotencyRecord | null> {
  const row = await db.prepare(`SELECT fingerprint, response, created_at FROM idempotency
    WHERE actor_id = ? AND operation = ? AND idempotency_key = ? AND created_at >= ?`)
    .bind(key.actorId, key.operation, key.idempotencyKey, retentionCutoff(now))
    .first<{ fingerprint: string; response: string; created_at: string }>();
  return row ? { ...key, fingerprint: row.fingerprint, response: row.response, createdAt: row.created_at } : null;
}

/**
 * The first statement turns a stale revision into a NOT NULL violation. D1 rolls
 * back the entire batch on any statement failure, including the final unique
 * idempotency insert. The revision check is therefore inside the write transaction.
 */
export async function commit(db: D1Database, input: CommitInput): Promise<void> {
  const { before, after, key, fingerprint, response, createdAt } = input;
  const diffs = tables.map(table => ({ table, ...tableDiff(table, before, after) }));
  const schedulingInputsChanged = diffs.some(diff => diff.table.schedulingInput && (diff.removed.length > 0 || diff.changed.length > 0));
  const statements: D1PreparedStatement[] = [db.prepare(`
    INSERT INTO meta (key, value) VALUES ('dataRevision',
      CASE WHEN COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'dataRevision'), 0) = ?
        THEN CAST(? + 1 AS TEXT) ELSE NULL END)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(before.dataRevision, before.dataRevision)];

  // Delete children before parents, then insert/update parents before children.
  for (const { table, removed } of [...diffs].reverse()) {
    for (const id of removed) statements.push(db.prepare(`DELETE FROM ${table.name} WHERE id = ?`).bind(id));
  }
  for (const { table, changed } of diffs) {
    const update = table.columns.filter(column => column !== 'id').map(column => `${column} = excluded.${column}`).join(', ');
    const sql = `INSERT INTO ${table.name} (${table.columns.join(', ')}) VALUES (${table.columns.map(() => '?').join(', ')}) ON CONFLICT(id) DO UPDATE SET ${update}`;
    for (const values of changed) statements.push(db.prepare(sql).bind(...values));
  }
  if (schedulingInputsChanged) {
    statements.push(db.prepare(`INSERT INTO meta (key, value) VALUES ('schedulingInputRevision', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`));
  }
  statements.push(db.prepare('DELETE FROM idempotency WHERE created_at < ?').bind(retentionCutoff(createdAt)));
  statements.push(db.prepare(`INSERT INTO idempotency (actor_id, operation, idempotency_key, fingerprint, response, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(key.actorId, key.operation, key.idempotencyKey, fingerprint, response, createdAt));
  try {
    await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/NOT NULL constraint failed: meta\.value/.test(message)) {
      throw new AppError('STALE_REVISION', 'The data changed. Refresh and try again.');
    }
    if (/UNIQUE constraint failed: idempotency\./.test(message)) {
      throw new AppError('DUPLICATE_REQUEST', 'This request has already been committed.');
    }
    throw storageError();
  }
}
