import { WORKBOOK_TABS } from './schema.js';

type Row = unknown[];

/** Minimal SpreadsheetApp stand-in shared by workbook-boundary tests. */
export class InMemoryRange {
  constructor(private readonly sheet: InMemorySheet, private readonly row: number, private readonly column: number, private readonly rows: number, private readonly columns: number) {}
  getValues(): Row[] { return this.sheet.values.slice(this.row - 1, this.row - 1 + this.rows).map((value) => value.slice(this.column - 1, this.column - 1 + this.columns)); }
  setValues(values: Row[]): void { values.forEach((value, index) => { this.sheet.values[this.row - 1 + index] = [...value]; }); }
  setValue(value: unknown): void { this.setValues([[value]]); }
  getValue(): unknown { return this.getValues()[0]?.[0]; }
  protect(): InMemoryRange { return this; }
  clearContent(): void { this.sheet.values.splice(this.row - 1, this.rows); }
  setDescription(_description?: string): this { return this; }
  setWarningOnly(_warningOnly?: boolean): this { return this; }
}

export class InMemorySheet {
  values: Row[];
  constructor(private readonly name: string, headers: readonly string[]) { this.values = [[...headers]]; }
  getName(): string { return this.name; }
  getLastColumn(): number { return this.values[0]?.length ?? 0; }
  getLastRow(): number { return this.values.length; }
  getRange(row: number, column: number, rows = 1, columns = 1): InMemoryRange { return new InMemoryRange(this, row, column, rows, columns); }
  appendRow(row: Row): void { this.values.push([...row]); }
}

export class InMemorySpreadsheet {
  private readonly sheets = new Map(WORKBOOK_TABS.map((tab) => [tab.name, new InMemorySheet(tab.name, tab.columns)]));
  getSheetByName(name: string): InMemorySheet | null { return this.sheets.get(name) ?? null; }
  insertSheet(name: string): InMemorySheet {
    const sheet = new InMemorySheet(name, []);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

export class InMemoryProperties {
  private readonly values = new Map<string, string>();
  getProperty(name: string): string | null { return this.values.get(name) ?? null; }
  setProperty(name: string, value: string): void { this.values.set(name, value); }
}
