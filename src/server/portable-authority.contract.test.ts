import { describe, expect, it } from 'vitest';
import { InMemorySpreadsheet, type InMemorySheet } from './workbook/in-memory-sheet.js';
import { emptyControlRecord, readControlRecord, serializeControlRecord, type ControlAuthority } from './workbook/control.js';
import { createPortableAuthority } from './portable-authority.js';
import { RepositoryError } from './workbook/repository.js';
import type { BatchReadPlan, BatchReadRows } from './workbook/batch-read.js';

const NOW = '2026-09-29T12:00:00.000Z';
const AUTHORITY: ControlAuthority = 'workbook-control';

function workbook(options: { authority?: ControlAuthority } = {}) {
  const spreadsheet = new InMemorySpreadsheet();
  const control = spreadsheet.getSheetByName('WorkbookControl');
  const journal = spreadsheet.getSheetByName('ControlJournal');
  if (!control || !journal) throw new Error('control tabs are missing from the stand-in workbook');
  const seed = serializeControlRecord({
    ...emptyControlRecord(NOW, 'operator'),
    authority: options.authority ?? AUTHORITY,
    authorityEpoch: 1,
    dataRevision: 5,
    tabRevisions: { Volunteers: 3 }
  });
  control.getRange(2, 1, 1, seed.length).setValues([seed]);
  return { spreadsheet, control, journal };
}

function authority(options: { authority?: ControlAuthority; writeEnabled?: boolean } = {}) {
  const { control, journal } = workbook(options);
  return {
    control,
    journal,
    portable: createPortableAuthority({ control, journal, writeEnabled: () => options.writeEnabled ?? true, now: () => NOW })
  };
}

function rows(plan: BatchReadPlan): BatchReadRows {
  return new Map() as BatchReadRows;
}

describe('portable revision source', () => {
  it('serves the global revision from the control record', () => {
    const { portable } = authority();

    expect(portable.revisionSource.current()).toBe(5);
    expect(portable.read().dataRevision).toBe(5);
  });

  it('opens on begin and completes on advance', () => {
    const { portable, control } = authority();
    const { revisionSource, session } = portable;

    revisionSource.begin?.('admin@example.test', 'admin.schedule.rerun');
    session.ensureMarked('Assignments');
    session.registerCommitted('Assignments');
    const advanced = revisionSource.advance?.('admin@example.test', 'admin.schedule.rerun');

    expect(advanced).toBe(6);
    expect(readControlRecord(control)).toMatchObject({
      mutationState: 'idle',
      dataRevision: 6,
      tabRevisions: { Volunteers: 3, Assignments: 1 }
    });
  });

  it('completes an admitted operation that changed no rows', () => {
    const { portable, control } = authority();

    portable.revisionSource.begin?.('admin@example.test', 'admin.insights.refresh');
    const advanced = portable.revisionSource.advance?.('admin@example.test', 'admin.insights.refresh');

    expect(advanced).toBe(6);
    expect(readControlRecord(control)).toMatchObject({ mutationState: 'idle', dataRevision: 6 });
  });

  it('never clears a published marker on failure, and leaves an untouched record alone', () => {
    // No write path reached a repository: nothing was published, so there is
    // nothing to settle and the record is unchanged.
    const untouched = authority();
    untouched.portable.revisionSource.begin?.('admin@example.test', 'admin.schedule.rerun');
    untouched.portable.revisionSource.settleAfterFailure?.('handler failed');
    expect(readControlRecord(untouched.control)).toMatchObject({ mutationState: 'idle', generation: 0 });

    // A published marker always stays pending: the rows may already have changed.
    const partial = authority();
    partial.portable.revisionSource.begin?.('admin@example.test', 'admin.schedule.rerun');
    partial.portable.session.ensureMarked('Assignments');
    partial.portable.revisionSource.settleAfterFailure?.('handler failed');
    expect(readControlRecord(partial.control).mutationState).toBe('pending');
  });
});

describe('guarded batch reads', () => {
  function guardWith(makeReader: (control: InMemorySheet, portable: ReturnType<typeof authority>['portable']) => (plan: BatchReadPlan) => BatchReadRows, options: { authority?: ControlAuthority } = {}) {
    const fixture = authority(options);
    const guarded = fixture.portable.guard({ read: makeReader(fixture.control, fixture.portable) });
    return { ...fixture, guarded };
  }

  it('returns the hydrated rows when nothing completed in between', () => {
    const { guarded } = guardWith(() => rows);

    expect(guarded.read('publishedSchedule')).toBeInstanceOf(Map);
  });

  it('rejects a plan read that straddles a concurrent completion', () => {
    // The hydration itself admits and completes another operation: the second
    // control read then disagrees with the first.
    const { guarded } = guardWith((_control, portable) => () => {
      portable.revisionSource.begin?.('other@example.test', 'admin.insights.refresh');
      portable.revisionSource.advance?.('other@example.test', 'admin.insights.refresh');
      return rows('publishedSchedule');
    });

    expect(() => guarded.read('publishedSchedule')).toThrow(RepositoryError);
    try {
      guarded.read('publishedSchedule');
    } catch (error) {
      expect((error as RepositoryError).code).toBe('STALE_REVISION');
    }
  });

  it('rejects a plan read taken while a mutation is pending', () => {
    const { guarded, portable } = guardWith(() => rows);
    // A concurrent writer opened its mutation and has not completed it.
    portable.revisionSource.begin?.('admin@example.test', 'admin.schedule.rerun');
    portable.session.ensureMarked('Volunteers');

    try {
      guarded.read('publishedSchedule');
      throw new Error('expected the guarded read to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryError);
      expect((error as RepositoryError).code).toBe('UNAVAILABLE');
    }
  });

  it('refuses to serve at all when the record belongs to the legacy authority', () => {
    const { guarded } = guardWith(() => rows, { authority: 'script-properties' });

    try {
      guarded.read('publishedSchedule');
      throw new Error('expected the guarded read to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryError);
      expect((error as RepositoryError).code).toBe('UNAVAILABLE');
    }
  });
});
