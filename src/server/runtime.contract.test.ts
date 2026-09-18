import { describe, expect, it } from 'vitest';
import { INTEGRATION_OPERATIONS } from './integration/dispatcher.js';
import { createProductionRuntime } from './runtime.js';
import { WORKBOOK_TABS } from './workbook/schema.js';

type Row = unknown[];

class FakeRange {
  constructor(private readonly sheet: FakeSheet, private readonly row: number, private readonly column: number, private readonly rows: number, private readonly columns: number) {}
  getValues(): Row[] { return this.sheet.values.slice(this.row - 1, this.row - 1 + this.rows).map((value) => value.slice(this.column - 1, this.column - 1 + this.columns)); }
  setValues(values: Row[]): void { values.forEach((value, index) => { this.sheet.values[this.row - 1 + index] = [...value]; }); }
  setValue(value: unknown): void { this.setValues([[value]]); }
  getValue(): unknown { return this.getValues()[0]?.[0]; }
  protect(): FakeRange { return this; }
  clearContent(): void { this.sheet.values.splice(this.row - 1, this.rows); }
  setDescription(_description?: string): this { return this; }
  setWarningOnly(_warningOnly?: boolean): this { return this; }
}

class FakeSheet {
  values: Row[];
  constructor(private readonly name: string, headers: readonly string[]) { this.values = [ [...headers] ]; }
  getName(): string { return this.name; }
  getLastColumn(): number { return this.values[0]?.length ?? 0; }
  getLastRow(): number { return this.values.length; }
  getRange(row: number, column: number, rows = 1, columns = 1): FakeRange { return new FakeRange(this, row, column, rows, columns); }
  appendRow(row: Row): void { this.values.push([...row]); }
}

class FakeSpreadsheet {
  private readonly sheets = new Map(WORKBOOK_TABS.map((tab) => [tab.name, new FakeSheet(tab.name, tab.columns)]));
  getSheetByName(name: string): FakeSheet | null { return this.sheets.get(name) ?? null; }
  insertSheet(name: string): FakeSheet {
    const sheet = new FakeSheet(name, []);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

class FakeProperties {
  private readonly values = new Map<string, string>();
  getProperty(name: string): string | null { return this.values.get(name) ?? null; }
  setProperty(name: string, value: string): void { this.values.set(name, value); }
}

describe('production Apps Script runtime', () => {
  it('composes persistent workbook handlers for every allowlisted operation', () => {
    const runtime = createProductionRuntime(new FakeSpreadsheet(), new FakeProperties());
    for (const operation of Object.values(INTEGRATION_OPERATIONS)) expect(runtime.handlers[operation]).toBeTypeOf('function');
  });
});
