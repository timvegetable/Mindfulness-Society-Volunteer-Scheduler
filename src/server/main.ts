import { createGoogleTokenInfoVerifier, MemoryUserDirectory, type UserDirectory } from './integration/auth.js';
import { createAppsScriptAdapters, type AppsScriptAdapterOptions, type AppsScriptRequest, type JsonOutput } from './integration/adapters.js';
import { createIntegrationDispatcher, INTEGRATION_OPERATIONS, type HandlerContext, type IntegrationDispatcher, type IntegrationDispatcherOptions, type RevisionSource, type WriteLock } from './integration/dispatcher.js';
import { projectIdentity } from './integration/projections.js';
import { checkActiveWorkbookSchema, initializeActiveWorkbook } from './workbook/initializer.js';
import { UserSchema, type ApiResponse, type User } from '../shared/domain.js';

export type ServerOptions = IntegrationDispatcherOptions & Readonly<{ adapter?: AppsScriptAdapterOptions }>;

export type Server = Readonly<{
  dispatcher: IntegrationDispatcher;
  doGet(event: AppsScriptRequest): Promise<JsonOutput | string>;
  doPost(event: AppsScriptRequest): Promise<JsonOutput | string>;
  initializeWorkbook(): unknown;
  checkWorkbookSchema(): unknown;
}>;

function runtimeProperties(): { getProperty(name: string): string | null; setProperty(name: string, value: string): void } | undefined {
  const runtime = globalThis as unknown as { PropertiesService?: { getScriptProperties(): { getProperty(name: string): string | null; setProperty(name: string, value: string): void } } };
  return runtime.PropertiesService?.getScriptProperties();
}

function runtimeUserDirectory(): UserDirectory {
  const runtime = globalThis as unknown as { SpreadsheetApp?: { getActiveSpreadsheet(): { getSheetByName(name: string): { getLastRow(): number; getLastColumn(): number; getRange(row: number, column: number, rows: number, columns: number): { getValues(): unknown[][] } } | null } } };
  const spreadsheet = runtime.SpreadsheetApp?.getActiveSpreadsheet();
  const sheet = spreadsheet?.getSheetByName('Users');
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 2) return new MemoryUserDirectory();
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headers = values[0] ?? [];
  const users: User[] = [];
  for (const row of values.slice(1)) {
    const record: Record<string, unknown> = {};
    headers.forEach((header, index) => { if (typeof header === 'string') record[header] = row[index]; });
    const roles = typeof record.roles === 'string' ? record.roles.split(',').map((role) => role.trim()).filter(Boolean) : record.roles;
    const centerIds = typeof record.centerIds === 'string' ? record.centerIds.split(',').map((center) => center.trim()).filter(Boolean) : record.centerIds;
    const parsed = UserSchema.safeParse({ ...record, roles, centerIds, active: record.active !== false && record.active !== 'false', revision: Number(record.revision ?? 0) });
    if (parsed.success) users.push(parsed.data);
  }
  return new MemoryUserDirectory(users);
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
  const writeLock = runtimeWriteLock();
  const handlers = {
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

export function initializeWorkbook(): unknown {
  return server().initializeWorkbook();
}

export function checkWorkbookSchema(): unknown {
  return server().checkWorkbookSchema();
}

export async function doGet(event: AppsScriptRequest): Promise<JsonOutput | string> {
  return server().doGet(event);
}

export async function doPost(event: AppsScriptRequest): Promise<JsonOutput | string> {
  return server().doPost(event);
}

export function unauthorizedResponse(): ApiResponse<never> {
  return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' } };
}
