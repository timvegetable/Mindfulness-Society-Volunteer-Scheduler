import type { ApiError, Revision } from '../../shared/domain.js';
import type { SheetLike } from './initializer.js';

export type AuditEntry = {
  id: string; entity: string; entityId: string; action: string; source: string; actorId: string;
  timestamp: string; before?: unknown; after?: unknown;
};

export type LockLike = { tryLock(timeoutMilliseconds: number): boolean; releaseLock(): void };

export class RepositoryError extends Error {
  readonly code: ApiError['code'];
  constructor(code: ApiError['code'], message: string) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
  }
}

export function withScriptLock<T>(lock: LockLike, action: () => T, timeoutMilliseconds = 10000): T {
  if (!lock.tryLock(timeoutMilliseconds)) throw new RepositoryError('CONFLICT', 'Another write is in progress');
  try {
    return action();
  } finally {
    lock.releaseLock();
  }
}

export type RevisionState = {
  number: number;
  changedAt: string;
  changedBy: string;
  source: string;
};

export interface RevisionedRepository<T extends { id: string }> {
  list(): T[];
  get(id: string): T | undefined;
  replace(rows: readonly T[], expectedRevision: number, actorId: string, source: string): RevisionState;
  upsert(row: T, expectedRevision: number, actorId: string, source: string): RevisionState;
  appendAudit(entry: AuditEntry): void;
  revision(): RevisionState;
  audits(): AuditEntry[];
}

function now(): string {
  return new Date().toISOString();
}

function auditId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `audit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class MemoryRepository<T extends { id: string }> implements RevisionedRepository<T> {
  private rows = new Map<string, T>();
  private currentRevision: RevisionState = { number: 0, changedAt: now(), changedBy: 'system', source: 'initial' };
  private readonly auditRows: AuditEntry[] = [];

  list(): T[] {
    return [...this.rows.values()];
  }

  get(id: string): T | undefined {
    return this.rows.get(id);
  }

  revision(): RevisionState {
    return { ...this.currentRevision };
  }

  audits(): AuditEntry[] {
    return this.auditRows.map((entry) => ({ ...entry }));
  }

  replace(rows: readonly T[], expectedRevision: number, actorId: string, source: string): RevisionState {
    this.assertExpected(expectedRevision);
    const before = this.list();
    this.rows = new Map(rows.map((row) => [row.id, { ...row }]));
    const revision = this.commit(actorId, source);
    this.appendAudit({ id: auditId(), entity: 'collection', entityId: 'all', action: 'replace', source, actorId, timestamp: revision.changedAt, before, after: this.list() });
    return revision;
  }

  upsert(row: T, expectedRevision: number, actorId: string, source: string): RevisionState {
    this.assertExpected(expectedRevision);
    const before = this.rows.get(row.id);
    this.rows.set(row.id, { ...row });
    const revision = this.commit(actorId, source);
    this.appendAudit({ id: auditId(), entity: 'row', entityId: row.id, action: before ? 'update' : 'create', source, actorId, timestamp: revision.changedAt, before, after: { ...row } });
    return revision;
  }

  appendAudit(entry: AuditEntry): void {
    this.auditRows.push({ ...entry });
  }

  private assertExpected(expectedRevision: number): void {
    if (expectedRevision !== this.currentRevision.number) throw new RepositoryError('STALE_REVISION', `Expected revision ${expectedRevision}, current revision is ${this.currentRevision.number}`);
  }

  private commit(changedBy: string, source: string): RevisionState {
    this.currentRevision = { number: this.currentRevision.number + 1, changedAt: now(), changedBy, source };
    return this.revision();
  }
}

export type SheetCodec<T extends { id: string }> = {
  fromRow(row: Record<string, unknown>): T;
  toRow(value: T): Record<string, unknown>;
};

export class SheetRepository<T extends { id: string }> implements RevisionedRepository<T> {
  constructor(private readonly sheet: SheetLike, private readonly headers: readonly string[], private readonly codec: SheetCodec<T>, private readonly revisionStore: RevisionStore) {}

  list(): T[] {
    const rowCount = this.sheet.getLastRow();
    if (rowCount < 2) return [];
    const values = this.sheet.getRange(2, 1, rowCount - 1, this.headers.length).getValues();
    return values.map((row) => this.codec.fromRow(this.recordFromRow(row)));
  }

  get(id: string): T | undefined {
    return this.list().find((row) => row.id === id);
  }

  revision(): RevisionState {
    return this.revisionStore.read();
  }

  audits(): AuditEntry[] {
    return [];
  }

  replace(rows: readonly T[], expectedRevision: number, actorId: string, source: string): RevisionState {
    return this.revisionStore.withExpected(expectedRevision, actorId, source, () => {
      const encoded = rows.map((row) => this.headers.map((header) => this.codec.toRow(row)[header] ?? ''));
      if (encoded.length > 0) this.sheet.getRange(2, 1, encoded.length, this.headers.length).setValues(encoded);
      return this.revisionStore.read();
    });
  }

  upsert(row: T, expectedRevision: number, actorId: string, source: string): RevisionState {
    const rows = this.list();
    const index = rows.findIndex((candidate) => candidate.id === row.id);
    if (index >= 0) rows[index] = row;
    else rows.push(row);
    return this.replace(rows, expectedRevision, actorId, source);
  }

  appendAudit(entry: AuditEntry): void {
    this.sheet.appendRow([entry.id, entry.entity, entry.entityId, entry.action, entry.source, entry.actorId, entry.timestamp, JSON.stringify(entry.before ?? null), JSON.stringify(entry.after ?? null)]);
  }

  private recordFromRow(row: unknown[]): Record<string, unknown> {
    const record: Record<string, unknown> = {};
    this.headers.forEach((header, index) => { record[header] = row[index]; });
    return record;
  }
}

export class RevisionStore {
  constructor(private readonly backing: { get(): RevisionState; set(value: RevisionState): void; lock?: LockLike }) {}

  read(): RevisionState {
    return { ...this.backing.get() };
  }

  withExpected<T>(expectedRevision: number, actorId: string, source: string, action: () => T): T {
    const execute = (): T => {
      const current = this.read();
      if (current.number !== expectedRevision) throw new RepositoryError('STALE_REVISION', `Expected revision ${expectedRevision}, current revision is ${current.number}`);
      const result = action();
      this.backing.set({ number: current.number + 1, changedAt: now(), changedBy: actorId, source });
      return result;
    };
    return this.backing.lock ? withScriptLock(this.backing.lock, execute) : execute();
  }
}

export function revisionFromNumber(number: number, changedBy = 'system', source = 'initial'): Revision {
  return { number, changedAt: now(), changedBy, source };
}
