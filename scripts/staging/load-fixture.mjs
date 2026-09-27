#!/usr/bin/env node
// Loads the synthetic staging fixture into one spreadsheet.
//
// It refuses to run without an explicit spreadsheet id, a service-account key
// path and a --confirm-staging flag, and it refuses a spreadsheet whose time zone
// it cannot read. It writes with the one-time loader identity, then reads the
// workbooks back exactly the way the Worker does and records the resulting digest
// and row counts, so the fixture identity in the staging manifest is measured
// rather than assumed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildFixture, FIXTURE_SIZES } from './fixture.mjs';
import { accessTokenFor } from './google-auth.mjs';
import { createWorkbookApi } from './workbook.mjs';

export function parseArguments(argv) {
  const options = { spreadsheet: undefined, key: 'staging-local/google-loader.json', size: undefined, startDate: undefined, report: undefined, confirm: false, plan: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${argument} needs a value.`);
      return argv[index];
    };
    if (argument === '--spreadsheet') options.spreadsheet = next();
    else if (argument === '--key') options.key = next();
    else if (argument === '--size') options.size = next();
    else if (argument === '--start-date') options.startDate = next();
    else if (argument === '--report') options.report = next();
    else if (argument === '--confirm-staging') options.confirm = true;
    else if (argument === '--plan') options.plan = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function requireOptions(options) {
  if (!options.spreadsheet || !/^[A-Za-z0-9_-]{20,}$/.test(options.spreadsheet)) {
    throw new Error('--spreadsheet must be a Google spreadsheet id.');
  }
  if (!(options.size in FIXTURE_SIZES)) throw new Error(`--size must be one of ${Object.keys(FIXTURE_SIZES).join(', ')}.`);
  if (options.startDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options.startDate)) throw new Error('--start-date must be YYYY-MM-DD.');
  return options;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\nUsage: load-fixture.mjs --spreadsheet ID --size representative|larger [--key PATH] [--start-date YYYY-MM-DD] [--report PATH] [--plan] --confirm-staging`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log('Usage: load-fixture.mjs --spreadsheet ID --size representative|larger [--key PATH] [--start-date YYYY-MM-DD] [--report PATH] [--plan] --confirm-staging');
    return;
  }
  try {
    requireOptions(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const fixture = buildFixture({ size: options.size, ...(options.startDate === undefined ? {} : { startDate: options.startDate }) });
  const plan = {
    spreadsheetId: options.spreadsheet,
    size: fixture.size,
    startDate: fixture.startDate,
    sessionStart: fixture.sessionStart,
    schedulingTimeZone: fixture.schedulingTimeZone,
    keyPath: options.key,
    revisions: fixture.revisions,
    expectedCounts: fixture.counts,
    accounts: fixture.accounts,
    writes: true
  };

  if (options.plan || !options.confirm) {
    console.log(JSON.stringify(plan, null, 2));
    if (!options.confirm) {
      console.error('Refusing to write: pass --confirm-staging once the synthetic workbook and the loader identity are approved for this write.');
      process.exitCode = options.plan ? 0 : 1;
    }
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

  const workbook = await createWorkbookApi({ token, spreadsheetId: options.spreadsheet });
  const { missingTabs, timeZone } = await workbook.ensureTabs();
  if (!timeZone) {
    console.error('The spreadsheet reported no time zone; refusing to load a fixture whose cells cannot be decoded deterministically.');
    process.exitCode = 1;
    return;
  }

  const written = {};
  for (const [tab, rows] of Object.entries(fixture.tabs)) {
    written[tab] = await workbook.writeTab(tab, rows);
  }

  const { rows, digest } = await workbook.snapshot();
  const counts = Object.fromEntries(Object.entries(rows).map(([tab, tabRows]) => [tab, tabRows.length]).sort(([left], [right]) => left.localeCompare(right)));
  const mismatched = Object.entries(written).filter(([tab, count]) => counts[tab] !== count);

  const report = {
    generatedAt: new Date().toISOString(),
    spreadsheetId: options.spreadsheet,
    size: fixture.size,
    startDate: fixture.startDate,
    sessionStart: fixture.sessionStart,
    workbookTimeZone: timeZone,
    schedulingTimeZone: fixture.schedulingTimeZone,
    missingTabs,
    revisions: fixture.revisions,
    writtenCounts: written,
    readBackCounts: counts,
    countsMatch: mismatched.length === 0,
    fixtureDigest: digest,
    accounts: fixture.accounts,
    sanitized: true
  };

  const reportPath = resolve(options.report ?? `staging-local/loaded-${fixture.size}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  if (mismatched.length > 0) {
    console.error(`Read-back counts differ from what was written for: ${mismatched.map(([tab]) => tab).join(', ')}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) await main();

export { readFile };
