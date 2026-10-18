import { prepareSchedule, preparedScheduleStatements } from '../scheduleRead/prepare';
import { representationTables } from '../scheduleRead/storage';
import type { Operation } from '../../shared/api/operations';
import { AppError } from '../../shared/api/errors';
import { emptySnapshot, type Snapshot } from '../../shared/domain/models';
import { decodeProjectedRow, rowProjection, tableDiff, tables } from './tables';

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
  recordSynchronization?: boolean;
  synchronizedSourceHash?: string;
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
  return (await readTables(db, tables)).snapshot;
}

/** Unloaded tables stay untouched by the diff commit; old interval provenance is append-only here. */
export async function readSynchronizationSnapshot(db: D1Database): Promise<Snapshot> {
  return (await readTables(db, tables.filter(table => synchronizationTableKeys.includes(table.key)))).snapshot;
}

const synchronizationTableKeys: readonly (typeof tables[number]['key'])[] = ['users', 'volunteers', 'recurringAvailability', 'imports', 'importMappings', 'synchronizations'];

const synchronizationHeadKeys: readonly (typeof tables[number]['key'])[] = ['users', 'synchronizations'];
const synchronizationHeadTables = tables.filter(table => synchronizationHeadKeys.includes(table.key));
export async function readSynchronizationHead(db: D1Database): Promise<Snapshot> {
  return (await readTables(db, synchronizationHeadTables)).snapshot;
}

/** Job state, artifacts and domain data share a transaction and one D1 round trip. */
export function readSynchronizationStage(db: D1Database, full: boolean, extra: D1PreparedStatement[]) {
  return readTables(db, full ? tables.filter(table => synchronizationTableKeys.includes(table.key)) : synchronizationHeadTables, undefined, extra);
}

export interface SynchronizationCheck { snapshot: Snapshot; replay: IdempotencyRecord | null }
export function readSynchronizationCheck(db: D1Database, key: IdempotencyKey, now: string): Promise<SynchronizationCheck> {
  return readTables(db, synchronizationHeadTables, { key, now });
}

// Projections always include current accounts and revisions. Writes retain the full
// snapshot except synchronization, whose commit only touches its loaded tables.
const operationTableKeys: Partial<Record<Operation, readonly (typeof tables[number]['key'])[]>> = {
  'session.me': ['users', 'centers'],
  'admin.sync.read': ['users', 'volunteers', 'imports', 'synchronizations'],
  'admin.sync.now': synchronizationHeadKeys,
  'admin.schedule.preview': ['users', 'volunteers', 'sessions', 'schedulingRuns', 'assignments', 'recurringAvailability', 'availabilityExceptions'],
  'admin.schedule.read': ['users', 'volunteers', 'sessions', 'schedulingRuns', 'assignments', 'backups'],
  'volunteer.dashboard': ['users', 'volunteers', 'sessions', 'schedulingRuns', 'assignments', 'recurringAvailability', 'availabilityExceptions', 'synchronizations'],
  'center.candidate.read': ['users', 'centers', 'candidateSchedules', 'volunteers', 'recurringAvailability'],
  'admin.insights.read': ['users', 'volunteers', 'recurringAvailability', 'schedulingRuns', 'assignments'],
};

export async function readOperationSnapshot(db: D1Database, operation: Operation): Promise<Snapshot> {
  const keys = operationTableKeys[operation];
  return (await readTables(db, keys ? tables.filter(table => keys.includes(table.key)) : tables)).snapshot;
}

async function readTables(db: D1Database, selectedTables: typeof tables, check?: { key: IdempotencyKey; now: string }, extra: D1PreparedStatement[] = []): Promise<SynchronizationCheck & { extra: D1Result<Record<string, unknown>>[] }> {
  // Import insertion order breaks equal-clock ties without assuming random IDs are chronological.
  const statements = selectedTables.map(table => db.prepare(rowProjection(table)));
  statements.push(db.prepare('SELECT key, value FROM meta'));
  if (check) statements.push(idempotencyStatement(db, check.key, check.now));
  statements.push(...extra);
  const results = await db.batch<Record<string, unknown>>(statements);
  const snapshot = emptySnapshot();
  for (const [index, table] of selectedTables.entries()) {
    const rows = results[index]?.results;
    if (!rows) throw storageError();
    (snapshot as unknown as Record<string, unknown>)[table.key] = rows.map(row => decodeProjectedRow(table, row.body));
  }
  for (const row of results[selectedTables.length]?.results ?? []) {
    if (row.key === 'dataRevision' || row.key === 'schedulingInputRevision' || row.key === 'synchronizedDataRevision') {
      const revision = Number(row.value);
      if (!Number.isSafeInteger(revision) || revision < 0) throw storageError();
      snapshot[row.key] = revision;
    }
    if (row.key === 'synchronizedSourceHash' && typeof row.value === 'string') snapshot.synchronizedSourceHash = row.value;
  }
  const row = check ? results[selectedTables.length + 1]?.results[0] as StoredIdempotency | undefined : undefined;
  return { snapshot, replay: check ? idempotencyRecord(check.key, row) : null, extra: results.slice(selectedTables.length + 1 + Number(!!check)) };
}

function retentionCutoff(now: string): string {
  return new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
}

interface StoredIdempotency { fingerprint: string; response: string; created_at: string }
function idempotencyStatement(db: D1Database, key: IdempotencyKey, now: string): D1PreparedStatement {
  return db.prepare(`SELECT fingerprint, response, created_at FROM idempotency
    WHERE actor_id = ? AND operation = ? AND idempotency_key = ? AND created_at >= ?`)
    .bind(key.actorId, key.operation, key.idempotencyKey, retentionCutoff(now));
}
function idempotencyRecord(key: IdempotencyKey, row: StoredIdempotency | null | undefined): IdempotencyRecord | null {
  return row ? { ...key, fingerprint: row.fingerprint, response: row.response, createdAt: row.created_at } : null;
}
export async function findIdempotency(db: D1Database, key: IdempotencyKey, now: string): Promise<IdempotencyRecord | null> {
  return idempotencyRecord(key, await idempotencyStatement(db, key, now).first<StoredIdempotency>());
}

/**
 * The first statement turns a stale revision into a NOT NULL violation. D1 rolls
 * back the entire batch on any statement failure, including the final unique
 * idempotency insert. The revision check is therefore inside the write transaction.
 */
export interface CommitStatement { sql: string; values: (string | number | null)[] }
const statement = (sql: string, ...values: (string | number | null)[]): CommitStatement => ({ sql, values });

export function prepareCommit(input: CommitInput, scheduleStatements: CommitStatement[] = []): CommitStatement[] {
  const { before, after, key, fingerprint, response, createdAt } = input;
  const diffs = tables.map(table => ({ table, ...tableDiff(table, before, after) }));
  if (input.advanceDataRevision === false && diffs.some(diff => diff.table.key !== 'synchronizations' && (diff.removed.length || diff.changed.length))) throw storageError();
  const schedulingInputsChanged = diffs.some(diff => diff.table.schedulingInput && (diff.removed.length > 0 || diff.changed.length > 0));
  const increment = input.advanceDataRevision === false ? 0 : 1;
  const statements: CommitStatement[] = [statement(`
    INSERT INTO meta (key, value) VALUES ('dataRevision',
      CASE WHEN COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'dataRevision'), 0) = ?
        THEN CAST(? + ? AS TEXT) ELSE NULL END)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, before.dataRevision, before.dataRevision, increment)];

  // Status-only checks do not advance the domain revision. Fence their generation
  // inside the same transaction so overlapping polls cannot overwrite newer results.
  const previousSync = before.synchronizations[0];
  const nextSync = after.synchronizations[0];
  if (nextSync && nextSync.generation !== previousSync?.generation) {
    statements.push(statement(`INSERT INTO meta (key, value) VALUES ('syncFence',
      CASE WHEN COALESCE((SELECT generation FROM synchronizations WHERE id = 'whenIsGood'), 0) = ?
        THEN 'ok' ELSE NULL END) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, previousSync?.generation ?? 0));
  }

  // Delete children before parents, then insert/update parents before children.
  for (const { table, removed } of [...diffs].reverse()) {
    if (removed.length) statements.push(statement(`DELETE FROM ${table.name} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(removed)));
  }
  for (const { table, changed } of diffs) {
    if (!changed.length) continue;
    const update = table.columns.filter(column => column !== 'id').map(column => `${column} = excluded.${column}`).join(', ');
    // One JSON binding avoids both per-row query costs and D1's bound-parameter limit.
    const values = table.columns.map((_, index) => `json_extract(value, '$[${index}]')`).join(', ');
    const sql = `INSERT INTO ${table.name} (${table.columns.join(', ')}) SELECT ${values} FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET ${update}`;
    statements.push(statement(sql, JSON.stringify(changed)));
  }
  if (schedulingInputsChanged) {
    statements.push(statement(`INSERT INTO meta (key, value) VALUES ('schedulingInputRevision', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`));
  }
  if (input.recordSynchronization && before.synchronizedDataRevision !== before.dataRevision + increment) {
    statements.push(statement(`INSERT INTO meta (key, value) VALUES ('synchronizedDataRevision', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(before.dataRevision + increment)));
  }
  if (input.recordSynchronization && input.synchronizedSourceHash && input.synchronizedSourceHash !== before.synchronizedSourceHash) {
    statements.push(statement(`INSERT INTO meta (key, value) VALUES ('synchronizedSourceHash', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`, input.synchronizedSourceHash));
  }
  statements.push(...scheduleStatements);
  statements.push(statement('DELETE FROM idempotency WHERE created_at < ?', retentionCutoff(createdAt)));
  statements.push(statement(`INSERT INTO idempotency (actor_id, operation, idempotency_key, fingerprint, response, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`, key.actorId, key.operation, key.idempotencyKey, fingerprint, response, createdAt));
  return statements;
}

export async function commit(db: D1Database, input: CommitInput, materializeSchedule = false): Promise<void> {
  const changesSchedule = materializeSchedule && tables.filter(table => representationTables.some(key => key === table.key)).some(table => {
    const diff = tableDiff(table, input.before, input.after);
    return diff.removed.length > 0 || diff.changed.length > 0;
  });
  const schedule = changesSchedule ? preparedScheduleStatements(await prepareSchedule(input.after)) : [];
  await executeCommit(db, prepareCommit(input, schedule));
}

/** Offline backfills use the same transactionally read input and preparation owner. */
export async function prepareScheduleBackfill(db: D1Database): Promise<CommitStatement[]> {
  const keys = operationTableKeys['admin.schedule.read']!;
  const { snapshot, extra } = await readTables(db, tables.filter(table => keys.includes(table.key)), undefined,
    [db.prepare("SELECT CAST(value AS INTEGER) AS version FROM meta WHERE key='scheduleViewRevision'")]);
  const version = Number(extra[0]?.results[0]?.version ?? 0);
  if (!Number.isSafeInteger(version) || version < 0) throw storageError();
  const prepared = await prepareSchedule(snapshot);
  return [statement(`INSERT INTO meta(key,value) VALUES ('scheduleReadFence', CASE WHEN
    COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='dataRevision'),0)=?
    AND COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='scheduleViewRevision'),0)=?
    THEN 'ok' ELSE NULL END) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, snapshot.dataRevision, version),
    ...preparedScheduleStatements(prepared)];
}

export async function executeCommit(db: D1Database, statements: CommitStatement[]): Promise<void> {
  try {
    await db.batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/NOT NULL constraint failed: synchronization_jobs\.phase/.test(message)) throw new AppError('FORBIDDEN', 'This account can no longer synchronize availability.');
    if (/NOT NULL constraint failed: synchronization_jobs\.version/.test(message)) throw new AppError('STALE_REVISION', 'The synchronization stage already advanced.');
    if (/NOT NULL constraint failed: meta\.value/.test(message)) {
      throw new AppError('STALE_REVISION', 'The data changed. Refresh and try again.');
    }
    if (/UNIQUE constraint failed: idempotency\./.test(message)) {
      throw new AppError('DUPLICATE_REQUEST', 'This request has already been committed.');
    }
    throw storageError();
  }
}
