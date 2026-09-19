import { createGoogleTokenInfoVerifier, MemoryUserDirectory, type UserDirectory } from './integration/auth.js';
import { createAppsScriptAdapters, type AppsScriptAdapterOptions, type AppsScriptRequest, type JsonOutput } from './integration/adapters.js';
import { createIntegrationDispatcher, INTEGRATION_OPERATIONS, type HandlerContext, type IntegrationDispatcher, type IntegrationDispatcherOptions, type OperationHandlers, type RevisionSource, type WriteLock } from './integration/dispatcher.js';
import { projectIdentity } from './integration/projections.js';
import { checkActiveWorkbookSchema, initializeActiveWorkbook } from './workbook/initializer.js';
import { createProductionRuntime } from './runtime.js';
import { applyMigrationPayload } from './workbook/loader.js';
import { UserSchema, type ApiResponse, type User } from '../shared/domain.js';
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

export function runtimeListField(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
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
    const id = optionalField(record.id);
    const email = optionalField(record.email);
    if (id === undefined && email === undefined) continue;
    const volunteerId = optionalField(record.volunteerId);
    const centerIds = runtimeListField(record.centerIds);
    const parsed = UserSchema.safeParse({
      id,
      email,
      roles: runtimeListField(record.roles),
      active: String(record.active ?? 'true').toLowerCase() !== 'false',
      revision: Number(record.revision ?? 0),
      ...(volunteerId === undefined ? {} : { volunteerId }),
      ...(Array.isArray(centerIds) && centerIds.length > 0 ? { centerIds } : {})
    });
    if (parsed.success) users.push(parsed.data);
    else console.warn(`Users row for ${String(record.email ?? '(no email)')} was ignored: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(row)'} ${issue.message}`).join('; ')}`);
  }
  return users;
}

function optionalField(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : undefined;
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

export function createServer(options: ServerOptions): Server {
  const dispatcher = createIntegrationDispatcher(options);
  const adapters = createAppsScriptAdapters(dispatcher, options.adapter);
  return {
    dispatcher,
    doGet: adapters.doGet,
    doPost: adapters.doPost,
    initializeWorkbook: () => initializeActiveWorkbook(),
    checkWorkbookSchema: () => checkActiveWorkbookSchema()
  };
}

function defaultServer(): Server {
  const properties = runtimeProperties();
  const audience = properties?.getProperty('OAUTH_AUDIENCE');
  if (!audience?.trim()) throw new Error('OAUTH_AUDIENCE is not configured');
  if (!runtimeTokenInfoAvailable()) throw new Error('Google token verification is unavailable');
  const verifier = createGoogleTokenInfoVerifier({ audience });
  const revision = runtimeRevisionSource();
  const writeEnabled = properties?.getProperty('WRITE_ENABLED') === 'true';
  const writeLock = writeEnabled ? runtimeWriteLock() : undefined;
  const spreadsheet = (globalThis as unknown as { SpreadsheetApp?: { getActiveSpreadsheet(): Parameters<typeof createProductionRuntime>[0] } }).SpreadsheetApp?.getActiveSpreadsheet();
  const production = properties && spreadsheet ? createProductionRuntime(spreadsheet, properties) : undefined;
  const handlers: OperationHandlers = production?.handlers ?? {
    [INTEGRATION_OPERATIONS.me]: ({ actor }: HandlerContext) => projectIdentity(actor)
  };
  return createServer({ verifier, users: runtimeUserDirectory(), revision, writeLock, handlers });
}

let configuredServer: Server | undefined;

function server(): Server {
  configuredServer ??= defaultServer();
  return configuredServer;
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
  const report = {
    audienceConfigured: Boolean(properties?.getProperty('OAUTH_AUDIENCE')?.trim()),
    audience: properties?.getProperty('OAUTH_AUDIENCE') || '(missing)',
    audienceMatchesPublicClient: properties?.getProperty('OAUTH_AUDIENCE')?.trim() === properties?.getProperty('PUBLIC_OAUTH_CLIENT_ID')?.trim(),
    writeEnabled: properties?.getProperty('WRITE_ENABLED') === 'true',
    timeZone: properties?.getProperty('TIME_ZONE') || '(default)',
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
  return server().doPost(event);
}

export function unauthorizedResponse(): ApiResponse<never> {
  return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' } };
}
