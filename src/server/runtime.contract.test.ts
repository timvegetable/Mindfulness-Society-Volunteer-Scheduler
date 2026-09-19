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
