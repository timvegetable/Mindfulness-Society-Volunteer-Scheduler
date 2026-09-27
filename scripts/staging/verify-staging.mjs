#!/usr/bin/env node
// Verifies the staging workbooks without writing anything.
//
// It authenticates as the read-only service account, reads every tab exactly the
// way the Worker does, and reports the spreadsheet time zone, per-tab row counts
// and the snapshot digest. Run it before loading a fixture to confirm the
// workbook is reachable and shared, and after loading to record what the Worker
// will see.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { accessTokenFor } from './google-auth.mjs';
import { createWorkbookApi } from './workbook.mjs';

export function parseArguments(argv) {
  const options = { key: 'staging-local/google-service-account.json', spreadsheets: [], report: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${argument} needs a value.`);
      return argv[index];
    };
    if (argument === '--key') options.key = next();
    else if (argument === '--spreadsheet') options.spreadsheets.push(next());
    else if (argument === '--report') options.report = next();
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function describe(token, spreadsheetId) {
  const workbook = await createWorkbookApi({ token, spreadsheetId });
  const metadata = await workbook.metadata();
  // A tab that does not exist yet cannot be ranged, so only the tabs the
  // spreadsheet already has are read; the rest are reported as missing. This is
  // how an unloaded workbook is verified without failing.
  const present = workbook.tabs.map((tab) => tab.name).filter((name) => metadata.sheets.includes(name));
  const missing = workbook.tabs.map((tab) => tab.name).filter((name) => !metadata.sheets.includes(name));
  const rows = present.length > 0 ? await workbook.readTabs(present) : {};
  const digest = await workbook.digest(rows);
  const counts = Object.fromEntries(Object.entries(rows).map(([tab, tabRows]) => [tab, tabRows.length]).sort(([left], [right]) => left.localeCompare(right)));
  return {
    spreadsheetId,
    workbookTimeZone: metadata.timeZone,
    sheetTitles: metadata.sheets,
    missingTabs: missing,
    counts,
    totalRows: Object.values(counts).reduce((total, count) => total + count, 0),
    fixtureDigest: digest
  };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\nUsage: verify-staging.mjs [--key PATH] --spreadsheet ID [--spreadsheet ID] [--report PATH]`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log('Usage: verify-staging.mjs [--key PATH] --spreadsheet ID [--spreadsheet ID] [--report PATH]');
    return;
  }
  if (options.spreadsheets.length === 0) {
    console.error('At least one --spreadsheet id is required.');
    process.exitCode = 1;
    return;
  }

  let token;
  try {
    token = await accessTokenFor(options.key);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const report = { generatedAt: new Date().toISOString(), keyPath: options.key, spreadsheets: [], sanitized: true };
  for (const spreadsheetId of options.spreadsheets) {
    try {
      report.spreadsheets.push(await describe(token, spreadsheetId));
    } catch (error) {
      console.error(`${spreadsheetId}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(JSON.stringify(report, null, 2));
  if (options.report) {
    const path = resolve(options.report);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) await main();
