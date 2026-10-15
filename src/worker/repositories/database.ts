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
  advanceDataRevision?: boolean;
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
  return readTables(db, tables);
}

/** Unloaded tables stay untouched by the diff commit; old interval provenance is append-only here. */
export async function readSynchronizationSnapshot(db: D1Database): Promise<Snapshot> {
  return readTables(db, tables.filter(table => ['volunteers', 'users', 'recurringAvailability', 'imports', 'importMappings', 'synchronizations'].includes(table.key)));
}

async function readTables(db: D1Database, selectedTables: typeof tables): Promise<Snapshot> {
  // Import insertion order breaks equal-clock ties without assuming random IDs are chronological.
  const statements = selectedTables.map(table => db.prepare(`SELECT ${table.columns.join(', ')} FROM ${table.name} ORDER BY ${table.key === 'imports' ? 'rowid' : 'id'}`));
  const results = await db.batch<Record<string, unknown>>([...statements, db.prepare('SELECT key, value FROM meta')]);
  const snapshot = emptySnapshot();
  for (const [index, table] of selectedTables.entries()) {
    const rows = results[index]?.results;
    if (!rows) throw storageError();
    (snapshot as unknown as Record<string, unknown>)[table.key] = rows.map(row => decodeRow(table, row));
  }
  for (const row of results[selectedTables.length]?.results ?? []) {
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
  if (input.advanceDataRevision === false && diffs.some(diff => diff.table.key !== 'synchronizations' && (diff.removed.length || diff.changed.length))) throw storageError();
  const schedulingInputsChanged = diffs.some(diff => diff.table.schedulingInput && (diff.removed.length > 0 || diff.changed.length > 0));
  const increment = input.advanceDataRevision === false ? 0 : 1;
  const statements: D1PreparedStatement[] = [db.prepare(`
    INSERT INTO meta (key, value) VALUES ('dataRevision',
      CASE WHEN COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'dataRevision'), 0) = ?
        THEN CAST(? + ? AS TEXT) ELSE NULL END)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(before.dataRevision, before.dataRevision, increment)];

  // Status-only checks do not advance the domain revision. Fence their generation
  // inside the same transaction so overlapping polls cannot overwrite newer results.
  const previousSync = before.synchronizations[0];
  const nextSync = after.synchronizations[0];
  if (nextSync && nextSync.generation !== previousSync?.generation) {
    statements.push(db.prepare(`INSERT INTO meta (key, value) VALUES ('syncFence',
      CASE WHEN COALESCE((SELECT generation FROM synchronizations WHERE id = 'whenIsGood'), 0) = ?
        THEN 'ok' ELSE NULL END) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(previousSync?.generation ?? 0));
  }

  // Delete children before parents, then insert/update parents before children.
  for (const { table, removed } of [...diffs].reverse()) {
    if (removed.length) statements.push(db.prepare(`DELETE FROM ${table.name} WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(removed)));
  }
  for (const { table, changed } of diffs) {
    if (!changed.length) continue;
    const update = table.columns.filter(column => column !== 'id').map(column => `${column} = excluded.${column}`).join(', ');
    // One JSON binding avoids both per-row query costs and D1's bound-parameter limit.
    const values = table.columns.map((_, index) => `json_extract(value, '$[${index}]')`).join(', ');
    const sql = `INSERT INTO ${table.name} (${table.columns.join(', ')}) SELECT ${values} FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET ${update}`;
    statements.push(db.prepare(sql).bind(JSON.stringify(changed)));
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
