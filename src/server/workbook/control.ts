import type { ApiError } from '../../shared/domain.js';
import type { SheetLike } from './initializer.js';
import { RepositoryError, type LockLike } from './repository.js';
import { SCHEDULING_INPUT_TABS, tabDefinition, WORKBOOK_TABS, type WorkbookTabName } from './schema.js';

/**
 * Portable control metadata: the versioned record that lets an independent
 * reader share revision authority with the legacy Apps Script writer.
 *
 * The record is one row and every transition rewrites the whole row, so no
 * transition can leave a partially updated counter set. This module owns the
 * codec, the failure taxonomy, the read-side revision provider and idempotent
 * initialization; the mutation lifecycle transitions are the writer protocol's
 * (task 3.1) and build on these primitives.
 *
 * Nothing here falls back to zero. A missing, duplicated, malformed or
 * unsupported record is a typed failure, because a reader that silently treats
 * unknown metadata as revision zero would accept arbitrary data as current.
 */

export const CONTROL_PROTOCOL_VERSION = 1;

export const CONTROL_LIMITS = {
  /** Serialized byte ceiling for the per-tab counter map. */
  tabRevisionsBytes: 4_096,
  /** Serialized byte ceiling for the pending mutation's affected tabs. */
  operationTabsBytes: 4_096,
  /** Serialized byte ceiling for the pending mutation's captured baseline. */
  operationBaselineBytes: 4_096,
  /** Retained journal rows; the writer prunes oldest first under its lock. */
  journalEntries: 200,
  /** Byte ceiling for one journal row. */
  journalEntryBytes: 2_048
} as const;

export type ControlFailureCode =
  | 'MISSING'
  | 'DUPLICATE'
  | 'MALFORMED'
  | 'UNSUPPORTED'
  | 'AUTHORITY_MISMATCH'
  | 'PENDING'
  | 'GENERATION_CHANGED'
  | 'OPERATION_MISMATCH'
  | 'GATE_CLOSED'
  | 'GATE_OPEN'
  | 'LOCKED';

export class ControlError extends Error {
  readonly code: ControlFailureCode;
  constructor(code: ControlFailureCode, message: string) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
  }
}

export type ControlAuthority = 'script-properties' | 'workbook-control';
export type MutationState = 'idle' | 'pending';

export type ControlRecord = {
  protocolVersion: number;
  authorityEpoch: number;
  authority: ControlAuthority;
  generation: number;
  completedGeneration: number;
  dataRevision: number;
  schedulingInputRevision: number;
  tabRevisions: Readonly<Record<string, number>>;
  mutationState: MutationState;
  operationId: string;
  operationStartedAt: string;
  operationTabs: readonly string[];
  operationBaseline: Readonly<Record<string, number>>;
  updatedAt: string;
  updatedBy: string;
};

const CONTROL_COLUMNS = tabDefinition('WorkbookControl').columns;
export { CONTROL_COLUMNS };
const KNOWN_TABS: ReadonlySet<string> = new Set(WORKBOOK_TABS.map((tab) => tab.name));
/** The baseline tuple carries the composed counters beside the per-tab ones. */
const BASELINE_RESERVED_KEYS: ReadonlySet<string> = new Set(['dataRevision', 'schedulingInputRevision']);

function malformed(field: string, detail: string): never {
  throw new ControlError('MALFORMED', `Workbook control field ${field} ${detail}`);
}

function counter(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    malformed(field, 'must be a non-negative integer');
  }
  return value;
}

function text(value: unknown, field: string, maxLength: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') malformed(field, 'must be text');
  if (value.length > maxLength) malformed(field, `must be at most ${maxLength} characters`);
  return value;
}

function counterMap(value: unknown, field: string, limitBytes: number, reservedKeys: ReadonlySet<string> = new Set()): Record<string, number> {
  if (value === null || value === undefined || value === '') return {};
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof serialized !== 'string') malformed(field, 'must be a JSON object');
  if (byteLength(serialized) > limitBytes) malformed(field, `must be at most ${limitBytes} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    malformed(field, 'must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) malformed(field, 'must be a JSON object');
  const output: Record<string, number> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KNOWN_TABS.has(key) && !reservedKeys.has(key)) malformed(field, `names an unknown tab: ${key}`);
    output[key] = counter(entry, `${field}.${key}`);
  }
  return output;
}

function byteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function stringList(value: unknown, field: string, limitBytes: number): string[] {
  if (value === null || value === undefined || value === '') return [];
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof serialized !== 'string' || byteLength(serialized) > limitBytes) malformed(field, `must be at most ${limitBytes} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    malformed(field, 'must be valid JSON');
  }
  if (!Array.isArray(parsed)) malformed(field, 'must be a JSON array');
  return parsed.map((entry) => {
    if (typeof entry !== 'string' || !KNOWN_TABS.has(entry)) malformed(field, 'must name known workbook tabs');
    return entry;
  });
}

function enumerate<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    malformed(field, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/**
 * Parse one control row. `row` is a raw Sheets row in `WorkbookControl` column
 * order. Every field is validated: counters are non-negative safe integers,
 * tab names must exist in the schema, enums are closed, the pending/completed
 * invariants hold, and the serialized maps stay inside their byte ceilings.
 */
export function parseControlRow(row: readonly unknown[]): ControlRecord {
  const at = (column: string): unknown => row[CONTROL_COLUMNS.indexOf(column as (typeof CONTROL_COLUMNS)[number])];
  const protocolVersion = counter(at('protocolVersion'), 'protocolVersion');
  if (protocolVersion !== CONTROL_PROTOCOL_VERSION) {
    throw new ControlError('UNSUPPORTED', `Workbook control protocol ${protocolVersion} is not supported (expected ${CONTROL_PROTOCOL_VERSION})`);
  }
  const authority = enumerate(at('authority'), 'authority', ['script-properties', 'workbook-control'] as const);
  const generation = counter(at('generation'), 'generation');
  const completedGeneration = counter(at('completedGeneration'), 'completedGeneration');
  const mutationState = enumerate(at('mutationState'), 'mutationState', ['idle', 'pending'] as const);
  if (mutationState === 'idle' && completedGeneration !== generation) {
    malformed('completedGeneration', 'must equal generation while the protocol is idle');
  }
  const operationId = text(at('operationId'), 'operationId', 128);
  const operationStartedAt = text(at('operationStartedAt'), 'operationStartedAt', 64);
  const operationTabs = stringList(at('operationTabs'), 'operationTabs', CONTROL_LIMITS.operationTabsBytes);
  const operationBaseline = counterMap(at('operationBaseline'), 'operationBaseline', CONTROL_LIMITS.operationBaselineBytes, BASELINE_RESERVED_KEYS);
  if (mutationState === 'pending') {
    if (operationId === '') malformed('operationId', 'is required while a mutation is pending');
    if (operationTabs.length === 0) malformed('operationTabs', 'must name at least one tab while a mutation is pending');
  } else if (operationId !== '' || operationTabs.length > 0) {
    malformed('operationId', 'must be empty while the protocol is idle');
  }
  return {
    protocolVersion,
    authorityEpoch: counter(at('authorityEpoch'), 'authorityEpoch'),
    authority,
    generation,
    completedGeneration,
    dataRevision: counter(at('dataRevision'), 'dataRevision'),
    schedulingInputRevision: counter(at('schedulingInputRevision'), 'schedulingInputRevision'),
    tabRevisions: counterMap(at('tabRevisions'), 'tabRevisions', CONTROL_LIMITS.tabRevisionsBytes),
    mutationState,
    operationId,
    operationStartedAt,
    operationTabs,
    operationBaseline,
    updatedAt: text(at('updatedAt'), 'updatedAt', 64),
    updatedBy: text(at('updatedBy'), 'updatedBy', 200)
  };
}

/** The row a transition writes, in `WorkbookControl` column order. */
export function serializeControlRecord(record: ControlRecord): unknown[] {
  // The mapped type requires every schema column, so a column added to the
  // schema without a serializer fails the type check instead of silently
  // writing an empty cell.
  const byColumn: Record<(typeof CONTROL_COLUMNS)[number], unknown> = {
    protocolVersion: record.protocolVersion,
    authorityEpoch: record.authorityEpoch,
    authority: record.authority,
    generation: record.generation,
    completedGeneration: record.completedGeneration,
    dataRevision: record.dataRevision,
    schedulingInputRevision: record.schedulingInputRevision,
    tabRevisions: Object.keys(record.tabRevisions).length === 0 ? '' : JSON.stringify(sortKeys(record.tabRevisions)),
    mutationState: record.mutationState,
    operationId: record.operationId,
    operationStartedAt: record.operationStartedAt,
    operationTabs: record.operationTabs.length === 0 ? '' : JSON.stringify([...record.operationTabs]),
    operationBaseline: Object.keys(record.operationBaseline).length === 0 ? '' : JSON.stringify(sortKeys(record.operationBaseline)),
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy
  };
  return CONTROL_COLUMNS.map((column) => byColumn[column]);
}

function sortKeys(map: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(map).sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * A freshly initialized record: protocol version present, authority still with
 * Script Properties and every counter zero. Activation (a reviewed maintenance
 * step) captures live counters with `max(captured, current)`; nothing here
 * invents a revision.
 */
export function emptyControlRecord(now: string, updatedBy: string): ControlRecord {
  return {
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    authorityEpoch: 0,
    authority: 'script-properties',
    generation: 0,
    completedGeneration: 0,
    dataRevision: 0,
    schedulingInputRevision: 0,
    tabRevisions: {},
    mutationState: 'idle',
    operationId: '',
    operationStartedAt: '',
    operationTabs: [],
    operationBaseline: {},
    updatedAt: now,
    updatedBy
  };
}

/**
 * Validate the single control record from its data rows (header excluded). Both
 * readers use this: the Apps Script adapter passes SpreadsheetApp rows, the
 * Worker passes the rows its validated REST batch returned.
 */
export function controlRecordFromRows(rows: readonly (readonly unknown[])[]): ControlRecord {
  const data = rows.filter((row) => row.some((cell) => cell !== '' && cell !== null && cell !== undefined));
  if (data.length === 0) throw new ControlError('MISSING', 'The workbook control record is missing');
  if (data.length > 1) throw new ControlError('DUPLICATE', `The workbook control tab holds ${data.length} data rows; exactly one is allowed`);
  return parseControlRow(data[0] ?? []);
}

/** Read and validate the single control row from a sheet. */
export function readControlRecord(sheet: SheetLike): ControlRecord {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new ControlError('MISSING', 'The workbook control record is missing');
  return controlRecordFromRows(sheet.getRange(2, 1, lastRow - 1, CONTROL_COLUMNS.length).getValues());
}

/**
 * Idempotent initialization: writes the empty record only when none exists.
 * A malformed, duplicated or unsupported record is never overwritten — that is
 * a recovery decision, not an initialization side effect.
 */
export function initializeControlRecord(sheet: SheetLike, now: string, updatedBy: string): { record: ControlRecord; created: boolean } {
  try {
    return { record: readControlRecord(sheet), created: false };
  } catch (error) {
    if (!(error instanceof ControlError) || error.code !== 'MISSING') throw error;
  }
  const record = emptyControlRecord(now, updatedBy);
  sheet.getRange(2, 1, 1, CONTROL_COLUMNS.length).setValues([serializeControlRecord(record)]);
  return { record, created: true };
}

export type PortableRevisionProvider = {
  authority: ControlAuthority;
  protocolVersion: number;
  generation: number;
  completedGeneration: number;
  idle: boolean;
  dataRevision(): number;
  schedulingInputRevision(): number;
  tabRevision(tab: WorkbookTabName): number;
  /** Revisions for a set of consumed tabs, for tuple comparison across a read. */
  revisionTuple(tabs: readonly WorkbookTabName[]): string;
};

export function portableRevisionProvider(record: ControlRecord): PortableRevisionProvider {
  const tabRevision = (tab: WorkbookTabName): number => record.tabRevisions[tab] ?? 0;
  return {
    authority: record.authority,
    protocolVersion: record.protocolVersion,
    generation: record.generation,
    completedGeneration: record.completedGeneration,
    idle: record.mutationState === 'idle',
    dataRevision: () => record.dataRevision,
    schedulingInputRevision: () => record.schedulingInputRevision,
    tabRevision,
    revisionTuple: (tabs) => [
      record.generation,
      record.completedGeneration,
      record.dataRevision,
      record.schedulingInputRevision,
      ...tabs.map((tab) => `${tab}:${tabRevision(tab)}`)
    ].join('|')
  };
}

/**
 * The completed-snapshot check a reader applies after hydration: the same
 * generation and revision tuple must bracket the read, and neither observation
 * may show a pending mutation. Equal revisions alone are not enough — an abort
 * advances the generation without moving a counter.
 */
export function assertCompletedGeneration(before: PortableRevisionProvider, after: PortableRevisionProvider, tabs: readonly WorkbookTabName[]): void {
  if (!before.idle || !after.idle) throw new ControlError('PENDING', 'A mutation is in progress; the snapshot is not current');
  if (before.revisionTuple(tabs) !== after.revisionTuple(tabs)) {
    throw new ControlError('GENERATION_CHANGED', 'The workbook changed while it was being read');
  }
}

/** The authority a reader or writer was activated for. */
export function assertAuthority(record: ControlRecord, expected: ControlAuthority): void {
  if (record.authority !== expected) {
    throw new ControlError('AUTHORITY_MISMATCH', `Workbook control authority is ${record.authority}, expected ${expected}`);
  }
}

/**
 * Translate a control failure into the repository error the dispatcher and the
 * client already understand, so the transport layer never has to know about the
 * protocol's own taxonomy.
 */
export function toRepositoryError(error: unknown, access: 'read' | 'write'): unknown {
  if (!(error instanceof ControlError)) return error;
  return new RepositoryError(controlFailureCode(error.code, access), error.message);
}

/** Map a control failure onto the API error codes the readers and writers return. */
export function controlFailureCode(code: ControlFailureCode, access: 'read' | 'write'): ApiError['code'] {
  switch (code) {
    case 'GENERATION_CHANGED': return 'STALE_REVISION';
    case 'PENDING': return access === 'write' ? 'CONFLICT' : 'UNAVAILABLE';
    case 'OPERATION_MISMATCH':
    case 'LOCKED': return 'CONFLICT';
    case 'GATE_OPEN': return 'UNAVAILABLE';
    default: return 'UNAVAILABLE';
  }
}

/**
 * Mutation lifecycle. A mutation is begin → domain writes → completion, and a
 * crash anywhere leaves the pending marker in place: dead traffic must never
 * clear it, and a reader that sees it rejects the snapshot. Counters advance on
 * exactly one transition — completion — so an abort moves the generation
 * without moving a revision, which is why readers compare the whole tuple and
 * not only the revision.
 */

export type JournalEvent = 'capture' | 'activate' | 'begin' | 'commit' | 'abort' | 'recover' | 'rollback';

export const JOURNAL_COLUMNS = tabDefinition('ControlJournal').columns;

export type ControlJournalEntry = {
  id: string;
  generation: number;
  event: JournalEvent;
  operationId: string;
  actorId: string;
  tabs: readonly string[];
  before: Readonly<Record<string, number>>;
  after: Readonly<Record<string, number>>;
  reason: string;
  timestamp: string;
};

/** The revision tuple a journal entry records, for before/after comparison. */
export function controlCounters(record: ControlRecord): Record<string, number> {
  return {
    dataRevision: record.dataRevision,
    schedulingInputRevision: record.schedulingInputRevision,
    ...sortKeys(record.tabRevisions)
  };
}

function opaqueId(prefix: string): string {
  // Guarded exactly like the audit id in repository.ts: the Apps Script bundle
  // audit fails the build when a Node or workerd global is touched unguarded,
  // and the cast is type-level only because the Workers type program declares
  // `crypto` as a `const`.
  if (typeof (globalThis as { crypto?: unknown }).crypto === 'object') {
    const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function journalId(): string {
  return opaqueId('journal');
}

/** Operation identity for the pending marker: operation name plus an opaque id. */
export function controlOperationId(operation: string): string {
  return `${operation}#${opaqueId('op')}`;
}

export function serializeJournalEntry(entry: ControlJournalEntry): unknown[] {
  const byColumn: Record<(typeof JOURNAL_COLUMNS)[number], unknown> = {
    id: entry.id,
    generation: entry.generation,
    event: entry.event,
    operationId: entry.operationId,
    actorId: entry.actorId,
    tabs: entry.tabs.length === 0 ? '' : JSON.stringify([...entry.tabs]),
    before: Object.keys(entry.before).length === 0 ? '' : JSON.stringify(sortKeys(entry.before)),
    after: Object.keys(entry.after).length === 0 ? '' : JSON.stringify(sortKeys(entry.after)),
    reason: entry.reason,
    timestamp: entry.timestamp
  };
  return JOURNAL_COLUMNS.map((column) => byColumn[column]);
}

/** A sheet that can prune: the maintenance journal is bounded by row count. */
export type PrunableSheetLike = SheetLike & { deleteRows?(rowPosition: number, howMany: number): void };

/**
 * Append one journal entry, pruning oldest-first past the retention ceiling when
 * the sheet supports it. An entry that cannot be written inside its byte
 * ceiling is refused rather than truncated: a truncated recovery record is worse
 * than none.
 */
export function appendJournalEntry(sheet: PrunableSheetLike, entry: ControlJournalEntry): void {
  const row = serializeJournalEntry(entry);
  if (byteLength(JSON.stringify(row)) > CONTROL_LIMITS.journalEntryBytes) {
    throw new ControlError('MALFORMED', `Workbook control journal entry exceeds ${CONTROL_LIMITS.journalEntryBytes} bytes`);
  }
  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, 1, JOURNAL_COLUMNS.length).setValues([row]);
  if (typeof sheet.deleteRows !== 'function') return;
  const dataRows = sheet.getLastRow() - 1;
  if (dataRows > CONTROL_LIMITS.journalEntries) {
    sheet.deleteRows(2, dataRows - CONTROL_LIMITS.journalEntries);
  }
}

export type ControlMutationRequest = {
  /** `<operation>#<opaque id>`; carries no actor or credential material. */
  operationId: string;
  /** Tabs this mutation may commit; a commit of an undeclared tab is refused. */
  tabs: readonly WorkbookTabName[];
  actorId: string;
};

/** Pure transition: publish the in-progress marker before any row changes. */
export function beginMutationRecord(record: ControlRecord, request: ControlMutationRequest, timestamp: string): ControlRecord {
  if (record.mutationState !== 'idle') {
    throw new ControlError('PENDING', `A mutation (${record.operationId || 'unknown'}) is already pending`);
  }
  if (request.operationId.trim().length === 0 || request.operationId.length > 128) {
    throw new ControlError('MALFORMED', 'A mutation requires an operation id of at most 128 characters');
  }
  if (request.tabs.length === 0) throw new ControlError('MALFORMED', 'A mutation must declare at least one affected tab');
  return {
    ...record,
    generation: record.generation + 1,
    mutationState: 'pending',
    operationId: request.operationId,
    operationStartedAt: timestamp,
    operationTabs: [...request.tabs],
    operationBaseline: controlCounters(record),
    updatedAt: timestamp,
    updatedBy: request.actorId
  };
}

/**
 * Pure transition: completion, after domain rows and audit data persisted. The
 * global revision advances once, the scheduling-input revision advances when a
 * committed tab is a scheduling input, and each committed tab advances by one.
 */
export function commitMutationRecord(record: ControlRecord, committedTabs: readonly WorkbookTabName[], actorId: string, timestamp: string): ControlRecord {
  requirePending(record);
  const tabRevisions = { ...record.tabRevisions };
  for (const tab of new Set(committedTabs)) tabRevisions[tab] = (tabRevisions[tab] ?? 0) + 1;
  const touchesSchedulingInput = committedTabs.some((tab) => SCHEDULING_INPUT_TABS.has(tab));
  return {
    ...record,
    generation: record.generation + 1,
    completedGeneration: record.generation + 1,
    dataRevision: record.dataRevision + 1,
    schedulingInputRevision: record.schedulingInputRevision + (touchesSchedulingInput ? 1 : 0),
    tabRevisions,
    mutationState: 'idle',
    operationId: '',
    operationStartedAt: '',
    operationTabs: [],
    operationBaseline: {},
    updatedAt: timestamp,
    updatedBy: actorId
  };
}

/**
 * Pure transition: an admitted mutating operation that changed no rows. Nothing
 * was fenced, so no pending marker is published, but the global revision still
 * counts the successful operation and the generation moves so a concurrent
 * reader's bracket cannot straddle it silently.
 */
export function recordOperationCompletion(record: ControlRecord, actorId: string, timestamp: string): ControlRecord {
  if (record.mutationState !== 'idle') {
    throw new ControlError('PENDING', `A mutation (${record.operationId || 'unknown'}) is already pending`);
  }
  return {
    ...record,
    generation: record.generation + 1,
    completedGeneration: record.generation + 1,
    dataRevision: record.dataRevision + 1,
    updatedAt: timestamp,
    updatedBy: actorId
  };
}

/**
 * Pure transition: abort. The generation still advances, so a read that started
 * under the pending marker cannot accept its snapshot, while every counter stays
 * exactly where it was — an aborted mutation is not a revision.
 */
export function abortMutationRecord(record: ControlRecord, actorId: string, timestamp: string): ControlRecord {
  requirePending(record);
  return {
    ...record,
    generation: record.generation + 1,
    completedGeneration: record.generation + 1,
    mutationState: 'idle',
    operationId: '',
    operationStartedAt: '',
    operationTabs: [],
    operationBaseline: {},
    updatedAt: timestamp,
    updatedBy: actorId
  };
}

function requirePending(record: ControlRecord): void {
  if (record.mutationState !== 'pending') {
    throw new ControlError('OPERATION_MISMATCH', 'No mutation is pending; there is nothing to complete or abort');
  }
}

export type RecoveryDecision = 'completed' | 'not-started' | 'restored';

export type RecoveryRequest = {
  /**
   * What the reviewer established about the interrupted mutation:
   * `completed` — every affected tab's persistence was verified;
   * `not-started` — no row was changed;
   * `restored` — rows were partially written and have been restored from the
   * approved snapshot.
   */
  decision: RecoveryDecision;
  actorId: string;
  /** The reviewed conclusion. Required, because the journal must explain itself. */
  reason: string;
  /** Tabs whose persistence the reviewer verified, for `completed`. */
  committedTabs?: readonly WorkbookTabName[];
};

/**
 * Pure transition for an interrupted mutation. It refuses to act unless a
 * mutation is actually pending, which is what makes a repeated recovery stop
 * instead of advancing every counter a second time. Rows are never restored by
 * this function — the reviewed procedure does that — and no counter is ever
 * written back to a snapshot value: recovering a restore advances the generation
 * and leaves the counters exactly where they were.
 */
export function recoveryTransition(record: ControlRecord, request: RecoveryRequest, timestamp: string): ControlRecord {
  if (record.mutationState !== 'pending') {
    throw new ControlError('OPERATION_MISMATCH', 'No interrupted mutation is pending; recovering again would advance the counters twice');
  }
  if (request.reason.trim().length === 0) {
    throw new ControlError('MALFORMED', 'A recovery decision must record the reason it was reached');
  }
  if (request.decision === 'completed') {
    const tabs = request.committedTabs ?? [];
    if (tabs.length === 0) {
      throw new ControlError('MALFORMED', 'A completed recovery must name the tabs whose persistence was verified');
    }
    return commitMutationRecord(record, tabs, request.actorId, timestamp);
  }
  return abortMutationRecord(record, request.actorId, timestamp);
}

export type ActivationRequest = {
  /** Counters read from the outgoing authority, captured before the switch. */
  captured: {
    dataRevision: number;
    schedulingInputRevision: number;
    tabRevisions: Readonly<Record<string, number>>;
  };
  actorId: string;
  reason: string;
};

/**
 * Pure transition for the migration's authority switch. The counters are taken as
 * `max(captured, current)` in every dimension, so a capture snapshot can never
 * lower one, and the generation moves so a reader bracketed across the switch
 * rejects its snapshot instead of accepting one that spans two authorities.
 */
export function activationTransition(record: ControlRecord, request: ActivationRequest, timestamp: string): ControlRecord {
  if (record.mutationState !== 'idle') {
    throw new ControlError('PENDING', `A mutation (${record.operationId || 'unknown'}) is pending; activate with writers drained and the record idle`);
  }
  if (request.reason.trim().length === 0) {
    throw new ControlError('MALFORMED', 'Activation must record why it is being performed');
  }
  const tabRevisions = { ...record.tabRevisions };
  for (const [tab, value] of Object.entries(request.captured.tabRevisions)) {
    if (!KNOWN_TABS.has(tab)) throw new ControlError('MALFORMED', `Activation captured an unknown tab: ${tab}`);
    if (!Number.isSafeInteger(value) || value < 0) throw new ControlError('MALFORMED', `Activation captured a non-integer counter for ${tab}`);
    tabRevisions[tab] = Math.max(tabRevisions[tab] ?? 0, value);
  }
  const generation = record.generation + 1;
  return {
    ...record,
    authority: 'workbook-control',
    authorityEpoch: record.authorityEpoch + 1,
    generation,
    completedGeneration: generation,
    dataRevision: Math.max(record.dataRevision, request.captured.dataRevision),
    schedulingInputRevision: Math.max(record.schedulingInputRevision, request.captured.schedulingInputRevision),
    tabRevisions,
    updatedAt: timestamp,
    updatedBy: request.actorId
  };
}

export type RollbackRequest = {
  /**
   * Counters read from the authority being restored, captured before the switch.
   * The restored counters become authoritative again, so they are taken as
   * `max(captured, current)`: a rollback can never lower a revision a client has
   * already seen, and a stopped legacy writer that got one write in before the
   * switch cannot be rolled over.
   */
  captured: {
    dataRevision: number;
    schedulingInputRevision: number;
    tabRevisions: Readonly<Record<string, number>>;
  };
  actorId: string;
  reason: string;
};

/**
 * Pure transition for the reverse authority switch: an approved rollback returns
 * the workbook to the Script Properties authority.
 *
 * It is the mirror of `activationTransition`, with the same guarantees and one
 * extra refusal. The generation moves so a reader bracketed across the switch
 * rejects its snapshot rather than accepting one that spans two authorities; the
 * authority epoch moves so the rollback is distinguishable from a first
 * activation; and the counters only ever rise. Unlike activation it requires the
 * record to be **already** on the portable authority, which is what makes a
 * repeated rollback stop instead of advancing the epoch every time it is run.
 */
export function rollbackTransition(record: ControlRecord, request: RollbackRequest, timestamp: string): ControlRecord {
  if (record.mutationState !== 'idle') {
    throw new ControlError('PENDING', `A mutation (${record.operationId || 'unknown'}) is pending; roll back with writers drained and the record idle`);
  }
  if (record.authority !== 'workbook-control') {
    throw new ControlError('AUTHORITY_MISMATCH', `Rollback requires a workbook on the portable authority; the record says ${record.authority}`);
  }
  if (request.reason.trim().length === 0) {
    throw new ControlError('MALFORMED', 'A rollback must record why it is being performed');
  }
  const tabRevisions = { ...record.tabRevisions };
  for (const [tab, value] of Object.entries(request.captured.tabRevisions)) {
    if (!KNOWN_TABS.has(tab)) throw new ControlError('MALFORMED', `Rollback captured an unknown tab: ${tab}`);
    if (!Number.isSafeInteger(value) || value < 0) throw new ControlError('MALFORMED', `Rollback captured a non-integer counter for ${tab}`);
    tabRevisions[tab] = Math.max(tabRevisions[tab] ?? 0, value);
  }
  const capturedScalar = (value: number, field: string): number => {
    // Refused rather than ignored: a negative or fractional capture means the
    // caller read the wrong thing, and silently taking the record's value would
    // hide that the rollback was performed against numbers nobody verified.
    if (!Number.isSafeInteger(value) || value < 0) throw new ControlError('MALFORMED', `Rollback captured a non-integer ${field}`);
    return value;
  };
  const generation = record.generation + 1;
  return {
    ...record,
    authority: 'script-properties',
    authorityEpoch: record.authorityEpoch + 1,
    generation,
    completedGeneration: generation,
    dataRevision: Math.max(record.dataRevision, capturedScalar(request.captured.dataRevision, 'dataRevision')),
    schedulingInputRevision: Math.max(record.schedulingInputRevision, capturedScalar(request.captured.schedulingInputRevision, 'schedulingInputRevision')),
    tabRevisions,
    updatedAt: timestamp,
    updatedBy: request.actorId
  };
}

export type MutationScope = {
  readonly operationId: string;
  readonly actorId: string;
  readonly tabs: readonly WorkbookTabName[];
  /** The record as read at begin, for reconciliation and diagnostics. */
  readonly baseline: ControlRecord;
  /**
   * Declare one more tab may be committed. The widening path calls this after
   * the marker has been extended; nothing else should.
   */
  declare(tab: WorkbookTabName): void;
  /** Register a tab whose rows and audit data persisted. */
  markCommitted(tab: WorkbookTabName): void;
  committedTabs(): readonly WorkbookTabName[];
};

export type ControlMutationWriterOptions = {
  control: SheetLike;
  journal: PrunableSheetLike;
  /** Omitted when the caller already holds the script lock for the whole mutation. */
  lock?: LockLike;
  /** Live operational gate. Mutations are refused unless it returns true. */
  writeEnabled: () => boolean;
  /** Authority this writer was activated for; both it and the gate are required. */
  authority: ControlAuthority;
  now?: () => string;
  /** Script-lock wait, in milliseconds. */
  lockTimeoutMs?: number;
};

/**
 * The fenced writer side of the protocol: script lock, live gate, authority and
 * the durable pending/completed transitions. `begin` refuses unless the live
 * gate is open, the authority is this writer's, the record is idle and the lock
 * is held; the pending row is written before the caller touches any domain row,
 * so a crash at any later point leaves an auditable marker rather than a silent
 * partial change.
 */
export class ControlMutationWriter {
  private readonly options: ControlMutationWriterOptions;

  constructor(options: ControlMutationWriterOptions) {
    this.options = options;
  }

  begin(request: ControlMutationRequest): { scope: MutationScope; record: ControlRecord } {
    return this.fenced(() => {
      const current = this.admit(undefined);
      const record = beginMutationRecord(current, request, this.timestamp());
      this.transition('begin', record, current, request.actorId, request.tabs, '');
      const committed = new Set<WorkbookTabName>();
      const declared = new Set<WorkbookTabName>(request.tabs);
      const scope: MutationScope = {
        operationId: request.operationId,
        actorId: request.actorId,
        tabs: [...request.tabs],
        baseline: current,
        declare: (tab) => { declared.add(tab); },
        markCommitted: (tab) => {
          if (!declared.has(tab)) {
            throw new ControlError('OPERATION_MISMATCH', `Mutation ${request.operationId} committed an undeclared tab: ${tab}`);
          }
          committed.add(tab);
        },
        committedTabs: () => [...committed]
      };
      return { scope, record };
    });
  }

  /**
   * Extend the pending marker to another tab before that tab's rows change.
   * Counters do not move: widening is a declaration, not a transition, and the
   * completion still advances each committed tab exactly once.
   */
  extend(scope: MutationScope, tab: WorkbookTabName): { record: ControlRecord } {
    return this.fenced(() => {
      const current = this.admit(scope.operationId);
      if (current.operationTabs.includes(tab)) return { record: current };
      const record: ControlRecord = {
        ...current,
        operationTabs: [...current.operationTabs, tab],
        updatedAt: this.timestamp(),
        updatedBy: scope.actorId
      };
      this.transition('begin', record, current, scope.actorId, record.operationTabs, `widened to include ${tab}`);
      return { record };
    });
  }

  commit(scope: MutationScope): { record: ControlRecord } {
    return this.fenced(() => {
      const current = this.admit(scope.operationId);
      const record = commitMutationRecord(current, scope.committedTabs(), scope.actorId, this.timestamp());
      this.transition('commit', record, current, scope.actorId, scope.committedTabs(), '');
      return { record };
    });
  }

  abort(scope: MutationScope, reason: string): { record: ControlRecord } {
    return this.fenced(() => {
      const current = this.admit(scope.operationId);
      const record = abortMutationRecord(current, scope.actorId, this.timestamp());
      this.transition('abort', record, current, scope.actorId, current.operationTabs, reason);
      return { record };
    });
  }

  /**
   * Apply a reviewed recovery decision to an interrupted mutation. The script
   * lock and the authority are required, but the **live write gate is not
   * consulted on purpose**: recovery is a stopped-service procedure, and the gate
   * is expected to be closed while it runs. Nothing else in this class skips that
   * check.
   */
  recover(request: RecoveryRequest): { record: ControlRecord } {
    return this.fenced(() => {
      const current = readControlRecord(this.options.control);
      assertAuthority(current, this.options.authority);
      const record = recoveryTransition(current, request, this.timestamp());
      this.transition('recover', record, current, request.actorId, request.committedTabs ?? current.operationTabs, request.reason);
      return { record };
    });
  }

  /**
   * The migration's authority switch. Like recovery it is a stopped-service
   * procedure, so the live gate is expected to be **closed** and is not
   * consulted; the lock and the authority are still required.
   */
  activate(request: ActivationRequest): { record: ControlRecord } {
    return this.fenced(() => {
      const current = readControlRecord(this.options.control);
      const record = activationTransition(current, request, this.timestamp());
      this.transition('activate', record, current, request.actorId, Object.keys(request.captured.tabRevisions), request.reason);
      return { record };
    });
  }

  /**
   * The reverse of `activate`: an approved rollback returns the workbook to the
   * Script Properties authority. Like recovery and activation it is a
   * stopped-service procedure, so the live gate is expected to be **closed** and
   * is not consulted. The writer's own authority is required, so a process that
   * is not on the portable authority cannot roll anything back, and the record
   * must be idle and activated.
   */
  revert(request: RollbackRequest): { record: ControlRecord } {
    return this.fenced(() => {
      const current = readControlRecord(this.options.control);
      assertAuthority(current, this.options.authority);
      const record = rollbackTransition(current, request, this.timestamp());
      this.transition('rollback', record, current, request.actorId, Object.keys(request.captured.tabRevisions), request.reason);
      return { record };
    });
  }

  /**
   * Reconcile a batch that was applied outside the protocol, as the reviewed
   * direct-write procedure requires. The batch is fenced first — a marker naming
   * the tabs it touched — and then settled by the reviewer's decision, so the
   * record never presents unreconciled rows as current and the arithmetic stays
   * the protocol's. The live gate is expected to be closed.
   */
  reconcile(request: { decision: RecoveryDecision; reason: string; actorId: string; committedTabs: readonly WorkbookTabName[] }): { record: ControlRecord } {
    return this.fenced(() => {
      const current = readControlRecord(this.options.control);
      assertAuthority(current, this.options.authority);
      if (current.mutationState !== 'idle') {
        throw new ControlError('PENDING', `A mutation (${current.operationId || 'unknown'}) is already pending; settle it before reconciling a batch`);
      }
      if (request.committedTabs.length === 0) {
        throw new ControlError('MALFORMED', 'A reconciliation must name the tabs the batch touched');
      }
      if (request.reason.trim().length === 0) {
        throw new ControlError('MALFORMED', 'A reconciliation must record why it was performed');
      }
      const opened = beginMutationRecord(current, { operationId: controlOperationId('direct-write.reconcile'), tabs: request.committedTabs, actorId: request.actorId }, this.timestamp());
      this.transition('begin', opened, current, request.actorId, [...request.committedTabs], `reconciliation: ${request.reason}`);
      const record = recoveryTransition(opened, { decision: request.decision, actorId: request.actorId, reason: request.reason, committedTabs: request.committedTabs }, this.timestamp());
      this.transition('recover', record, opened, request.actorId, [...request.committedTabs], request.reason);
      return { record };
    });
  }

  /**
   * An admitted mutating operation that changed no rows. Nothing was fenced, so
   * no marker is published, but the global revision still counts the operation.
   */
  completeWithoutRows(actorId: string): { record: ControlRecord } {
    return this.fenced(() => {
      const current = this.admit(undefined);
      const record = recordOperationCompletion(current, actorId, this.timestamp());
      this.transition('commit', record, current, actorId, [], 'no rows changed');
      return { record };
    });
  }

  /** Read the record under the lock, refusing anything this writer may not touch. */
  private admit(operationId: string | undefined): ControlRecord {
    if (!this.options.writeEnabled()) {
      throw new ControlError('GATE_CLOSED', 'The live write gate is closed; no mutation may begin');
    }
    const current = readControlRecord(this.options.control);
    assertAuthority(current, this.options.authority);
    if (operationId !== undefined && (current.mutationState !== 'pending' || current.operationId !== operationId)) {
      throw new ControlError('OPERATION_MISMATCH', `Pending mutation ${current.operationId || '(none)'} does not match ${operationId}`);
    }
    return current;
  }

  /** Journal first, then the control row: a crash between them leaves an auditable attempt. */
  private transition(event: JournalEvent, record: ControlRecord, previous: ControlRecord, actorId: string, tabs: readonly string[], reason: string): void {
    appendJournalEntry(this.options.journal, {
      id: journalId(),
      generation: record.generation,
      event,
      operationId: record.operationId === '' ? previous.operationId : record.operationId,
      actorId,
      tabs,
      before: controlCounters(previous),
      after: controlCounters(record),
      reason,
      timestamp: record.updatedAt
    });
    this.options.control.getRange(2, 1, 1, CONTROL_COLUMNS.length).setValues([serializeControlRecord(record)]);
  }

  private fenced<T>(action: () => T): T {
    const lock = this.options.lock;
    if (!lock) return action();
    const timeout = this.options.lockTimeoutMs ?? 10_000;
    if (!lock.tryLock(timeout)) throw new ControlError('LOCKED', 'Another write holds the workbook control lock');
    try {
      return action();
    } finally {
      lock.releaseLock();
    }
  }

  private timestamp(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}
