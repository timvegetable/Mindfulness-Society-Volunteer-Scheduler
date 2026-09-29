import { Temporal } from '@js-temporal/polyfill';
import { expect } from 'vitest';
import { INTEGRATION_OPERATIONS } from '../server/integration/request-policy.js';
import { createProductionRuntime } from '../server/runtime.js';
import { InMemoryProperties, InMemorySpreadsheet } from '../server/workbook/in-memory-sheet.js';
import { WORKBOOK_TABS, tabDefinition, WORKBOOK_CONTROL_TABS } from '../server/workbook/schema.js';
import { GOOGLE_JWKS_URL, GOOGLE_TOKEN_ENDPOINT, base64UrlEncodeJson, signRs256, type FetchLike } from './google/index.js';
import { createStagingReadService } from './staging.js';

/**
 * Shared fixture and Google-double helpers for the Worker-native differential
 * tests. Extracted verbatim from `staging.test.ts` so the host and gateway test
 * suites exercise the same synthetic workbook, codecs, tokens and legacy
 * runtime instead of drifting copies. Nothing here is production code.
 */

export const WORKBOOK_ZONE = 'America/New_York';
export const DISPLAY_ZONE = 'America/Chicago';
export const CLOCK = '2026-10-05T12:00:00.000Z';
export const NOW_MS = Date.parse(CLOCK);
export const AUDIENCE = 'staging-client.apps.googleusercontent.com';
export const CLIENT_EMAIL = 'staging-reader@example-project.iam.gserviceaccount.com';
const SHEETS_EPOCH = Temporal.PlainDate.from('1899-12-30');
export const DATA_REVISION = 42;
export const INPUT_REVISION = 5;
export const OUTPUT_REVISION = 7;

export type Row = Record<string, unknown>;

const CONTROL_TAB_NAMES: ReadonlySet<string> = new Set(WORKBOOK_CONTROL_TABS.map((tab) => tab.name));

/** Serial number for a date in the workbook's zone, as the REST API returns it. */
function dateSerial(date: string): number {
  return Temporal.PlainDate.from(date).since(SHEETS_EPOCH).days;
}

/** Fraction of a day for a clock time, as the REST API returns it. */
function clockFraction(clock: string): number {
  const [hour, minute] = clock.split(':').map(Number);
  return ((hour ?? 0) * 60 + (minute ?? 0)) / (24 * 60);
}

/** A `Date` anchored to the workbook zone, as Apps Script returns it. */
function zoneDate(date: string, zone = WORKBOOK_ZONE): Date {
  return new Date(Temporal.PlainDate.from(date).toZonedDateTime(zone).toInstant().epochMilliseconds);
}

function zoneClock(clock: string, zone = WORKBOOK_ZONE): Date {
  return new Date(Temporal.PlainDate.from('1899-12-30').toPlainDateTime(clock).toZonedDateTime(zone).toInstant().epochMilliseconds);
}

const DATE_COLUMNS = new Set(['date']);
const CLOCK_COLUMNS = new Set(['start', 'end']);
const INSTANT_COLUMNS = new Set(['createdAt', 'updatedAt', 'cancelledAt', 'startedAt', 'completedAt', 'promotedAt', 'importedAt']);

/** Renders one logical row the way Apps Script's `getValues()` would. */
function appsScriptRow(tab: string, row: Row, zone = WORKBOOK_ZONE): unknown[] {
  return tabDefinition(tab).columns.map((column) => {
    const value = row[column];
    if (value === undefined || value === null || value === '') return '';
    if (DATE_COLUMNS.has(column) && typeof value === 'string') return zoneDate(value, zone);
    if (CLOCK_COLUMNS.has(column) && typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) return zoneClock(value, zone);
    if (INSTANT_COLUMNS.has(column) && typeof value === 'string') return new Date(value);
    return typeof value === 'object' ? JSON.stringify(value) : value;
  });
}

/** Renders one logical row the way `values:batchGet` with SERIAL_NUMBER would. */
function restRow(tab: string, row: Row, zone = WORKBOOK_ZONE): unknown[] {
  // The control tabs hold protocol text and numbers: counters are numbers, the
  // serialized maps and stamps are text the codec parses. Sheets returns a text
  // cell as text, so the date/time heuristics below must not reinterpret them —
  // they exist for the domain fixtures' genuinely typed cells.
  const protocolTab = CONTROL_TAB_NAMES.has(tab);
  const cells = tabDefinition(tab).columns.map((column) => {
    const value = row[column];
    // A blank cell is a blank cell, whatever its column type: rendering '' as a
    // date serial would be a fixture bug, not Sheets behaviour.
    if (value === undefined || value === null || value === '') return '';
    if (protocolTab) return typeof value === 'object' ? JSON.stringify(value) : value;
    if (DATE_COLUMNS.has(column) && typeof value === 'string') return dateSerial(value);
    if (CLOCK_COLUMNS.has(column) && typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) return clockFraction(value);
    if (INSTANT_COLUMNS.has(column) && typeof value === 'string') {
      // Date-time cells render as a serial with a time fraction.
      const instant = Temporal.Instant.from(value).toZonedDateTimeISO(zone);
      const days = instant.toPlainDate().since(SHEETS_EPOCH).days;
      const seconds = instant.hour * 3600 + instant.minute * 60 + instant.second;
      return days + seconds / 86_400;
    }
    return typeof value === 'object' ? JSON.stringify(value) : value;
  });
  // Sheets omits trailing empty cells: volunteer-008's source and updatedAt are
  // genuinely blank, so its REST row stops after the last populated cell and the
  // shared validator pads it back to the schema width.
  if (tab === 'Volunteers' && row.id === 'volunteer-008') {
    let lastPopulated = cells.length - 1;
    while (lastPopulated >= 0 && (cells[lastPopulated] === '' || cells[lastPopulated] === undefined)) lastPopulated -= 1;
    return cells.slice(0, lastPopulated + 1);
  }
  return cells;
}

export function fixtureRows(): Map<string, Row[]> {
  const rows = new Map<string, Row[]>();
  const timestamp = '2026-09-01T12:00:00.000Z';
  const add = (tab: string, row: Row): void => {
    const existing = rows.get(tab) ?? [];
    existing.push(row);
    rows.set(tab, existing);
  };

  for (let index = 1; index <= 4; index += 1) {
    add('Centers', { id: `center-${index}`, name: `Center ${index}`, active: true, revision: 1, createdAt: timestamp, updatedAt: timestamp });
  }

  // Twelve volunteers: eight eligible, and the four ineligible categories the
  // experiment contract pins.
  for (let index = 1; index <= 12; index += 1) {
    const suffix = String(index).padStart(3, '0');
    const ineligible = index > 8;
    add('Volunteers', {
      id: `volunteer-${suffix}`,
      name: `Volunteer ${suffix}`,
      email: `volunteer-${suffix}@example.test`,
      lifecycleStatus: index === 9 ? 'graduated' : index === 10 ? 'inactive' : 'active',
      interviewStatus: index === 11 ? 'incomplete' : 'complete',
      readinessRank: index === 12 ? '' : (index % 3) + 1,
      revision: 1,
      source: index === 8 ? '' : 'staging-fixture',
      createdAt: timestamp,
      updatedAt: index === 8 ? '' : timestamp
    });
    if (ineligible) continue;
    for (const [weekday, start, end] of [[1, '09:00', '13:00'], [3, '13:00', '17:00']] as const) {
      add('RecurringAvailability', {
        id: `availability-${suffix}-${weekday}`,
        volunteerId: `volunteer-${suffix}`,
        weekday,
        start,
        end,
        timeZone: DISPLAY_ZONE,
        revision: 1,
        source: 'staging-fixture',
        updatedAt: timestamp
      });
    }
  }

  add('AvailabilityExceptions', {
    id: 'exception-1', volunteerId: 'volunteer-001', date: '2026-10-07', kind: 'unavailable',
    start: '09:00', end: '17:00', timeZone: DISPLAY_ZONE, reason: 'appointment', revision: 1, updatedAt: timestamp
  });

  // Sessions start after the pinned clock so the cutoff keeps them, and one
  // starts exactly at the clock to pin the strict comparison.
  const sessions: Array<[string, string, string, string, number]> = [
    ['session-01', '2026-10-05', '12:00', '14:00', 1],
    ['session-02', '2026-10-06', '10:00', '12:00', 2],
    ['session-03', '2026-10-07', '10:00', '12:00', 1],
    ['session-04', '2026-10-08', '14:00', '16:00', 1],
    ['session-05', '2026-10-12', '09:00', '11:00', 2],
    ['session-06', '2026-10-13', '09:00', '11:00', 1],
    ['session-07', '2026-10-14', '15:00', '17:00', 1],
    ['session-08', '2026-10-15', '15:00', '17:00', 2],
    // The US DST transition. 01:30 on 2026-11-01 is ambiguous in New York, so
    // both its wall clock and its decoded instant are pinned.
    ['session-09', '2026-11-01', '01:30', '03:30', 1]
  ];
  sessions.forEach(([id, date, start, end, required], index) => {
    add('Sessions', {
      id, kind: 'center', centerId: `center-${(index % 4) + 1}`, title: `Session ${index + 1}`,
      date, start, end, timeZone: DISPLAY_ZONE, requiredStaffCount: required,
      status: 'locked', revision: 1,
      createdAt: id === 'session-09' ? '2026-11-01T05:30:00.000Z' : timestamp,
      updatedAt: id === 'session-09' ? '2026-11-01T05:30:00.000Z' : timestamp
    });
    add('Assignments', {
      id: `assignment-${String(index + 1).padStart(2, '0')}`, sessionId: id,
      // Only the first five eligible volunteers are assigned, so the leftover
      // population (and therefore the Insights grid) is non-empty.
      volunteerId: `volunteer-${String((index % 5) + 1).padStart(3, '0')}`,
      scheduleRevision: OUTPUT_REVISION, status: 'assigned', createdAt: timestamp
    });
  });
  add('Backups', {
    id: 'backup-01', sessionId: 'session-01', volunteerId: 'volunteer-002',
    scheduleRevision: OUTPUT_REVISION, position: 1, status: 'available'
  });

  add('SchedulingRuns', {
    id: 'run-older', inputRevision: 3, outputRevision: 4, status: 'completed',
    startedAt: '2026-09-20T10:00:00.000Z', completedAt: '2026-09-20T10:05:00.000Z',
    assignmentIds: [], backupIds: [], shortfalls: []
  });
  add('SchedulingRuns', {
    id: 'run-current', inputRevision: INPUT_REVISION, outputRevision: OUTPUT_REVISION, status: 'completed',
    startedAt: '2026-09-28T10:00:00.000Z', completedAt: '2026-09-28T10:05:00.000Z',
    assignmentIds: [], backupIds: [], shortfalls: []
  });

  add('Users', { id: 'user-admin', email: 'admin@example.test', roles: ['administrator'], active: true, revision: 1 });
  add('Users', { id: 'user-volunteer', email: 'volunteer@example.test', roles: ['volunteer'], volunteerId: 'volunteer-001', active: true, revision: 1 });
  add('Users', { id: 'user-multi', email: 'multi@example.test', roles: ['administrator', 'volunteer', 'center-contact'], volunteerId: 'volunteer-002', centerIds: ['center-1'], active: true, revision: 1 });
  add('Users', { id: 'user-contact', email: 'contact@example.test', roles: ['center-contact'], centerIds: ['center-2'], active: true, revision: 1 });
  add('Users', { id: 'user-blank-active', email: 'blank-active@example.test', roles: ['administrator'], active: '', revision: 1 });
  add('Users', { id: 'user-inactive', email: 'inactive@example.test', roles: ['administrator'], active: false, revision: 1 });

  return rows;
}

export const LOGICAL_ROWS = fixtureRows();

export function stagingBindings(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    STAGING_ALLOWED_ORIGINS: 'https://scheduling.example.test',
    STAGING_OAUTH_AUDIENCE: AUDIENCE,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: CLIENT_EMAIL,
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: PEM,
    STAGING_WORKBOOK_ID: 'staging-workbook-id',
    STAGING_WORKBOOK_TIME_ZONE: WORKBOOK_ZONE,
    STAGING_TIME_ZONE: DISPLAY_ZONE,
    STAGING_DISPLAY_INCREMENT_MINUTES: '30',
    STAGING_OPERATING_HOURS_START: '09:00',
    STAGING_OPERATING_HOURS_END: '21:00',
    STAGING_DATA_REVISION: String(DATA_REVISION),
    STAGING_SCHEDULING_INPUT_REVISION: String(INPUT_REVISION),
    STAGING_TAB_REVISIONS: JSON.stringify(Object.fromEntries(WORKBOOK_TABS.map((tab) => [tab.name, 1]))),
    ...overrides
  };
}

// --- Signing material and Google doubles -------------------------------------

let signingKey: CryptoKey;
let publicJwk: JsonWebKey & { kid: string };
let PEM = '';

/** Called once from `beforeAll` in each test file that mints tokens. */
export async function setupSigningKeys(): Promise<void> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair;
  signingKey = pair.privateKey;
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
  publicJwk = { ...exported, kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(binary).replace(/(.{64})/g, '$1\n').trim()}\n-----END PRIVATE KEY-----`;
}

export async function idToken(email: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const signingInput = `${base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT', kid: 'fixture-key' })}.${base64UrlEncodeJson({
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    sub: `subject-${email}`,
    email,
    email_verified: true,
    // Valid across every clock this file uses, including the post-DST run.
    exp: Math.floor(Date.parse('2026-12-01T00:00:00.000Z') / 1000),
    iat: Math.floor(Date.parse('2026-10-01T00:00:00.000Z') / 1000),
    ...overrides
  })}`;
  return `${signingInput}.${await signRs256(signingInput, signingKey)}`;
}

export type SheetsCall = { ranges: string[] };

/** Routes JWKS, the token exchange and Sheets reads, and records what was asked for. */
export function fakeGoogle(rows: Map<string, Row[]> = LOGICAL_ROWS, zone = WORKBOOK_ZONE) {
  const sheetsCalls: SheetsCall[] = [];
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url === GOOGLE_JWKS_URL) return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      expect(String(init?.body)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
      return new Response(JSON.stringify({ access_token: 'sheets-access-token', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.startsWith('https://sheets.googleapis.com/')) {
      const parsed = new URL(url);
      const ranges = parsed.searchParams.getAll('ranges');
      sheetsCalls.push({ ranges });
      expect(parsed.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
      expect(parsed.searchParams.get('dateTimeRenderOption')).toBe('SERIAL_NUMBER');
      const valueRanges = ranges.map((range) => {
        const tab = /^'((?:[^']|'')+)'!/.exec(range)?.[1]?.replaceAll("''", "'") ?? '';
        const rowsForTab = rows.get(tab) ?? [];
        return { range, values: rowsForTab.map((row) => restRow(tab, row, zone)) };
      });
      return new Response(JSON.stringify({ spreadsheetId: 'staging-workbook-id', valueRanges }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchImpl, sheetsCalls, urls };
}

export function serviceWith(fetchImpl: FetchLike, bindings: Record<string, string> = stagingBindings()) {
  return createStagingReadService(bindings, { fetch: fetchImpl, nowMs: () => NOW_MS });
}

export function request(operation: string, credential: string, extra: Record<string, unknown> = {}) {
  return { operation, payload: {}, idempotencyKey: `staging-probe-${operation}`, credential, ...extra };
}

/** The same fixture through the existing synchronous Apps Script runtime. */
export function legacyRuntime(rows: Map<string, Row[]>, zones: { workbookZone?: string; displayZone?: string } = {}) {
  const spreadsheet = new InMemorySpreadsheet(zones.workbookZone ?? WORKBOOK_ZONE);
  for (const tab of WORKBOOK_TABS) {
    const sheet = spreadsheet.getSheetByName(tab.name);
    if (!sheet) throw new Error(`missing ${tab.name}`);
    for (const row of rows.get(tab.name) ?? []) sheet.appendRow(appsScriptRow(tab.name, row, zones.workbookZone ?? WORKBOOK_ZONE));
  }
  const properties = new InMemoryProperties();
  for (const [key, value] of Object.entries(stagingBindings())) {
    if (key.startsWith('STAGING_') && key !== 'STAGING_TAB_REVISIONS') properties.setProperty(key.replace('STAGING_', ''), value);
  }
  properties.setProperty('TIME_ZONE', zones.displayZone ?? DISPLAY_ZONE);
  properties.setProperty('DISPLAY_INCREMENT_MINUTES', '30');
  properties.setProperty('OPERATING_HOURS_START', '09:00');
  properties.setProperty('OPERATING_HOURS_END', '21:00');
  properties.setProperty('DATA_REVISION', String(DATA_REVISION));
  properties.setProperty('SCHEDULING_INPUT_REVISION', String(INPUT_REVISION));
  for (const tab of WORKBOOK_TABS) properties.setProperty(`TAB_REVISION_${tab.name}`, '1');
  return createProductionRuntime(spreadsheet, properties);
}

export function legacyProjection(operation: string, now = CLOCK): unknown {
  const runtime = legacyRuntime(LOGICAL_ROWS);
  const handler = runtime.handlers[operation as keyof typeof runtime.handlers];
  if (!handler) throw new Error(`missing handler ${operation}`);
  return handler({
    actor: {
      claims: { iss: 'https://accounts.google.com', aud: AUDIENCE, sub: 'subject-admin@example.test', email: 'admin@example.test', email_verified: true, exp: 0 },
      user: runtime.users.find((user) => user.email === 'admin@example.test')!,
      email: 'admin@example.test'
    },
    operation: operation as never,
    idempotencyKey: 'legacy-parity',
    now
  }, {});
}
