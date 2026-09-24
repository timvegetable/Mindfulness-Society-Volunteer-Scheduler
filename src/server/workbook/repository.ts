import type { ApiError, Revision } from '../../shared/domain.js';
import type { SheetLike } from './initializer.js';
import type { SheetValueContext } from './sheet-values.js';

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
  const cryptoApi = typeof globalThis.crypto === 'object' ? globalThis.crypto : undefined;
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
  fromRow(row: Record<string, unknown>, context?: SheetValueContext): T;
  toRow(value: T): Record<string, unknown>;
};

export class SheetRepository<T extends { id: string }> implements RevisionedRepository<T> {
  private snapshot: T[] | undefined;

  constructor(private readonly sheet: SheetLike, private readonly headers: readonly string[], private readonly codec: SheetCodec<T>, private readonly revisionStore: RevisionStore, private readonly auditWriter?: (entry: AuditEntry) => void, private readonly context: SheetValueContext = {}, private readonly onRead?: <R>(tab: string, action: () => R) => R, private readonly onSheetCall?: <R>(action: () => R) => R) {}

  /** Hydrate a read-only route from one validated workbook batch before list(). */
  primeRows(rows: readonly (readonly unknown[])[]): void {
    if (this.snapshot !== undefined) throw new Error(`Workbook tab ${this.sheet.getName()} was already read in this request`);
    const decode = (): T[] => rows.map((row) => this.codec.fromRow(this.recordFromRow([...row]), { ...this.context, numericDateTimeSerials: true }));
    this.snapshot = this.onRead ? this.onRead(this.sheet.getName(), decode) : decode();
  }

  /**
   * Decodes the tab once per request: `get`, `upsert`, and every consumer of
   * `list()` share this snapshot, and a successful write replaces it. Rows are
   * never retained beyond the request that read them.
   */
  list(): T[] {
    if (!this.snapshot) {
      const read = (): T[] => {
        const rowCount = this.onSheetCall ? this.onSheetCall(() => this.sheet.getLastRow()) : this.sheet.getLastRow();
        if (rowCount < 2) return [];
        const readValues = () => this.sheet.getRange(2, 1, rowCount - 1, this.headers.length).getValues();
        const values = this.onSheetCall ? this.onSheetCall(readValues) : readValues();
        return values.map((row) => this.codec.fromRow(this.recordFromRow(row), this.context));
      };
      this.snapshot = this.onRead ? this.onRead(this.sheet.getName(), read) : read();
    }
    return [...this.snapshot];
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
    return this.revisionStore.withExpected(expectedRevision, actorId, source, (nextRevision) => {
      const before = this.list();
      const encoded = rows.map((row) => this.headers.map((header) => this.codec.toRow(row)[header] ?? ''));
      if (encoded.length > 0) this.sheet.getRange(2, 1, encoded.length, this.headers.length).setValues(encoded);
      if (this.sheet.getLastRow() > rows.length + 1) {
        const staleRows = this.sheet.getRange(rows.length + 2, 1, this.sheet.getLastRow() - rows.length - 1, this.headers.length);
        staleRows.clearContent?.();
      }
      // The request's snapshot follows the committed write so later reads in the
      // same execution see exactly what was stored.
      this.snapshot = rows.map((row) => ({ ...row }));
      this.auditWriter?.({ id: auditId(), entity: this.sheet.getName(), entityId: 'all', action: 'replace', source, actorId, timestamp: nextRevision.changedAt, before, after: [...rows] });
      return nextRevision;
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
    if (this.auditWriter) {
      this.auditWriter(entry);
      return;
    }
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

  withExpected<T>(expectedRevision: number, actorId: string, source: string, action: (nextRevision: RevisionState) => T): T {
    const execute = (): T => {
      const current = this.read();
      if (current.number !== expectedRevision) throw new RepositoryError('STALE_REVISION', `Expected revision ${expectedRevision}, current revision is ${current.number}`);
      const nextRevision: RevisionState = { number: current.number + 1, changedAt: now(), changedBy: actorId, source };
      const result = action(nextRevision);
      this.backing.set(nextRevision);
      return result;
    };
    return this.backing.lock ? withScriptLock(this.backing.lock, execute) : execute();
  }
}

export function revisionFromNumber(number: number, changedBy = 'system', source = 'initial'): Revision {
  return { number, changedAt: now(), changedBy, source };
}
