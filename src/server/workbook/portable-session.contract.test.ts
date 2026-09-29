import { describe, expect, it } from 'vitest';
import { InMemoryProperties, InMemorySpreadsheet, type InMemorySheet } from './in-memory-sheet.js';
import { ControlError, emptyControlRecord, readControlRecord, serializeControlRecord, type ControlAuthority } from './control.js';
import { PortableSession } from './portable-session.js';
import { repositories } from '../runtime.js';
import type { Volunteer } from '../../shared/domain.js';

const NOW = '2026-09-29T12:00:00.000Z';
const AUTHORITY: ControlAuthority = 'workbook-control';

function tab(name: string): InMemorySheet {
  const sheet = new InMemorySpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error(`${name} tab is missing from the stand-in workbook`);
  return sheet;
}

/** A workbook whose record already declares the portable authority. */
function activated() {
  const spreadsheet = new InMemorySpreadsheet();
  const control = spreadsheet.getSheetByName('WorkbookControl');
  const journal = spreadsheet.getSheetByName('ControlJournal');
  if (!control || !journal) throw new Error('control tabs are missing from the stand-in workbook');
  const seed = serializeControlRecord({ ...emptyControlRecord(NOW, 'operator'), authority: AUTHORITY, authorityEpoch: 1, dataRevision: 5, schedulingInputRevision: 2, tabRevisions: { Volunteers: 3 } });
  control.getRange(2, 1, 1, seed.length).setValues([seed]);
  return { spreadsheet, control, journal };
}

function session(options: { writeEnabled?: boolean } = {}) {
  const { spreadsheet, control, journal } = activated();
  const instance = new PortableSession({
    control,
    journal,
    writeEnabled: () => options.writeEnabled ?? true,
    now: () => NOW
  });
  instance.bind('admin@example.test', 'volunteer.availability.recurring.update');
  return { session: instance, spreadsheet, control, journal };
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

const volunteer: Volunteer = {
  id: 'volunteer-1',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  lifecycleStatus: 'active',
  interviewStatus: 'complete',
  readinessRank: 1,
  recurringAvailability: [],
  revision: 3,
  createdAt: NOW,
  updatedAt: NOW
};

describe('portable session counters', () => {
  it('serves the counters from the control record', () => {
    const { session: portable } = session();

    expect(portable.dataRevision()).toBe(5);
    expect(portable.schedulingInputRevision()).toBe(2);
    expect(portable.tabRevision('Volunteers')).toBe(3);
    expect(portable.tabRevision('Assignments')).toBe(0);
  });

  it('reflects this request own commits before completion', () => {
    const { session: portable, control } = session();
    portable.ensureMarked('Volunteers');
    portable.registerCommitted('Volunteers');

    expect(portable.tabRevision('Volunteers')).toBe(4);
    // The stored record has not moved: the counter advances at completion.
    expect(readControlRecord(control).tabRevisions).toEqual({ Volunteers: 3 });
  });
});

describe('portable session marker', () => {
  it('publishes the pending marker before the rows change and completes once', () => {
    const { session: portable, control, journal } = session();

    portable.ensureMarked('Volunteers');
    const pending = readControlRecord(control);
    expect(pending).toMatchObject({ mutationState: 'pending', generation: 1, dataRevision: 5 });
    expect(pending.operationTabs).toEqual(['Volunteers']);
    expect(pending.operationId).toContain('volunteer.availability.recurring.update#');

    portable.registerCommitted('Volunteers');
    const record = portable.commit();

    expect(record).toMatchObject({
      mutationState: 'idle',
      generation: 2,
      completedGeneration: 2,
      dataRevision: 6,
      // Volunteers is a scheduling input.
      schedulingInputRevision: 3,
      tabRevisions: { Volunteers: 4 }
    });
    expect(journal.values.slice(1).map((row) => row[2])).toEqual(['begin', 'commit']);
  });

  it('widens the marker when the mutation turns out to touch another tab', () => {
    const { session: portable, control, journal } = session();

    portable.ensureMarked('Volunteers');
    portable.registerCommitted('Volunteers');
    portable.ensureMarked('Assignments');
    portable.registerCommitted('Assignments');

    expect(readControlRecord(control).operationTabs).toEqual(['Volunteers', 'Assignments']);
    expect(journal.values.slice(1).map((row) => row[2])).toEqual(['begin', 'begin']);

    const record = portable.commit();

    expect(record.tabRevisions).toEqual({ Volunteers: 4, Assignments: 1 });
    // Only the scheduling-input tab moves the composed counter.
    expect(record.schedulingInputRevision).toBe(3);
  });

  it('does not widen twice for the same tab', () => {
    const { session: portable, journal } = session();
    portable.ensureMarked('Assignments');
    portable.ensureMarked('Assignments');

    expect(journal.values).toHaveLength(2);
  });

  it('counts an admitted mutation that changed no rows', () => {
    const { session: portable, journal } = session();

    const record = portable.commit();

    expect(record).toMatchObject({ mutationState: 'idle', generation: 1, dataRevision: 6, tabRevisions: { Volunteers: 3 } });
    expect(portable.began()).toBe(false);
    expect(journal.values.slice(1).map((row) => row[2])).toEqual(['commit']);
  });

  it('refuses a row change under a closed live gate', () => {
    const { session: portable } = session({ writeEnabled: false });

    expectControlError(() => portable.ensureMarked('Volunteers'), 'GATE_CLOSED');
  });

  it('refuses a row change that no admitted operation opened', () => {
    const { control, journal } = activated();
    const unbound = new PortableSession({ control, journal, writeEnabled: () => true, now: () => NOW });

    expectControlError(() => unbound.ensureMarked('Volunteers'), 'OPERATION_MISMATCH');
    expectControlError(() => unbound.commit(), 'OPERATION_MISMATCH');
  });

  it('refuses a commit for a tab the marker never declared', () => {
    const { session: portable } = session();
    portable.ensureMarked('Volunteers');

    expectControlError(() => portable.registerCommitted('Assignments'), 'OPERATION_MISMATCH');
  });
});

describe('portable session failure settlement', () => {
  it('aborts a failure that changed no rows, so the next request is not blocked', () => {
    const { session: portable, control } = session();
    portable.ensureMarked('Volunteers');

    const record = portable.settleAfterFailure('validation refused the payload');

    expect(record).toMatchObject({ mutationState: 'idle', generation: 2, dataRevision: 5, tabRevisions: { Volunteers: 3 } });
    expect(readControlRecord(control).mutationState).toBe('idle');
  });

  it('leaves a failure that changed rows pending for reviewed recovery', () => {
    const { session: portable, control } = session();
    portable.ensureMarked('Volunteers');
    portable.registerCommitted('Volunteers');

    expect(portable.settleAfterFailure('the handler threw mid-write')).toBeUndefined();
    expect(readControlRecord(control).mutationState).toBe('pending');
  });

  it('does nothing when no marker was published', () => {
    const { session: portable } = session();

    expect(portable.settleAfterFailure('handler failed before any write')).toBeUndefined();
  });
});

describe('repositories under the portable authority', () => {
  it('fences the marker before the rows and commits the counters afterwards', () => {
    const { spreadsheet, control, journal } = activated();
    const portable = new PortableSession({ control, journal, writeEnabled: () => true, now: () => NOW });
    portable.bind('admin@example.test', 'volunteer.availability.recurring.update');
    const properties = new InMemoryProperties();
    const store = repositories(spreadsheet, properties, undefined, undefined, portable);

    const revision = store.volunteers.replace([volunteer], 3, 'admin@example.test', 'test');

    expect(revision.number).toBe(4);
    // Rows landed, and the marker was published before them.
    expect(spreadsheet.getSheetByName('Volunteers')?.values[1]?.[0]).toBe('volunteer-1');
    expect(readControlRecord(control).mutationState).toBe('pending');
    // No legacy counter was touched under the portable authority.
    expect(properties.getProperty('TAB_REVISION_Volunteers')).toBeNull();
    expect(properties.getProperty('SCHEDULING_INPUT_REVISION')).toBeNull();

    const record = portable.commit();

    expect(record).toMatchObject({ dataRevision: 6, schedulingInputRevision: 3, tabRevisions: { Volunteers: 4 } });
    expect(journal.values.slice(1).map((row) => row[2])).toEqual(['begin', 'commit']);
  });

  it('still advances Script Properties when no session is installed', () => {
    const { spreadsheet } = activated();
    const properties = new InMemoryProperties();
    properties.setProperty('TAB_REVISION_Volunteers', '3');
    const store = repositories(spreadsheet, properties);

    const revision = store.volunteers.replace([volunteer], 3, 'admin@example.test', 'test');

    expect(revision.number).toBe(4);
    expect(properties.getProperty('TAB_REVISION_Volunteers')).toBe('4');
    expect(properties.getProperty('SCHEDULING_INPUT_REVISION')).toBe('1');
  });
});

describe('revision kinds stay distinct', () => {
  it('keeps the schedule output revision in its row while counters move separately', () => {
    const { spreadsheet, control, journal } = activated();
    const portable = new PortableSession({ control, journal, writeEnabled: () => true, now: () => NOW });
    portable.bind('admin@example.test', 'admin.schedule.rerun');
    const store = repositories(spreadsheet, new InMemoryProperties(), undefined, undefined, portable);

    // A publication-shaped mutation: assignments, backups and the run row. None
    // of those tabs is a scheduling input, so the composed input counter must
    // not move, and the run's own outputRevision is a domain value in its row.
    portable.ensureMarked('Assignments');
    store.assignments.replace([{ id: 'assignment-1', sessionId: 'session-1', volunteerId: 'volunteer-1', scheduleRevision: 7, status: 'assigned', createdAt: NOW }], 0, 'admin@example.test', 'publication');
    portable.ensureMarked('SchedulingRuns');
    store.schedulingRuns.replace([{ id: 'run-1', inputRevision: 2, outputRevision: 7, status: 'completed', startedAt: NOW, completedAt: NOW, assignmentIds: ['assignment-1'], backupIds: [], shortfalls: [] }], 0, 'admin@example.test', 'publication');

    const record = portable.commit();
    const runRow = spreadsheet.getSheetByName('SchedulingRuns')?.values[1] ?? [];

    expect(record).toMatchObject({
      dataRevision: 6,
      // Untouched: no scheduling-input tab committed.
      schedulingInputRevision: 2,
      tabRevisions: { Volunteers: 3, Assignments: 1, SchedulingRuns: 1 }
    });
    // outputRevision is the row's own value, not one of the control counters.
    expect(runRow[2]).toBe(7);
    expect(record.tabRevisions.SchedulingRuns).toBe(1);
  });
});
