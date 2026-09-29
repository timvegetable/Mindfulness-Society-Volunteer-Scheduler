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
import {
  abortMutationRecord,
  beginMutationRecord,
  commitMutationRecord,
  controlOperationId,
  controlCounters,
  controlRecordFromRows,
  emptyControlRecord,
  portableRevisionProvider,
  readControlRecord,
  recoveryTransition,
  serializeControlRecord,
  serializeJournalEntry,
  type ControlRecord,
  type JournalEvent,
  type RecoveryDecision
} from '../../src/server/workbook/control.js';
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
  event?: 'begin' | 'complete' | 'abort' | 'recover';
  decision?: 'completed' | 'not-started' | 'restored';
  tabs: readonly string[];
  reason: string;
  actor: string;
  authority?: 'script-properties' | 'workbook-control';
  dataRevision?: number;
  inputRevision?: number;
  tabRevisions?: Record<string, number>;
};

export function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (!command) throw new Error('Usage: rehearse-portable-state <baseline|initialize|verify|capture|transition|rollback> --role representative|larger [--baseline PATH] --confirm-staging');
  let role: Role | undefined;
  let confirm = false;
  let baseline: string | undefined;
  let event: Args['event'];
  let decision: Args['decision'];
  let authority: Args['authority'];
  let dataRevision: number | undefined;
  let inputRevision: number | undefined;
  let tabRevisions: Record<string, number> | undefined;
  const tabs: string[] = [];
  let reason = '';
  let actor = 'rehearsal@example.test';
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    const next = (): string => {
      const candidate = rest[index + 1];
      if (candidate === undefined) throw new Error(`${value} needs a value.`);
      index += 1;
      return candidate;
    };
    if (value === '--role') {
      const candidate = next();
      if (candidate !== 'representative' && candidate !== 'larger') throw new Error('--role must be representative or larger.');
      role = candidate;
    } else if (value === '--baseline') {
      baseline = next();
    } else if (value === '--event') {
      const candidate = next();
      if (candidate !== 'begin' && candidate !== 'complete' && candidate !== 'abort' && candidate !== 'recover') throw new Error('--event must be begin, complete, abort or recover.');
      event = candidate;
    } else if (value === '--decision') {
      const candidate = next();
      if (candidate !== 'completed' && candidate !== 'not-started' && candidate !== 'restored') throw new Error('--decision must be completed, not-started or restored.');
      decision = candidate;
    } else if (value === '--data-revision') {
      const candidate = Number(next());
      if (!Number.isSafeInteger(candidate) || candidate < 0) throw new Error('--data-revision must be a non-negative integer.');
      dataRevision = candidate;
    } else if (value === '--input-revision') {
      const candidate = Number(next());
      if (!Number.isSafeInteger(candidate) || candidate < 0) throw new Error('--input-revision must be a non-negative integer.');
      inputRevision = candidate;
    } else if (value === '--tab-revisions') {
      const candidate = next();
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        throw new Error('--tab-revisions must be a JSON object of tab names to non-negative integers.');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('--tab-revisions must be a JSON object.');
      for (const entry of Object.values(parsed)) {
        if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) throw new Error('--tab-revisions values must be non-negative integers.');
      }
      tabRevisions = parsed as Record<string, number>;
    } else if (value === '--authority') {
      const candidate = next();
      if (candidate !== 'script-properties' && candidate !== 'workbook-control') throw new Error('--authority must be script-properties or workbook-control.');
      authority = candidate;
    } else if (value === '--tabs') {
      tabs.push(...next().split(',').map((tab) => tab.trim()).filter(Boolean));
    } else if (value === '--reason') {
      reason = next();
    } else if (value === '--actor') {
      actor = next();
    } else if (value === '--confirm-staging') {
      confirm = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!role) throw new Error('--role is required; the runner addresses workbooks by role, never by raw id.');
  return {
    command,
    role,
    confirm,
    tabs,
    reason,
    actor,
    ...(baseline ? { baseline } : {}),
    ...(event ? { event } : {}),
    ...(decision ? { decision } : {}),
    ...(authority ? { authority } : {}),
    ...(dataRevision === undefined ? {} : { dataRevision }),
    ...(inputRevision === undefined ? {} : { inputRevision }),
    ...(tabRevisions ? { tabRevisions } : {})
  };
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
    domainRows: Object.fromEntries(domain.filter((name) => rows[name]).map((name) => [name, (rows[name] ?? []).length])),
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
  let record: ControlRecord | undefined;
  let recordError: string | undefined;
  try {
    record = await readRecord(api);
    if (!record) recordError = 'control record is absent';
  } catch (error) {
    recordError = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown';
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

/** Reads the control record, or undefined when the workbook has none yet. */
async function readRecord(api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<ControlRecord | undefined> {
  const rows = await api.readTabs(['WorkbookControl']);
  const data = (rows.WorkbookControl ?? []).filter((row) => row.some((cell) => cell !== '' && cell !== null && cell !== undefined));
  if (data.length === 0) return undefined;
  return controlRecordFromRows(data);
}

function mergeMax(current: Readonly<Record<string, number>>, captured: Readonly<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = { ...current };
  for (const [tab, value] of Object.entries(captured)) merged[tab] = Math.max(merged[tab] ?? 0, value);
  return merged;
}

/** Appends the journal entry a transition produced, through the shared codec. */
async function journal(api: Awaited<ReturnType<typeof createWorkbookApi>>, event: JournalEvent, operationId: string, actorId: string, tabs: readonly string[], before: ControlRecord, after: ControlRecord, reason: string, at: string): Promise<void> {
  await api.appendRow('ControlJournal', serializeJournalEntry({
    id: `${event}-${after.generation}-${Date.now()}`,
    generation: after.generation,
    event,
    operationId,
    actorId,
    tabs,
    before: controlCounters(before),
    after: controlCounters(after),
    reason,
    timestamp: at
  }) as unknown[]);
}

async function writeRecord(api: Awaited<ReturnType<typeof createWorkbookApi>>, record: ControlRecord): Promise<void> {
  await api.writeControlRow('WorkbookControl', serializeControlRecord(record));
}

function tuple(record: ControlRecord) {
  return {
    generation: record.generation,
    completedGeneration: record.completedGeneration,
    authority: record.authority,
    authorityEpoch: record.authorityEpoch,
    mutationState: record.mutationState,
    dataRevision: record.dataRevision,
    schedulingInputRevision: record.schedulingInputRevision,
    tabRevisions: record.tabRevisions,
    idle: portableRevisionProvider(record).idle
  };
}

/**
 * S3: capture the counters the deployed staging readers serve into the control
 * record. Nothing is invented: the values are supplied from the deployment
 * configuration, the counters are taken as `max(captured, current)` so they never
 * decrease, and the authority epoch advances.
 */
async function commandCapture(args: Args, api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<unknown> {
  if (args.dataRevision === undefined || args.inputRevision === undefined || !args.tabRevisions) {
    throw new Error('capture needs --data-revision, --input-revision and --tab-revisions (the values the deployment currently serves).');
  }
  const current = await readRecord(api);
  if (current?.mutationState === 'pending') throw new Error('The record has a pending mutation; recover it before capturing.');
  const at = new Date().toISOString();
  const record: ControlRecord = {
    ...(current ?? emptyControlRecord(at, args.actor)),
    authorityEpoch: (current?.authorityEpoch ?? 0) + 1,
    authority: 'workbook-control',
    dataRevision: Math.max(current?.dataRevision ?? 0, args.dataRevision),
    schedulingInputRevision: Math.max(current?.schedulingInputRevision ?? 0, args.inputRevision),
    tabRevisions: mergeMax(current?.tabRevisions ?? {}, args.tabRevisions),
    mutationState: 'idle',
    operationId: '',
    operationStartedAt: '',
    operationTabs: [],
    operationBaseline: {},
    updatedAt: at,
    updatedBy: args.actor
  };
  await writeRecord(api, record);
  const after = await readRecord(api);
  await journal(api, 'capture', '', args.actor, [], record, record, 'rehearsal capture', at);
  const path = await report(`rehearsal-capture-${args.role}`, { role: args.role, at, captured: tuple(record), reread: after ? tuple(after) : undefined });
  return { path, captured: tuple(record), rereadMatches: after !== undefined && serializeControlRecord(after).join('|') === serializeControlRecord(record).join('|'), apiCalls: api.callCount() };
}

/** S4-S7: one protocol transition, applied with the production arithmetic. */
async function commandTransition(args: Args, api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<unknown> {
  const current = await readRecord(api);
  if (!current) throw new Error('The workbook has no control record; run capture first.');
  const at = new Date().toISOString();
  const event = args.event;
  if (!event) throw new Error('transition needs --event begin|complete|abort|recover.');
  const tabs = args.tabs as never[];
  let record: ControlRecord;
  let journalEvent: JournalEvent;
  let operationId = current.operationId;
  if (event === 'begin') {
    if (tabs.length === 0) throw new Error('begin needs --tabs (at least one tab).');
    operationId = controlOperationId('rehearsal.transition');
    record = beginMutationRecord(current, { operationId, tabs, actorId: args.actor }, at);
    journalEvent = 'begin';
  } else if (event === 'complete') {
    if (tabs.length === 0) throw new Error('complete needs --tabs (the tabs whose persistence was verified).');
    record = commitMutationRecord(current, tabs, args.actor, at);
    journalEvent = 'commit';
  } else if (event === 'abort') {
    record = abortMutationRecord(current, args.actor, at);
    journalEvent = 'abort';
  } else {
    if (!args.reason.trim()) throw new Error('recover needs --reason: the reviewed conclusion is part of the transition.');
    record = recoveryTransition(current, {
      decision: (args.decision ?? 'restored') as RecoveryDecision,
      actorId: args.actor,
      reason: args.reason,
      ...(tabs.length > 0 ? { committedTabs: tabs } : {})
    }, at);
    journalEvent = 'recover';
  }
  await writeRecord(api, record);
  const after = await readRecord(api);
  await journal(api, journalEvent, operationId, args.actor, tabs, current, record, args.reason, at);
  const path = await report(`rehearsal-transition-${args.role}`, { role: args.role, at, event, before: tuple(current), after: tuple(record), reread: after ? tuple(after) : undefined });
  return { path, event, before: tuple(current), after: tuple(record), rereadMatches: after !== undefined && serializeControlRecord(after).join('|') === serializeControlRecord(record).join('|'), apiCalls: api.callCount() };
}

/**
 * S7: insert a tagged fixture row, then restore it. The recovery transition is
 * the point: a restore advances the generation and leaves every counter exactly
 * where it was, and the row is removed afterwards so the workbook returns to its
 * baseline.
 */
async function commandFixture(args: Args, api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<unknown> {
  const tab = args.tabs[0];
  if (!tab) throw new Error('fixture needs --tabs <Tab> (the tab whose tagged row is inserted and removed).');
  const definitions = new Map<string, readonly string[]>([...(await workbookTabs()), ...(await workbookControlTabs())].map((entry) => [entry.name, entry.columns]));
  const columns = definitions.get(tab);
  if (!columns) throw new Error(`Unknown tab ${tab}.`);
  const tag = `rehearsal-fixture-${Date.now()}`;
  const before = await api.readTabs([tab]);
  const beforeRows = before[tab] ?? [];
  const cells = columns.map((column) => (column === 'id' ? tag : column === 'active' ? true : ''));
  await api.appendRow(tab, cells);
  const inserted = await api.readTabs([tab]);
  const insertedRows = inserted[tab] ?? [];
  const rowNumber = beforeRows.length + 2;
  const path = await report(`rehearsal-fixture-${args.role}`, { role: args.role, at: new Date().toISOString(), tab, tag, rowNumber, rowsBefore: beforeRows.length, rowsAfter: insertedRows.length });
  return { path, tab, tag, rowNumber, rowsBefore: beforeRows.length, rowsAfter: insertedRows.length, inserted: insertedRows.length === beforeRows.length + 1, apiCalls: api.callCount() };
}

/** Removes the tagged fixture row inserted by `fixture` and reports the tab digest. */
async function commandCleanup(args: Args, api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<unknown> {
  const tab = args.tabs[0];
  if (!tab) throw new Error('cleanup needs --tabs <Tab>.');
  const definitions = new Map<string, readonly string[]>([...(await workbookTabs()), ...(await workbookControlTabs())].map((entry) => [entry.name, entry.columns]));
  const columns = definitions.get(tab);
  if (!columns) throw new Error(`Unknown tab ${tab}.`);
  const rows = (await api.readTabs([tab]))[tab] ?? [];
  const tagIndex = columns.indexOf('id');
  const tagRow = rows.findIndex((row) => typeof row[tagIndex] === 'string' && String(row[tagIndex]).startsWith('rehearsal-fixture-'));
  if (tagRow < 0) return { removed: false, reason: 'no tagged fixture row present', rows: rows.length };
  await api.clearRow(tab, tagRow + 2, columns.length);
  const after = (await api.readTabs([tab]))[tab] ?? [];
  const path = await report(`rehearsal-cleanup-${args.role}`, { role: args.role, at: new Date().toISOString(), tab, clearedRow: tagRow + 2, rowsBefore: rows.length, rowsAfter: after.length, digest: tabDigest(after) });
  return { path, removed: true, clearedRow: tagRow + 2, rowsBefore: rows.length, rowsAfter: after.length, digest: tabDigest(after), apiCalls: api.callCount() };
}

/** S8: flip the authority between Script Properties and the control record. */
async function commandRollback(args: Args, api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<unknown> {
  const current = await readRecord(api);
  if (!current) throw new Error('The workbook has no control record; run capture first.');
  if (current.mutationState === 'pending') throw new Error('The record has a pending mutation; a rollback must not run over an interrupted write.');
  if (!args.authority) throw new Error('rollback needs --authority script-properties|workbook-control.');
  const at = new Date().toISOString();
  // The design's transition table gives authority activation and rollback a
  // generation advance as well as an epoch advance, so a reader bracketed across
  // the switch rejects its snapshot instead of accepting one spanning it.
  const record: ControlRecord = {
    ...current,
    authority: args.authority,
    authorityEpoch: current.authorityEpoch + 1,
    generation: current.generation + 1,
    completedGeneration: current.generation + 1,
    updatedAt: at,
    updatedBy: args.actor
  };
  await writeRecord(api, record);
  const after = await readRecord(api);
  await journal(api, 'rollback', current.operationId, args.actor, current.operationTabs, current, record, `rehearsal authority switch to ${args.authority}`, at);
  const path = await report(`rehearsal-rollback-${args.role}`, { role: args.role, at, before: tuple(current), after: tuple(record), reread: after ? tuple(after) : undefined });
  return { path, before: tuple(current), after: tuple(record), rereadMatches: after !== undefined && serializeControlRecord(after).join('|') === serializeControlRecord(record).join('|'), apiCalls: api.callCount() };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const workbook = config.workbooks[args.role];
  if (!workbook?.spreadsheetId) throw new Error(`No workbook is configured for role ${args.role}.`);
  if (requiresStagingConfirmation(args.command) && !args.confirm) {
    throw new Error('Mutating subcommands require --confirm-staging: the rehearsal is approved for the synthetic staging workbooks only.');
  }
  const token = await accessTokenFor(resolve(config.loaderKey), SHEETS_SCOPE);
  const api = await createWorkbookApi({ token, spreadsheetId: workbook.spreadsheetId });
  const commands: Record<string, () => Promise<unknown>> = {
    baseline: () => commandBaseline(args, api),
    initialize: () => commandInitialize(args, api),
    verify: () => commandVerify(args, api),
    capture: () => commandCapture(args, api),
    transition: () => commandTransition(args, api),
    rollback: () => commandRollback(args, api),
    fixture: () => commandFixture(args, api),
    cleanup: () => commandCleanup(args, api)
  };
  const run = commands[args.command];
  if (!run) throw new Error(`Unknown subcommand: ${args.command}`);
  const outcome = await run();
  console.log(JSON.stringify({ command: args.command, role: args.role, ...outcome as object }, null, 2));
}

/**
 * Which subcommands mutate the synthetic workbooks and therefore require the
 * explicit confirmation flag. Pure, so the guard can be tested without running
 * anything against a workbook.
 */
export function requiresStagingConfirmation(command: string): boolean {
  return !READ_ONLY_COMMANDS.has(command);
}

export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set(['baseline', 'verify']);

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (invokedDirectly) await main();
