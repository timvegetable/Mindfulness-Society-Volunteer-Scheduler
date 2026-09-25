import { beforeAll, describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { INTEGRATION_OPERATIONS } from '../server/integration/request-policy.js';
import { differingProjectionFields } from '../server/integration/projection-diff.js';
import { createProductionRuntime } from '../server/runtime.js';
import { BATCH_READ_PLANS, type BatchReadTab } from '../server/workbook/batch-read.js';
import { InMemoryProperties, InMemorySpreadsheet } from '../server/workbook/in-memory-sheet.js';
import { WORKBOOK_TABS, tabDefinition } from '../server/workbook/schema.js';
import { GOOGLE_JWKS_URL, GOOGLE_TOKEN_ENDPOINT, base64UrlEncodeJson, signRs256, type FetchLike } from './google/index.js';
import { createStagingReadService } from './staging.js';
import { createSnapshotBatchReader, createWorkbookSnapshot } from './workbook/snapshot.js';

/**
 * Differential tests for the composed staging slice.
 *
 * The same synthetic workbook is rendered twice: the way Apps Script hands cells
 * to the codecs (Date instances) and the way the Sheets REST API does (serial
 * numbers). The three served operations are then run through both the existing
 * synchronous production runtime and the Worker composition, and the projections
 * must be identical apart from the derivation timestamp. Authorization,
 * revision and workbook-immutability behaviour are asserted separately.
 */

const WORKBOOK_ZONE = 'America/New_York';
const DISPLAY_ZONE = 'America/Chicago';
const CLOCK = '2026-10-05T12:00:00.000Z';
const NOW_MS = Date.parse(CLOCK);
const AUDIENCE = 'staging-client.apps.googleusercontent.com';
const CLIENT_EMAIL = 'staging-reader@example-project.iam.gserviceaccount.com';
const SHEETS_EPOCH = Temporal.PlainDate.from('1899-12-30');
const DATA_REVISION = 42;
const INPUT_REVISION = 5;
const OUTPUT_REVISION = 7;

type Row = Record<string, unknown>;

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
  const cells = tabDefinition(tab).columns.map((column) => {
    const value = row[column];
    // A blank cell is a blank cell, whatever its column type: rendering '' as a
    // date serial would be a fixture bug, not Sheets behaviour.
    if (value === undefined || value === null || value === '') return '';
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

function fixtureRows(): Map<string, Row[]> {
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

const LOGICAL_ROWS = fixtureRows();

function stagingBindings(overrides: Record<string, string> = {}): Record<string, string> {
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

beforeAll(async () => {
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
});

async function idToken(email: string, overrides: Record<string, unknown> = {}): Promise<string> {
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

type SheetsCall = { ranges: string[] };

/** Routes JWKS, the token exchange and Sheets reads, and records what was asked for. */
function fakeGoogle(rows: Map<string, Row[]> = LOGICAL_ROWS, zone = WORKBOOK_ZONE) {
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

function serviceWith(fetchImpl: FetchLike, bindings: Record<string, string> = stagingBindings()) {
  return createStagingReadService(bindings, { fetch: fetchImpl, nowMs: () => NOW_MS });
}

function request(operation: string, credential: string, extra: Record<string, unknown> = {}) {
  return { operation, payload: {}, idempotencyKey: `staging-probe-${operation}`, credential, ...extra };
}

/** The same fixture through the existing synchronous Apps Script runtime. */
function legacyRuntime(rows: Map<string, Row[]>, zones: { workbookZone?: string; displayZone?: string } = {}) {
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

function legacyProjection(operation: string, now = CLOCK): unknown {
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

// --- Tests -------------------------------------------------------------------

describe('staging workbook reads', () => {
  it('reads the authorization table fresh and decodes it through the production Users codec', async () => {
    const { fetchImpl, sheetsCalls } = fakeGoogle();
    const service = serviceWith(fetchImpl);
    const response = await service.handle(request(INTEGRATION_OPERATIONS.me, await idToken('admin@example.test')));
    expect(response.ok).toBe(true);
    expect(sheetsCalls).toHaveLength(1);
    expect(sheetsCalls[0]?.ranges).toEqual([`'Users'!A2:G`]);
  });

  it('requests exactly the plan ranges for each served operation', async () => {
    const schedule = fakeGoogle();
    await serviceWith(schedule.fetchImpl).handle(request(INTEGRATION_OPERATIONS.adminSchedule, await idToken('admin@example.test')));
    expect(schedule.sheetsCalls).toHaveLength(2);
    expect(schedule.sheetsCalls[0]?.ranges).toEqual([`'Users'!A2:G`]);
    expect(schedule.sheetsCalls[1]?.ranges).toHaveLength(BATCH_READ_PLANS.publishedSchedule.length);

    const insights = fakeGoogle();
    await serviceWith(insights.fetchImpl).handle(request(INTEGRATION_OPERATIONS.adminInsights, await idToken('admin@example.test')));
    expect(insights.sheetsCalls).toHaveLength(2);
    expect(insights.sheetsCalls[1]?.ranges).toHaveLength(BATCH_READ_PLANS.insightCacheMiss.length);
  });

  it('treats a Sheets failure as an unavailable dependency, never as success', async () => {
    for (const fetchImpl of [
      (async () => { throw new Error('network down'); }) as FetchLike,
      (async (input: string) => String(input).startsWith('https://sheets.googleapis.com/')
        ? new Response('{"error":"boom"}', { status: 500 })
        : fakeGoogle().fetchImpl(input)) as FetchLike,
      (async (input: string) => String(input).startsWith('https://sheets.googleapis.com/')
        ? new Response(JSON.stringify({ spreadsheetId: 'someone-else', valueRanges: [] }), { status: 200 })
        : fakeGoogle().fetchImpl(input)) as FetchLike
    ]) {
      const response = await serviceWith(fetchImpl).handle(request(INTEGRATION_OPERATIONS.adminSchedule, await idToken('admin@example.test')));
      expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
      expect(JSON.stringify(response)).not.toContain('boom');
    }
  });
});

describe('operation parity with the Apps Script runtime', () => {
  it('returns the same published schedule projection', async () => {
    const { fetchImpl } = fakeGoogle();
    const response = await serviceWith(fetchImpl).handle(request(INTEGRATION_OPERATIONS.adminSchedule, await idToken('admin@example.test')));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(differingProjectionFields(response.data, legacyProjection(INTEGRATION_OPERATIONS.adminSchedule))).toEqual([]);
    // The pinned invariants from the experiment contract.
    expect(response.data).toMatchObject({
      revision: DATA_REVISION,
      inputRevision: INPUT_REVISION,
      scheduleRevision: OUTPUT_REVISION,
      outputRevision: OUTPUT_REVISION,
      preview: false,
      stale: false
    });
    const summary = (response.data as { summary: { assignmentCount: number; shortfallCount: number } }).summary;
    expect(summary.assignmentCount).toBe(9);
    expect(summary.shortfallCount).toBeGreaterThan(0);
  });

  it('returns the same Insights projection', async () => {
    const { fetchImpl } = fakeGoogle();
    const response = await serviceWith(fetchImpl).handle(request(INTEGRATION_OPERATIONS.adminInsights, await idToken('admin@example.test')));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(differingProjectionFields(response.data, legacyProjection(INTEGRATION_OPERATIONS.adminInsights), ['generatedAt'])).toEqual([]);
    // The projection is non-trivial: covered slots for the eight eligible
    // volunteers, and a leftover population that excludes them.
    const projection = response.data as { cells: Array<{ volunteerIds: string[] }>; leftoverVolunteers: unknown[] };

    expect(projection.cells.length).toBeGreaterThan(0);
    expect(projection.cells.every((cell) => cell.volunteerIds.length > 0)).toBe(true);
    expect(projection.leftoverVolunteers).toHaveLength(3);
  });

  it('returns the same identity projection as the legacy runtime for every role that may call session.me', async () => {
    const expected: Array<[string, string, Record<string, unknown>]> = [
      ['admin@example.test', 'administrator', {}],
      ['volunteer@example.test', 'volunteer', { volunteerId: 'volunteer-001' }],
      // The primary role is administrator, so the projection carries no centerId.
      ['multi@example.test', 'administrator', { volunteerId: 'volunteer-002' }],
      ['contact@example.test', 'center-contact', { centerId: 'center-2' }]
    ];
    for (const [email, role, extra] of expected) {
      const { fetchImpl } = fakeGoogle();
      const response = await serviceWith(fetchImpl).handle(request(INTEGRATION_OPERATIONS.me, await idToken(email)));
      expect(response.ok, email).toBe(true);
      if (!response.ok) continue;
      expect(response.data).toMatchObject({ email, role, ...extra });
      // The whole projection, not just the fields asserted above.
      const legacy = legacyRuntime(LOGICAL_ROWS);
      const legacyProjection = legacy.handlers[INTEGRATION_OPERATIONS.me]!({
        actor: { claims: { iss: 'https://accounts.google.com', aud: AUDIENCE, sub: `subject-${email}`, email, email_verified: true, exp: 0 }, user: legacy.users.find((user) => user.email === email)!, email },
        operation: INTEGRATION_OPERATIONS.me as never,
        idempotencyKey: 'legacy-identity',
        now: CLOCK
      }, {});
      expect(differingProjectionFields(response.data, legacyProjection), email).toEqual([]);
    }
  });

  it('produces identical results on a second identical request and leaves the snapshot unchanged', async () => {
    const { fetchImpl } = fakeGoogle();
    const service = serviceWith(fetchImpl);
    const token = await idToken('admin@example.test');
    const first = await service.handle(request(INTEGRATION_OPERATIONS.adminSchedule, token));
    const second = await service.handle(request(INTEGRATION_OPERATIONS.adminSchedule, token));
    expect(second).toEqual(first);
    expect(service.stats()).toMatchObject({ requests: 2, denied: 0, sheetsReads: 4 });
  });

  it('decodes a session on the DST transition date and agrees with the legacy runtime after it', async () => {
    // Ahead of the transition the session is still scheduled, and its ambiguous
    // 01:30 local time must decode to exactly what the coordinator entered.
    const { fetchImpl } = fakeGoogle();
    const response = await serviceWith(fetchImpl).handle(request(INTEGRATION_OPERATIONS.adminSchedule, await idToken('admin@example.test')));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const sessions = (response.data as { sessions: Array<{ id: string; date: string; start: string }> }).sessions;
    expect(sessions.find((session) => session.id === 'session-09')).toMatchObject({
      date: '2026-11-01',
      start: '01:30',
      // The ambiguous local hour resolves to the earlier (EDT) instant, which is
      // what the shared decoder's compatible disambiguation produces.
      createdAt: '2026-11-01T05:30:00.000Z'
    });

    // After the transition every fixture session is behind the cutoff, and both
    // runtimes must agree on that empty projection.
    const postTransition = '2026-11-03T12:00:00.000Z';
    const later = createStagingReadService(stagingBindings(), { fetch: fakeGoogle().fetchImpl, nowMs: () => Date.parse(postTransition) });
    const laterResponse = await later.handle(request(INTEGRATION_OPERATIONS.adminSchedule, await idToken('admin@example.test')));
    expect(laterResponse.ok).toBe(true);
    if (!laterResponse.ok) return;
    expect((laterResponse.data as { sessions: unknown[] }).sessions).toEqual([]);
    expect(differingProjectionFields(laterResponse.data, legacyProjection(INTEGRATION_OPERATIONS.adminSchedule, postTransition))).toEqual([]);
  });

  it('matches the legacy runtime when a row is malformed and when a session kind is unknown', async () => {
    const rows = new Map(LOGICAL_ROWS);
    rows.set('Volunteers', (rows.get('Volunteers') ?? []).map((row) => row.id === 'volunteer-007' ? { ...row, revision: 'not-a-number' } : row));
    // A session revision is part of the served projection, so the coercion is
    // observable rather than merely decoded.
    rows.set('Sessions', (rows.get('Sessions') ?? []).map((row) => row.id === 'session-02' ? { ...row, revision: 'not-a-number' } : row));
    rows.set('Sessions', [...(rows.get('Sessions') ?? []), {
      id: 'session-unknown', kind: 'mystery', centerId: 'center-1', title: 'Unknown kind',
      date: '2026-10-20', start: '10:00', end: '11:00', timeZone: DISPLAY_ZONE,
      requiredStaffCount: 1, status: 'locked', revision: 1, createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z'
    }]);
    const { fetchImpl } = fakeGoogle(rows);
    const response = await serviceWith(fetchImpl).handle(request(INTEGRATION_OPERATIONS.adminSchedule, await idToken('admin@example.test')));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    // A non-numeric revision is coerced to 0 and the row is retained; an unknown
    // kind survives decoding but is never schedulable.
    const projected = (response.data as { sessions: Array<{ id: string; revision: number }> }).sessions;
    const ids = projected.map((session) => session.id);
    expect(ids).not.toContain('session-unknown');
    // A non-numeric revision is coerced to 0 and the row is retained.
    expect(projected.find((session) => session.id === 'session-02')?.revision).toBe(0);
    expect(ids).toContain('session-02');
    const legacy = legacyRuntime(rows);
    const legacyProjection = legacy.handlers[INTEGRATION_OPERATIONS.adminSchedule]!({
      actor: { claims: { iss: 'https://accounts.google.com', aud: AUDIENCE, sub: 'subject-admin@example.test', email: 'admin@example.test', email_verified: true, exp: 0 }, user: legacy.users.find((user) => user.email === 'admin@example.test')!, email: 'admin@example.test' },
      operation: INTEGRATION_OPERATIONS.adminSchedule as never,
      idempotencyKey: 'legacy-malformed',
      now: CLOCK
    }, {});
    expect(differingProjectionFields(response.data, legacyProjection)).toEqual([]);
  });

  it('decodes cells in the workbook zone even when the scheduling zone differs', async () => {
    // Workbook in Chicago, scheduling in New York: a decoder that ignored the
    // workbook zone would shift every decoded date and clock by an hour.
    const bindings = stagingBindings({ STAGING_WORKBOOK_TIME_ZONE: 'America/Chicago', STAGING_TIME_ZONE: 'America/New_York' });
    const { fetchImpl } = fakeGoogle(LOGICAL_ROWS, 'America/Chicago');
    const response = await createStagingReadService(bindings, { fetch: fetchImpl, nowMs: () => NOW_MS })
      .handle(request(INTEGRATION_OPERATIONS.adminSchedule, await idToken('admin@example.test')));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const sessions = (response.data as { sessions: Array<{ id: string; date: string; start: string; timeZone: string }> }).sessions;
    const first = sessions.find((session) => session.id === 'session-01');
    // The cell was entered as 2026-10-05 12:00 in the scheduling zone; decoding
    // it in the workbook zone keeps the wall clock the coordinator typed.
    expect(first).toMatchObject({ date: '2026-10-05', start: '12:00' });
    const legacy = legacyRuntime(LOGICAL_ROWS, { workbookZone: 'America/Chicago', displayZone: 'America/New_York' });
    const legacySchedule = legacy.handlers[INTEGRATION_OPERATIONS.adminSchedule]!({
      actor: { claims: { iss: 'https://accounts.google.com', aud: AUDIENCE, sub: 'subject-admin@example.test', email: 'admin@example.test', email_verified: true, exp: 0 }, user: legacy.users.find((user) => user.email === 'admin@example.test')!, email: 'admin@example.test' },
      operation: INTEGRATION_OPERATIONS.adminSchedule as never,
      idempotencyKey: 'legacy-zone',
      now: CLOCK
    }, {});
    expect(differingProjectionFields(response.data, legacySchedule)).toEqual([]);
  });

  it('serves an empty workbook without inventing rows', async () => {
    const empty = new Map<string, Row[]>([['Users', LOGICAL_ROWS.get('Users') ?? []]]);
    const { fetchImpl } = fakeGoogle(empty);
    const response = await serviceWith(fetchImpl).handle(request(INTEGRATION_OPERATIONS.adminSchedule, await idToken('admin@example.test')));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data).toMatchObject({ sessions: [], scheduleRevision: null, outputRevision: 0, runStatus: 'none' });
  });
});

describe('staging authorization', () => {
  const denied = [
    ['an account with no Users row', 'outsider@example.test', 'UNAUTHORIZED'],
    ['an inactive row', 'inactive@example.test', 'UNAUTHORIZED'],
    ['a blank active cell, which decodes inactive', 'blank-active@example.test', 'UNAUTHORIZED'],
    ['a volunteer calling an administrator operation', 'volunteer@example.test', 'FORBIDDEN'],
    ['a center contact calling an administrator operation', 'contact@example.test', 'FORBIDDEN']
  ] as const;

  it('denies every unauthorized caller without reading a domain range', async () => {
    for (const [label, email, code] of denied) {
      const { fetchImpl, sheetsCalls } = fakeGoogle();
      const response = await serviceWith(fetchImpl).handle(request(INTEGRATION_OPERATIONS.adminSchedule, await idToken(email)));
      expect(response, label).toMatchObject({ ok: false, error: { code } });
      // Only the authorization table was read.
      expect(sheetsCalls, label).toHaveLength(1);
      expect(sheetsCalls[0]?.ranges, label).toEqual([`'Users'!A2:G`]);
    }
  });

  it('re-reads Users on every request, so revoking a row denies the next request despite warm caches', async () => {
    const rows = new Map(LOGICAL_ROWS);
    const { fetchImpl } = fakeGoogle(rows);
    const service = serviceWith(fetchImpl);
    const token = await idToken('admin@example.test');
    expect((await service.handle(request(INTEGRATION_OPERATIONS.adminSchedule, token))).ok).toBe(true);
    // Revoke the row in the workbook, not in a cache.
    rows.set('Users', (rows.get('Users') ?? []).map((row) => row.email === 'admin@example.test' ? { ...row, active: false } : row));
    expect(await service.handle(request(INTEGRATION_OPERATIONS.adminSchedule, token))).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('refuses every operation outside the three served ones before any Google call', async () => {
    const { fetchImpl, urls } = fakeGoogle();
    const service = serviceWith(fetchImpl);
    const outside = Object.values(INTEGRATION_OPERATIONS).filter((operation) => ![INTEGRATION_OPERATIONS.me, INTEGRATION_OPERATIONS.adminSchedule, INTEGRATION_OPERATIONS.adminInsights].includes(operation as never));
    expect(outside).toHaveLength(13);
    for (const operation of outside) {
      const response = await service.handle(request(operation, await idToken('admin@example.test')));
      expect(response, operation).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    expect(urls).toEqual([]);
  });

  it('honours expectedRevision and reports a stale one', async () => {
    const { fetchImpl } = fakeGoogle();
    const service = serviceWith(fetchImpl);
    const token = await idToken('admin@example.test');
    expect(await service.handle(request(INTEGRATION_OPERATIONS.adminSchedule, token, { expectedRevision: DATA_REVISION }))).toMatchObject({ ok: true });
    expect(await service.handle(request(INTEGRATION_OPERATIONS.adminSchedule, token, { expectedRevision: DATA_REVISION + 1 })))
      .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
  });

  it('treats the staging properties facade as immutable', async () => {
    const { workbookConfiguration } = await import('./config.js');
    const properties = workbookConfiguration(stagingBindings()).properties;
    expect(properties.getProperty('DATA_REVISION')).toBe(String(DATA_REVISION));
    expect(properties.getProperty('WRITE_ENABLED')).toBe('false');
    expect(properties.getProperty('TAB_REVISION_Volunteers')).toBe('1');
    expect(properties.getProperty('NOT_CONFIGURED')).toBeNull();
    expect(() => properties.setProperty('DATA_REVISION', '99')).toThrow(/immutable/);
  });

  it('fails closed when workbook configuration is absent, without reading the workbook', async () => {
    const { fetchImpl, sheetsCalls } = fakeGoogle();
    const bindings = stagingBindings();
    delete bindings.STAGING_WORKBOOK_ID;
    const response = await serviceWith(fetchImpl, bindings).handle(request(INTEGRATION_OPERATIONS.adminSchedule, await idToken('admin@example.test')));
    expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(sheetsCalls).toEqual([]);
  });
});

describe('staging snapshot primitives', () => {
  it('treats an unfetched tab as absent and refuses every write', () => {
    const snapshot = createWorkbookSnapshot(WORKBOOK_ZONE);
    expect(snapshot.spreadsheet.getSheetByName('Volunteers')).toBeNull();
    snapshot.setTab('Volunteers', [['volunteer-001']]);
    const sheet = snapshot.spreadsheet.getSheetByName('Volunteers');
    expect(sheet).not.toBeNull();
    // Row 1 is the header, so one data row means two rows in the sheet.
    expect(sheet?.getLastRow()).toBe(2);
    expect(sheet?.getLastColumn()).toBe(tabDefinition('Volunteers').columns.length);
    expect(() => sheet?.appendRow([])).toThrow(/read-only/);
    expect(() => sheet?.getRange(1, 1).setValues([[]])).toThrow(/read-only/);
    expect(() => sheet?.getRange(1, 1).setValue('x')).toThrow(/read-only/);
    expect(() => sheet?.getRange(1, 1).protect()).toThrow(/read-only/);
    expect(() => sheet?.getRange(1, 1).clearContent?.()).toThrow(/read-only/);
    expect(() => snapshot.spreadsheet.insertSheet('x')).toThrow(/read-only/);
    expect(() => createSnapshotBatchReader(new Map()).read('publishedSchedule')).toThrow(/missing/);
    expect(snapshot.spreadsheet.getSpreadsheetTimeZone?.()).toBe(WORKBOOK_ZONE);
  });

  it('digests the snapshot stably and changes it when a tab changes', async () => {
    const snapshot = createWorkbookSnapshot(WORKBOOK_ZONE);
    snapshot.setTab('Volunteers', [['a']]);
    const first = await snapshot.digest();
    expect(await snapshot.digest()).toBe(first);
    snapshot.setTab('Volunteers', [['b']]);
    expect(await snapshot.digest()).not.toBe(first);
  });
});
