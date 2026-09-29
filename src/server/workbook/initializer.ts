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
  /** Matching Settings version rows seen; more than one is the append defect's residue. */
  schemaVersionRecords: number;
  /** Matching rows whose value was not a non-negative integer. */
  malformedVersionRecords: number;
  /** True when the effective version record was rewritten rather than appended. */
  updatedVersionRecord: boolean;
};

function ensureHeader(sheet: SheetLike, definition: WorkbookTab): boolean {
  const width = definition.columns.length;
  const existing = sheet.getLastColumn() >= width ? (sheet.getRange(1, 1, 1, width).getValues()[0] ?? []) : [];
  const matches = definition.columns.every((column, index) => existing[index] === column);
  if (matches) return false;
  sheet.getRange(1, 1, 1, width).setValues([ [...definition.columns] ]);
  return true;
}

/**
 * Contiguous runs of the declared protected columns, in one-based column
 * numbers. Grouping adjacent columns keeps the number of protection calls
 * proportional to the runs rather than to the columns.
 */
export function protectedColumnRuns(definition: WorkbookTab): { start: number; length: number }[] {
  const indexes = definition.protectedColumns
    .map((column) => definition.columns.indexOf(column))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  const runs: { start: number; length: number }[] = [];
  for (const index of indexes) {
    const previous = runs[runs.length - 1];
    if (previous && previous.start + previous.length === index + 1) previous.length += 1;
    else runs.push({ start: index + 1, length: 1 });
  }
  return runs;
}

/**
 * Protect the declared data columns, not only the header: a header-only
 * protection leaves every identifier, revision and audit stamp editable by any
 * editor of the workbook. The header row stays protected across the full schema
 * width so a column cannot be renamed out from under the codecs, and each run of
 * protected columns is protected from row 2 to the last row that currently
 * exists (at least row 2), so the next appended row is covered too.
 */
function protectColumns(sheet: SheetLike, definition: WorkbookTab): void {
  if (definition.protectedColumns.length === 0) return;
  const protectedHeader = `Protected columns: ${definition.protectedColumns.join(', ')}`;
  sheet.getRange(1, 1, 1, definition.columns.length).protect().setDescription('Schema header row').setWarningOnly(false);
  const lastRow = sheet.getLastRow();
  const dataRows = Math.max(1, lastRow - 1);
  for (const run of protectedColumnRuns(definition)) {
    sheet.getRange(2, run.start, dataRows, run.length).protect().setDescription(protectedHeader).setWarningOnly(false);
  }
}

export type SchemaVersionResolution = {
  /** Effective version: the last matching Settings row whose value parses. */
  version: number | null;
  /** Matching version rows seen. More than one means duplicates already exist. */
  records: number;
  /** Matching rows whose value was not a non-negative integer. */
  malformed: number;
};

/**
 * Resolve the effective schema version. `initializeWorkbook` used to append a
 * version row whenever the first matching row disagreed with the code, so a
 * workbook can hold stale duplicates; reading the *first* match then reports an
 * old version forever and re-initialization appends yet another row. The last
 * matching row is the effective record, malformed values are counted instead of
 * being coerced, and a workbook with no matching row resolves to `null`.
 */
export function resolveSchemaVersion(spreadsheet: SpreadsheetLike): SchemaVersionResolution {
  const settings = spreadsheet.getSheetByName('Settings');
  if (!settings || settings.getLastRow() < 2) return { version: null, records: 0, malformed: 0 };
  const rows = settings.getRange(1, 1, settings.getLastRow(), Math.max(1, settings.getLastColumn())).getValues();
  const header = rows[0] ?? [];
  const keyIndex = header.indexOf('key');
  const valueIndex = header.indexOf('value');
  if (keyIndex < 0 || valueIndex < 0) return { version: null, records: 0, malformed: 0 };
  let version: number | null = null;
  let records = 0;
  let malformed = 0;
  for (const row of rows.slice(1)) {
    if (row[keyIndex] !== WORKBOOK_SCHEMA.metadataKey) continue;
    records += 1;
    const parsed = Number(row[valueIndex]);
    if (Number.isSafeInteger(parsed) && parsed >= 0) version = parsed;
    else malformed += 1;
  }
  return { version, records, malformed };
}

export function readSchemaVersion(spreadsheet: SpreadsheetLike): number | null {
  return resolveSchemaVersion(spreadsheet).version;
}

export function assertSchemaVersion(spreadsheet: SpreadsheetLike, expected = WORKBOOK_SCHEMA_VERSION): void {
  const resolution = resolveSchemaVersion(spreadsheet);
  if (resolution.version !== expected) {
    const detail = resolution.records === 0
      ? 'no version record'
      : `${resolution.version ?? 'malformed'} across ${resolution.records} record(s)`;
    throw new Error(`Workbook schema ${detail} does not match expected ${expected}`);
  }
}

/**
 * Idempotent initialization: the effective version record is rewritten in place
 * when it differs from the code's version, and appended only when the workbook
 * has none, so running this twice appends nothing and leaves one effective
 * record.
 */
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
  const resolution = resolveSchemaVersion(spreadsheet);
  let updatedVersionRecord = false;
  if (resolution.version !== WORKBOOK_SCHEMA_VERSION) {
    updatedVersionRecord = writeSchemaVersion(settings, resolution);
  }
  const version = resolveSchemaVersion(spreadsheet);
  return {
    createdTabs,
    updatedHeaders,
    schemaVersion: WORKBOOK_SCHEMA_VERSION,
    alreadyInitialized: createdTabs.length === 0 && updatedHeaders.length === 0 && !updatedVersionRecord,
    schemaVersionRecords: version.records,
    malformedVersionRecords: version.malformed,
    updatedVersionRecord
  };
}

/** Rewrites the last matching version row in place, or appends the first one. */
function writeSchemaVersion(settings: SheetLike, resolution: SchemaVersionResolution): boolean {
  const header = settings.getRange(1, 1, 1, Math.max(1, settings.getLastColumn())).getValues()[0] ?? [];
  const keyIndex = header.indexOf('key');
  const valueIndex = header.indexOf('value');
  if (keyIndex < 0 || valueIndex < 0) throw new Error('Settings tab is missing the key/value header');
  if (resolution.records > 0) {
    for (let rowNumber = settings.getLastRow(); rowNumber >= 2; rowNumber -= 1) {
      const row = settings.getRange(rowNumber, 1, 1, Math.max(1, settings.getLastColumn())).getValues()[0] ?? [];
      if (row[keyIndex] !== WORKBOOK_SCHEMA.metadataKey) continue;
      settings.getRange(rowNumber, valueIndex + 1).setValue(WORKBOOK_SCHEMA_VERSION);
      return true;
    }
  }
  settings.appendRow([WORKBOOK_SCHEMA.metadataKey, WORKBOOK_SCHEMA_VERSION, new Date().toISOString(), 'initializer']);
  return true;
}

export function initializeActiveWorkbook(): InitializationResult {
  const app = (globalThis as unknown as { SpreadsheetApp?: { getActiveSpreadsheet(): SpreadsheetLike } }).SpreadsheetApp;
  if (!app) throw new Error('SpreadsheetApp is unavailable outside Apps Script');
  return initializeWorkbook(app.getActiveSpreadsheet());
}

export function checkActiveWorkbookSchema(): { valid: boolean; version: number | null; records: number; malformed: number } {
  const app = (globalThis as unknown as { SpreadsheetApp?: { getActiveSpreadsheet(): SpreadsheetLike } }).SpreadsheetApp;
  if (!app) throw new Error('SpreadsheetApp is unavailable outside Apps Script');
  const resolution = resolveSchemaVersion(app.getActiveSpreadsheet());
  return { valid: resolution.version === WORKBOOK_SCHEMA_VERSION, version: resolution.version, records: resolution.records, malformed: resolution.malformed };
}
