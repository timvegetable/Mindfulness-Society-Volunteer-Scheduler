// The bounded staging rehearsal runner for `make-workbook-state-portable`
// (tasks 4.1/4.2). Executed with `npx vite-node` so it can import the
// repository's own initializer, control codecs and revision transitions: the
// rehearsal applies the production arithmetic to a synthetic workbook instead of
// reimplementing it.
//
// Every mutating subcommand requires `--confirm-staging`, and every run writes a
// timestamped report under `staging-local/` (ignored, private). Nothing here can
// address a non-staging workbook: the spreadsheet id comes from the private
// rehearsal configuration by role name.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { InMemorySheet, type RecordedProtection } from '../../src/server/workbook/in-memory-sheet.js';
import { initializeWorkbook, resolveSchemaVersion, type SheetLike, type SpreadsheetLike } from '../../src/server/workbook/initializer.js';
import { controlRecordFromRows, portableRevisionProvider, type ControlRecord } from '../../src/server/workbook/control.js';
import { accessTokenFor } from './google-auth.mjs';
import { createWorkbookApi, workbookControlTabs, workbookTabs, type StagingProtectedRange } from './workbook.mjs';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const PRIVATE_DIR = 'staging-local';

type Role = 'representative' | 'larger';

type RehearsalConfig = {
  loaderKey: string;
  workbooks: Record<Role, { spreadsheetId: string }>;
};

type Args = {
  command: string;
  role: Role;
  confirm: boolean;
  baseline?: string;
};

function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (!command) throw new Error('Usage: rehearse-portable-state <baseline|initialize|verify> --role representative|larger [--baseline PATH] --confirm-staging');
  let role: Role | undefined;
  let confirm = false;
  let baseline: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--role') {
      const next = rest[index + 1];
      if (next !== 'representative' && next !== 'larger') throw new Error('--role must be representative or larger.');
      role = next;
      index += 1;
    } else if (value === '--baseline') {
      const next = rest[index + 1];
      if (!next) throw new Error('--baseline needs a path.');
      baseline = next;
      index += 1;
    } else if (value === '--confirm-staging') {
      confirm = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!role) throw new Error('--role is required; the runner addresses workbooks by role, never by raw id.');
  return { command, role, confirm, ...(baseline ? { baseline } : {}) };
}

async function loadConfig(): Promise<RehearsalConfig> {
  const path = resolve(PRIVATE_DIR, 'rehearsal-config.json');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as RehearsalConfig;
  if (!parsed.loaderKey || !parsed.workbooks?.representative?.spreadsheetId || !parsed.workbooks?.larger?.spreadsheetId) {
    throw new Error(`The rehearsal configuration at ${path} is incomplete.`);
  }
  return parsed;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function report(name: string, payload: unknown): Promise<string> {
  await mkdir(PRIVATE_DIR, { recursive: true });
  const path = resolve(PRIVATE_DIR, `${name}-${stamp()}.json`);
  await writeFile(path, JSON.stringify(payload, null, 2));
  return path;
}

/**
 * An in-memory mirror of the workbook's *existing* tabs, so the production
 * initializer can decide what to change without a synchronous/async bridge. The
 * diff it produces is then applied over REST.
 */
function mirror(existing: ReadonlyMap<string, unknown[][]>, definitions: ReadonlyMap<string, readonly string[]>): { spreadsheet: SpreadsheetLike; sheets: Map<string, InMemorySheet> } {
  const sheets = new Map<string, InMemorySheet>();
  for (const [name, rows] of existing) {
    // The staging read path requests `A2:` — data rows only — so the header comes
    // from the schema and every read row is data. Treating the first row as a
    // header is what once wrote data values into row 1 of every tab.
    const sheet = new InMemorySheet(name, definitions.get(name) ?? []);
    for (const row of rows) sheet.appendRow([...row]);
    sheets.set(name, sheet);
  }
  const spreadsheet: SpreadsheetLike = {
    getSheetByName: (name: string): SheetLike | null => sheets.get(name) ?? null,
    insertSheet: (name: string): SheetLike => {
      const created = new InMemorySheet(name, []);
      sheets.set(name, created);
      return created;
    }
  };
  return { spreadsheet, sheets };
}

function dataRows(rows: readonly unknown[][]): unknown[][] {
  return rows.slice(1);
}

function tabDigest(rows: unknown[][]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function protectionRange(protection: RecordedProtection): StagingProtectedRange {
  return {
    startRowIndex: protection.startRow - 1,
    endRowIndex: protection.startRow - 1 + protection.rows,
    startColumnIndex: protection.startColumn - 1,
    endColumnIndex: protection.startColumn - 1 + protection.columns
  };
}

/** Reads every tab the rehearsal cares about, plus the spreadsheet's tab list. */
async function readWorkbook(api: ReturnType<typeof createWorkbookApi>) {
  const meta = await api.metadata();
  const names = [...(await workbookTabs()).map((tab) => tab.name), ...(await workbookControlTabs()).map((tab) => tab.name)];
  const present = names.filter((name) => meta.sheets.includes(name));
  const rows = present.length > 0 ? await api.readTabs(present) : {};
  return { meta, present, rows: rows as Record<string, unknown[][]> };
}

async function commandBaseline(args: Args, api: ReturnType<typeof createWorkbookApi>): Promise<unknown> {
  const { meta, rows } = await readWorkbook(api);
  const domain = (await workbookTabs()).map((tab) => tab.name);
  const control = (await workbookControlTabs()).map((tab) => tab.name);
  const digests: Record<string, string> = {};
  for (const [name, tabRows] of Object.entries(rows)) digests[name] = tabDigest(tabRows);
  const payload = {
    role: args.role,
    capturedAt: new Date().toISOString(),
    timeZone: meta.timeZone,
    tabs: meta.sheets,
    domainDigest: tabDigest(domain.flatMap((name) => [[name, rows[name] ?? null]])),
    digests,
    rows
  };
  const path = await report(`rehearsal-baseline-${args.role}`, payload);
  return {
    path,
    tabs: meta.sheets.length,
    domainRows: Object.fromEntries(domain.filter((name) => rows[name]).map((name) => [name, dataRows(rows[name] ?? []).length])),
    controlTabsPresent: control.filter((name) => meta.sheets.includes(name)),
    domainDigest: payload.domainDigest.slice(0, 16)
  };
}

async function commandInitialize(args: Args, api: ReturnType<typeof createWorkbookApi>): Promise<unknown> {
  const { meta, rows } = await readWorkbook(api);
  const existing = new Map<string, unknown[][]>(Object.entries(rows));
  const definitions = new Map<string, readonly string[]>([...(await workbookTabs()), ...(await workbookControlTabs())].map((tab) => [tab.name, tab.columns]));
  const { spreadsheet, sheets } = mirror(existing, definitions);

  const result = initializeWorkbook(spreadsheet);

  // Apply the initializer's decisions over REST: new tabs, header rows, the
  // effective Settings version record, and every protection it recorded.
  const createdTabs = result.createdTabs;
  for (const name of createdTabs) {
    await api.ensureTabsFor([name]);
  }
  const headerWrites = [...sheets.entries()]
    .filter(([name]) => createdTabs.includes(name) || result.updatedHeaders.includes(name))
    .map(([name, sheet]) => ({ name, header: (sheet.values[0] ?? []).map((cell) => String(cell ?? '')) }));
  // One batched write rather than one per tab: the Sheets write quota is per
  // minute per user, and the first run of this runner hit it.
  const headerOutcome = await api.writeHeaders(headerWrites);
  const settings = sheets.get('Settings');
  const settingsRows = (settings?.values ?? []) as unknown[][];
  if (settingsRows.length > 1) {
    await api.writeTab('Settings', settingsRows.slice(1).map((row) => Object.fromEntries(settingsRows[0]!.map((column, index) => [String(column), row[index]]))));
  }
  const protections = [...sheets.entries()].flatMap(([name, sheet]) => sheet.protections.map((protection) => ({ name, ...protection })));
  const protectionOutcomes = protections.length === 0
    ? []
    : (await api.addProtectedRanges(protections.map((protection) => ({
        name: protection.name,
        range: protectionRange(protection),
        description: protection.description ?? '',
        warningOnly: protection.warningOnly === true
      })))).outcomes;

  const path = await report(`rehearsal-initialize-${args.role}`, { role: args.role, at: new Date().toISOString(), result, protections: protections.length });
  return {
    path,
    alreadyInitialized: result.alreadyInitialized,
    createdTabs,
    updatedHeaders: result.updatedHeaders,
    schemaVersion: result.schemaVersion,
    schemaVersionRecords: result.schemaVersionRecords,
    malformedVersionRecords: result.malformedVersionRecords,
    updatedVersionRecord: result.updatedVersionRecord,
    protectionsApplied: protectionOutcomes.filter((outcome) => outcome.applied).length,
    protectionsRefused: protectionOutcomes.filter((outcome) => !outcome.applied).length,
    headerOutcome,
    apiCalls: api.callCount(),
    tabsBefore: meta.sheets.length
  };
}

async function commandVerify(args: Args, api: ReturnType<typeof createWorkbookApi>): Promise<unknown> {
  if (!args.baseline) throw new Error('verify needs --baseline PATH (the baseline report written before the mutations).');
  const baseline = JSON.parse(await readFile(args.baseline, 'utf8')) as { rows: Record<string, unknown[][]>; digests: Record<string, string> };
  const { meta, rows } = await readWorkbook(api);
  const domain = (await workbookTabs()).map((tab) => tab.name);
  const changed: string[] = [];
  for (const name of domain) {
    if (!rows[name]) continue;
    if (tabDigest(rows[name] ?? []) !== baseline.digests[name]) changed.push(name);
  }
  const verifyDefinitions = new Map<string, readonly string[]>([...(await workbookTabs()), ...(await workbookControlTabs())].map((tab) => [tab.name, tab.columns]));
  const { spreadsheet } = mirror(new Map<string, unknown[][]>(Object.entries(rows)), verifyDefinitions);
  const resolution = resolveSchemaVersion(spreadsheet);
  const controlRows = rows.WorkbookControl ? dataRows(rows.WorkbookControl) : [];
  let record: ControlRecord | undefined;
  let recordError: string | undefined;
  try {
    record = controlRows.length > 0 ? controlRecordFromRows(controlRows) : undefined;
    if (!record) recordError = 'control record is absent';
  } catch (error) {
    recordError = error instanceof Error ? error.name : 'unknown';
  }
  const path = await report(`rehearsal-verify-${args.role}`, { role: args.role, at: new Date().toISOString(), resolution, changedDomainTabs: changed, record, recordError, tabs: meta.sheets });
  return {
    path,
    tabs: meta.sheets.length,
    changedDomainTabs: changed,
    schemaVersion: resolution.version,
    schemaVersionRecords: resolution.records,
    malformedVersionRecords: resolution.malformed,
    controlRecordPresent: record !== undefined,
    controlAuthority: record?.authority,
    controlIdle: record ? portableRevisionProvider(record).idle : undefined,
    controlDataRevision: record?.dataRevision,
    recordError,
    apiCalls: api.callCount()
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const workbook = config.workbooks[args.role];
  if (!workbook?.spreadsheetId) throw new Error(`No workbook is configured for role ${args.role}.`);
  if (args.command !== 'baseline' && args.command !== 'verify' && !args.confirm) {
    throw new Error('Mutating subcommands require --confirm-staging: the rehearsal is approved for the synthetic staging workbooks only.');
  }
  const token = await accessTokenFor(resolve(config.loaderKey), SHEETS_SCOPE);
  const api = await createWorkbookApi({ token, spreadsheetId: workbook.spreadsheetId });
  const outcome = args.command === 'baseline'
    ? await commandBaseline(args, api)
    : args.command === 'initialize'
      ? await commandInitialize(args, api)
      : args.command === 'verify'
        ? await commandVerify(args, api)
        : (() => { throw new Error(`Unknown subcommand: ${args.command}`); })();
  console.log(JSON.stringify({ command: args.command, role: args.role, ...outcome as object }, null, 2));
}

await main();
