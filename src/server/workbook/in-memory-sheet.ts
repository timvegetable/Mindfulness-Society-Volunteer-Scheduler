import { WORKBOOK_TABS } from './schema.js';

type Row = unknown[];

/** A protection applied to a range, recorded so tests can assert what is covered. */
export type RecordedProtection = {
  tab: string;
  startRow: number;
  startColumn: number;
  rows: number;
  columns: number;
  description?: string;
  warningOnly?: boolean;
};

/** Minimal SpreadsheetApp stand-in shared by workbook-boundary tests. */
export class InMemoryRange {
  constructor(private readonly sheet: InMemorySheet, private readonly row: number, private readonly column: number, private readonly rows: number, private readonly columns: number) {}
  getValues(): Row[] { return this.sheet.values.slice(this.row - 1, this.row - 1 + this.rows).map((value) => value.slice(this.column - 1, this.column - 1 + this.columns)); }
  setValues(values: Row[]): void { values.forEach((value, index) => { this.sheet.values[this.row - 1 + index] = [...value]; }); }
  /** Writes one cell, as the real `Range.setValue` does, leaving the rest of the row alone. */
  setValue(value: unknown): void {
    const row = this.sheet.values[this.row - 1] ?? [];
    row[this.column - 1] = value;
    this.sheet.values[this.row - 1] = row;
  }
  getValue(): unknown { return this.getValues()[0]?.[0]; }
  protect(): InMemoryRange {
    this.sheet.protections.push({
      tab: this.sheet.getName(),
      startRow: this.row,
      startColumn: this.column,
      rows: this.rows,
      columns: this.columns
    });
    return this;
  }
  clearContent(): void { this.sheet.values.splice(this.row - 1, this.rows); }
  setDescription(description?: string): this {
    const protection = this.sheet.protections[this.sheet.protections.length - 1];
    if (protection) protection.description = description;
    return this;
  }
  setWarningOnly(warningOnly?: boolean): this {
    const protection = this.sheet.protections[this.sheet.protections.length - 1];
    if (protection) protection.warningOnly = warningOnly;
    return this;
  }
}

export class InMemorySheet {
  values: Row[];
  readonly protections: RecordedProtection[] = [];
  constructor(private readonly name: string, headers: readonly string[]) { this.values = [[...headers]]; }
  getName(): string { return this.name; }
  getLastColumn(): number { return this.values[0]?.length ?? 0; }
  getLastRow(): number { return this.values.length; }
  getRange(row: number, column: number, rows = 1, columns = 1): InMemoryRange { return new InMemoryRange(this, row, column, rows, columns); }
  appendRow(row: Row): void { this.values.push([...row]); }
}

export class InMemorySpreadsheet {
  private readonly sheets: Map<string, InMemorySheet> = new Map(WORKBOOK_TABS.map((tab) => [tab.name as string, new InMemorySheet(tab.name, tab.columns)]));
  constructor(private readonly timeZone = 'America/New_York') {}
  getSpreadsheetTimeZone(): string { return this.timeZone; }
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
