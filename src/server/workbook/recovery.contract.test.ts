import { describe, expect, it } from 'vitest';
import { InMemorySpreadsheet, type InMemorySheet } from './in-memory-sheet.js';
import {
  ControlError,
  ControlMutationWriter,
  emptyControlRecord,
  readControlRecord,
  serializeControlRecord,
  type ControlAuthority
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

function openLock(): LockLike {
  let held = false;
  return { tryLock: () => (held ? false : ((held = true), true)), releaseLock: () => { held = false; } };
}

/** Wraps a sheet so a chosen write can fail, for the failure-during-recovery case. */
function failable(sheet: InMemorySheet, failOnWrite?: number): SheetLike {
  let writes = 0;
  return {
    getName: () => sheet.getName(),
    getLastColumn: () => sheet.getLastColumn(),
    getLastRow: () => sheet.getLastRow(),
    getRange: (row: number, column: number, rows?: number, columns?: number): RangeLike => {
      const range = sheet.getRange(row, column, rows, columns);
      return {
        getValues: () => range.getValues(),
        setValues: (values: unknown[][]) => {
          writes += 1;
          if (failOnWrite !== undefined && writes === failOnWrite) throw new Error('simulated write failure');
          range.setValues(values);
        },
        setValue: (value: unknown) => range.setValue(value),
        getValue: () => range.getValue(),
        protect: () => range.protect(),
        clearContent: () => range.clearContent()
      };
    },
    appendRow: (row: unknown[]) => sheet.appendRow(row)
  };
}

/** An interrupted mutation: pending at generation 1 with a baseline recorded. */
function interrupted() {
  const control = tab('WorkbookControl');
  const journal = tab('ControlJournal');
  const pending = serializeControlRecord({
    ...emptyControlRecord(NOW, 'operator'),
    authority: AUTHORITY,
    authorityEpoch: 1,
    generation: 1,
    completedGeneration: 0,
    dataRevision: 5,
    schedulingInputRevision: 2,
    tabRevisions: { Volunteers: 3 },
    mutationState: 'pending',
    operationId: 'admin.schedule.rerun#op-1',
    operationStartedAt: NOW,
    operationTabs: ['Assignments', 'SchedulingRuns'],
    operationBaseline: { dataRevision: 5, schedulingInputRevision: 2, Volunteers: 3 }
  });
  control.getRange(2, 1, 1, pending.length).setValues([pending]);
  return { control, journal };
}

function writer(options: { control: SheetLike; journal: SheetLike; writeEnabled?: boolean; lock?: LockLike; authority?: ControlAuthority }) {
  return new ControlMutationWriter({
    control: options.control,
    journal: options.journal as SheetLike & { deleteRows?(row: number, count: number): void },
    ...(options.lock ? { lock: options.lock } : {}),
    writeEnabled: () => options.writeEnabled ?? false,
    authority: options.authority ?? AUTHORITY,
    now: () => NOW
  });
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

describe('reviewed recovery', () => {
  it('completes an interrupted mutation whose persistence was verified', () => {
    const { control, journal } = interrupted();
    const recovery = writer({ control, journal });

    const { record } = recovery.recover({ decision: 'completed', actorId: 'operator@example.test', reason: 'audit rows and both tabs matched the intended post-commit state', committedTabs: ['Assignments', 'SchedulingRuns'] });

    expect(record).toMatchObject({
      mutationState: 'idle',
      // The fixture is the post-begin record at generation 1; completing it is
      // one transition, so the protocol lands at generation 2.
      generation: 2,
      completedGeneration: 2,
      dataRevision: 6,
      // Neither tab is a scheduling input.
      schedulingInputRevision: 2,
      tabRevisions: { Volunteers: 3, Assignments: 1, SchedulingRuns: 1 }
    });
    expect(journal.values.slice(1).map((row) => row[2])).toEqual(['recover']);
    // The journal names the interrupted operation, not the recovery actor.
    expect(journal.values[1]?.[3]).toBe('admin.schedule.rerun#op-1');
    expect(journal.values[1]?.[8]).toContain('matched the intended post-commit state');
  });

  it('aborts an interrupted mutation that never changed a row', () => {
    const { control, journal } = interrupted();
    const recovery = writer({ control, journal });

    const { record } = recovery.recover({ decision: 'not-started', actorId: 'operator@example.test', reason: 'the snapshot matches the baseline row for row' });

    expect(record).toMatchObject({
      mutationState: 'idle',
      generation: 2,
      completedGeneration: 2,
      dataRevision: 5,
      schedulingInputRevision: 2,
      tabRevisions: { Volunteers: 3 }
    });
  });

  it('records a restore without resetting any counter', () => {
    const { control, journal } = interrupted();
    const recovery = writer({ control, journal });

    const { record } = recovery.recover({ decision: 'restored', actorId: 'operator@example.test', reason: 'partial rows restored from the approved snapshot; counters left at their then-current values' });

    expect(record).toMatchObject({
      mutationState: 'idle',
      generation: 2,
      completedGeneration: 2,
      // Counters only ever increase: a restore is a new change, not an undo.
      dataRevision: 5,
      schedulingInputRevision: 2,
      tabRevisions: { Volunteers: 3 }
    });
    expect(journal.values[1]?.[8]).toContain('restored from the approved snapshot');
  });

  it('refuses a repeated recovery, so counters cannot advance twice', () => {
    const { control, journal } = interrupted();
    const recovery = writer({ control, journal });
    recovery.recover({ decision: 'not-started', actorId: 'operator@example.test', reason: 'nothing was written' });

    expectControlError(() => recovery.recover({ decision: 'completed', actorId: 'operator@example.test', reason: 'second attempt', committedTabs: ['Assignments'] }), 'OPERATION_MISMATCH');
    expect(readControlRecord(control)).toMatchObject({ generation: 2, dataRevision: 5, mutationState: 'idle' });
  });

  it('refuses a decision with no recorded reason, and a completed decision with no verified tabs', () => {
    const { control, journal } = interrupted();
    const recovery = writer({ control, journal });

    expectControlError(() => recovery.recover({ decision: 'restored', actorId: 'operator@example.test', reason: '   ' }), 'MALFORMED');
    expectControlError(() => recovery.recover({ decision: 'completed', actorId: 'operator@example.test', reason: 'looks fine to me' }), 'MALFORMED');
    expect(readControlRecord(control).mutationState).toBe('pending');
  });

  it('requires the script lock and the writer own authority', () => {
    const locked = interrupted();
    const held: LockLike = { tryLock: () => false, releaseLock: () => undefined };
    expectControlError(() => writer({ control: locked.control, journal: locked.journal, lock: held }).recover({ decision: 'not-started', actorId: 'operator@example.test', reason: 'no rows' }), 'LOCKED');

    const foreign = interrupted();
    expectControlError(() => writer({ control: foreign.control, journal: foreign.journal, authority: 'script-properties' }).recover({ decision: 'not-started', actorId: 'operator@example.test', reason: 'no rows' }), 'AUTHORITY_MISMATCH');
  });

  it('runs with the live write gate closed, unlike every ordinary mutation', () => {
    const { control, journal } = interrupted();
    const recovery = writer({ control, journal, writeEnabled: false });

    expectControlError(() => recovery.begin({ operationId: 'op#new', tabs: ['Volunteers'], actorId: 'operator@example.test' }), 'GATE_CLOSED');
    expect(() => recovery.recover({ decision: 'not-started', actorId: 'operator@example.test', reason: 'drained service' })).not.toThrow();
  });

  it('leaves the state recoverable when the transition write fails, then succeeds on retry', () => {
    const { control, journal } = interrupted();
    // Journal first, control row second: fail the control-row write.
    const failing = writer({ control: failable(control, 1), journal });

    expect(() => failing.recover({ decision: 'not-started', actorId: 'operator@example.test', reason: 'first attempt' })).toThrow('simulated write failure');
    // The attempt is auditable and nothing moved.
    expect(journal.values.slice(1).map((row) => row[2])).toEqual(['recover']);
    expect(readControlRecord(control)).toMatchObject({ mutationState: 'pending', generation: 1, dataRevision: 5 });

    const { record } = writer({ control, journal }).recover({ decision: 'not-started', actorId: 'operator@example.test', reason: 'retry after the write failure' });

    expect(record).toMatchObject({ mutationState: 'idle', generation: 2, dataRevision: 5 });
    expect(journal.values.slice(1).map((row) => row[2])).toEqual(['recover', 'recover']);
  });
});
