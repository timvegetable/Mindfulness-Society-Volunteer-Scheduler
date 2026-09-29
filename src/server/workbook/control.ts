import type { ApiError } from '../../shared/domain.js';
import type { SheetLike } from './initializer.js';
import { tabDefinition, WORKBOOK_TABS, type WorkbookTabName } from './schema.js';

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
  | 'GENERATION_CHANGED';

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

function counterMap(value: unknown, field: string, limitBytes: number): Record<string, number> {
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
    if (!KNOWN_TABS.has(key)) malformed(field, `names an unknown tab: ${key}`);
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
  const operationBaseline = counterMap(at('operationBaseline'), 'operationBaseline', CONTROL_LIMITS.operationBaselineBytes);
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

/** Read and validate the single control row. */
export function readControlRecord(sheet: SheetLike): ControlRecord {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new ControlError('MISSING', 'The workbook control record is missing');
  const rows = sheet.getRange(2, 1, lastRow - 1, CONTROL_COLUMNS.length).getValues()
    .filter((row) => row.some((cell) => cell !== '' && cell !== null && cell !== undefined));
  if (rows.length === 0) throw new ControlError('MISSING', 'The workbook control record is missing');
  if (rows.length > 1) throw new ControlError('DUPLICATE', `The workbook control tab holds ${rows.length} data rows; exactly one is allowed`);
  return parseControlRow(rows[0] ?? []);
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

/** Map a control failure onto the API error codes the readers and writers return. */
export function controlFailureCode(code: ControlFailureCode, access: 'read' | 'write'): ApiError['code'] {
  switch (code) {
    case 'GENERATION_CHANGED': return 'STALE_REVISION';
    case 'PENDING': return access === 'write' ? 'CONFLICT' : 'UNAVAILABLE';
    default: return 'UNAVAILABLE';
  }
}
