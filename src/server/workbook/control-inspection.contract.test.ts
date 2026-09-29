import { describe, expect, it } from 'vitest';
import { InMemorySpreadsheet, type InMemorySheet } from './in-memory-sheet.js';
import { emptyControlRecord, serializeControlRecord, type ControlAuthority } from './control.js';
import { inspectControlState } from './control-inspection.js';
import { initializeWorkbook } from './initializer.js';

const NOW = '2026-09-29T12:00:00.000Z';
const AUTHORITY: ControlAuthority = 'workbook-control';

function controlSheet(spreadsheet: InMemorySpreadsheet): InMemorySheet {
  const sheet = spreadsheet.getSheetByName('WorkbookControl');
  if (!sheet) throw new Error('WorkbookControl tab is missing from the stand-in workbook');
  return sheet;
}

/** A workbook whose control tab holds one record. */
function seeded(overrides: Partial<ReturnType<typeof emptyControlRecord>> = {}) {
  const spreadsheet = new InMemorySpreadsheet();
  const row = serializeControlRecord({ ...emptyControlRecord(NOW, 'operator'), authority: AUTHORITY, authorityEpoch: 1, ...overrides });
  controlSheet(spreadsheet).getRange(2, 1, 1, row.length).setValues([row]);
  return spreadsheet;
}

describe('control state inspection', () => {
  it('reports a workbook that has no control tab at all', () => {
    const spreadsheet = new InMemorySpreadsheet();
    // Model a pre-initialization workbook: the tab is simply absent.
    const withoutControl = {
      getSheetByName: (name: string) => (name === 'WorkbookControl' ? null : spreadsheet.getSheetByName(name)),
      insertSheet: (name: string) => spreadsheet.insertSheet(name)
    };

    const inspection = inspectControlState(withoutControl);

    expect(inspection).toMatchObject({ controlTabPresent: false, failure: 'MISSING', journalEntries: 0 });
    expect(inspection.record).toBeUndefined();
  });

  it('reports a control tab that exists but holds no record', () => {
    const inspection = inspectControlState(new InMemorySpreadsheet());

    expect(inspection).toMatchObject({ controlTabPresent: true, controlHeaderMatches: true, failure: 'MISSING', journalEntries: 0 });
    expect(inspection.failureMessage).toContain('holds no record');
  });

  it('returns the parsed record and its counters when the record validates', () => {
    const inspection = inspectControlState(seeded({ generation: 8, completedGeneration: 8, dataRevision: 43, schedulingInputRevision: 6, tabRevisions: { Volunteers: 2 } }));

    expect(inspection.failure).toBeUndefined();
    expect(inspection.record).toMatchObject({ authority: AUTHORITY, authorityEpoch: 1, generation: 8, dataRevision: 43, schedulingInputRevision: 6, mutationState: 'idle', tabRevisions: { Volunteers: 2 } });
    expect(inspection.journalTabPresent).toBe(true);
    expect(inspection.journalHeaderMatches).toBe(true);
  });

  it('reports a pending mutation without treating it as current', () => {
    const inspection = inspectControlState(seeded({ generation: 9, completedGeneration: 8, mutationState: 'pending', operationId: 'admin.schedule.rerun#op-1', operationTabs: ['Assignments'] }));

    expect(inspection.record).toMatchObject({ mutationState: 'pending', operationId: 'admin.schedule.rerun#op-1' });
    expect(inspection.failure).toBeUndefined();
  });

  it('reports why an unusable record is unusable, with its code', () => {
    const malformed = seeded();
    controlSheet(malformed).getRange(2, 8).setValue('not json');
    expect(inspectControlState(malformed)).toMatchObject({ failure: 'MALFORMED' });

    const unsupported = seeded();
    controlSheet(unsupported).getRange(2, 1).setValue(99);
    expect(inspectControlState(unsupported)).toMatchObject({ failure: 'UNSUPPORTED' });

    const duplicated = seeded();
    const row = serializeControlRecord(emptyControlRecord(NOW, 'operator'));
    controlSheet(duplicated).getRange(3, 1, 1, row.length).setValues([row]);
    expect(inspectControlState(duplicated)).toMatchObject({ failure: 'DUPLICATE' });
  });

  it('counts journal entries and reports a header that drifted from the schema', () => {
    const spreadsheet = seeded();
    const journal = spreadsheet.getSheetByName('ControlJournal');
    if (!journal) throw new Error('missing journal tab');
    journal.appendRow(['entry-1', 1, 'begin', 'op#1', 'operator@example.test', '', '', '', 'rehearsal', NOW]);
    journal.appendRow(['entry-2', 2, 'abort', 'op#1', 'operator@example.test', '', '', '', 'rehearsal', NOW]);

    expect(inspectControlState(spreadsheet).journalEntries).toBe(2);

    journal.getRange(1, 1).setValue('renamed');
    const drifted = inspectControlState(spreadsheet);
    expect(drifted.journalHeaderMatches).toBe(false);
    // A drifted header does not make the record unusable; both facts are reported.
    expect(drifted.record).toBeDefined();
  });

  it('agrees with what initialization leaves behind', () => {
    const spreadsheet = new InMemorySpreadsheet();
    initializeWorkbook(spreadsheet);

    const inspection = inspectControlState(spreadsheet);

    // Initialization creates the tabs and headers but seeds no record: the
    // capture step writes it, and inspection says exactly that.
    expect(inspection).toMatchObject({
      controlTabPresent: true,
      journalTabPresent: true,
      controlHeaderMatches: true,
      journalHeaderMatches: true,
      failure: 'MISSING',
      journalEntries: 0
    });
  });
});
