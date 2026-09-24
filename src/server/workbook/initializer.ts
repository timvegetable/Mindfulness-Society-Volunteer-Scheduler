import { WORKBOOK_SCHEMA, WORKBOOK_SCHEMA_VERSION, type WorkbookTab } from './schema.js';

export type RangeLike = {
  getValues(): unknown[][];
  setValues(values: unknown[][]): void;
  setValue(value: unknown): void;
  getValue(): unknown;
  protect(): ProtectionLike;
  clearContent?(): void;
};

export type ProtectionLike = {
  setDescription(description: string): ProtectionLike;
  setWarningOnly(warningOnly: boolean): ProtectionLike;
};

export type SheetLike = {
  getName(): string;
  getLastColumn(): number;
  getLastRow(): number;
  getRange(row: number, column: number, numRows?: number, numColumns?: number): RangeLike;
  appendRow(row: unknown[]): void;
};

export type SpreadsheetLike = {
  getSheetByName(name: string): SheetLike | null;
  insertSheet(name: string): SheetLike;
  /** Bound workbook ID, required only when an approved Advanced Sheets read is enabled. */
  getId?(): string;
  /** Zone the spreadsheet anchors date and time cells to; absent on stand-ins that do not model it. */
  getSpreadsheetTimeZone?(): string;
};

export type InitializationResult = {
  createdTabs: string[];
  updatedHeaders: string[];
  schemaVersion: number;
  alreadyInitialized: boolean;
};

function ensureHeader(sheet: SheetLike, definition: WorkbookTab): boolean {
  const width = definition.columns.length;
  const existing = sheet.getLastColumn() >= width ? (sheet.getRange(1, 1, 1, width).getValues()[0] ?? []) : [];
  const matches = definition.columns.every((column, index) => existing[index] === column);
  if (matches) return false;
  sheet.getRange(1, 1, 1, width).setValues([ [...definition.columns] ]);
  return true;
}

function protectColumns(sheet: SheetLike, definition: WorkbookTab): void {
  if (definition.protectedColumns.length === 0) return;
  const protectedHeader = `Protected columns: ${definition.protectedColumns.join(', ')}`;
  sheet.getRange(1, 1, 1, definition.columns.length).protect().setDescription(protectedHeader).setWarningOnly(false);
}

export function readSchemaVersion(spreadsheet: SpreadsheetLike): number | null {
  const settings = spreadsheet.getSheetByName('Settings');
  if (!settings || settings.getLastRow() < 2) return null;
  const rows = settings.getRange(1, 1, settings.getLastRow(), Math.max(1, settings.getLastColumn())).getValues();
  const header = rows[0] ?? [];
  const keyIndex = header.indexOf('key');
  const valueIndex = header.indexOf('value');
  if (keyIndex < 0 || valueIndex < 0) return null;
  for (const row of rows.slice(1)) {
    if (row[keyIndex] === WORKBOOK_SCHEMA.metadataKey) return Number(row[valueIndex]);
  }
  return null;
}

export function assertSchemaVersion(spreadsheet: SpreadsheetLike, expected = WORKBOOK_SCHEMA_VERSION): void {
  const actual = readSchemaVersion(spreadsheet);
  if (actual !== expected) throw new Error(`Workbook schema ${actual ?? 'missing'} does not match expected ${expected}`);
}

export function initializeWorkbook(spreadsheet: SpreadsheetLike): InitializationResult {
  const createdTabs: string[] = [];
  const updatedHeaders: string[] = [];
  for (const definition of WORKBOOK_SCHEMA.tabs) {
    let sheet = spreadsheet.getSheetByName(definition.name);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(definition.name);
      createdTabs.push(definition.name);
    }
    if (ensureHeader(sheet, definition)) updatedHeaders.push(definition.name);
    protectColumns(sheet, definition);
  }
  const settings = spreadsheet.getSheetByName('Settings');
  if (!settings) throw new Error('Settings tab was not created');
  const currentVersion = readSchemaVersion(spreadsheet);
  if (currentVersion !== WORKBOOK_SCHEMA_VERSION) settings.appendRow([WORKBOOK_SCHEMA.metadataKey, WORKBOOK_SCHEMA_VERSION, new Date().toISOString(), 'initializer']);
  return { createdTabs, updatedHeaders, schemaVersion: WORKBOOK_SCHEMA_VERSION, alreadyInitialized: createdTabs.length === 0 && updatedHeaders.length === 0 && currentVersion === WORKBOOK_SCHEMA_VERSION };
}

export function initializeActiveWorkbook(): InitializationResult {
  const app = (globalThis as unknown as { SpreadsheetApp?: { getActiveSpreadsheet(): SpreadsheetLike } }).SpreadsheetApp;
  if (!app) throw new Error('SpreadsheetApp is unavailable outside Apps Script');
  return initializeWorkbook(app.getActiveSpreadsheet());
}

export function checkActiveWorkbookSchema(): { valid: boolean; version: number | null } {
  const app = (globalThis as unknown as { SpreadsheetApp?: { getActiveSpreadsheet(): SpreadsheetLike } }).SpreadsheetApp;
  if (!app) throw new Error('SpreadsheetApp is unavailable outside Apps Script');
  const version = readSchemaVersion(app.getActiveSpreadsheet());
  return { valid: version === WORKBOOK_SCHEMA_VERSION, version };
}
