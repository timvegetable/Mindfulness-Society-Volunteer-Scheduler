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
  CONTROL_COLUMNS,
  controlRecordFromRows,
  ControlError,
  ControlMutationWriter,
  initializeControlRecord,
  JOURNAL_COLUMNS,
  portableRevisionProvider,
  readControlRecord,
  recoveryTransition,
  serializeControlRecord,
  serializeJournalEntry,
  type ControlFailureCode,
  type ControlRecord,
  type JournalEvent,
  type RecoveryDecision
} from '../../src/server/workbook/control.js';
import { legacyAdmission, type ControlReadOutcome } from '../../src/server/workbook/legacy-admission.js';
import { accessTokenFor } from './google-auth.mjs';
import { createWorkbookApi, workbookControlTabs, workbookTabs, type StagingProtectedRange } from './workbook.mjs';
import { capturedCounters, controlWriterOverRest as writerOverRest, type ControlTabsApi } from './rehearsal-transitions.js';
import { DEFAULT_FIRE_MS, DEFAULT_STRADDLE_EXPECTATION, DEFAULT_STRADDLE_OPERATION, INJECTION_KINDS, parseArgs, requiresStagingConfirmation, type Args, type Role } from './rehearsal-arguments.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const PRIVATE_DIR = 'staging-local';


type RehearsalConfig = {
  loaderKey: string;
  workbooks: Record<Role, { spreadsheetId: string }>;
};



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

/** The production writer over this run's REST client, with the schema's columns. */
async function controlWriterOverRest(api: Awaited<ReturnType<typeof createWorkbookApi>>, at: string) {
  const definitions = new Map((await workbookControlTabs()).map((tab) => [tab.name as string, tab.columns]));
  const controlColumns = definitions.get('WorkbookControl');
  if (!controlColumns) throw new Error('The workbook schema has no WorkbookControl definition.');
  return await writerOverRest(api as unknown as ControlTabsApi, {
    at,
    controlColumns,
    journalColumns: definitions.get('ControlJournal') ?? JOURNAL_COLUMNS
  });
}

/** Zips positional control rows with their column names, for a whole-tab write. */
function controlRowObjects(rows: readonly (readonly unknown[])[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(CONTROL_COLUMNS.map((column, index) => [column, row[index] ?? ''])));
}

/** Reads the control record, or undefined when the workbook has none yet. */
async function readRecord(api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<ControlRecord | undefined> {
  const rows = await api.readTabs(['WorkbookControl']);
  const data = (rows.WorkbookControl ?? []).filter((row) => row.some((cell) => cell !== '' && cell !== null && cell !== undefined));
  if (data.length === 0) return undefined;
  return controlRecordFromRows(data);
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
 * record, through the production activation transition. Nothing is invented: the
 * values are supplied from the deployment configuration, the transition takes
 * every counter as `max(captured, current)`, and the authority epoch and the
 * generation advance together.
 *
 * A workbook that carries the control tabs but no record yet is seeded with the
 * production `initializeControlRecord` first — the same idempotent step the
 * maintenance fence runs — so activation always has a record to move.
 */
async function commandCapture(args: Args, api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<unknown> {
  const captured = capturedCounters(args);
  const at = new Date().toISOString();
  const facade = await controlWriterOverRest(api, at);
  const seeded = initializeControlRecord(facade.controlSheet, at, args.actor);
  const { record } = facade.writer.activate({ captured, actorId: args.actor, reason: args.reason.trim() || 'rehearsal capture' });
  const applied = await facade.apply();
  const after = await readRecord(api);
  const path = await report(`rehearsal-capture-${args.role}`, { role: args.role, at, seededRecord: seeded.created, captured: tuple(record), reread: after ? tuple(after) : undefined, applied });
  return { path, seededRecord: seeded.created, captured: tuple(record), applied, rereadMatches: after !== undefined && serializeControlRecord(after).join('|') === serializeControlRecord(record).join('|'), apiCalls: api.callCount() };
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

/**
 * S8: flip the authority, through the production transitions in both directions.
 *
 * `--authority script-properties` is the rollback: `rollbackTransition` requires
 * the record to be activated, advances the authority epoch and the generation,
 * and takes every counter as `max(captured, current)`. `--authority
 * workbook-control` is the forward activation and is the same step as `capture`.
 * Both run through `ControlMutationWriter`, so the runner no longer hand-builds
 * an authority row.
 */
async function commandRollback(args: Args, api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<unknown> {
  if (!args.authority) throw new Error('rollback needs --authority script-properties|workbook-control.');
  const at = new Date().toISOString();
  const facade = await controlWriterOverRest(api, at);
  const reason = args.reason.trim() || `rehearsal authority switch to ${args.authority}`;
  const { record } = args.authority === 'script-properties'
    ? facade.writer.revert({ captured: capturedCounters(args), actorId: args.actor, reason })
    : facade.writer.activate({ captured: capturedCounters(args), actorId: args.actor, reason });
  const applied = await facade.apply();
  const after = await readRecord(api);
  const path = await report(`rehearsal-rollback-${args.role}`, { role: args.role, at, direction: args.authority, after: tuple(record), reread: after ? tuple(after) : undefined, applied });
  return { path, direction: args.authority, after: tuple(record), applied, rereadMatches: after !== undefined && serializeControlRecord(after).join('|') === serializeControlRecord(record).join('|'), apiCalls: api.callCount() };
}

/**
 * S9 (4.2): evaluate the legacy-writer judgement against the live workbook.
 *
 * The decision is the production `legacyAdmission`, given the record as this run
 * read it and whether the workbook carries control structure at all. The
 * divergence is the concrete thing the rollback procedure's equality check has
 * to detect: the counters the record holds against the counters the deployment
 * still serves, which stop advancing the moment the record becomes the
 * authority.
 */
async function commandLegacyAdmission(args: Args, api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<unknown> {
  const { meta } = await readWorkbook(api);
  const controlTabsPresent = meta.sheets.includes('WorkbookControl') || meta.sheets.includes('ControlJournal');
  let record: ControlRecord | undefined;
  let outcome: ControlReadOutcome;
  try {
    record = await readRecord(api);
    outcome = record ? { ok: true, record } : { ok: false, code: 'MISSING' };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    outcome = { ok: false, code: error.code as ControlFailureCode };
  }
  const decision = legacyAdmission({ authority: 'script-properties', controlTabsPresent, outcome });
  const deployment = {
    dataRevision: args.dataRevision ?? null,
    schedulingInputRevision: args.inputRevision ?? null,
    tabRevisions: args.tabRevisions ?? null
  };
  const divergence = record === undefined || args.dataRevision === undefined
    ? null
    : {
        dataRevision: { record: record.dataRevision, deployment: args.dataRevision, ahead: record.dataRevision - args.dataRevision },
        schedulingInputRevision: args.inputRevision === undefined
          ? null
          : { record: record.schedulingInputRevision, deployment: args.inputRevision, ahead: record.schedulingInputRevision - args.inputRevision },
        tabRevisions: args.tabRevisions === undefined
          ? null
          : Object.fromEntries(Object.entries(record.tabRevisions).map(([tab, value]) => [tab, { record: value, deployment: args.tabRevisions?.[tab] ?? null, ahead: value - (args.tabRevisions?.[tab] ?? 0) }]))
      };
  const path = await report(`rehearsal-legacy-admission-${args.role}`, {
    role: args.role,
    at: new Date().toISOString(),
    controlTabsPresent,
    recordState: record ? tuple(record) : null,
    readOutcome: outcome.ok ? 'valid record' : outcome.code,
    decision,
    deployment,
    divergence
  });
  return {
    path,
    controlTabsPresent,
    recordAuthority: record?.authority ?? null,
    readOutcome: outcome.ok ? 'valid record' : outcome.code,
    admitted: decision.admit,
    refusalCode: decision.admit ? null : decision.code,
    message: decision.admit ? null : decision.message,
    deploymentCountersSupplied: args.dataRevision !== undefined,
    divergence,
    apiCalls: api.callCount()
  };
}

/**
 * B2: write one deliberately broken control state, snapshotting what was there.
 *
 * The read matrix has to see each failure class refused live, and every one of
 * them is a control-row write. The pre-injection rows are saved first, so the
 * `restore` step puts the workbook back exactly as it was — the matrix must not
 * leave a malformed record behind for the next check to trip over.
 */
async function commandInject(args: Args, api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<unknown> {
  const kind = args.kind;
  if (!kind) throw new Error(`inject needs --kind ${INJECTION_KINDS.join('|')}.`);
  const at = new Date().toISOString();
  const before = ((await api.readTabs(['WorkbookControl'])).WorkbookControl ?? []) as unknown[][];
  const snapshotPath = await report(`rehearsal-inject-snapshot-${args.role}`, { role: args.role, at, kind, controlRows: before });
  const dataRows = before.filter((row) => row.some((cell) => cell !== '' && cell !== null && cell !== undefined));
  const current = dataRows[0] ? controlRecordFromRows([dataRows[0]]) : undefined;
  const need = (): ControlRecord => {
    if (!current) throw new Error(`inject --kind ${kind} needs an existing control record.`);
    return current;
  };
  let rows: unknown[][];
  if (kind === 'missing') {
    rows = [];
  } else if (kind === 'duplicate') {
    rows = [serializeControlRecord(need()), serializeControlRecord(need())];
  } else if (kind === 'pending') {
    const tabs = (args.tabs.length > 0 ? args.tabs : ['Assignments']) as never[];
    rows = [serializeControlRecord(beginMutationRecord(need(), { operationId: controlOperationId('rehearsal.inject'), tabs, actorId: args.actor }, at))];
  } else {
    const row = serializeControlRecord(need());
    const at_column = (name: (typeof CONTROL_COLUMNS)[number]): number => CONTROL_COLUMNS.indexOf(name);
    if (kind === 'malformed') row[at_column('protocolVersion')] = 'two';
    else if (kind === 'unsupported') row[at_column('protocolVersion')] = 99;
    else row[at_column('authority')] = 'script-properties';
    rows = [row];
  }
  await api.writeTab('WorkbookControl', controlRowObjects(rows));
  const after = ((await api.readTabs(['WorkbookControl'])).WorkbookControl ?? []) as unknown[][];
  const readBack = after.filter((row) => row.some((cell) => cell !== '' && cell !== null && cell !== undefined)).length;
  const path = await report(`rehearsal-inject-${args.role}`, { role: args.role, at, kind, snapshotPath, rowsWritten: rows.length, readBack });
  return { path, snapshotPath, kind, rowsWritten: rows.length, readBackDataRows: readBack, apiCalls: api.callCount() };
}

/** Puts the control tab back exactly as an `inject` step found it. */
async function commandRestore(args: Args, api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<unknown> {
  if (!args.from) throw new Error('restore needs --from PATH (the snapshot the inject step wrote).');
  const snapshot = JSON.parse(await readFile(resolve(args.from), 'utf8')) as { controlRows?: unknown[][] };
  if (!Array.isArray(snapshot.controlRows)) throw new Error(`The snapshot at ${args.from} carries no controlRows array.`);
  await api.writeTab('WorkbookControl', controlRowObjects(snapshot.controlRows));
  const after = ((await api.readTabs(['WorkbookControl'])).WorkbookControl ?? []) as unknown[][];
  const record = after.find((row) => row.some((cell) => cell !== '' && cell !== null && cell !== undefined));
  const path = await report(`rehearsal-restore-${args.role}`, { role: args.role, at: new Date().toISOString(), from: args.from, rowsWritten: snapshot.controlRows.length, readBack: after });
  return {
    path,
    restoredRows: snapshot.controlRows.length,
    recordAuthority: record ? controlRecordFromRows([record]).authority : null,
    apiCalls: api.callCount()
  };
}

/** Reads the private Google ID token the browser leg captured. */
async function readCredential(path: string): Promise<string> {
  const raw = await readFile(resolve(path), 'utf8');
  const token = raw.trim();
  if (token.length === 0) throw new Error(`The credential file ${path} is empty; re-capture it before the straddle run.`);
  return token;
}

/**
 * S10 (4.1): race a live read against a control transition.
 *
 * The read is started and deliberately not awaited; after `--fire-ms` the runner
 * applies a `begin`+`abort` pair — which leaves the record idle with a higher
 * generation and every counter untouched — and then awaits the response. The
 * bracket must have seen two different tuples and refused with the pinned code,
 * serving no rows. Everything happens in one process, which is what the three
 * earlier attempts lacked: each ran its transition in a separate `vite-node`
 * start-up and never made the window.
 */
async function commandStraddle(args: Args, api: Awaited<ReturnType<typeof createWorkbookApi>>): Promise<unknown> {
  if (!args.workerUrl) throw new Error('straddle needs --worker-url (the deployed staging gateway /exec URL).');
  if (!args.credentialPath) throw new Error('straddle needs --credential (the private file holding a Google ID token).');
  const operation = args.operation ?? DEFAULT_STRADDLE_OPERATION;
  const expectation = args.expect ?? DEFAULT_STRADDLE_EXPECTATION;
  const fireMs = args.fireMs ?? DEFAULT_FIRE_MS;
  const credential = await readCredential(args.credentialPath);
  const before = await readRecord(api);
  if (!before) throw new Error('The workbook has no control record; capture it before racing a read against it.');
  if (before.mutationState !== 'idle') throw new Error('The record already has a pending mutation; settle it before racing a read.');

  const startedAt = Date.now();
  const pending = fetch(args.workerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ operation, payload: {}, idempotencyKey: `straddle-${startedAt}`, credential })
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, fireMs));

  // The transition the read has to straddle. `abort` fires a pair: begin
  // publishes the marker, abort clears it and moves the generation while leaving
  // every counter exactly where it was, so the read must reject on the tuple and
  // not on a counter. `begin` fires the marker alone, which leaves the workbook
  // interrupted on purpose for the pending variant and the recovery drill.
  const at = new Date().toISOString();
  const tabs = (args.tabs.length > 0 ? args.tabs : ['Assignments']) as never[];
  const fireEvent = args.event ?? 'abort';
  const opened = beginMutationRecord(before, { operationId: controlOperationId('rehearsal.straddle'), tabs, actorId: args.actor }, at);
  await writeRecord(api, opened);
  await journal(api, 'begin', opened.operationId, args.actor, tabs, before, opened, 'straddle instrumentation', at);
  if (fireEvent === 'abort') {
    const aborted = abortMutationRecord(opened, args.actor, at);
    await writeRecord(api, aborted);
    await journal(api, 'abort', opened.operationId, args.actor, tabs, opened, aborted, 'straddle instrumentation', at);
  }

  const response = await pending;
  const body = await response.json().catch(() => undefined) as { ok?: boolean; error?: { code?: string; details?: { reason?: string } } } | undefined;
  const observed = {
    status: response.status,
    durationMs: Date.now() - startedAt,
    fireMs,
    operation,
    ok: body?.ok === true,
    errorCode: body?.ok === false ? body.error?.code : undefined,
    reason: body?.ok === false ? body.error?.details?.reason : undefined,
    sheetsReads: Number(response.headers.get('x-staging-sheets-reads') ?? '') || 0,
    readMs: response.headers.get('x-staging-read-ms'),
    hostDeployedAt: response.headers.get('x-staging-host-deployed-at'),
    hasCorrelationId: response.headers.get('x-staging-correlation-id') !== null
  };
  // The expectation is the refusal the raced read must produce, written
  // `CODE[:reason]` (or `ok`). The default names STALE_REVISION and
  // control-generation_changed; comparing the reason against the code slot made
  // a correct refusal report itself as a failure.
  const wanted = expectation.startsWith('failed:') ? expectation.slice('failed:'.length).split(':') : expectation.split(':');
  const passed = wanted[0] === 'ok'
    ? observed.ok
    : observed.ok === false && observed.errorCode === wanted[0] && (wanted[1] === undefined || observed.reason === wanted[1]);
  const after = await readRecord(api);
  const countersUnchanged = after !== undefined
    && after.dataRevision === before.dataRevision
    && after.schedulingInputRevision === before.schedulingInputRevision
    && JSON.stringify(after.tabRevisions) === JSON.stringify(before.tabRevisions);
  const path = await report(`rehearsal-straddle-${args.role}`, {
    role: args.role,
    at,
    expectation,
    before: tuple(before),
    after: after ? tuple(after) : null,
    opened: tuple(opened),
    fired: fireEvent,
    observed,
    passed,
    countersUnchanged,
    generationAdvanced: after !== undefined && after.generation > before.generation,
    idleAfter: after !== undefined && portableRevisionProvider(after).idle,
    leftPending: after !== undefined && !portableRevisionProvider(after).idle
  });
  return {
    path,
    expectation,
    observed,
    passed,
    generationAdvanced: after !== undefined && after.generation > before.generation,
    countersUnchanged,
    idleAfter: after !== undefined && portableRevisionProvider(after).idle,
    servedRows: observed.ok,
    apiCalls: api.callCount()
  };
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
    cleanup: () => commandCleanup(args, api),
    inject: () => commandInject(args, api),
    restore: () => commandRestore(args, api),
    'legacy-admission': () => commandLegacyAdmission(args, api),
    straddle: () => commandStraddle(args, api)
  };
  const run = commands[args.command];
  if (!run) throw new Error(`Unknown subcommand: ${args.command}`);
  const outcome = await run();
  console.log(JSON.stringify({ command: args.command, role: args.role, ...outcome as object }, null, 2));
}


// vite-node strips the script path from argv, so this module cannot detect how it
// was invoked; the command-line contract lives in `rehearsal-arguments.ts`, which
// the contract test imports instead of this entry point.
await main();
