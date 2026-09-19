import { describe, expect, it } from 'vitest';
import { INTEGRATION_OPERATIONS, type HandlerContext, type IntegrationOperation } from './integration/dispatcher.js';
import { createProductionRuntime, runtimeConfiguration } from './runtime.js';
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
    spreadsheet.getSheetByName('Sessions')?.appendRow(['session-1', 'center', 'center-1', 'Center session', '2026-09-07', '10:00', '11:00', 'America/New_York', 1, 'locked', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
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
      spreadsheet.getSheetByName('Sessions')?.appendRow(['session-1', 'center', 'center-1', 'Center session', '2026-09-14', '09:00', '10:00', 'America/New_York', 1, 'locked', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
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
