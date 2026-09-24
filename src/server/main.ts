import { createGoogleTokenInfoVerifier, MemoryUserDirectory, type UserDirectory } from './integration/auth.js';
import { createAppsScriptDigest, createCachingTokenVerifier, type AppsScriptDigestService } from './integration/claim-cache.js';
import { createAppsScriptAdapters, type AppsScriptAdapterOptions, type AppsScriptRequest, type JsonOutput } from './integration/adapters.js';
import { createIntegrationDispatcher, INTEGRATION_OPERATIONS, type HandlerContext, type IntegrationDispatcher, type IntegrationDispatcherOptions, type OperationHandlers, type RevisionSource, type WriteLock } from './integration/dispatcher.js';
import { projectIdentity } from './integration/projections.js';
import { checkActiveWorkbookSchema, initializeActiveWorkbook } from './workbook/initializer.js';
import { createProductionRuntime, runtimeConfiguration } from './runtime.js';
import { applyMigrationPayload } from './workbook/loader.js';
import { cellBoolean, cellNumber, optionalCellText } from './workbook/sheet-values.js';
import { UserSchema, type ApiResponse, type User } from '../shared/domain.js';
import { ReadTiming } from './integration/read-timing.js';
import { BATCH_READ_PLANS, createWorkbookBatchReader, type BatchGetValuesRequest, type WorkbookBatchReader } from './workbook/batch-read.js';

// Approved batched reads still fail closed if the bound workbook or service is unavailable.
const ADVANCED_SHEETS_READS_ENABLED = true;
export type ServerOptions = IntegrationDispatcherOptions & Readonly<{ adapter?: AppsScriptAdapterOptions }>;

export type Server = Readonly<{
  dispatcher: IntegrationDispatcher;
  doGet(event: AppsScriptRequest): JsonOutput | string;
  doPost(event: AppsScriptRequest): JsonOutput | string;
  initializeWorkbook(): unknown;
  checkWorkbookSchema(): unknown;
}>;

function runtimeProperties(): { getProperty(name: string): string | null; setProperty(name: string, value: string): void } | undefined {
  const runtime = globalThis as unknown as { PropertiesService?: { getScriptProperties(): { getProperty(name: string): string | null; setProperty(name: string, value: string): void } } };
  return runtime.PropertiesService?.getScriptProperties();
}

/**
 * Reads a Users-tab list cell, which the workbook stores as JSON or as a
 * comma-separated string. Only string entries survive: a stray number or null
 * would fail UserSchema and silently drop the whole row, locking that account
 * out, so it is ignored here instead.
 */
export function runtimeListField(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === 'string');
  } catch {
    // Fall back to the workbook's comma-separated representation.
  }
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
}

/** Sheet boundary for one Users row: blank optional cells mean "absent", not "". */
export type UserSheetLike = {
  getLastRow(): number;
  getLastColumn(): number;
  getRange(row: number, column: number, rows: number, columns: number): { getValues(): unknown[][] };
};

/**
 * Reads the authorization table. A blank cell is treated as an absent value:
 * `volunteerId: ''` would otherwise fail UserSchema and silently drop the row,
 * which locks every user who has no linked volunteer record out of the app.
 */
export function usersFromSheet(sheet: UserSheetLike): User[] {
  if (sheet.getLastRow() < 2 || sheet.getLastColumn() < 2) return [];
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headers = values[0] ?? [];
  const users: User[] = [];
  for (const row of values.slice(1)) {
    const record: Record<string, unknown> = {};
    headers.forEach((header, index) => { if (typeof header === 'string') record[header] = row[index]; });
    const id = optionalCellText(record.id);
    const email = optionalCellText(record.email);
    if (id === undefined && email === undefined) continue;
    const volunteerId = optionalCellText(record.volunteerId);
    const centerIds = runtimeListField(record.centerIds);
    const parsed = UserSchema.safeParse({
      id,
      email,
      roles: runtimeListField(record.roles),
      active: cellBoolean(record.active, true),
      revision: cellNumber(record.revision),
      ...(volunteerId === undefined ? {} : { volunteerId }),
      ...(Array.isArray(centerIds) && centerIds.length > 0 ? { centerIds } : {})
    });
    if (parsed.success) users.push(parsed.data);
    else console.warn(`Users row for ${String(record.email ?? '(no email)')} was ignored: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(row)'} ${issue.message}`).join('; ')}`);
  }
  return users;
}

function runtimeUserDirectory(): UserDirectory {
  const runtime = globalThis as unknown as { SpreadsheetApp?: { getActiveSpreadsheet(): { getSheetByName(name: string): UserSheetLike | null } } };
  const sheet = runtime.SpreadsheetApp?.getActiveSpreadsheet()?.getSheetByName('Users');
  return new MemoryUserDirectory(sheet ? usersFromSheet(sheet) : []);
}

function runtimeRevisionSource(): RevisionSource | undefined {
  const properties = runtimeProperties();
  if (!properties) return undefined;
  const read = (): number => {
    const value = Number(properties.getProperty('DATA_REVISION') ?? '0');
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  return {
    current: read,
    advance: (_actorId, _operation) => {
      const next = read() + 1;
      properties.setProperty('DATA_REVISION', String(next));
      return next;
    }
  };
}

function runtimeWriteLock(): WriteLock | undefined {
  const runtime = globalThis as unknown as { LockService?: { getScriptLock(): { tryLock(timeoutMilliseconds: number): boolean; releaseLock(): void } } };
  const lock = runtime.LockService?.getScriptLock();
  if (!lock) return undefined;
  return {
    tryAcquire: () => lock.tryLock(100),
    release: () => lock.releaseLock()
  };
}

function runtimeTokenInfoAvailable(): boolean {
  const runtime = globalThis as unknown as { UrlFetchApp?: unknown };
  return runtime.UrlFetchApp !== undefined;
}

export function runtimeBatchReader(spreadsheet: Parameters<typeof createProductionRuntime>[0], enabled: boolean, sheets: unknown, timing?: ReadTiming): WorkbookBatchReader | undefined {
  if (!enabled) return undefined;
  const workbookId = spreadsheet.getId?.()?.trim();
  if (!workbookId) throw new Error('The bound workbook ID is unavailable for batched reads');
  const service = sheets as { Spreadsheets?: { Values?: { batchGet?: (spreadsheetId: string, request: BatchGetValuesRequest) => unknown } } } | undefined;
  const values = service?.Spreadsheets?.Values;
  if (typeof values?.batchGet !== 'function') throw new Error('The Advanced Sheets batch read service is unavailable');
  return createWorkbookBatchReader({ boundSpreadsheetId: workbookId, service: { batchGet: (spreadsheetId, request) => {
    const fetch = () => values.batchGet!(spreadsheetId, request);
    return timing ? timing.sheetCall(fetch) : fetch();
  } } });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function differingProjectionFields(left: unknown, right: unknown, ignoredFields: readonly string[] = []): string[] {
  if (!left || typeof left !== 'object' || Array.isArray(left) || !right || typeof right !== 'object' || Array.isArray(right)) {
    return stableJson(left) === stableJson(right) ? [] : ['(projection)'];
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].filter((key) => !ignoredFields.includes(key) && stableJson(leftRecord[key]) !== stableJson(rightRecord[key])).sort();
}

/**
 * Read-only editor diagnostic for checking route projection parity on the
 * active workbook. The report includes only booleans and projection field
 * names; row data and exception details are never returned or logged.
 */
export function readOnlyRouteParityReport(
  spreadsheet: Parameters<typeof createProductionRuntime>[0],
  properties: NonNullable<ReturnType<typeof runtimeProperties>>,
  sheets: unknown
): Record<string, unknown> {
  if (properties.getProperty('WRITE_ENABLED') !== 'false') {
    return { passed: false, stage: 'preflight', reason: 'WRITE_ENABLED must be exactly false', rowValuesIncluded: false };
  }

  let stage = 'setup';
  try {
    stage = 'baseline-runtime';
    const scheduleBaseline = createProductionRuntime(spreadsheet, properties);
    stage = 'batch-reader';
    const scheduleBatchReader = runtimeBatchReader(spreadsheet, true, sheets);
    if (!scheduleBatchReader) throw new Error('Batched reader is disabled');
    stage = 'batch-runtime';
    const scheduleBatched = createProductionRuntime(spreadsheet, properties, { batchReader: scheduleBatchReader });
    stage = 'baseline-runtime';
    const insightsBaseline = createProductionRuntime(spreadsheet, properties);
    stage = 'batch-reader';
    const insightsBatchReader = runtimeBatchReader(spreadsheet, true, sheets);
    if (!insightsBatchReader) throw new Error('Batched reader is disabled');
    stage = 'batch-runtime';
    const insightsBatched = createProductionRuntime(spreadsheet, properties, { batchReader: insightsBatchReader });
    const revisionKeys = [...new Set([
      'DATA_REVISION',
      'SCHEDULING_INPUT_REVISION',
      ...BATCH_READ_PLANS.insightCacheMiss.map((tab) => `TAB_REVISION_${tab}`),
      ...BATCH_READ_PLANS.publishedSchedule.map((tab) => `TAB_REVISION_${tab}`)
    ])];
    const revisions = () => revisionKeys.map((key) => properties.getProperty(key) ?? '0');
    const before = revisions();
    const now = new Date().toISOString();
    const invoke = (runtime: ReturnType<typeof createProductionRuntime>, operation: typeof INTEGRATION_OPERATIONS.adminSchedule | typeof INTEGRATION_OPERATIONS.adminInsights): unknown => {
      const handler = runtime.handlers[operation];
      if (!handler) throw new Error(`Missing read handler for ${operation}`);
      return handler({ actor: {} as HandlerContext['actor'], operation, idempotencyKey: 'editor-read-parity', now }, {});
    };

    stage = 'schedule';
    const regularSchedule = invoke(scheduleBaseline, INTEGRATION_OPERATIONS.adminSchedule);
    const batchedSchedule = invoke(scheduleBatched, INTEGRATION_OPERATIONS.adminSchedule);
    stage = 'insights';
    const regularInsights = invoke(insightsBaseline, INTEGRATION_OPERATIONS.adminInsights) as Record<string, unknown>;
    const batchedInsights = invoke(insightsBatched, INTEGRATION_OPERATIONS.adminInsights) as Record<string, unknown>;
    const revisionsStable = revisions().every((value, index) => value === before[index]);
    const writeGateStayedDisabled = properties.getProperty('WRITE_ENABLED') === 'false';
    const scheduleDifferences = differingProjectionFields(regularSchedule, batchedSchedule);
    const insightsDifferences = differingProjectionFields(regularInsights, batchedInsights, ['generatedAt']);
    const scheduleMatches = scheduleDifferences.length === 0;
    const insightsMatch = insightsDifferences.length === 0;
    return {
      passed: revisionsStable && writeGateStayedDisabled && scheduleMatches && insightsMatch,
      revisionsStable,
      writeGateStayedDisabled,
      schedule: { matches: scheduleMatches, differingFields: scheduleDifferences },
      insights: { matches: insightsMatch, differingFields: insightsDifferences, ignoredFields: ['generatedAt'] },
      rowValuesIncluded: false
    };
  } catch {
    return { passed: false, stage, reason: 'Read-only parity check failed; exception details omitted', rowValuesIncluded: false };
  }
}

/** Compare ordinary SpreadsheetApp reads with Advanced Sheets reads in the editor. */
export function compareAdvancedReadParity(): unknown {
  const properties = runtimeProperties();
  const spreadsheet = activeSpreadsheet();
  if (!properties || !spreadsheet) throw new Error('SpreadsheetApp and PropertiesService are required; run this from the bound Apps Script project');
  const runtime = globalThis as unknown as { Sheets?: unknown };
  return logResult('compareAdvancedReadParity', readOnlyRouteParityReport(spreadsheet, properties, runtime.Sheets));
}

export function createServer(options: ServerOptions): Server {
  const dispatcher = createIntegrationDispatcher(options);
  const adapters = createAppsScriptAdapters(dispatcher, { ...options.adapter, timing: options.timing });
  return {
    dispatcher,
    doGet: adapters.doGet,
    doPost: adapters.doPost,
    initializeWorkbook: () => initializeActiveWorkbook(),
    checkWorkbookSchema: () => checkActiveWorkbookSchema()
  };
}

function runtimeAppsscriptServices(): { scriptCache?: { get(key: string): string | null; put(key: string, value: string, seconds: number): void }; utilities?: AppsScriptDigestService } {
  const runtime = globalThis as unknown as {
    CacheService?: { getScriptCache(): { get(key: string): string | null; put(key: string, value: string, seconds: number): void } };
    Utilities?: AppsScriptDigestService;
  };
  const scriptCache = runtime.CacheService?.getScriptCache();
  return { ...(scriptCache ? { scriptCache } : {}), ...(runtime.Utilities ? { utilities: runtime.Utilities } : {}) };
}

function defaultServer(timing?: ReadTiming): Server {
  const properties = runtimeProperties();
  const audience = properties?.getProperty('OAUTH_AUDIENCE');
  if (!audience?.trim()) throw new Error('OAUTH_AUDIENCE is not configured');
  if (!runtimeTokenInfoAvailable()) throw new Error('Google token verification is unavailable');
  const { scriptCache, utilities } = runtimeAppsscriptServices();
  const verifier = scriptCache && utilities
    ? createCachingTokenVerifier({ verifier: createGoogleTokenInfoVerifier({ audience }), cache: scriptCache, digest: createAppsScriptDigest(utilities), audience })
    : createGoogleTokenInfoVerifier({ audience });
  const revision = runtimeRevisionSource();
  const writeEnabled = properties?.getProperty('WRITE_ENABLED') === 'true';
  const writeLock = writeEnabled ? runtimeWriteLock() : undefined;
  const spreadsheet = (globalThis as unknown as { SpreadsheetApp?: { getActiveSpreadsheet(): Parameters<typeof createProductionRuntime>[0] } }).SpreadsheetApp?.getActiveSpreadsheet();
  const sheets = (globalThis as unknown as { Sheets?: unknown }).Sheets;
  const batchReader = spreadsheet ? runtimeBatchReader(spreadsheet, ADVANCED_SHEETS_READS_ENABLED, sheets, timing) : undefined;
  const production = properties && spreadsheet ? createProductionRuntime(spreadsheet, properties, { scriptCache, timing, batchReader }) : undefined;
  const handlers: OperationHandlers = production?.handlers ?? {
    [INTEGRATION_OPERATIONS.me]: ({ actor }: HandlerContext) => projectIdentity(actor)
  };
  // `production.users` is the Users tab decoded once for this request, so
  // authorization can never survive from an earlier request.
  return createServer({ verifier, users: production ? new MemoryUserDirectory(production.users) : runtimeUserDirectory(), revision, writeLock, handlers, timing });
}

/**
 * Only an explicitly configured adapter is retained. The default server is
 * rebuilt for every request so no cached rows, revisions, or authorizations can
 * leak from one execution into the next.
 */
let configuredServer: Server | undefined;

function server(): Server {
  return configuredServer ?? defaultServer();
}

export function configureServer(options: ServerOptions): Server {
  configuredServer = createServer(options);
  return configuredServer;
}

/**
 * Editor entry points return a value to the caller, but the Apps Script editor
 * discards it: only the execution log is visible, so every editor-invoked
 * function also logs its result.
 */
function logResult(label: string, value: unknown): unknown {
  console.log(`${label}: ${JSON.stringify(value, null, 2)}`);
  return value;
}

export function initializeWorkbook(): unknown {
  return logResult('initializeWorkbook', server().initializeWorkbook());
}

export function checkWorkbookSchema(): unknown {
  return logResult('checkWorkbookSchema', server().checkWorkbookSchema());
}

function activeSpreadsheet(): Parameters<typeof applyMigrationPayload>[0] | undefined {
  const runtime = globalThis as unknown as { SpreadsheetApp?: { getActiveSpreadsheet(): Parameters<typeof applyMigrationPayload>[0] } };
  return runtime.SpreadsheetApp?.getActiveSpreadsheet();
}

/**
 * Validate the pasted MIGRATION_PAYLOAD without writing. Safe to run repeatedly:
 * it initializes any missing tabs and reports exactly which rows would be
 * rejected, so the payload can be fixed before anything touches the workbook.
 */
export function validateMigrationWorkbook(): unknown {
  const properties = runtimeProperties();
  const spreadsheet = activeSpreadsheet();
  if (!properties || !spreadsheet) throw new Error('SpreadsheetApp and PropertiesService are required; run this from the bound Apps Script project');
  return logResult('validateMigrationWorkbook', applyMigrationPayload(spreadsheet, properties, migrationPayload(), { apply: false }));
}

/**
 * Write the reviewed migration payload into the workbook. Requires the
 * WRITE_ENABLED script property to be "true"; refuses the whole load if any row
 * fails validation, so the workbook is never left half-migrated.
 *
 * The audit actor comes from the optional MIGRATION_ACTOR script property rather
 * than Session.getActiveUser(), which would require the script to request the
 * userinfo.email scope that this deployment deliberately omits.
 */
export function loadMigrationWorkbook(): unknown {
  const properties = runtimeProperties();
  const spreadsheet = activeSpreadsheet();
  if (!properties || !spreadsheet) throw new Error('SpreadsheetApp and PropertiesService are required; run this from the bound Apps Script project');
  if (properties.getProperty('WRITE_ENABLED') !== 'true') {
    throw new Error('Refusing to write: set the WRITE_ENABLED script property to "true" first, then run loadMigrationWorkbook again');
  }
  const actorId = properties.getProperty('MIGRATION_ACTOR')?.trim() || 'migration';
  return logResult('loadMigrationWorkbook', applyMigrationPayload(spreadsheet, properties, migrationPayload(), { apply: true, actorId }));
}

/**
 * Editor-run diagnostic for sign-in problems. Returns and logs the resolved
 * deployment configuration and the Users directory, so a failing sign-in can be
 * split into "configuration" versus "this account" without server log access.
 */
export function describeSignIn(): unknown {
  const properties = runtimeProperties();
  const spreadsheet = activeSpreadsheet();
  const sheet = spreadsheet?.getSheetByName('Users') ?? null;
  const directory = sheet ? usersFromSheet(sheet) : [];
  const configuration = properties ? runtimeConfiguration(properties) : undefined;
  const workbookTimeZone = spreadsheet?.getSpreadsheetTimeZone?.().trim();
  const report = {
    audienceConfigured: Boolean(properties?.getProperty('OAUTH_AUDIENCE')?.trim()),
    audience: properties?.getProperty('OAUTH_AUDIENCE') || '(missing)',
    audienceMatchesPublicClient: properties?.getProperty('OAUTH_AUDIENCE')?.trim() === properties?.getProperty('PUBLIC_OAUTH_CLIENT_ID')?.trim(),
    writeEnabled: properties?.getProperty('WRITE_ENABLED') === 'true',
    timeZone: configuration?.timeZone ?? '(default)',
    timeZoneConfigured: Boolean(properties?.getProperty('TIME_ZONE')?.trim()),
    // Date and time cells are decoded in the spreadsheet's zone; a mismatch with
    // TIME_ZONE is worth seeing here because it is invisible in the workbook.
    workbookTimeZone: workbookTimeZone || '(unavailable)',
    workbookTimeZoneMatchesConfigured: Boolean(workbookTimeZone) && workbookTimeZone === (configuration?.timeZone ?? ''),
    displayIncrementMinutes: configuration?.incrementMinutes,
    displayIncrementConfigured: Boolean(properties?.getProperty('DISPLAY_INCREMENT_MINUTES')?.trim()),
    operatingHoursStart: configuration?.operatingHours.start,
    operatingHoursEnd: configuration?.operatingHours.end,
    operatingHoursConfigured: Boolean(properties?.getProperty('OPERATING_HOURS_START')?.trim() && properties?.getProperty('OPERATING_HOURS_END')?.trim()),
    whoIsGoodEndpointConfigured: Boolean(properties?.getProperty('WHENISGOOD_ENDPOINT')?.trim()),
    spreadsheetAvailable: Boolean(spreadsheet),
    usersSheetRows: sheet ? Math.max(0, sheet.getLastRow() - 1) : 0,
    authorizedUsers: directory.map((user) => `${user.email} [${user.roles.join('+')}]${user.volunteerId ? ` -> ${user.volunteerId}` : ''}${user.centerIds?.length ? ` @${user.centerIds.join(',')}` : ''}${user.active ? '' : ' (INACTIVE)'}`),
    hint: 'If the account you signed in with is not listed above, its Users row is missing, inactive, or unreadable.'
  };
  return logResult('describeSignIn', report);
}

function migrationPayload(): unknown {
  const runtime = globalThis as unknown as { MIGRATION_PAYLOAD?: unknown };
  if (runtime.MIGRATION_PAYLOAD === undefined) {
    throw new Error('MIGRATION_PAYLOAD is not defined; add the generated MigrationPayload.gs file to this Apps Script project');
  }
  return runtime.MIGRATION_PAYLOAD;
}

export function doGet(event: AppsScriptRequest): JsonOutput | string {
  return server().doGet(event);
}

export function doPost(event: AppsScriptRequest): JsonOutput | string {
  if (configuredServer) return configuredServer.doPost(event);
  const timing = new ReadTiming();
  let operation = 'invalid';
  let probeId: string | undefined;
  try {
    const parsed: unknown = JSON.parse(event.postData?.contents ?? 'null');
    if (parsed && typeof parsed === 'object') {
      if ('operation' in parsed && typeof parsed.operation === 'string' && Object.values(INTEGRATION_OPERATIONS).includes(parsed.operation as typeof INTEGRATION_OPERATIONS[keyof typeof INTEGRATION_OPERATIONS])) operation = parsed.operation;
      if ('idempotencyKey' in parsed && typeof parsed.idempotencyKey === 'string' && /^read-probe-[0-9]{13}-[a-z0-9]{8,16}$/.test(parsed.idempotencyKey)) probeId = parsed.idempotencyKey;
    }
  } catch { /* malformed input is reported as invalid */ }
  try { return defaultServer(timing).doPost(event); }
  finally { if (operation === INTEGRATION_OPERATIONS.adminSchedule || operation === INTEGRATION_OPERATIONS.adminInsights) timing.report(operation, timing.succeeded, probeId); }
}

export function unauthorizedResponse(): ApiResponse<never> {
  return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' } };
}
