#!/usr/bin/env node
// One-off diagnostic: compare locally regenerated fixture rows against the
// live staged workbook read-back, tab by tab, cell by cell.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { accessTokenFor } from './google-auth.mjs';
import { createWorkbookApi } from './workbook.mjs';
import { buildFixture } from './fixture.mjs';

const TEMPORAL_SHEETS_EPOCH = '1899-12-30';
const DATE_COLUMNS = new Set(['date']);
const CLOCK_COLUMNS = new Set(['start', 'end']);
const INSTANT_COLUMNS = new Set(['createdAt', 'updatedAt', 'cancelledAt', 'startedAt', 'completedAt', 'promotedAt', 'importedAt']);

const { Temporal } = await import('@js-temporal/polyfill');
const { WORKBOOK_TABS, tabDefinition } = await (async () => {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [new URL('../../src/server/workbook/schema.ts', import.meta.url).pathname],
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent'
  });
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  return module;
})();

function dateSerial(date) { return Temporal.PlainDate.from(date).since(Temporal.PlainDate.from(TEMPORAL_SHEETS_EPOCH)).days; }
function clockFraction(clock) {
  const [hour, minute] = clock.split(':').map(Number);
  return ((hour ?? 0) * 60 + (minute ?? 0)) / (24 * 60);
}
function restRow(tab, row) {
  const cells = tabDefinition(tab).columns.map((column) => {
    const value = row[column];
    if (value === undefined || value === null || value === '') return '';
    if (DATE_COLUMNS.has(column) && typeof value === 'string') return dateSerial(value);
    if (CLOCK_COLUMNS.has(column) && typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) return clockFraction(value);
    return typeof value === 'object' ? JSON.stringify(value) : value;
  });
  let last = cells.length - 1;
  while (last >= 0 && (cells[last] === '' || cells[last] === undefined)) last -= 1;
  return cells.slice(0, last + 1);
}

const spreadsheetId = process.argv[2];
const size = process.argv[3] ?? 'representative';
const keyPath = process.argv[4] ?? 'staging-local/google-service-account.json';

const fixture = buildFixture({ size, startDate: '2026-10-05' });
const expected = {};
for (const tab of WORKBOOK_TABS) expected[tab.name] = (fixture.tabs[tab.name] ?? []).map((row) => restRow(tab.name, row));

const token = await accessTokenFor(keyPath);
const workbook = await createWorkbookApi({ token, spreadsheetId });
const actual = await workbook.readTabs(WORKBOOK_TABS.map((tab) => tab.name));

for (const tab of WORKBOOK_TABS) {
  const expectedRows = expected[tab.name];
  const actualRows = actual[tab.name] ?? [];
  if (expectedRows.length !== actualRows.length) {
    console.log(`${tab}: row count differs expected=${expectedRows.length} actual=${actualRows.length}`);
    continue;
  }
  let differences = 0;
  for (let index = 0; index < expectedRows.length && differences < 3; index += 1) {
    const e = JSON.stringify(expectedRows[index]);
    const a = JSON.stringify(actualRows[index]);
    if (e !== a) {
      differences += 1;
      console.log(`${tab}[${index}]:`);
      console.log(`  expected: ${e.slice(0, 300)}`);
      console.log(`  actual:   ${a.slice(0, 300)}`);
    }
  }
  if (differences === 0) console.log(`${tab}: identical (${expectedRows.length} rows)`);
}
const canonical = WORKBOOK_TABS.map((tab) => [tab.name, actual[tab.name] ?? null]);
console.log('live digest', createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
const localCanonical = WORKBOOK_TABS.map((tab) => [tab.name, expected[tab.name] ?? null]);
console.log('local digest', createHash('sha256').update(JSON.stringify(localCanonical)).digest('hex'));
