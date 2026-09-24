import { READ_PLANS } from './read-plans.js';
import { tabDefinition, type WorkbookTab } from './schema.js';

/**
 * Data ranges eligible for Advanced Sheets reads. The Users tab deliberately
 * stays on the SpreadsheetApp path so a batch read cannot happen before the
 * dispatcher's fresh authorization lookup.
 */
function withoutUsers<const T extends readonly WorkbookTab['name'][]>(tabs: T): Exclude<T[number], 'Users'>[] {
  return tabs.filter((tab) => tab !== 'Users') as Exclude<T[number], 'Users'>[];
}

export const BATCH_READ_PLANS = {
  publishedSchedule: withoutUsers(READ_PLANS.publishedSchedule),
  insightCacheHit: withoutUsers(READ_PLANS.insightCacheHit),
  insightCacheMiss: withoutUsers(READ_PLANS.insightCacheMiss)
} as const;

export type BatchReadPlan = keyof typeof BATCH_READ_PLANS;
export type BatchReadTab = typeof BATCH_READ_PLANS[BatchReadPlan][number];
export type BatchReadRows = ReadonlyMap<BatchReadTab, readonly (readonly unknown[])[]>;
export type WorkbookBatchReader = { read(plan: BatchReadPlan): BatchReadRows };

export type BatchGetValuesRequest = {
  ranges: string[];
  majorDimension: 'ROWS';
  valueRenderOption: 'UNFORMATTED_VALUE';
  dateTimeRenderOption: 'SERIAL_NUMBER';
};

export type BatchGetValuesService = {
  batchGet(spreadsheetId: string, request: BatchGetValuesRequest): unknown;
};

export class WorkbookBatchReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbookBatchReadError';
  }
}

type ParsedRange = { tab: string; startColumn: number; startRow: number; endColumn: number; endRow?: number };

function columnNumber(letters: string): number {
  let result = 0;
  for (const character of letters) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function columnLetters(number: number): string {
  let remaining = number;
  let result = '';
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    result = String.fromCharCode(65 + digit) + result;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return result;
}

function requestedRange(tab: BatchReadTab): string {
  const endColumn = columnLetters(tabDefinition(tab).columns.length);
  const quotedTab = `'${tab.replaceAll("'", "''")}'`;
  return `${quotedTab}!A2:${endColumn}`;
}

function parseA1Range(value: unknown): ParsedRange | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)(?:\$?(\d+))?$/u.exec(value);
  if (!match) return undefined;
  const tab = match[1] === undefined ? match[2] : match[1].replaceAll("''", "'");
  if (!tab) return undefined;
  const startRow = Number(match[4]);
  const endRow = match[6] === undefined ? undefined : Number(match[6]);
  if (!Number.isSafeInteger(startRow) || (endRow !== undefined && !Number.isSafeInteger(endRow))) return undefined;
  return {
    tab,
    startColumn: columnNumber(match[3]!),
    startRow,
    endColumn: columnNumber(match[5]!),
    ...(endRow === undefined ? {} : { endRow })
  };
}

function validateBoundSpreadsheetId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkbookBatchReadError('The bound workbook ID is required for batched reads');
  }
  return value.trim();
}

function cellValue(value: unknown, tab: BatchReadTab): unknown {
  if (value === null) return '';
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new WorkbookBatchReadError(`The batched read for ${tab} contained a malformed cell`);
}

function normalizeMatrix(value: unknown, tab: BatchReadTab, schemaWidth: number, returnedWidth: number, rangeRows?: number): readonly (readonly unknown[])[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new WorkbookBatchReadError(`The batched read for ${tab} contained malformed rows`);
  if (rangeRows !== undefined && value.length > rangeRows) throw new WorkbookBatchReadError(`The batched read for ${tab} exceeded its returned range`);

  const rows: (readonly unknown[])[] = [];
  for (const rawRow of value) {
    if (!Array.isArray(rawRow) || rawRow.length > returnedWidth) {
      throw new WorkbookBatchReadError(`The batched read for ${tab} contained a malformed row`);
    }
    const row = Array.from({ length: schemaWidth }, (_unused, index) => index >= rawRow.length ? '' : cellValue(rawRow[index], tab));
    rows.push(Object.freeze(row));
  }
  return Object.freeze(rows);
}

function rowsFromResponse(response: unknown, spreadsheetId: string, requestedTabs: readonly BatchReadTab[]): Map<BatchReadTab, readonly (readonly unknown[])[]> {
  if (!response || typeof response !== 'object') throw new WorkbookBatchReadError('Google Sheets returned a malformed batch response');
  const result = response as { spreadsheetId?: unknown; valueRanges?: unknown };
  if (result.spreadsheetId !== spreadsheetId) throw new WorkbookBatchReadError('Google Sheets returned a response for a different workbook');
  if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== requestedTabs.length) {
    throw new WorkbookBatchReadError('Google Sheets returned an incomplete batch response');
  }

  const output = new Map<BatchReadTab, readonly (readonly unknown[])[]>();
  result.valueRanges.forEach((rawRange, index) => {
    const tab = requestedTabs[index];
    if (!tab || !rawRange || typeof rawRange !== 'object') throw new WorkbookBatchReadError('Google Sheets returned a malformed value range');
    const rangeResult = rawRange as { range?: unknown; values?: unknown };
    const parsedRange = parseA1Range(rangeResult.range);
    const width = tabDefinition(tab).columns.length;
    if (
      !parsedRange
      || parsedRange.tab !== tab
      || parsedRange.startColumn !== 1
      || parsedRange.startRow !== 2
      || parsedRange.endColumn < 1
      || parsedRange.endColumn > width
      || (parsedRange.endRow !== undefined && parsedRange.endRow < parsedRange.startRow)
    ) {
      throw new WorkbookBatchReadError(`Google Sheets returned an unexpected range for ${tab}`);
    }
    const rangeRows = parsedRange.endRow === undefined ? undefined : parsedRange.endRow - parsedRange.startRow + 1;
    output.set(tab, normalizeMatrix(rangeResult.values, tab, width, parsedRange.endColumn, rangeRows));
  });
  return output;
}

/**
 * Creates a reader scoped to one request. Only named workbook plans can be
 * fetched, ranges come from the tab schema, and later plan reads fetch only
 * newly required tabs. Callers must construct a new reader for each request.
 */
export function createWorkbookBatchReader(options: {
  boundSpreadsheetId: string;
  service: BatchGetValuesService;
}): WorkbookBatchReader {
  const spreadsheetId = validateBoundSpreadsheetId(options.boundSpreadsheetId);
  if (!options.service || typeof options.service.batchGet !== 'function') {
    throw new WorkbookBatchReadError('The Google Sheets batch read service is unavailable');
  }
  const snapshots = new Map<BatchReadTab, readonly (readonly unknown[])[]>();

  return {
    read(plan) {
      if (!Object.prototype.hasOwnProperty.call(BATCH_READ_PLANS, plan)) {
        throw new WorkbookBatchReadError('The requested workbook batch plan is not allowlisted');
      }
      const planTabs = BATCH_READ_PLANS[plan] as readonly BatchReadTab[];
      const missingTabs = planTabs.filter((tab) => !snapshots.has(tab));
      if (missingTabs.length > 0) {
        const request: BatchGetValuesRequest = {
          ranges: missingTabs.map(requestedRange),
          majorDimension: 'ROWS',
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'SERIAL_NUMBER'
        };
        const freshRows = rowsFromResponse(options.service.batchGet(spreadsheetId, request), spreadsheetId, missingTabs);
        for (const [tab, rows] of freshRows) snapshots.set(tab, rows);
      }
      return new Map(snapshots) as BatchReadRows;
    }
  };
}
