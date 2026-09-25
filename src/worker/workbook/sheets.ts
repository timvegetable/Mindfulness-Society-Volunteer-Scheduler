import { batchGetRequestForTabs, parseBatchGetResponse, WorkbookBatchReadError, type BatchGetValuesRequest, type BatchReadRows, type BatchReadTab } from '../../server/workbook/batch-read.js';
import type { WorkbookTabName } from '../../server/workbook/schema.js';
import type { FetchLike } from '../google/index.js';

/**
 * The Worker's Sheets read boundary.
 *
 * It speaks the Sheets v4 REST API with a service-account access token and
 * reuses the Apps Script path's schema-derived ranges and response validation,
 * so both runtimes accept exactly the same values and normalise them the same
 * way. Nothing here decides *what* may be read; the callers pass only tabs that
 * a named read plan already allowlists.
 */

export const SHEETS_API_ORIGIN = 'https://sheets.googleapis.com';

export class SheetsReadError extends Error {
  /** HTTP status when Google answered, so a caller can classify without the body. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SheetsReadError';
    if (status !== undefined) this.status = status;
  }
}

export type SheetsReadClientOptions = Readonly<{
  spreadsheetId: string;
  /** Supplies a bearer token for the read-only Sheets scope. */
  accessToken: () => Promise<string>;
  fetch: FetchLike;
}>;

export type SheetsReadClient = Readonly<{
  /** Fetches schema-derived ranges for the given tabs and validates the response. */
  readTabs(tabs: readonly BatchReadTab[]): Promise<BatchReadRows>;
  /** Fetches one non-batch tab (the authorization table) as raw rows. */
  readTab(name: WorkbookTabName): Promise<readonly (readonly unknown[])[]>;
  /** Number of Sheets API requests issued, for the measurement record. */
  readCount(): number;
}>;

function batchGetUrl(spreadsheetId: string, request: BatchGetValuesRequest): string {
  const url = new URL(`${SHEETS_API_ORIGIN}/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`);
  for (const range of request.ranges) url.searchParams.append('ranges', range);
  url.searchParams.set('majorDimension', request.majorDimension);
  url.searchParams.set('valueRenderOption', request.valueRenderOption);
  url.searchParams.set('dateTimeRenderOption', request.dateTimeRenderOption);
  return url.toString();
}

export function createSheetsReadClient(options: SheetsReadClientOptions): SheetsReadClient {
  const spreadsheetId = options.spreadsheetId.trim();
  if (spreadsheetId.length === 0) throw new SheetsReadError('A bound workbook id is required for staging reads.');
  let reads = 0;

  const request = async (url: string): Promise<unknown> => {
    let token: string;
    try {
      token = await options.accessToken();
    } catch {
      throw new SheetsReadError('A Sheets access token is unavailable.');
    }
    reads += 1;
    let response: Response;
    try {
      response = await options.fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch {
      throw new SheetsReadError('The Sheets API could not be reached.');
    }
    if (!response.ok) {
      // The body is dropped: it can echo request material, and the status is
      // enough to classify a failure.
      throw new SheetsReadError(`The Sheets API request failed with status ${response.status}.`, response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new SheetsReadError('The Sheets API returned a malformed response.');
    }
  };

  return {
    async readTabs(tabs: readonly BatchReadTab[]): Promise<BatchReadRows> {
      if (tabs.length === 0) return new Map();
      const payload = await request(batchGetUrl(spreadsheetId, batchGetRequestForTabs(tabs)));
      try {
        return parseBatchGetResponse(payload, spreadsheetId, tabs);
      } catch (error) {
        // A response the shared validator rejects is a provider fault, not a
        // caller fault, and its message already avoids echoing row values.
        throw new SheetsReadError(error instanceof WorkbookBatchReadError ? error.message : 'The Sheets API returned an unexpected range.');
      }
    },
    async readTab(name: WorkbookTabName): Promise<readonly (readonly unknown[])[]> {
      // One tab still goes through the same validated batch path, so the
      // authorization read cannot drift from the domain reads.
      const payload = await request(batchGetUrl(spreadsheetId, batchGetRequestForTabs([name])));
      try {
        return parseBatchGetResponse(payload, spreadsheetId, [name]).get(name) ?? [];
      } catch (error) {
        throw new SheetsReadError(error instanceof WorkbookBatchReadError ? error.message : 'The Sheets API returned an unexpected range.');
      }
    },
    readCount: () => reads
  };
}
