import { describe, expect, it } from 'vitest';
import { InMemorySpreadsheet, type InMemorySheet } from './in-memory-sheet.js';
import {
  assertAuthority,
  assertCompletedGeneration,
  CONTROL_COLUMNS,
  CONTROL_LIMITS,
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  controlFailureCode,
  emptyControlRecord,
  initializeControlRecord,
  parseControlRow,
  portableRevisionProvider,
  readControlRecord,
  serializeControlRecord,
  type ControlRecord
} from './control.js';

const NOW = '2026-09-29T12:00:00.000Z';

function controlSheet(): InMemorySheet {
  const sheet = new InMemorySpreadsheet().getSheetByName('WorkbookControl');
  if (!sheet) throw new Error('WorkbookControl tab is missing from the stand-in workbook');
  return sheet;
}

function row(overrides: Partial<ControlRecord> = {}): unknown[] {
  return serializeControlRecord({ ...emptyControlRecord(NOW, 'tester'), ...overrides });
}

function withColumn(values: unknown[], column: string, value: unknown): unknown[] {
  const next = [...values];
  const index = CONTROL_COLUMNS.indexOf(column as (typeof CONTROL_COLUMNS)[number]);
  if (index < 0) throw new Error(`Unknown control column: ${column}`);
  next[index] = value;
  return next;
}

function writeRows(sheet: InMemorySheet, rows: readonly unknown[][]): void {
  for (const [offset, values] of rows.entries()) sheet.getRange(2 + offset, 1, 1, CONTROL_COLUMNS.length).setValues([[...values]]);
}

function expectControlError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).code).toBe(code);
    return;
  }
  throw new Error(`Expected a ControlError with code ${code}`);
}

describe('control record codec', () => {
  it('round-trips an idle record through the row form', () => {
    const record = emptyControlRecord(NOW, 'tester');
    const serialized = serializeControlRecord(record);

    expect(serialized).toHaveLength(CONTROL_COLUMNS.length);
    // Empty maps and lists are blank cells, never "{}" or "[]".
    expect(serialized[CONTROL_COLUMNS.indexOf('tabRevisions' as never)]).toBe('');
    expect(serialized[CONTROL_COLUMNS.indexOf('operationTabs' as never)]).toBe('');
    expect(parseControlRow(serialized)).toEqual(record);
  });

  it('round-trips a pending mutation with counters in any insertion order', () => {
    const record: ControlRecord = {
      ...emptyControlRecord(NOW, 'tester'),
      authority: 'workbook-control',
      authorityEpoch: 2,
      generation: 9,
      completedGeneration: 8,
      dataRevision: 41,
      schedulingInputRevision: 7,
      tabRevisions: { Volunteers: 3, Sessions: 5 },
      mutationState: 'pending',
      operationId: 'admin.schedule.publish#abc',
      operationStartedAt: NOW,
      operationTabs: ['Assignments', 'SchedulingRuns'],
      operationBaseline: { Assignments: 3 }
    };

    const parsed = parseControlRow(serializeControlRecord(record));

    expect(parsed).toEqual(record);
    expect(parsed.tabRevisions).toEqual({ Sessions: 5, Volunteers: 3 });
    expect(portableRevisionProvider(parsed).tabRevision('Volunteers')).toBe(3);
    expect(portableRevisionProvider(parsed).tabRevision('Centers')).toBe(0);
  });

  it('refuses an unsupported protocol version', () => {
    expectControlError(() => parseControlRow(withColumn(row(), 'protocolVersion', CONTROL_PROTOCOL_VERSION + 1)), 'UNSUPPORTED');
  });

  it.each([
    ['a negative counter', withColumn(row(), 'dataRevision', -1)],
    ['a non-integer counter', withColumn(row(), 'generation', 1.5)],
    ['a numeric string counter', withColumn(row(), 'generation', '3')],
    ['an unknown authority', withColumn(row(), 'authority', 'nobody')],
    ['an unknown mutation state', withColumn(row(), 'mutationState', 'halfway')],
    ['a completed generation ahead of the generation', withColumn(row(), 'generation', 4)],
    ['unparseable tab counters', withColumn(row(), 'tabRevisions', '{oops')],
    ['tab counters for an unknown tab', withColumn(row(), 'tabRevisions', JSON.stringify({ NotATab: 1 }))],
    ['a pending state with no operation id', withColumn(withColumn(row(), 'mutationState', 'pending'), 'generation', 0)],
    ['a pending state with no affected tabs', withColumn(withColumn(withColumn(row(), 'mutationState', 'pending'), 'operationId', 'op#1'), 'generation', 0)],
    ['an idle state that keeps an operation id', withColumn(row(), 'operationId', 'op#1')],
    ['tab counters beyond the byte ceiling', withColumn(row(), 'tabRevisions', JSON.stringify({ Volunteers: Number('9'.repeat(20)) }))]
  ])('rejects %s', (_label, values) => {
    expectControlError(() => parseControlRow(values), 'MALFORMED');
  });

  it('bounds an oversized counter cell rather than trusting it', () => {
    // The ceiling guards the raw cell, not the JSON shape: a hand-edited or
    // corrupted cell can carry far more than the 15 known tab names.
    const oversized = `${' '.repeat(CONTROL_LIMITS.tabRevisionsBytes)}${JSON.stringify({ Volunteers: 1 })}`;
    expect(oversized.length).toBeGreaterThan(CONTROL_LIMITS.tabRevisionsBytes);

    expectControlError(() => parseControlRow(withColumn(row(), 'tabRevisions', oversized)), 'MALFORMED');
    // The same contents inside the ceiling still parse.
    expect(parseControlRow(withColumn(row(), 'tabRevisions', JSON.stringify({ Volunteers: 1 }))).tabRevisions).toEqual({ Volunteers: 1 });
  });
});

describe('control record storage', () => {
  it('reports a missing record and initializes exactly one row, idempotently', () => {
    const sheet = controlSheet();

    expectControlError(() => readControlRecord(sheet), 'MISSING');

    const first = initializeControlRecord(sheet, NOW, 'tester');

    expect(first.created).toBe(true);
    expect(first.record).toEqual(emptyControlRecord(NOW, 'tester'));
    expect(first.record.protocolVersion).toBe(CONTROL_PROTOCOL_VERSION);
    // Initialization never invents authority: Script Properties still own it.
    expect(first.record.authority).toBe('script-properties');
    expect(sheet.values).toHaveLength(2);

    const second = initializeControlRecord(sheet, '2026-09-29T13:00:00.000Z', 'tester');

    expect(second.created).toBe(false);
    expect(second.record.updatedAt).toBe(NOW);
    expect(sheet.values).toHaveLength(2);
  });

  it('reports duplicate records and refuses to overwrite them', () => {
    const sheet = controlSheet();
    writeRows(sheet, [row(), row()]);

    expectControlError(() => readControlRecord(sheet), 'DUPLICATE');
    expectControlError(() => initializeControlRecord(sheet, NOW, 'tester'), 'DUPLICATE');
    expect(sheet.values).toHaveLength(3);
  });

  it('refuses to initialize over a malformed or unsupported record', () => {
    const malformedSheet = controlSheet();
    writeRows(malformedSheet, [withColumn(row(), 'tabRevisions', 'not json')]);
    expectControlError(() => initializeControlRecord(malformedSheet, NOW, 'tester'), 'MALFORMED');

    const unsupportedSheet = controlSheet();
    writeRows(unsupportedSheet, [withColumn(row(), 'protocolVersion', 99)]);
    expectControlError(() => initializeControlRecord(unsupportedSheet, NOW, 'tester'), 'UNSUPPORTED');
  });

  it('ignores a trailing blank row when locating the record', () => {
    const sheet = controlSheet();
    writeRows(sheet, [row()]);
    sheet.appendRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);

    expect(readControlRecord(sheet).protocolVersion).toBe(CONTROL_PROTOCOL_VERSION);
  });
});

describe('portable revision provider', () => {
  it('brackets a read by the generation and revision tuple', () => {
    const record = emptyControlRecord(NOW, 'tester');
    const provider = portableRevisionProvider(record);

    expect(provider.idle).toBe(true);
    expect(provider.dataRevision()).toBe(0);
    expect(provider.revisionTuple(['Volunteers', 'Sessions'])).toBe('0|0|0|0|Volunteers:0|Sessions:0');
    expect(() => assertCompletedGeneration(provider, portableRevisionProvider(record), ['Volunteers'])).not.toThrow();
  });

  it('rejects a snapshot whose generation moved or whose tab counters changed', () => {
    const before = portableRevisionProvider(emptyControlRecord(NOW, 'tester'));
    const advanced = portableRevisionProvider({ ...emptyControlRecord(NOW, 'tester'), generation: 1, completedGeneration: 1 });
    const committed = portableRevisionProvider({ ...emptyControlRecord(NOW, 'tester'), tabRevisions: { Volunteers: 1 } });

    expectControlError(() => assertCompletedGeneration(before, advanced, ['Volunteers']), 'GENERATION_CHANGED');
    expectControlError(() => assertCompletedGeneration(before, committed, ['Volunteers']), 'GENERATION_CHANGED');
    // A counter that the reader did not consume does not invalidate its snapshot.
    expect(() => assertCompletedGeneration(before, committed, ['Sessions'])).not.toThrow();
  });

  it('rejects a snapshot bracketed by a pending mutation', () => {
    const pending = portableRevisionProvider({
      ...emptyControlRecord(NOW, 'tester'),
      generation: 3,
      completedGeneration: 2,
      mutationState: 'pending',
      operationId: 'op#1',
      operationTabs: ['Volunteers']
    });

    expect(pending.idle).toBe(false);
    expectControlError(() => assertCompletedGeneration(pending, pending, ['Volunteers']), 'PENDING');
  });

  it('refuses an authority the caller was not activated for', () => {
    const record = emptyControlRecord(NOW, 'tester');

    expect(() => assertAuthority(record, 'script-properties')).not.toThrow();
    expectControlError(() => assertAuthority(record, 'workbook-control'), 'AUTHORITY_MISMATCH');
  });

  it('maps failures onto API error codes, with pending split by access', () => {
    expect(controlFailureCode('GENERATION_CHANGED', 'read')).toBe('STALE_REVISION');
    expect(controlFailureCode('GENERATION_CHANGED', 'write')).toBe('STALE_REVISION');
    expect(controlFailureCode('PENDING', 'read')).toBe('UNAVAILABLE');
    expect(controlFailureCode('PENDING', 'write')).toBe('CONFLICT');
    for (const code of ['MISSING', 'DUPLICATE', 'MALFORMED', 'UNSUPPORTED', 'AUTHORITY_MISMATCH'] as const) {
      expect(controlFailureCode(code, 'read')).toBe('UNAVAILABLE');
      expect(controlFailureCode(code, 'write')).toBe('UNAVAILABLE');
    }
  });
});
