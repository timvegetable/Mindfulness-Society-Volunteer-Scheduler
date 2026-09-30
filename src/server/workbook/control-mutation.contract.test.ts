import { describe, expect, it } from 'vitest';
import { InMemorySpreadsheet, type InMemorySheet, type RecordedProtection } from './in-memory-sheet.js';
import { initializeWorkbook } from './initializer.js';
import {
  appendJournalEntry,
  CONTROL_LIMITS,
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  ControlMutationWriter,
  controlCounters,
  emptyControlRecord,
  initializeControlRecord,
  portableRevisionProvider,
  readControlRecord,
  serializeControlRecord,
  type ControlAuthority,
  type MutationScope,
  type PrunableSheetLike
} from './control.js';
import type { RangeLike, SheetLike } from './initializer.js';
import type { LockLike } from './repository.js';

const NOW = '2026-09-29T12:00:00.000Z';
const AUTHORITY: ControlAuthority = 'workbook-control';

function tab(name: string): InMemorySheet {
  const sheet = new InMemorySpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error(`${name} tab is missing from the stand-in workbook`);
  return sheet;
}

/**
 * Wraps a stand-in sheet so a test can assert the order in which the protocol
 * touched the journal and the control row.
 */
function tagged(sheet: InMemorySheet, tag: string, log: string[]): PrunableSheetLike {
  return {
    getName: () => sheet.getName(),
    getLastColumn: () => sheet.getLastColumn(),
    getLastRow: () => sheet.getLastRow(),
    getRange: (row: number, column: number, rows?: number, columns?: number): RangeLike => {
      const range = sheet.getRange(row, column, rows, columns);
      return {
        getValues: () => range.getValues(),
        setValues: (values: unknown[][]) => { log.push(tag); range.setValues(values); },
        setValue: (value: unknown) => { log.push(tag); range.setValue(value); },
        getValue: () => range.getValue(),
        protect: () => range.protect(),
        clearContent: () => { log.push(tag); range.clearContent(); }
      };
    },
    appendRow: (row: unknown[]) => { log.push(tag); sheet.appendRow(row); },
    deleteRows: (rowPosition: number, howMany: number) => { log.push(tag); sheet.deleteRows(rowPosition, howMany); }
  };
}

function openLock(): LockLike {
  let held = false;
  return {
    tryLock: () => (held ? false : ((held = true), true)),
    releaseLock: () => { held = false; }
  };
}

function fixture(options: { writeEnabled?: boolean; authority?: ControlAuthority; lock?: LockLike; seed?: 'activated' | 'empty' } = {}) {
  const controlSheet = tab('WorkbookControl');
  const journalSheet = tab('ControlJournal');
  const log: string[] = [];
  if (options.seed !== 'empty') {
    const seeded = serializeControlRecord({ ...emptyControlRecord(NOW, 'operator'), authority: AUTHORITY, authorityEpoch: 1 });
    controlSheet.getRange(2, 1, 1, seeded.length).setValues([seeded]);
  }
  const writer = new ControlMutationWriter({
    control: tagged(controlSheet, 'control', log),
    journal: tagged(journalSheet, 'journal', log),
    lock: options.lock ?? openLock(),
    writeEnabled: () => options.writeEnabled ?? true,
    authority: options.authority ?? AUTHORITY,
    now: () => NOW
  });
  return { writer, controlSheet, journalSheet, log };
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

function journalRows(sheet: InMemorySheet): Record<string, unknown>[] {
  return sheet.values.slice(1).map((row) => Object.fromEntries([...sheet.values[0] ?? []].map((column, index) => [String(column), row[index]])));
}

function expectRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return expect.objectContaining(overrides);
}

describe('mutation lifecycle', () => {
  it('publishes the in-progress marker and journals it before touching any row', () => {
    const { writer, controlSheet, journalSheet, log } = fixture();

    const { scope, record } = writer.begin({ operationId: 'admin.schedule.publish#op-1', tabs: ['Volunteers', 'Assignments'], actorId: 'admin@example.test' });

    expect(record).toEqual(expectRecord({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      generation: 1,
      completedGeneration: 0,
      mutationState: 'pending',
      operationId: 'admin.schedule.publish#op-1',
      operationTabs: ['Volunteers', 'Assignments'],
      dataRevision: 0,
      updatedBy: 'admin@example.test'
    }));
    expect(record.operationBaseline).toEqual({ dataRevision: 0, schedulingInputRevision: 0 });
    expect(scope.committedTabs()).toEqual([]);
    expect(portableRevisionProvider(record).idle).toBe(false);
    // Journal first, control row second: a crash between them leaves an
    // auditable attempt rather than an unexplained counter jump.
    expect(log).toEqual(['journal', 'control']);
    expect(journalRows(journalSheet)).toHaveLength(1);
    expect(journalRows(journalSheet)[0]).toMatchObject({ event: 'begin', generation: 1, operationId: 'admin.schedule.publish#op-1' });
    expect(readControlRecord(controlSheet).mutationState).toBe('pending');
  });

  it('refuses to begin while the live write gate is closed, writing nothing', () => {
    const { writer, journalSheet, log, controlSheet } = fixture({ writeEnabled: false });

    expectControlError(() => writer.begin({ operationId: 'op#1', tabs: ['Volunteers'], actorId: 'admin@example.test' }), 'GATE_CLOSED');

    expect(log).toEqual([]);
    expect(journalRows(journalSheet)).toEqual([]);
    expect(readControlRecord(controlSheet).generation).toBe(0);
  });

  it('requires both the live gate and its own authority', () => {
    const { writer } = fixture({ authority: 'script-properties' });

    // The record says workbook-control; a writer activated for Script
    // Properties must not mutate it.
    expectControlError(() => writer.begin({ operationId: 'op#1', tabs: ['Volunteers'], actorId: 'admin@example.test' }), 'AUTHORITY_MISMATCH');
  });

  it('refuses to begin without the script lock', () => {
    const held: LockLike = { tryLock: () => false, releaseLock: () => undefined };
    const { writer, log } = fixture({ lock: held });

    expectControlError(() => writer.begin({ operationId: 'op#1', tabs: ['Volunteers'], actorId: 'admin@example.test' }), 'LOCKED');
    expect(log).toEqual([]);
  });

  it('refuses a second mutation while one is pending', () => {
    const { writer } = fixture();
    writer.begin({ operationId: 'op#1', tabs: ['Volunteers'], actorId: 'admin@example.test' });

    expectControlError(() => writer.begin({ operationId: 'op#2', tabs: ['Assignments'], actorId: 'admin@example.test' }), 'PENDING');
  });

  it('refuses a mutation that declares no affected tab', () => {
    const { writer } = fixture();

    expectControlError(() => writer.begin({ operationId: 'op#1', tabs: [], actorId: 'admin@example.test' }), 'MALFORMED');
  });

  it('leaves the marker pending when the writer stops before any row change', () => {
    const { writer, controlSheet, journalSheet } = fixture();
    writer.begin({ operationId: 'op#1', tabs: ['Volunteers'], actorId: 'admin@example.test' });

    // No completion and no abort: a crash before rows.
    const survivor = readControlRecord(controlSheet);

    expect(survivor.mutationState).toBe('pending');
    expect(survivor.generation).toBe(1);
    expect(survivor.dataRevision).toBe(0);
    expect(portableRevisionProvider(survivor).idle).toBe(false);
    // Ordinary traffic cannot clear it: a writer against the same workbook is
    // refused too, which is the fail-closed half of the protocol.
    const second = new ControlMutationWriter({
      control: controlSheet,
      journal: journalSheet,
      lock: openLock(),
      writeEnabled: () => true,
      authority: AUTHORITY,
      now: () => NOW
    });
    expectControlError(() => second.begin({ operationId: 'op#2', tabs: ['Volunteers'], actorId: 'admin@example.test' }), 'PENDING');
  });

  it('aborts a mid-write failure by advancing generation only', () => {
    const { writer, controlSheet, journalSheet } = fixture();
    const { scope } = writer.begin({ operationId: 'op#1', tabs: ['Volunteers', 'Assignments'], actorId: 'admin@example.test' });
    scope.markCommitted('Volunteers');

    const { record } = writer.abort(scope, 'restored from snapshot');

    expect(record).toEqual(expectRecord({
      generation: 2,
      completedGeneration: 2,
      mutationState: 'idle',
      dataRevision: 0,
      schedulingInputRevision: 0,
      tabRevisions: {},
      operationId: '',
      operationTabs: []
    }));
    const events = journalRows(journalSheet).map((row) => row.event);
    expect(events).toEqual(['begin', 'abort']);
    expect(journalRows(journalSheet)[1]).toMatchObject({ reason: 'restored from snapshot', generation: 2 });
    expect(readControlRecord(controlSheet).generation).toBe(2);
  });

  it('refuses a completion or abort that does not match the pending operation', () => {
    const { writer } = fixture();
    const { scope } = writer.begin({ operationId: 'op#1', tabs: ['Volunteers'], actorId: 'admin@example.test' });
    const impostor: MutationScope = { ...scope, operationId: 'op#2', declare: () => undefined, markCommitted: () => undefined, committedTabs: () => ['Volunteers'] };

    expectControlError(() => writer.commit(impostor), 'OPERATION_MISMATCH');
    expectControlError(() => writer.abort(impostor, 'not mine'), 'OPERATION_MISMATCH');
  });

  it('completes a mutation by advancing every counter exactly once', () => {
    const { writer, journalSheet } = fixture();
    const { scope } = writer.begin({ operationId: 'op#1', tabs: ['Volunteers', 'Assignments'], actorId: 'admin@example.test' });
    scope.markCommitted('Volunteers');
    scope.markCommitted('Assignments');
    scope.markCommitted('Volunteers');

    const { record } = writer.commit(scope);

    expect(record).toEqual(expectRecord({
      generation: 2,
      completedGeneration: 2,
      mutationState: 'idle',
      dataRevision: 1,
      // Volunteers is a scheduling input, so the composed counter moves too.
      schedulingInputRevision: 1,
      tabRevisions: { Volunteers: 1, Assignments: 1 },
      operationId: ''
    }));
    expect(journalRows(journalSheet).map((row) => row.event)).toEqual(['begin', 'commit']);
    expect(journalRows(journalSheet)[1]).toMatchObject({ event: 'commit', generation: 2, tabs: JSON.stringify(['Volunteers', 'Assignments']) });
  });

  it('does not move the scheduling-input counter for a tab that is not one', () => {
    const { writer } = fixture();
    const { scope } = writer.begin({ operationId: 'op#1', tabs: ['Assignments', 'SchedulingRuns'], actorId: 'admin@example.test' });
    scope.markCommitted('Assignments');
    scope.markCommitted('SchedulingRuns');

    const { record } = writer.commit(scope);

    expect(record.schedulingInputRevision).toBe(0);
    expect(record.tabRevisions).toEqual({ Assignments: 1, SchedulingRuns: 1 });
    expect(record.dataRevision).toBe(1);
  });

  it('refuses a commit of a tab the mutation did not declare', () => {
    const { writer } = fixture();
    const { scope } = writer.begin({ operationId: 'op#1', tabs: ['Volunteers'], actorId: 'admin@example.test' });

    expectControlError(() => scope.markCommitted('Users'), 'OPERATION_MISMATCH');
  });

  it('records the counter tuple on both sides of every transition', () => {
    const { writer, journalSheet } = fixture();
    const { scope } = writer.begin({ operationId: 'op#1', tabs: ['Volunteers'], actorId: 'admin@example.test' });
    scope.markCommitted('Volunteers');
    writer.commit(scope);

    const [begin, commit] = journalRows(journalSheet);
    expect(JSON.parse(String(begin?.before))).toEqual({ dataRevision: 0, schedulingInputRevision: 0 });
    expect(JSON.parse(String(begin?.after))).toEqual({ dataRevision: 0, schedulingInputRevision: 0 });
    expect(JSON.parse(String(commit?.before))).toEqual({ dataRevision: 0, schedulingInputRevision: 0 });
    expect(JSON.parse(String(commit?.after))).toEqual({ dataRevision: 1, Volunteers: 1, schedulingInputRevision: 1 });
  });
});

describe('control journal bounds', () => {
  const entry = (index: number) => ({
    id: `entry-${index}`,
    generation: index,
    event: 'abort' as const,
    operationId: `op#${index}`,
    actorId: 'admin@example.test',
    tabs: ['Volunteers'],
    before: { dataRevision: index },
    after: { dataRevision: index },
    reason: '',
    timestamp: NOW
  });

  it('prunes oldest entries past the retention ceiling', () => {
    const sheet = tab('ControlJournal');
    for (let index = 0; index < CONTROL_LIMITS.journalEntries + 5; index += 1) appendJournalEntry(sheet, entry(index));

    expect(sheet.values).toHaveLength(CONTROL_LIMITS.journalEntries + 1);
    // The oldest entries are gone; the newest are intact.
    expect(sheet.values[1]?.[1]).toBe(5);
    expect(sheet.values[sheet.values.length - 1]?.[1]).toBe(CONTROL_LIMITS.journalEntries + 4);
  });

  it('refuses an entry that cannot fit inside the journal byte ceiling', () => {
    const sheet = tab('ControlJournal');
    const huge = { ...entry(1), reason: 'x'.repeat(CONTROL_LIMITS.journalEntryBytes) };

    expectControlError(() => appendJournalEntry(sheet, huge), 'MALFORMED');
    expect(sheet.values).toHaveLength(1);
  });
});

describe('initialization bounds', () => {
  it('keeps the control record to a single row across repeated initialization', () => {
    const sheet = tab('WorkbookControl');

    expect(initializeControlRecord(sheet, NOW, 'operator').created).toBe(true);
    expect(initializeControlRecord(sheet, NOW, 'operator').created).toBe(false);
    initializeControlRecord(sheet, NOW, 'operator');

    expect(sheet.values).toHaveLength(2);
    // The empty record's tuple is genuinely empty: no revision is invented.
    expect(controlCounters(readControlRecord(sheet))).toEqual({ dataRevision: 0, schedulingInputRevision: 0 });
  });

  it('covers the control tab with the same declared-column protection', () => {
    const spreadsheet = new InMemorySpreadsheet();
    initializeWorkbook(spreadsheet);
    const sheet = spreadsheet.getSheetByName('WorkbookControl');
    if (!sheet) throw new Error('WorkbookControl tab is missing from the stand-in workbook');

    const protectedColumns: RecordedProtection[] = sheet.protections.filter((protection) => protection.startRow >= 2);
    const columns = new Set(protectedColumns.flatMap((protection) => Array.from({ length: protection.columns }, (_unused, index) => protection.startColumn + index)));

    // Every control column is protected metadata, not just the header.
    expect(columns.size).toBe(sheet.getLastColumn());
    expect(protectedColumns.every((protection) => protection.warningOnly === false)).toBe(true);
  });
});

describe('rollback transition', () => {
  /** The counters the outgoing authority reported, as the procedure captures them. */
  const captured = (overrides: Partial<{ dataRevision: number; schedulingInputRevision: number; tabRevisions: Record<string, number> }> = {}) => ({
    dataRevision: 0,
    schedulingInputRevision: 0,
    tabRevisions: {},
    ...overrides
  });

  /** The fixture's own control sheet, seeded with a record the test controls. */
  function fixtureWithRecord(record: Partial<ReturnType<typeof emptyControlRecord>> = {}, options: Parameters<typeof fixture>[0] = {}) {
    const seeded = {
      ...emptyControlRecord(NOW, 'operator'),
      authority: AUTHORITY,
      authorityEpoch: 1,
      generation: 9,
      completedGeneration: 9,
      dataRevision: 46,
      schedulingInputRevision: 6,
      tabRevisions: { Volunteers: 3 },
      ...record
    };
    const opened = fixture(options);
    opened.controlSheet.getRange(2, 1, 1, serializeControlRecord(seeded).length).setValues([serializeControlRecord(seeded)]);
    return opened;
  }

  it('returns the authority to Script Properties, moving the epoch and generation and keeping every counter', () => {
    const { writer, journalSheet } = fixtureWithRecord();

    const { record } = writer.revert({ captured: captured({ dataRevision: 42, schedulingInputRevision: 5, tabRevisions: { Volunteers: 2, Centers: 1 } }), actorId: 'operator@example.test', reason: 'approved rollback drill' });

    expect(record).toEqual(expectRecord({
      authority: 'script-properties',
      authorityEpoch: 2,
      generation: 10,
      completedGeneration: 10,
      // max(captured, current) in every dimension: nothing a client has already
      // seen goes backwards, and a counter the record did not carry is adopted.
      dataRevision: 46,
      schedulingInputRevision: 6,
      tabRevisions: { Volunteers: 3, Centers: 1 }
    }));
    const journal = journalRows(journalSheet);
    expect(journal.at(-1)).toMatchObject({ event: 'rollback', reason: 'approved rollback drill', actorId: 'operator@example.test', generation: 10 });
  });

  it('adopts a counter the stopped legacy writer advanced past the record', () => {
    const { writer } = fixtureWithRecord();

    const reverted = writer.revert({ captured: captured({ dataRevision: 50, tabRevisions: { Volunteers: 9 } }), actorId: 'operator@example.test', reason: 'legacy writer advanced before the drain' });

    expect(reverted.record).toMatchObject({ dataRevision: 50, tabRevisions: { Volunteers: 9 } });
  });

  it('runs with the live gate closed, because a rollback is a stopped-service procedure', () => {
    const { writer } = fixtureWithRecord({}, { writeEnabled: false });

    expect(writer.revert({ captured: captured(), actorId: 'operator@example.test', reason: 'drained rollback' }).record.authority).toBe('script-properties');
  });

  it('refuses while a mutation is pending', () => {
    const { writer } = fixtureWithRecord({ mutationState: 'pending', generation: 10, operationId: 'admin.schedule.rerun#op-1', operationTabs: ['Assignments'] });

    expectControlError(() => writer.revert({ captured: captured(), actorId: 'operator@example.test', reason: 'too early' }), 'PENDING');
  });

  it('refuses a record that is not on the portable authority, so a repeat stops', () => {
    const { writer } = fixtureWithRecord();

    writer.revert({ captured: captured(), actorId: 'operator@example.test', reason: 'first rollback' });

    expectControlError(() => writer.revert({ captured: captured(), actorId: 'operator@example.test', reason: 'second rollback' }), 'AUTHORITY_MISMATCH');
  });

  it('refuses a writer that is not itself on the portable authority', () => {
    const { writer } = fixtureWithRecord({}, { authority: 'script-properties' });

    expectControlError(() => writer.revert({ captured: captured(), actorId: 'operator@example.test', reason: 'wrong process' }), 'AUTHORITY_MISMATCH');
  });

  it('requires a recorded reason', () => {
    const { writer } = fixtureWithRecord();

    expectControlError(() => writer.revert({ captured: captured(), actorId: 'operator@example.test', reason: '   ' }), 'MALFORMED');
  });

  it('refuses a captured counter that is not a non-negative integer or names an unknown tab', () => {
    const { writer } = fixtureWithRecord();

    expectControlError(() => writer.revert({ captured: captured({ dataRevision: -1 }), actorId: 'operator@example.test', reason: 'negative' }), 'MALFORMED');
    expectControlError(() => writer.revert({ captured: captured({ tabRevisions: { Nope: 1 } }), actorId: 'operator@example.test', reason: 'unknown tab' }), 'MALFORMED');
  });
});
