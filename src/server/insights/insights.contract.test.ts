import { describe, expect, it } from 'vitest';
import { INTEGRATION_OPERATIONS, type HandlerContext, type IntegrationOperation } from '../integration/dispatcher.js';
import { createProductionRuntime, repositories } from '../runtime.js';
import { InMemoryProperties, InMemorySheet, InMemorySpreadsheet } from '../workbook/in-memory-sheet.js';

const actor = {
  claims: { iss: 'https://accounts.google.com', aud: 'client', sub: 'sub-1', email: 'admin@example.test', email_verified: true, exp: 0 },
  email: 'admin@example.test',
  user: { id: 'admin@example.test', email: 'admin@example.test', roles: ['administrator'] as const, active: true, revision: 0 }
};

const context = (operation: IntegrationOperation): HandlerContext => ({
  actor: actor as unknown as HandlerContext['actor'],
  operation,
  idempotencyKey: `insight-${operation}`,
  now: '2026-09-19T00:00:00.000Z'
});

class FakeScriptCache {
  readonly entries = new Map<string, string>();
  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  put(key: string, value: string, _seconds: number): void {
    this.entries.set(key, value);
  }
}

/** Counts the ranges a tab hands out, so a page-level read can be bounded. */
class CountingSpreadsheet extends InMemorySpreadsheet {
  readonly reads = new Map<string, number>();

  override getSheetByName(name: string): InMemorySheet | null {
    const sheet = super.getSheetByName(name);
    if (!sheet) return null;
    if (!this.reads.has(name)) this.reads.set(name, 0);
    return new Proxy(sheet, {
      get: (target, property, receiver) => {
        if (property === 'getRange') this.reads.set(name, (this.reads.get(name) ?? 0) + 1);
        return Reflect.get(target, property, receiver);
      }
    }) as InMemorySheet;
  }
}

function seededSpreadsheet(): InMemorySpreadsheet {
  const spreadsheet = new InMemorySpreadsheet();
  spreadsheet.getSheetByName('Volunteers')?.appendRow(['vol-1', 'Example Volunteer', 'volunteer@example.test', 'active', 'complete', 1, 0, 'roster', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
  spreadsheet.getSheetByName('RecurringAvailability')?.appendRow(['availability-1', 'vol-1', 1, '09:00', '20:00', 'America/New_York', 0, 'whenisgood', '2026-09-01T00:00:00.000Z']);
  spreadsheet.getSheetByName('Sessions')?.appendRow(['session-1', 'center', 'center-1', 'Center session', '2026-09-21', '10:00', '11:00', 'America/New_York', 1, 'locked', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
  return spreadsheet;
}

type InsightResponse = {
  generatedAt: string;
  stale: boolean;
  cells: Array<{ weekday: number; start: string; end: string; count: number }>;
  leftoverVolunteerCount: number;
  sourceRevision: { assignmentRevision: number; assignmentRowsRevision: number };
};

describe('cached insight reads', () => {
  it('serves an unchanged dataset without re-deriving it', () => {
    const cache = new FakeScriptCache();
    const runtime = createProductionRuntime(seededSpreadsheet(), new InMemoryProperties(), { scriptCache: cache });
    const read = (): InsightResponse => runtime.handlers[INTEGRATION_OPERATIONS.adminInsights]?.(context(INTEGRATION_OPERATIONS.adminInsights), {}) as InsightResponse;

    const first = read();
    const second = read();

    expect(first.cells).toEqual([{ weekday: 1, start: '09:00', end: '20:00', timeZone: 'America/New_York', count: 1, volunteerIds: ['vol-1'], volunteerNames: ['Example Volunteer'] }]);
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.stale).toBe(false);
    expect(cache.entries.size).toBe(1);
  });

  it('reads each required tab at most once per insight request', () => {
    const spreadsheet = new CountingSpreadsheet();
    const runtime = createProductionRuntime(spreadsheet, new InMemoryProperties(), { scriptCache: new FakeScriptCache() });
    runtime.handlers[INTEGRATION_OPERATIONS.adminInsights]?.(context(INTEGRATION_OPERATIONS.adminInsights), {});

    for (const tab of ['Volunteers', 'RecurringAvailability', 'Assignments', 'SchedulingRuns']) {
      expect(spreadsheet.reads.get(tab), `${tab} range reads`).toBeLessThanOrEqual(1);
    }
  });

  it('marks insights stale after a cancellation without changing the published output revision', () => {
    const spreadsheet = seededSpreadsheet();
    const properties = new InMemoryProperties();
    const cache = new FakeScriptCache();
    const firstRuntime = createProductionRuntime(spreadsheet, properties, { scriptCache: cache });
    const read = (runtime: ReturnType<typeof createProductionRuntime>): InsightResponse => runtime.handlers[INTEGRATION_OPERATIONS.adminInsights]?.(context(INTEGRATION_OPERATIONS.adminInsights), {}) as InsightResponse;
    const schedule = () => firstRuntime.handlers[INTEGRATION_OPERATIONS.adminSchedule]?.(context(INTEGRATION_OPERATIONS.adminSchedule), {}) as { scheduleRevision: number | null; sessions: Array<{ assignments: Array<{ volunteerId: string }> }> };

    firstRuntime.handlers[INTEGRATION_OPERATIONS.adminScheduleRerun]?.(context(INTEGRATION_OPERATIONS.adminScheduleRerun), {});
    const published = schedule();
    expect(published.sessions[0]?.assignments.map((assignment) => assignment.volunteerId)).toEqual(['vol-1']);
    const assigned = read(firstRuntime);
    expect(assigned.cells).toEqual([]);
    expect(assigned.sourceRevision.assignmentRevision).toBe(published.scheduleRevision);

    // The volunteer cancels in a later request: the Assignments tab changes, the
    // published output revision does not.
    const store = repositories(spreadsheet, properties, { timeZone: 'America/New_York' });
    const rows = store.assignments.list().map((assignment) => ({ ...assignment, status: 'cancelled' as const, cancelledAt: '2026-09-19T00:00:00.000Z' }));
    store.assignments.replace(rows, store.assignments.revision().number, 'volunteer@example.test', 'self-service-assignment-cancellation');
    const laterRuntime = createProductionRuntime(spreadsheet, properties, { scriptCache: cache });

    const staleRead = read(laterRuntime);
    // The cached dataset keeps its own revision stamp; the cancellation only
    // changed the Assignments tab, so the read is marked stale and not re-derived.
    expect(staleRead.stale).toBe(true);
    expect(staleRead.generatedAt).toBe(assigned.generatedAt);
    expect(staleRead.cells).toEqual(assigned.cells);
    expect(staleRead.sourceRevision.assignmentRevision).toBe(assigned.sourceRevision.assignmentRevision);
    expect(schedule().scheduleRevision).toBe(published.scheduleRevision);

    // A refresh re-derives: the cancelled assignment no longer excludes anyone.
    const refreshed = laterRuntime.handlers[INTEGRATION_OPERATIONS.adminInsightsRefresh]?.(context(INTEGRATION_OPERATIONS.adminInsightsRefresh), {}) as InsightResponse;
    expect(refreshed.stale).toBe(false);
    expect(refreshed.leftoverVolunteerCount).toBe(1);
    expect(refreshed.cells).toEqual([{ weekday: 1, start: '09:00', end: '20:00', timeZone: 'America/New_York', count: 1, volunteerIds: ['vol-1'], volunteerNames: ['Example Volunteer'] }]);
  });
});
