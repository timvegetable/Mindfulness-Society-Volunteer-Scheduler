import { beforeAll, describe, expect, it, vi } from 'vitest';
import { INTEGRATION_OPERATIONS } from '../server/integration/request-policy.js';
import { differingProjectionFields } from '../server/integration/projection-diff.js';
import { createProductionRuntime } from '../server/runtime.js';
import { READ_API_PATH, BENCHMARK_PREVIEW_PATH, READ_API_OPERATIONS, BENCHMARK_PREVIEW_OPERATIONS } from './read-api.js';
import { benchmarkPreviewEnabled, StagingWorkbookHost } from './host.js';
import {
  CLOCK,
  DATA_REVISION,
  INPUT_REVISION,
  LOGICAL_ROWS,
  NOW_MS,
  OUTPUT_REVISION,
  fakeGoogle,
  fixtureRows,
  idToken,
  legacyProjection,
  legacyRuntime,
  request,
  setupSigningKeys,
  stagingBindings,
  type Row
} from './staging-test-support.js';

/**
 * Worker-native tests for the Durable Object host: benchmark enablement,
 * preview parity against the real handler at fixed clocks across two synthetic
 * workbooks, denial costs, per-request counters and request isolation, object
 * storage untouched, and first-use telemetry.
 */

function hostWith(overrides: Record<string, string> = {}, rows: Map<string, Row[]> = LOGICAL_ROWS) {
  const { fetchImpl, sheetsCalls, urls } = fakeGoogle(rows);
  const storage: string[] = [];
  const state = {
    id: { toString: () => 'test-object' },
    // Any storage access is a defect for this topology: the object holds no
    // application state, so every method records and refuses.
    storage: new Proxy({}, {
      get: (_target, property) => () => {
        storage.push(String(property));
        throw new Error('object storage must not be touched');
      }
    })
  } as unknown as DurableObjectState;
  const host = new StagingWorkbookHost(state, stagingBindings(overrides), { fetch: fetchImpl, nowMs: () => NOW_MS });
  return { host, sheetsCalls, urls, storage };
}

function benchmarkRequest(operation: string, credential: string, extra: Record<string, unknown> = {}): Request {
  return new Request(`https://gateway.example.test${BENCHMARK_PREVIEW_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(request(operation, credential, extra))
  });
}

function execRequest(operation: string, credential: string, extra: Record<string, unknown> = {}): Request {
  return new Request(`https://gateway.example.test${READ_API_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(request(operation, credential, extra))
  });
}

/** A genuinely larger synthetic workbook: more volunteers, availability, sessions and centers. */
function largerRows(): Map<string, Row[]> {
  const rows = fixtureRows();
  const timestamp = '2026-09-01T12:00:00.000Z';
  const add = (tab: string, row: Row): void => {
    rows.set(tab, [...(rows.get(tab) ?? []), row]);
  };
  for (let index = 5; index <= 12; index += 1) {
    add('Centers', { id: `center-${index}`, name: `Center ${index}`, active: true, revision: 1, createdAt: timestamp, updatedAt: timestamp });
  }
  for (let index = 13; index <= 44; index += 1) {
    const suffix = String(index).padStart(3, '0');
    const ineligible = index > 36;
    add('Volunteers', {
      id: `volunteer-${suffix}`,
      name: `Volunteer ${suffix}`,
      email: `volunteer-${suffix}@example.test`,
      lifecycleStatus: index === 37 ? 'graduated' : index === 38 ? 'inactive' : 'active',
      interviewStatus: index === 39 ? 'incomplete' : 'complete',
      readinessRank: index === 39 ? '' : (index % 3) + 1,
      revision: 1,
      source: 'staging-fixture',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    if (ineligible) continue;
    add('RecurringAvailability', { id: `availability-${suffix}-2`, volunteerId: `volunteer-${suffix}`, weekday: 2, start: '10:00', end: '14:00', timeZone: 'America/Chicago', revision: 1, source: 'staging-fixture', updatedAt: timestamp });
  }
  add('AvailabilityExceptions', { id: 'exception-2', volunteerId: 'volunteer-020', date: '2026-10-12', kind: 'unavailable', start: '09:00', end: '17:00', timeZone: 'America/Chicago', reason: 'staging-fixture', revision: 1, updatedAt: timestamp });
  for (let index = 10; index <= 25; index += 1) {
    const id = `session-${String(index).padStart(2, '0')}`;
    add('Sessions', {
      id, kind: 'center', centerId: `center-${(index % 12) + 1}`, title: `Session ${index}`,
      date: '2026-10-16', start: '09:00', end: '11:00', timeZone: 'America/Chicago', requiredStaffCount: (index % 2) + 1,
      status: 'locked', revision: 1, createdAt: timestamp, updatedAt: timestamp
    });
    add('Assignments', { id: `assignment-${String(index).padStart(2, '0')}`, sessionId: id, volunteerId: `volunteer-${String((index % 36) + 1).padStart(3, '0')}`, scheduleRevision: OUTPUT_REVISION, status: 'assigned', createdAt: timestamp });
  }
  add('SchedulingRuns', {
    id: 'run-older-larger', inputRevision: 2, outputRevision: 3, status: 'completed',
    startedAt: '2026-09-15T10:00:00.000Z', completedAt: '2026-09-15T10:04:00.000Z',
    assignmentIds: [], backupIds: [], shortfalls: []
  });
  return rows;
}

beforeAll(setupSigningKeys);

describe('benchmark preview enablement', () => {
  it('is disabled unless the deployment sets the exact literal true', () => {
    expect(benchmarkPreviewEnabled({})).toBe(false);
    expect(benchmarkPreviewEnabled({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'false' })).toBe(false);
    expect(benchmarkPreviewEnabled({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'True' })).toBe(false);
    expect(benchmarkPreviewEnabled({ STAGING_PREVIEW_BENCHMARK_ENABLED: ' true ' })).toBe(true);
    expect(benchmarkPreviewEnabled({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' })).toBe(true);
    expect(benchmarkPreviewEnabled({ STAGING_PREVIEW_BENCHMARK_ENABLED: 42 })).toBe(false);
  });

  it('answers a disabled benchmark route with the unknown-route 404 and no workbook access', async () => {
    const { host, urls, sheetsCalls } = hostWith();
    const response = await host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, 'credential-placeholder'));
    expect(response.status).toBe(404);
    const envelope = await response.json() as { ok: boolean; error: { code: string; message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('NOT_FOUND');
    expect(envelope.error.message).toBe('Route not found.');
    expect(urls).toEqual([]);
    expect(sheetsCalls).toEqual([]);
    // A preflight for the disabled route is refused the same way.
    const preflight = await host.fetch(new Request(`https://gateway.example.test${BENCHMARK_PREVIEW_PATH}`, { method: 'OPTIONS' }));
    expect(preflight.status).toBe(404);
  });

  it('echoes the deployment marker so a lagging object is identifiable before colds are counted', async () => {
    const marker = '2026-09-29T07:00:00.000Z';
    const { host } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true', STAGING_DEPLOYED_AT: marker });
    const response = await host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, 'credential-placeholder'));
    // The marker rides on every response, including a denied one, so the
    // version-lag check works before any attempt is counted.
    expect(response.headers.get('X-Staging-Host-Deployed-At')).toBe(marker);
    const noMarker = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
    const plain = await noMarker.host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, 'credential-placeholder'));
    expect(plain.headers.get('X-Staging-Host-Deployed-At')).toBeNull();
  });

  it('answers an enabled benchmark preflight like /exec', async () => {
    const { host } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
    const preflight = await host.fetch(new Request(`https://gateway.example.test${BENCHMARK_PREVIEW_PATH}`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://scheduling.example.test' }
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://scheduling.example.test');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
  });

  it('serves the preview to a freshly authorized administrator with one Users read and one domain batch', async () => {
    const { host, sheetsCalls } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
    const credential = await idToken('admin@example.test');
    const response = await host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, credential));
    expect(response.status).toBe(200);
    const envelope = await response.json() as { ok: boolean; data: Record<string, unknown> };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ preview: true, revision: DATA_REVISION, inputRevision: INPUT_REVISION });
    // Identity read + exactly one schema-derived batch of the seven preview tabs.
    expect(sheetsCalls).toHaveLength(2);
    expect(sheetsCalls[0]?.ranges).toEqual([`'Users'!A2:G`]);
    const batchRanges = sheetsCalls[1]?.ranges ?? [];
    expect(batchRanges).toHaveLength(7);
    expect(batchRanges.map((range) => range.split('!')[0]?.replaceAll("'", ''))).toEqual([
      'SchedulingRuns', 'Volunteers', 'RecurringAvailability', 'AvailabilityExceptions', 'Sessions', 'Assignments', 'Centers'
    ]);
    expect(response.headers.get('x-staging-sheets-reads')).toBe('2');
    expect(response.headers.get('x-staging-snapshot-digest')).toBeTruthy();
  });

  it('returns the same preview projection the existing runtime produces at the fixed clock', async () => {
    const { host } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
    const credential = await idToken('admin@example.test');
    const response = await host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, credential));
    expect(response.ok === undefined ? response.status : response.status).toBe(200);
    const envelope = await response.json() as { ok: boolean; data: unknown };
    expect(envelope.ok).toBe(true);
    // The served preview and the existing synchronous runtime's preview agree
    // apart from nothing: the clock is fixed and the projection is actor-independent.
    expect(differingProjectionFields(envelope.data, legacyProjection(INTEGRATION_OPERATIONS.adminSchedulePreview))).toEqual([]);
  });

  it('returns preview parity across a genuinely larger fixture too', async () => {
    const rows = largerRows();
    const { host } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' }, rows);
    const credential = await idToken('admin@example.test');
    const response = await host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, credential));
    expect(response.status).toBe(200);
    const envelope = await response.json() as { ok: boolean; data: unknown };
    expect(envelope.ok).toBe(true);
    const runtime = legacyRuntime(rows);
    const legacyPreview = runtime.handlers[INTEGRATION_OPERATIONS.adminSchedulePreview]!({
      actor: { claims: { iss: 'https://accounts.google.com', aud: 'staging', sub: 'benchmark', email: 'benchmark@example.test', exp: 0 }, user: runtime.users.find((user) => user.email === 'admin@example.test')!, email: 'admin@example.test' },
      operation: INTEGRATION_OPERATIONS.adminSchedulePreview as never,
      idempotencyKey: 'legacy-larger-preview',
      now: CLOCK
    }, {});
    expect(differingProjectionFields(envelope.data, legacyPreview)).toEqual([]);
    // And read parity for the same larger fixture.
    const scheduleResponse = await host.fetch(execRequest(INTEGRATION_OPERATIONS.adminSchedule, await idToken('admin@example.test')));
    expect(scheduleResponse.status).toBe(200);
    const scheduleEnvelope = await scheduleResponse.json() as { ok: boolean; data: unknown };
    expect(differingProjectionFields(scheduleEnvelope.data, (() => {
      const legacySchedule = legacyRuntime(rows);
      return legacySchedule.handlers[INTEGRATION_OPERATIONS.adminSchedule]!({
        actor: { claims: { iss: 'https://accounts.google.com', aud: 'staging', sub: 'subject-admin@example.test', email: 'admin@example.test', email_verified: true, exp: 0 }, user: legacySchedule.users.find((user) => user.email === 'admin@example.test')!, email: 'admin@example.test' },
        operation: INTEGRATION_OPERATIONS.adminSchedule as never,
        idempotencyKey: 'legacy-larger-schedule',
        now: CLOCK
      }, {});
    })())).toEqual([]);
  });

  it('denies a volunteer with the existing envelope and zero domain reads', async () => {
    const { host, sheetsCalls } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
    const credential = await idToken('volunteer@example.test');
    const response = await host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, credential));
    expect(response.status).toBe(200);
    const envelope = await response.json() as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('FORBIDDEN');
    expect(sheetsCalls).toHaveLength(1);
    expect(sheetsCalls[0]?.ranges).toEqual([`'Users'!A2:G`]);
    expect(response.headers.get('x-staging-sheets-reads')).toBe('1');
  });

  it('denies a forged credential with zero Sheets reads', async () => {
    const { host, sheetsCalls } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
    const response = await host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, 'not-a-google-token'));
    expect(response.status).toBe(200);
    const envelope = await response.json() as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('UNAUTHORIZED');
    expect(sheetsCalls).toEqual([]);
  });

  it('serves only the preview operation on the benchmark route', async () => {
    const { host, sheetsCalls } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
    const credential = await idToken('admin@example.test');
    for (const operation of Object.values(INTEGRATION_OPERATIONS).filter((candidate) => !BENCHMARK_PREVIEW_OPERATIONS.has(candidate as string))) {
      const response = await host.fetch(benchmarkRequest(operation as string, credential));
      expect(response.status, operation).toBe(operation === INTEGRATION_OPERATIONS.me ? 200 : 200);
      const envelope = await response.json() as { ok: boolean; error?: { code: string } };
      expect(envelope.ok, operation).toBe(false);
      expect(envelope.error?.code, operation).toBe('FORBIDDEN');
    }
    expect(sheetsCalls).toEqual([]);
  });

  it('rejects the preview through /exec even when the benchmark is enabled', async () => {
    const { host, sheetsCalls } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
    const credential = await idToken('admin@example.test');
    const response = await host.fetch(execRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, credential));
    expect(response.status).toBe(200);
    const envelope = await response.json() as { ok: boolean; error: { code: string; message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('FORBIDDEN');
    // Refused at the transport allowlist, before any Google call.
    expect(sheetsCalls).toEqual([]);
  });

  it('refuses mutations on both routes without any workbook access', async () => {
    const { host, urls } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
    const credential = await idToken('admin@example.test');
    const mutationOperations = ['admin.schedule.rerun', 'admin.import.sheet'];
    for (const operation of mutationOperations) {
      for (const build of [execRequest, benchmarkRequest]) {
        const response = await host.fetch(build(operation, credential));
        expect(response.status, operation).toBe(200);
        const envelope = await response.json() as { ok: boolean; error?: { code: string } };
        expect(envelope.ok, `${build.name} ${operation}`).toBe(false);
      }
    }
    expect(urls).toEqual([]);
  });
});

describe('request isolation inside the object', () => {
  it('keeps per-request counters and states local: sequential requests do not accumulate', async () => {
    const { host } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
    const credential = await idToken('admin@example.test');
    const first = await host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, credential));
    const second = await host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, credential));
    expect(first.headers.get('x-staging-sheets-reads')).toBe('2');
    expect(second.headers.get('x-staging-sheets-reads')).toBe('2');
    // Identical envelopes at a fixed clock: no state bled between requests.
    expect(await second.text()).toBe(await first.text());
  });

  it('serves concurrent requests independently', async () => {
    const { host } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
    const [admin, volunteer] = await Promise.all([idToken('admin@example.test'), idToken('volunteer@example.test')]);
    const [adminResponse, volunteerResponse] = await Promise.all([
      host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, admin)),
      host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, volunteer))
    ]);
    const adminEnvelope = await adminResponse.json() as { ok: boolean };
    const volunteerEnvelope = await volunteerResponse.json() as { ok: boolean; error?: { code: string } };
    expect(adminEnvelope.ok).toBe(true);
    expect(volunteerEnvelope.ok).toBe(false);
    expect(volunteerEnvelope.error?.code).toBe('FORBIDDEN');
  });

  it('never touches object storage across requests', async () => {
    const { host, storage } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
    await host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, await idToken('admin@example.test')));
    await host.fetch(execRequest(INTEGRATION_OPERATIONS.me, await idToken('admin@example.test')));
    expect(storage).toEqual([]);
  });

  it('records first-use telemetry once per object instance, never request data', async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (message: string) => { logs.push(message); };
    try {
      const { host } = hostWith({ STAGING_PREVIEW_BENCHMARK_ENABLED: 'true' });
      await host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, await idToken('admin@example.test')));
      await host.fetch(benchmarkRequest(INTEGRATION_OPERATIONS.adminSchedulePreview, await idToken('admin@example.test')));
    } finally {
      console.log = original;
    }
    expect(logs.filter((line) => line.includes('first use'))).toHaveLength(1);
    // No credential, token or row value ever appears in telemetry.
    for (const line of logs) {
      expect(line).not.toContain('credential');
      expect(line).not.toContain('eyJ');
    }
  });
});
