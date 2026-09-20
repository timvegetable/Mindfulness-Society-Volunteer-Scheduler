import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { INTEGRATION_OPERATIONS, IntegrationError, type HandlerContext, type IntegrationOperation } from './integration/dispatcher.js';
import { createProductionRuntime, repositories, runtimeConfiguration } from './runtime.js';
import { InMemoryProperties, InMemorySpreadsheet } from './workbook/in-memory-sheet.js';

const actor = {
  claims: { iss: 'https://accounts.google.com', aud: 'client', sub: 'sub-1', email: 'admin@example.test', email_verified: true, exp: 0 },
  email: 'admin@example.test',
  user: { id: 'admin@example.test', email: 'admin@example.test', roles: ['administrator'] as const, active: true, revision: 0 }
};

describe('production Apps Script runtime', () => {
  it('resolves the deployed scheduling policy when Script Properties are absent', () => {
    expect(runtimeConfiguration(new InMemoryProperties())).toEqual({
      timeZone: 'America/New_York',
      incrementMinutes: 30,
      operatingHours: { start: '09:00', end: '21:00' }
    });
    const properties = new InMemoryProperties();
    properties.setProperty('TIME_ZONE', 'America/Chicago');
    properties.setProperty('DISPLAY_INCREMENT_MINUTES', '15');
    properties.setProperty('OPERATING_HOURS_START', '08:30');
    properties.setProperty('OPERATING_HOURS_END', '20:00');
    expect(runtimeConfiguration(properties)).toEqual({
      timeZone: 'America/Chicago',
      incrementMinutes: 15,
      operatingHours: { start: '08:30', end: '20:00' }
    });
  });

  // Evening availability only appears when the configured operating hours reach
  // it; the previous 09:00-17:00 fallback silently dropped every 18:00 interval.
  it('uses the configured operating hours for insight availability windows', () => {
    const spreadsheet = new InMemorySpreadsheet();
    const properties = new InMemoryProperties();
    properties.setProperty('TIME_ZONE', 'America/New_York');
    properties.setProperty('DISPLAY_INCREMENT_MINUTES', '30');
    properties.setProperty('OPERATING_HOURS_START', '09:00');
    properties.setProperty('OPERATING_HOURS_END', '21:00');
    spreadsheet.getSheetByName('Volunteers')?.appendRow(['vol-1', 'Example Volunteer', 'volunteer@example.test', 'active', 'complete', 1, 0, 'roster', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z']);
    spreadsheet.getSheetByName('RecurringAvailability')?.appendRow(['availability-1', 'vol-1', 1, '18:00', '20:00', 'America/New_York', 0, 'whenisgood', '2026-09-18T00:00:00.000Z']);

    const runtime = createProductionRuntime(spreadsheet, properties);
    const context: HandlerContext = { actor: actor as unknown as HandlerContext['actor'], operation: INTEGRATION_OPERATIONS.adminInsights, idempotencyKey: 'insight-window', now: '2026-09-19T00:00:00.000Z' };
    const insights = runtime.handlers[INTEGRATION_OPERATIONS.adminInsights]?.(context, {}) as { cells: unknown[] };
    expect(insights.cells).toEqual([
      { weekday: 1, start: '18:00', end: '20:00', timeZone: 'America/New_York', count: 1, volunteerIds: ['vol-1'], volunteerNames: ['Example Volunteer'] }
    ]);
  });

  // Recurring availability lives in its own tab; scheduling, insights, and
  // coverage only see it once the request groups those rows onto the roster.
  function seededAvailabilitySpreadsheet(): InMemorySpreadsheet {
    const spreadsheet = new InMemorySpreadsheet();
    spreadsheet.getSheetByName('Volunteers')?.appendRow(['vol-1', 'Example Volunteer', 'volunteer@example.test', 'active', 'complete', 1, 0, 'roster', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
    spreadsheet.getSheetByName('RecurringAvailability')?.appendRow(['availability-1', 'vol-1', 1, '09:00', '20:00', 'America/New_York', 0, 'whenisgood', '2026-09-01T00:00:00.000Z']);
    return spreadsheet;
  }

  it('schedules from the authoritative recurring availability tab', () => {
    const spreadsheet = seededAvailabilitySpreadsheet();
    spreadsheet.getSheetByName('Sessions')?.appendRow(['session-1', 'center', 'center-1', 'Center session', '2026-09-21', '10:00', '11:00', 'America/New_York', 1, 'locked', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
    const runtime = createProductionRuntime(spreadsheet, new InMemoryProperties());
    const context: HandlerContext = { actor: actor as unknown as HandlerContext['actor'], operation: INTEGRATION_OPERATIONS.adminScheduleRerun, idempotencyKey: 'schedule-run', now: '2026-09-19T00:00:00.000Z' };
    const schedule = runtime.handlers[INTEGRATION_OPERATIONS.adminScheduleRerun]?.(context, {}) as { sessions: Array<{ assignments: Array<{ volunteerId: string }>; shortfall: number }> };
    expect(schedule.sessions.map((session) => session.assignments.map((assignment) => assignment.volunteerId))).toEqual([['vol-1']]);
    expect(schedule.sessions[0]?.shortfall).toBe(0);
  });

  it('counts authoritative recurring availability in insights', () => {
    const runtime = createProductionRuntime(seededAvailabilitySpreadsheet(), new InMemoryProperties());
    const context: HandlerContext = { actor: actor as unknown as HandlerContext['actor'], operation: INTEGRATION_OPERATIONS.adminInsights, idempotencyKey: 'insight-read', now: '2026-09-19T00:00:00.000Z' };
    const insights = runtime.handlers[INTEGRATION_OPERATIONS.adminInsights]?.(context, {}) as { cells: unknown[] };
    expect(insights.cells).toEqual([
      { weekday: 1, start: '09:00', end: '20:00', timeZone: 'America/New_York', count: 1, volunteerIds: ['vol-1'], volunteerNames: ['Example Volunteer'] }
    ]);
  });

  // End-to-end import path: fetch → parse → match → promote both tabs, then the
  // promoted intervals must be visible to insights and to a scheduling run.
  it('promotes a fetched WhenIsGood result into scheduling and insight eligibility', () => {
    const html = `
      <table>
        <td class="slot proposed" id="1789376400000"></td>
        <td class="slot proposed" id="1789380000000"></td>
      </table>
      <script>
        var respondents = new Array();
        var r100 = new Object();
        r100.id = "100";
        r100.name = "Example Person";
        r100.myCanDos = "1789376400000,1789380000000".split(",");
        r100.included = true;
        respondents["r100"] = r100;
      </script>`;
    const runtimeGlobal = globalThis as { UrlFetchApp?: unknown };
    const previousFetch = runtimeGlobal.UrlFetchApp;
    runtimeGlobal.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => html }) };
    try {
      const spreadsheet = new InMemorySpreadsheet();
      spreadsheet.getSheetByName('Volunteers')?.appendRow(['vol-1', 'Example Person', 'person@example.test', 'active', 'complete', 1, 0, 'roster', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
      spreadsheet.getSheetByName('Sessions')?.appendRow(['session-1', 'center', 'center-1', 'Center session', '2026-09-21', '09:00', '10:00', 'America/New_York', 1, 'locked', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
      const properties = new InMemoryProperties();
      properties.setProperty('WHENISGOOD_ENDPOINT', 'https://whenisgood.example.test/results');
      properties.setProperty('TIME_ZONE', 'America/New_York');
      const runtime = createProductionRuntime(spreadsheet, properties);
      const context = (operation: IntegrationOperation): HandlerContext => ({ actor: actor as unknown as HandlerContext['actor'], operation, idempotencyKey: `step-${operation}`, now: '2026-09-19T00:00:00.000Z' });

      const preview = runtime.handlers[INTEGRATION_OPERATIONS.adminImportPreview]?.(context(INTEGRATION_OPERATIONS.adminImportPreview), { resultsCode: 'legacy-result' }) as {
        canPromote: boolean;
        matchedCount: number;
        availabilityPreview: Array<{ volunteerName: string; intervals: unknown[] }>;
        mappingOptions: Array<{ volunteerId: string }>;
      };
      expect(preview).toMatchObject({ canPromote: true, matchedCount: 1 });
      expect(preview.availabilityPreview).toEqual([{ volunteerId: 'vol-1', volunteerName: 'Example Person', intervals: [{ weekday: 1, start: '09:00', end: '10:00', timeZone: 'America/New_York' }, { weekday: 1, start: '10:00', end: '11:00', timeZone: 'America/New_York' }] }]);
      expect(preview.mappingOptions.map((option) => option.volunteerId)).toEqual(['vol-1']);

      runtime.handlers[INTEGRATION_OPERATIONS.adminImportPromote]?.(context(INTEGRATION_OPERATIONS.adminImportPromote), { resultsCode: 'legacy-result' });
      const authoritative = spreadsheet.getSheetByName('RecurringAvailability')?.values.slice(1);
      expect(authoritative?.map((row) => [row[1], row[2], row[3], row[4], row[5]])).toEqual([
        ['vol-1', 1, '09:00', '10:00', 'America/New_York'],
        ['vol-1', 1, '10:00', '11:00', 'America/New_York']
      ]);
      expect(spreadsheet.getSheetByName('ImportedAvailability')?.values.length).toBe(3);

      const insights = runtime.handlers[INTEGRATION_OPERATIONS.adminInsights]?.(context(INTEGRATION_OPERATIONS.adminInsights), {}) as { cells: unknown[] };
      expect(insights.cells).toEqual([
        { weekday: 1, start: '09:00', end: '11:00', timeZone: 'America/New_York', count: 1, volunteerIds: ['vol-1'], volunteerNames: ['Example Person'] }
      ]);

      const schedule = runtime.handlers[INTEGRATION_OPERATIONS.adminScheduleRerun]?.(context(INTEGRATION_OPERATIONS.adminScheduleRerun), {}) as { sessions: Array<{ assignments: Array<{ volunteerId: string }>; shortfall: number }> };
      expect(schedule.sessions.map((session) => session.assignments.map((assignment) => assignment.volunteerId))).toEqual([['vol-1']]);
      expect(schedule.sessions[0]?.shortfall).toBe(0);
    } finally {
      if (previousFetch === undefined) delete (globalThis as { UrlFetchApp?: unknown }).UrlFetchApp;
      else runtimeGlobal.UrlFetchApp = previousFetch;
    }
  });

  // Sheets anchors a time-only cell to 1899-12-30 in the spreadsheet's own zone,
  // and that date predates standard time, so decoding in the configured zone
  // shifted every session by a local-mean-time offset (a Detroit workbook read
  // as New York turned the 09:00 OPAL session into 09:32).
  it('reads workbook clocks in the workbook time zone, not the configured zone', () => {
    const spreadsheet = new InMemorySpreadsheet('America/Detroit');
    const properties = new InMemoryProperties();
    properties.setProperty('TIME_ZONE', 'America/New_York');
    const detroit = (hour: number, minute: number) =>
      new Date(Temporal.ZonedDateTime.from({ timeZone: 'America/Detroit', year: 1899, month: 12, day: 30, hour, minute }).epochMilliseconds);
    spreadsheet.getSheetByName('Sessions')?.appendRow(['session-1', 'center', 'center-1', 'Center session: OPAL Senior Center', '2026-09-21', detroit(9, 0), detroit(9, 45), 'America/New_York', 1, 'locked', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);

    const runtime = createProductionRuntime(spreadsheet, properties);
    const context: HandlerContext = { actor: actor as unknown as HandlerContext['actor'], operation: INTEGRATION_OPERATIONS.adminSchedule, idempotencyKey: 'workbook-zone', now: '2026-09-19T00:00:00.000Z' };
    const schedule = runtime.handlers[INTEGRATION_OPERATIONS.adminSchedule]?.(context, {}) as { sessions: Array<{ start: string; end: string }> };

    expect(schedule.sessions).toEqual([expect.objectContaining({ start: '09:00', end: '09:45' })]);
  });

  it('separates the global revision from the scheduling-input revision', () => {
    const spreadsheet = seededAvailabilitySpreadsheet();
    spreadsheet.getSheetByName('Sessions')?.appendRow(['session-1', 'center', 'center-1', 'Center session', '2026-09-21', '10:00', '11:00', 'America/New_York', 1, 'locked', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
    const properties = new InMemoryProperties();
    properties.setProperty('DATA_REVISION', '5');
    properties.setProperty('SCHEDULING_INPUT_REVISION', '2');
    const runtime = createProductionRuntime(spreadsheet, properties);
    const context = (operation: IntegrationOperation, key: string): HandlerContext => ({ actor: actor as unknown as HandlerContext['actor'], operation, idempotencyKey: key, now: '2026-09-19T00:00:00.000Z' });
    const schedule = () => runtime.handlers[INTEGRATION_OPERATIONS.adminSchedule]?.(context(INTEGRATION_OPERATIONS.adminSchedule, 'read'), {}) as { revision: number; inputRevision: number; scheduleRevision: number | null; stale: boolean };

    const published = runtime.handlers[INTEGRATION_OPERATIONS.adminScheduleRerun]?.(context(INTEGRATION_OPERATIONS.adminScheduleRerun, 'publish'), {}) as { revision: number; inputRevision: number; scheduleRevision: number | null; stale: boolean };
    expect(published).toMatchObject({ revision: 5, inputRevision: 2, stale: false });
    expect(published.scheduleRevision).toBeTypeOf('number');

    // A candidate change is not a scheduling input: the tab revision moves but
    // neither the global revision nor the published schedule becomes stale.
    const store = repositories(spreadsheet, properties, { timeZone: 'America/New_York' });
    store.candidates.upsert({ id: 'candidate-1', centerId: 'center-1', weekday: 1, start: '10:00', end: '11:00', timeZone: 'America/New_York', requestedStaffCount: 1, status: 'candidate', createdBy: 'admin@example.test', revision: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }, store.candidates.revision().number, 'admin@example.test', 'candidate-draft');
    expect(schedule()).toMatchObject({ revision: 5, inputRevision: 2, stale: false });

    // A session change is a scheduling input: the dedicated counter advances and
    // the completed run no longer matches it.
    store.sessions.upsert({ id: 'session-2', kind: 'univ100', title: 'UNIV100 class', date: '2026-09-22', start: '10:00', end: '11:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'confirmed', revision: 0 }, store.sessions.revision().number, 'admin@example.test', 'class-confirmation');
    expect(schedule()).toMatchObject({ revision: 5, inputRevision: 3, stale: true });
  });

  it('keeps the scheduling preview free of side effects and identical to what publishing writes', () => {
    const spreadsheet = seededAvailabilitySpreadsheet();
    spreadsheet.getSheetByName('Sessions')?.appendRow(['session-past', 'center', 'center-1', 'Past center session', '2026-09-18', '10:00', '11:00', 'America/New_York', 1, 'locked', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
    spreadsheet.getSheetByName('Sessions')?.appendRow(['session-cutoff', 'center', 'center-1', 'Exact-cutoff center session', '2026-09-19', '10:00', '11:00', 'America/New_York', 1, 'locked', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
    spreadsheet.getSheetByName('Sessions')?.appendRow(['session-future', 'center', 'center-1', 'Future center session', '2026-09-21', '10:00', '11:00', 'America/New_York', 1, 'locked', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
    spreadsheet.getSheetByName('Sessions')?.appendRow(['session-proposed', 'univ100', '', 'Proposed UNIV100 class', '2026-09-22', '10:00', '11:00', 'America/New_York', 1, 'proposed', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
    const properties = new InMemoryProperties();
    properties.setProperty('DATA_REVISION', '4');
    const runtime = createProductionRuntime(spreadsheet, properties);
    const context = (operation: IntegrationOperation, key: string): HandlerContext => ({ actor: actor as unknown as HandlerContext['actor'], operation, idempotencyKey: key, now: '2026-09-19T14:00:00.000Z' });

    const preview = runtime.handlers[INTEGRATION_OPERATIONS.adminSchedulePreview]?.(context(INTEGRATION_OPERATIONS.adminSchedulePreview, 'preview'), {}) as { preview: boolean; sessions: Array<{ id: string }>; excludedProposedSessions: unknown[]; revision: number; inputRevision: number; outputRevision: number; computedAt: string; summary: { assignmentCount: number; backupCount: number; shortfallCount: number } };
    expect(preview.preview).toBe(true);
    expect(preview.revision).toBe(4);
    expect(preview.inputRevision).toBe(0);
    expect(preview.sessions.map((session) => session.id)).toEqual(['session-future']);
    expect(preview.excludedProposedSessions).toEqual([{ id: 'session-proposed', displayName: 'Proposed UNIV100 class', reason: 'proposed' }]);
    expect(preview.computedAt).toBe('2026-09-19T14:00:00.000Z');
    expect(preview.outputRevision).toBe(1);
    expect(preview.summary).toEqual({ assignmentCount: 1, backupCount: 0, shortfallCount: 0 });
    // Nothing was written: no assignments, no run, no revision movement.
    expect(spreadsheet.getSheetByName('Assignments')?.values.length).toBe(1);
    expect(spreadsheet.getSheetByName('SchedulingRuns')?.values.length).toBe(1);
    expect(properties.getProperty('SCHEDULING_INPUT_REVISION')).toBeNull();
    expect(properties.getProperty('DATA_REVISION')).toBe('4');

    const published = runtime.handlers[INTEGRATION_OPERATIONS.adminScheduleRerun]?.(context(INTEGRATION_OPERATIONS.adminScheduleRerun, 'publish'), {}) as { preview: boolean; sessions: unknown[]; revision: number; outputRevision: number; computedAt: string; summary: { assignmentCount: number; backupCount: number; shortfallCount: number } };
    expect(published.preview).toBe(false);
    expect(published.sessions).toEqual(preview.sessions);
    expect(published.outputRevision).toBe(preview.outputRevision);
    expect(published.computedAt).toBe(preview.computedAt);
    expect(published.summary).toEqual(preview.summary);
    expect(spreadsheet.getSheetByName('Assignments')?.values.length).toBe(2);
  });

  it('returns zero-valued preview counts and revision metadata explicitly', () => {
    const runtime = createProductionRuntime(new InMemorySpreadsheet(), new InMemoryProperties());
    const context: HandlerContext = { actor: actor as unknown as HandlerContext['actor'], operation: INTEGRATION_OPERATIONS.adminSchedulePreview, idempotencyKey: 'empty-preview', now: '2026-09-19T14:00:00.000Z' };

    const preview = runtime.handlers[INTEGRATION_OPERATIONS.adminSchedulePreview]?.(context, {}) as Record<string, unknown>;

    expect(preview).toMatchObject({
      computedAt: '2026-09-19T14:00:00.000Z',
      revision: 0,
      inputRevision: 0,
      scheduleRevision: null,
      outputRevision: 1,
      summary: { assignmentCount: 0, backupCount: 0, shortfallCount: 0 }
    });
  });

  it('composes a handler for every allowlisted operation', () => {
    const runtime = createProductionRuntime(new InMemorySpreadsheet(), new InMemoryProperties());
    for (const operation of Object.values(INTEGRATION_OPERATIONS)) expect(runtime.handlers[operation]).toBeTypeOf('function');
  });

  // Apps Script rejects a web app whose entry point returns a Promise with
  // "The script completed but the returned value is not a supported return type".
  it('never returns a Promise from a handler', () => {
    const runtime = createProductionRuntime(new InMemorySpreadsheet(), new InMemoryProperties());
    for (const operation of Object.values(INTEGRATION_OPERATIONS) as IntegrationOperation[]) {
      const handler = runtime.handlers[operation];
      if (!handler) continue;
      const context: HandlerContext = { actor: actor as unknown as HandlerContext['actor'], operation, idempotencyKey: 'contract-check', now: '2026-09-19T00:00:00.000Z' };
      let value: unknown;
      try {
        value = handler(context, {});
      } catch {
        continue; // a missing prerequisite is fine here; the return type is what matters
      }
      expect(typeof (value as { then?: unknown } | null)?.then, `${operation} returned a Promise`).not.toBe('function');
    }
  });
});

describe('center candidate entry', () => {
  const contact = {
    claims: { iss: 'https://accounts.google.com', aud: 'client', sub: 'sub-2', email: 'contact@example.test', email_verified: true, exp: 0 },
    email: 'contact@example.test',
    user: { id: 'contact@example.test', email: 'contact@example.test', roles: ['center-contact'] as const, centerIds: ['center-a'], active: true, revision: 0 }
  };

  function centerRuntime(seed?: (spreadsheet: InMemorySpreadsheet) => void): ReturnType<typeof createProductionRuntime> {
    const spreadsheet = new InMemorySpreadsheet();
    spreadsheet.getSheetByName('Centers')?.appendRow(['center-a', 'Example Center', true, 0, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z']);
    seed?.(spreadsheet);
    return createProductionRuntime(spreadsheet, new InMemoryProperties());
  }

  function context(): HandlerContext {
    return { actor: contact as unknown as HandlerContext['actor'], operation: INTEGRATION_OPERATIONS.centerCandidateUpdate, idempotencyKey: 'candidate-entry', now: '2026-09-20T00:00:00.000Z' };
  }

  // The center form has no id to send for a new interval, so the service must
  // mint one. Refusing an id-less payload made creating the first candidate
  // impossible: the browser surfaced "candidateId is required".
  it('creates a candidate from the exact payload the center form sends', () => {
    const runtime = centerRuntime();
    const result = runtime.handlers[INTEGRATION_OPERATIONS.centerCandidateUpdate]?.(context(), {
      weekday: 3,
      start: '13:00',
      end: '14:00',
      timeZone: 'America/New_York',
      requestedStaffCount: 1
    }) as { candidate: { id: string; centerId: string; weekday: number; status: string } };

    expect(result.candidate.id).toMatch(/^candidate/u);
    expect(result.candidate.centerId).toBe('center-a');
    expect(result.candidate.weekday).toBe(3);
    expect(result.candidate.status).toBe('candidate');
  });

  it('still edits an existing candidate when the payload carries its id', () => {
    const runtime = centerRuntime();
    const handler = runtime.handlers[INTEGRATION_OPERATIONS.centerCandidateUpdate];
    const created = handler?.(context(), { weekday: 3, start: '13:00', end: '14:00', timeZone: 'America/New_York', requestedStaffCount: 1 }) as { candidate: { id: string } };
    const edited = handler?.(context(), { id: created.candidate.id, start: '14:00', end: '15:00' }) as { candidate: { id: string; start: string; end: string; weekday: number } };

    expect(edited.candidate.id).toBe(created.candidate.id);
    expect([edited.candidate.start, edited.candidate.end]).toEqual(['14:00', '15:00']);
    expect(edited.candidate.weekday).toBe(3);
  });

  it('rejects a weekend candidate interval rather than storing it', () => {
    const runtime = centerRuntime();
    const handler = runtime.handlers[INTEGRATION_OPERATIONS.centerCandidateUpdate];
    expect(() => handler?.(context(), { weekday: 6, start: '13:00', end: '14:00', timeZone: 'America/New_York', requestedStaffCount: 1 })).toThrow(/Monday through Friday/u);
  });
});

describe('center workflow failures reach the caller', () => {
  const contact = {
    claims: { iss: 'https://accounts.google.com', aud: 'client', sub: 'sub-2', email: 'contact@example.test', email_verified: true, exp: 0 },
    email: 'contact@example.test',
    user: { id: 'contact@example.test', email: 'contact@example.test', roles: ['center-contact'] as const, centerIds: ['center-a'], active: true, revision: 0 }
  };

  // 2026-09-09 is a Wednesday, matching the candidate weekday below.
  function lockedCenterRuntime(): ReturnType<typeof createProductionRuntime> {
    const spreadsheet = new InMemorySpreadsheet();
    spreadsheet.getSheetByName('Centers')?.appendRow(['center-a', 'Example Center', true, 0, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z']);
    spreadsheet.getSheetByName('Sessions')?.appendRow(['session-locked-a', 'center', 'center-a', 'Locked occurrence', '2026-09-09', '13:00', '14:00', 'America/New_York', 1, 'locked', '', 0, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z']);
    return createProductionRuntime(spreadsheet, new InMemoryProperties());
  }

  // The centers package throws its own error type. Unmapped, the dispatcher
  // reduced every refusal to "The scheduling service could not complete the
  // request." and dropped the reason and the shortfall counts with it.
  it('reports the locked-occurrence refusal by name instead of a generic failure', () => {
    const runtime = lockedCenterRuntime();
    const context: HandlerContext = { actor: contact as unknown as HandlerContext['actor'], operation: INTEGRATION_OPERATIONS.centerCandidateUpdate, idempotencyKey: 'locked-entry', now: '2026-09-20T00:00:00.000Z' };

    let caught: unknown;
    try {
      runtime.handlers[INTEGRATION_OPERATIONS.centerCandidateUpdate]?.(context, { weekday: 3, start: '13:00', end: '14:00', timeZone: 'America/New_York', requestedStaffCount: 1 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IntegrationError);
    const failure = caught as IntegrationError;
    expect(failure.code).toBe('CONFLICT');
    expect(failure.message).toContain('an administrator must manage the existing session');
    expect(failure.message).not.toContain('could not complete the request');
    expect(failure.details?.lockedSessionId).toBe('session-locked-a');
  });

  it('reports the coverage refusal with its shortfall counts', () => {
    const runtime = lockedCenterRuntime();
    // Candidate coverage is compared against volunteer availability, so an
    // unstaffed centre cannot confirm at all; the counts must survive the throw.
    const handler = runtime.handlers[INTEGRATION_OPERATIONS.centerCandidateUpdate];
    const created = handler?.({ actor: contact as unknown as HandlerContext['actor'], operation: INTEGRATION_OPERATIONS.centerCandidateUpdate, idempotencyKey: 'seed-candidate', now: '2026-09-20T00:00:00.000Z' }, { weekday: 2, start: '10:00', end: '11:00', timeZone: 'America/New_York', requestedStaffCount: 1 }) as { candidate: { id: string } };

    const confirmContext: HandlerContext = { actor: { ...contact, user: { ...contact.user, roles: ['administrator'] } } as unknown as HandlerContext['actor'], operation: INTEGRATION_OPERATIONS.adminCenterCandidateConfirm, idempotencyKey: 'confirm-candidate', now: '2026-09-20T00:00:00.000Z' };
    let caught: unknown;
    try {
      runtime.handlers[INTEGRATION_OPERATIONS.adminCenterCandidateConfirm]?.(confirmContext, { candidateId: created.candidate.id });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IntegrationError);
    const failure = caught as IntegrationError;
    expect(failure.code).toBe('CONFLICT');
    expect(failure.message).toContain('coverage is insufficient');
    expect(failure.details?.shortfall).toBe(1);
  });
});
