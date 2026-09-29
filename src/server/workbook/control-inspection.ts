import {
  ControlError,
  controlRecordFromRows,
  type ControlFailureCode,
  type ControlRecord
} from './control.js';
import type { SheetLike, SpreadsheetLike } from './initializer.js';
import { tabDefinition } from './schema.js';

/**
 * Read-only inspection of a workbook's portable control state.
 *
 * This is the diagnostic the migration and verification procedures run before
 * and after an activation: it reports what the workbook actually holds — the
 * two control tabs, whether their headers still match the schema, whether the
 * record parses under the reader's own codec, and why not when it does not —
 * without writing anything and without interpreting a malformed record as an
 * empty one. The recovery manifests and the snapshot tooling consume the same
 * shape.
 */

export type ControlInspection = {
  controlTabPresent: boolean;
  journalTabPresent: boolean;
  controlHeaderMatches: boolean;
  journalHeaderMatches: boolean;
  /** The parsed record, present only when it validates. */
  record?: ControlRecord;
  /** Why the record is unusable, when it is. */
  failure?: ControlFailureCode;
  failureMessage?: string;
  /** Retained journal rows; the writer prunes oldest-first at its ceiling. */
  journalEntries: number;
};

function headerMatches(sheet: SheetLike, columns: readonly string[]): boolean {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < columns.length) return false;
  const header = sheet.getRange(1, 1, 1, columns.length).getValues()[0] ?? [];
  return columns.every((column, index) => header[index] === column);
}

function nonBlankRows(sheet: SheetLike, width: number): readonly (readonly unknown[])[] {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, width).getValues()
    .filter((row) => row.some((cell) => cell !== '' && cell !== null && cell !== undefined));
}

export function inspectControlState(spreadsheet: SpreadsheetLike): ControlInspection {
  const control = spreadsheet.getSheetByName('WorkbookControl');
  const journal = spreadsheet.getSheetByName('ControlJournal');
  const controlColumns = tabDefinition('WorkbookControl').columns;
  const journalColumns = tabDefinition('ControlJournal').columns;

  const inspection: ControlInspection = {
    controlTabPresent: control !== null,
    journalTabPresent: journal !== null,
    controlHeaderMatches: control ? headerMatches(control, controlColumns) : false,
    journalHeaderMatches: journal ? headerMatches(journal, journalColumns) : false,
    journalEntries: journal ? nonBlankRows(journal, journalColumns.length).length : 0
  };

  if (!control) {
    return { ...inspection, failure: 'MISSING', failureMessage: 'The workbook has no control tab; initialization has not run' };
  }
  try {
    const rows = nonBlankRows(control, controlColumns.length);
    return rows.length === 0
      ? { ...inspection, failure: 'MISSING', failureMessage: 'The workbook control tab holds no record' }
      : { ...inspection, record: controlRecordFromRows(rows) };
  } catch (error) {
    if (error instanceof ControlError) {
      return { ...inspection, failure: error.code, failureMessage: error.message };
    }
    throw error;
  }
}
