// Sheets helpers for the staging scripts (see workbook.mjs).
export type StagingTabDefinition = {
  name: string;
  columns: readonly string[];
  protectedColumns: readonly string[];
  appendOnly?: boolean;
};

export type StagingWorkbookMetadata = { timeZone?: string; sheets: string[] };

/** Index-based range, as the Sheets `addProtectedRange` request expects. */
export type StagingProtectedRange = {
  startRowIndex: number;
  endRowIndex?: number;
  startColumnIndex: number;
  endColumnIndex?: number;
};

export type StagingWorkbookApi = {
  tabs: readonly StagingTabDefinition[];
  controlTabs: readonly StagingTabDefinition[];
  callCount(): number;
  metadata(): Promise<StagingWorkbookMetadata>;
  sheetIds(): Promise<Map<string, number>>;
  setTimeZone(timeZone: string): Promise<string>;
  ensureTabs(): Promise<{ missingTabs: string[]; timeZone?: string }>;
  ensureTabsFor(names: readonly string[]): Promise<{ created: string[] }>;
  ensureControlTabs(): Promise<{ createdTabs: string[] }>;
  writeHeader(name: string, header: readonly unknown[]): Promise<void>;
  writeHeaders(entries: readonly { name: string; header: readonly string[] }[]): Promise<{ written: number }>;
  addProtectedRanges(entries: readonly { name: string; range: StagingProtectedRange; description: string; warningOnly: boolean }[]): Promise<{ outcomes: { name: string; applied: boolean; reason?: string }[] }>;
  addProtectedRange(name: string, range: StagingProtectedRange, description: string, warningOnly: boolean): Promise<{ applied: boolean; reason?: string }>;
  writeTab(name: string, rows: readonly Record<string, unknown>[]): Promise<number>;
  writeControlRow(name: string, row: readonly unknown[]): Promise<number>;
  appendRow(name: string, values: readonly unknown[]): Promise<number>;
  clearRow(name: string, rowNumber: number, columns: number): Promise<number>;
  readTabs(names: readonly string[]): Promise<Record<string, unknown[][]>>;
  readAllTabs(): Promise<{ rows: Record<string, unknown[][]>; digests: Record<string, string> }>;
  digest(rowsByTab: Record<string, unknown[][]>): Promise<string>;
  snapshot(): Promise<{ rows: Record<string, unknown[][]>; digest: string }>;
};

export declare function workbookTabs(): Promise<readonly StagingTabDefinition[]>;
export declare function workbookControlTabs(): Promise<readonly StagingTabDefinition[]>;
export declare function createWorkbookApi(options: { token: string; spreadsheetId: string }): StagingWorkbookApi;
