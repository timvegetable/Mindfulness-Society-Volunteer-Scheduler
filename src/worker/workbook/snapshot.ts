import type { BatchReadPlan, BatchReadRows, BatchReadTab, WorkbookBatchReader } from '../../server/workbook/batch-read.js';
import { BATCH_READ_PLANS, WorkbookBatchReadError } from '../../server/workbook/batch-read.js';
import { WORKBOOK_TABS, tabDefinition } from '../../server/workbook/schema.js';
import type { RangeLike, SheetLike, SpreadsheetLike } from '../../server/workbook/initializer.js';

/**
 * A read-only workbook snapshot for one request.
 *
 * The Worker fetches its ranges asynchronously before any handler runs, but the
 * domain code is synchronous by contract (the Apps Script entry points must
 * stay synchronous), so the fetched rows are replayed through the *same*
 * `SpreadsheetLike` surface the production runtime already uses. Two properties
 * matter more than convenience:
 *
 *  - a tab that was not fetched is absent, so a handler that reads something the
 *    request did not plan for fails loudly instead of seeing an empty tab;
 *  - every mutating method throws, so a read path that tried to write would fail
 *    rather than silently mutate a copy and report success.
 */

export class SnapshotWriteError extends Error {
  constructor(operation: string) {
    super(`The staging snapshot is read-only; ${operation} is not permitted.`);
    this.name = 'SnapshotWriteError';
  }
}

type Row = readonly unknown[];

function createRange(sheet: SnapshotSheet, row: number, column: number, rows: number, columns: number): RangeLike {
  const values = (): unknown[][] => sheet.values.slice(row - 1, row - 1 + rows).map((value) => value.slice(column - 1, column - 1 + columns));
  return {
    getValues: values,
    setValues: () => { throw new SnapshotWriteError('setValues'); },
    setValue: () => { throw new SnapshotWriteError('setValue'); },
    getValue: () => values()[0]?.[0],
    protect: () => { throw new SnapshotWriteError('protect'); },
    clearContent: () => { throw new SnapshotWriteError('clearContent'); }
  };
}

class SnapshotSheet implements SheetLike {
  /**
   * Row 1 is the schema header and the data rows follow, exactly as a real tab
   * is shaped, so `getRange(2, 1, …)` addresses the first data row the way every
   * repository expects.
   */
  readonly values: Row[];

  constructor(private readonly name: string, private readonly headers: readonly string[], readonly rows: readonly Row[]) {
    this.values = [headers, ...rows];
  }

  getName(): string { return this.name; }
  getLastColumn(): number { return this.headers.length; }
  getLastRow(): number { return this.values.length; }
  getRange(row: number, column: number, rows = 1, columns = 1): RangeLike { return createRange(this, row, column, rows, columns); }
  appendRow(): void { throw new SnapshotWriteError('appendRow'); }
}

export type WorkbookSnapshot = Readonly<{
  /** The `SpreadsheetLike` the production runtime reads through. */
  spreadsheet: SpreadsheetLike;
  /** Adds or replaces a tab's rows, as the request fetches more of the workbook. */
  setTab(name: string, rows: readonly Row[]): void;
  /** Tab names currently present; a plan can assert what it fetched. */
  tabs(): readonly string[];
  /**
   * Canonical SHA-256 over every schema tab, with an unfetched tab marked `null`
   * and a fetched-but-empty tab as `[]`. The harness computes it over a fully
   * primed snapshot to record fixture identity; because an absent tab is
   * distinguishable, a partial snapshot still hashes deterministically.
   */
  digest(): Promise<string>;
}>;

/**
 * Builds a snapshot whose sheets expose the schema's headers and the supplied
 * rows. Tabs that were not supplied are genuinely absent.
 */
export function createWorkbookSnapshot(timeZone: string): WorkbookSnapshot {
  const sheets = new Map<string, SnapshotSheet>();

  const spreadsheet: SpreadsheetLike = {
    getSheetByName: (name) => sheets.get(name) ?? null,
    insertSheet: () => { throw new SnapshotWriteError('insertSheet'); },
    getSpreadsheetTimeZone: () => timeZone
  };

  return {
    spreadsheet,
    setTab(name, rows) {
      const definition = WORKBOOK_TABS.find((tab) => tab.name === name);
      if (!definition) throw new WorkbookBatchReadError(`Unknown workbook tab ${name}`);
      sheets.set(name, new SnapshotSheet(name, definition.columns, [...rows]));
    },
    tabs: () => [...sheets.keys()],
    async digest() {
      const canonical = WORKBOOK_TABS.map((tab) => [tab.name, sheets.has(tab.name) ? (sheets.get(tab.name)?.rows ?? []) : null]);
      return await digestOf(canonical);
    }
  };
}

/**
 * A batch reader over rows that were already fetched. It refuses a plan whose
 * tabs are not all present: a partial snapshot must fail, not silently feed the
 * repositories an empty tab.
 */
export function createSnapshotBatchReader(rows: ReadonlyMap<string, readonly Row[]>): WorkbookBatchReader {
  return {
    read(plan: BatchReadPlan): BatchReadRows {
      const planTabs = BATCH_READ_PLANS[plan] as readonly BatchReadTab[];
      const output = new Map<BatchReadTab, readonly Row[]>();
      for (const tab of planTabs) {
        const tabRows = rows.get(tab);
        if (!tabRows) throw new WorkbookBatchReadError(`The ${plan} snapshot is missing ${tab}`);
        output.set(tab, tabRows);
      }
      return output;
    }
  };
}

/** SHA-256 over a canonical string, using the runtime's own WebCrypto. */
async function digestOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export { tabDefinition };
