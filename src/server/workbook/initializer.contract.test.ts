import { describe, expect, it } from 'vitest';
import { InMemorySpreadsheet, type RecordedProtection } from './in-memory-sheet.js';
import { assertSchemaVersion, initializeWorkbook, protectedColumnRuns, resolveSchemaVersion } from './initializer.js';
import { WORKBOOK_SCHEMA_VERSION, tabDefinition, type WorkbookTab } from './schema.js';

const METADATA_KEY = 'workbookSchemaVersion';

function settings(spreadsheet: InMemorySpreadsheet) {
  const sheet = spreadsheet.getSheetByName('Settings');
  if (!sheet) throw new Error('Settings tab is missing from the stand-in workbook');
  return sheet;
}

function appendVersionRow(spreadsheet: InMemorySpreadsheet, value: unknown, updatedBy = 'operator'): void {
  settings(spreadsheet).appendRow([METADATA_KEY, value, '2026-09-01T00:00:00.000Z', updatedBy]);
}

/** Protections that cover a one-based column below the header row. */
function dataProtectionsFor(protections: readonly RecordedProtection[], column: number): RecordedProtection[] {
  return protections.filter((protection) => protection.startRow >= 2
    && column >= protection.startColumn
    && column < protection.startColumn + protection.columns);
}

function oneBasedColumn(tab: WorkbookTab, column: string): number {
  return tab.columns.indexOf(column) + 1;
}

describe('schema-version resolution', () => {
  it('resolves the effective version from the last matching record, not the first', () => {
    const spreadsheet = new InMemorySpreadsheet();
    appendVersionRow(spreadsheet, 2);
    appendVersionRow(spreadsheet, WORKBOOK_SCHEMA_VERSION);

    // Regression: the first-match reader reported 2 forever once the append
    // defect had left a stale row above the current one.
    const resolution = resolveSchemaVersion(spreadsheet);

    expect(resolution.version).toBe(WORKBOOK_SCHEMA_VERSION);
    expect(resolution.records).toBe(2);
    expect(resolution.malformed).toBe(0);
  });

  it('counts malformed version records instead of coercing them', () => {
    const spreadsheet = new InMemorySpreadsheet();
    appendVersionRow(spreadsheet, 'not-a-number');
    appendVersionRow(spreadsheet, -1);
    appendVersionRow(spreadsheet, WORKBOOK_SCHEMA_VERSION);

    const resolution = resolveSchemaVersion(spreadsheet);

    expect(resolution.version).toBe(WORKBOOK_SCHEMA_VERSION);
    expect(resolution.records).toBe(3);
    expect(resolution.malformed).toBe(2);
  });

  it('reports a workbook whose only version record is malformed', () => {
    const spreadsheet = new InMemorySpreadsheet();
    appendVersionRow(spreadsheet, 'three');

    expect(resolveSchemaVersion(spreadsheet)).toEqual({ version: null, records: 1, malformed: 1 });
    expect(() => assertSchemaVersion(spreadsheet)).toThrow(/malformed/u);
  });

  it('resolves to null when the Settings tab holds no version record', () => {
    const spreadsheet = new InMemorySpreadsheet();

    expect(resolveSchemaVersion(spreadsheet)).toEqual({ version: null, records: 0, malformed: 0 });
    expect(() => assertSchemaVersion(spreadsheet)).toThrow(/no version record/u);
  });
});

describe('initialization idempotence', () => {
  it('rewrites the effective version record in place and appends nothing on a rerun', () => {
    const spreadsheet = new InMemorySpreadsheet();
    appendVersionRow(spreadsheet, WORKBOOK_SCHEMA_VERSION - 1, 'owner@example.test');

    const first = initializeWorkbook(spreadsheet);
    const rowsAfterFirst = settings(spreadsheet).values.length;

    expect(first.updatedVersionRecord).toBe(true);
    expect(first.schemaVersionRecords).toBe(1);
    expect(rowsAfterFirst).toBe(2);
    // The rewrite touches the value cell only; the row's other columns survive.
    expect(settings(spreadsheet).values[1]).toEqual([METADATA_KEY, WORKBOOK_SCHEMA_VERSION, '2026-09-01T00:00:00.000Z', 'owner@example.test']);

    const second = initializeWorkbook(spreadsheet);

    expect(second.updatedVersionRecord).toBe(false);
    expect(second.alreadyInitialized).toBe(true);
    expect(settings(spreadsheet).values.length).toBe(rowsAfterFirst);
  });

  it('does not append a duplicate row when stale duplicates already exist', () => {
    const spreadsheet = new InMemorySpreadsheet();
    appendVersionRow(spreadsheet, 1);
    appendVersionRow(spreadsheet, WORKBOOK_SCHEMA_VERSION);

    const result = initializeWorkbook(spreadsheet);

    // Repeated initialization converges: the effective record already matches,
    // so nothing is written and the residue is reported rather than grown.
    expect(result.updatedVersionRecord).toBe(false);
    expect(result.schemaVersionRecords).toBe(2);
    expect(settings(spreadsheet).values.length).toBe(3);
  });

  it('converges stale duplicates onto the current version without shrinking history', () => {
    const spreadsheet = new InMemorySpreadsheet();
    appendVersionRow(spreadsheet, 1);
    appendVersionRow(spreadsheet, 2);

    const result = initializeWorkbook(spreadsheet);

    expect(result.updatedVersionRecord).toBe(true);
    expect(settings(spreadsheet).values.length).toBe(3);
    expect(settings(spreadsheet).values[2]?.[1]).toBe(WORKBOOK_SCHEMA_VERSION);
    expect(resolveSchemaVersion(spreadsheet).version).toBe(WORKBOOK_SCHEMA_VERSION);
  });
});

describe('declared data-column protection', () => {
  it('groups adjacent protected columns into runs', () => {
    const definition: WorkbookTab = { name: 'Example', columns: ['a', 'b', 'c', 'd', 'e'], protectedColumns: ['a', 'c', 'd'] };

    expect(protectedColumnRuns(definition)).toEqual([{ start: 1, length: 1 }, { start: 3, length: 2 }]);
  });

  it('protects every declared data column and the header row for each tab', () => {
    const spreadsheet = new InMemorySpreadsheet();
    spreadsheet.getSheetByName('Volunteers')?.appendRow(['v1', 'Ada', 'ada@example.test', 'active', 'complete', 1, 3, 'seed', 'a', 'b']);
    spreadsheet.getSheetByName('Volunteers')?.appendRow(['v2', 'Grace', 'grace@example.test', 'active', 'complete', 2, 4, 'seed', 'a', 'b']);

    initializeWorkbook(spreadsheet);

    const volunteers = tabDefinition('Volunteers');
    const sheet = spreadsheet.getSheetByName('Volunteers');
    if (!sheet) throw new Error('Volunteers tab is missing from the stand-in workbook');
    const headerProtection = sheet.protections.find((protection) => protection.startRow === 1);
    expect(headerProtection).toMatchObject({ startColumn: 1, rows: 1, columns: volunteers.columns.length });

    // Regression: the header-only protection left every declared data column
    // editable, including identifiers, revisions and audit stamps.
    for (const column of volunteers.protectedColumns) {
      const protections = dataProtectionsFor(sheet.protections, oneBasedColumn(volunteers, column));
      expect(protections.length, `no data protection covers ${column}`).toBeGreaterThan(0);
      expect(Math.max(...protections.map((protection) => protection.rows))).toBeGreaterThanOrEqual(sheet.getLastRow() - 1);
      expect(protections.every((protection) => protection.warningOnly === false)).toBe(true);
    }

    const unprotected = volunteers.columns.filter((column) => !volunteers.protectedColumns.includes(column));
    for (const column of unprotected) {
      expect(dataProtectionsFor(sheet.protections, oneBasedColumn(volunteers, column))).toEqual([]);
    }
  });

  it('protects the next data row even when a tab holds only its header', () => {
    const spreadsheet = new InMemorySpreadsheet();

    initializeWorkbook(spreadsheet);

    const centers = tabDefinition('Centers');
    const sheet = spreadsheet.getSheetByName('Centers');
    if (!sheet) throw new Error('Centers tab is missing from the stand-in workbook');
    const protections = dataProtectionsFor(sheet.protections, oneBasedColumn(centers, 'revision'));

    expect(protections.length).toBeGreaterThan(0);
    expect(protections.every((protection) => protection.rows >= 1)).toBe(true);
  });
});
