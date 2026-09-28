import { beforeAll, describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { INTEGRATION_OPERATIONS } from '../server/integration/request-policy.js';
import { differingProjectionFields } from '../server/integration/projection-diff.js';
import { BATCH_READ_PLANS, type BatchReadTab } from '../server/workbook/batch-read.js';
import { tabDefinition } from '../server/workbook/schema.js';
import type { FetchLike } from './google/index.js';
import { createStagingReadService } from './staging.js';
import { createSnapshotBatchReader, createWorkbookSnapshot } from './workbook/snapshot.js';
import {
  AUDIENCE,
  CLOCK,
  DATA_REVISION,
  DISPLAY_ZONE,
  INPUT_REVISION,
  LOGICAL_ROWS,
  NOW_MS,
  OUTPUT_REVISION,
  WORKBOOK_ZONE,
  fakeGoogle,
  fixtureRows,
  idToken,
  legacyProjection,
  legacyRuntime,
  request,
  serviceWith,
  setupSigningKeys,
  stagingBindings,
  type Row
} from './staging-test-support.js';

/**
 * Differential tests for the composed staging slice.
 *
 * The same synthetic workbook is rendered twice: the way Apps Script hands cells
 * to the codecs (Date instances) and the way the Sheets REST API does (serial
 * numbers). The three served operations are then run through both the existing
 * synchronous production runtime and the Worker composition, and the projections
 * must be identical apart from the derivation timestamp. Authorization,
 * revision and workbook-immutability behaviour are asserted separately.
 *
 * The fixtures, codecs, Google doubles and legacy runtime live in
 * `staging-test-support.ts`, shared with the gateway and Durable Object host
 * test suites so all of them exercise the same workbook.
 */

beforeAll(setupSigningKeys);

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
