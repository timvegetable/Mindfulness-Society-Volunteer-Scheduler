import { describe, expect, it } from 'vitest';
import { createProductionRuntime } from '../runtime.js';
import { INTEGRATION_OPERATIONS, type HandlerContext } from '../integration/dispatcher.js';
import { InMemoryProperties, InMemorySpreadsheet } from './in-memory-sheet.js';
import { READ_PLANS } from './read-plans.js';

class CountingSpreadsheet extends InMemorySpreadsheet {
  readonly resolved: string[] = [];
  readonly rowReads = new Map<string, number>();
  private readonly wrapped = new Set<string>();
  override getSheetByName(name: string) {
    this.resolved.push(name);
    const sheet = super.getSheetByName(name);
    if (sheet && !this.wrapped.has(name)) {
      this.wrapped.add(name);
      const original = sheet.getLastRow.bind(sheet);
      sheet.getLastRow = () => { this.rowReads.set(name, (this.rowReads.get(name) ?? 0) + 1); return original(); };
    }
    return sheet;
  }
}

const actor = {
  claims: { iss: 'https://accounts.google.com', aud: 'client', sub: 'sub-1', email: 'admin@example.test', exp: 0 },
  email: 'admin@example.test',
  user: { id: 'admin', email: 'admin@example.test', roles: ['administrator'], active: true, revision: 0 }
} as unknown as HandlerContext['actor'];

function context(operation: HandlerContext['operation']): HandlerContext {
  return { actor, operation, idempotencyKey: 'read-plan', now: '2026-09-19T00:00:00.000Z' };
}

function seedUser(spreadsheet: CountingSpreadsheet): void {
  spreadsheet.getSheetByName('Users')?.appendRow(['admin', 'admin@example.test', '["administrator"]', '', '[]', true, 0]);
  spreadsheet.resolved.length = 0;
}

describe('measured route read plans', () => {
  it('reads each published Schedule tab once, with fresh Users first', () => {
    const spreadsheet = new CountingSpreadsheet();
    seedUser(spreadsheet);
    const runtime = createProductionRuntime(spreadsheet, new InMemoryProperties());
    const read = () => runtime.handlers[INTEGRATION_OPERATIONS.adminSchedule]?.(context(INTEGRATION_OPERATIONS.adminSchedule), {});
    const first = read();
    expect(spreadsheet.resolved).toEqual(READ_PLANS.publishedSchedule);
    expect(read()).toEqual(first);
    expect(spreadsheet.resolved).toEqual(READ_PLANS.publishedSchedule);
    expect(Object.fromEntries(spreadsheet.rowReads)).toEqual(Object.fromEntries(READ_PLANS.publishedSchedule.map((tab) => [tab, 1])));
  });

  it('reads only runs and revisions on an Insights cache hit, and source rows on a miss', () => {
    const spreadsheet = new CountingSpreadsheet();
    seedUser(spreadsheet);
    const entries = new Map<string, string>();
    const scriptCache = { get: (key: string) => entries.get(key) ?? null, put: (key: string, value: string) => { entries.set(key, value); } };
    const properties = new InMemoryProperties();
    const firstRuntime = createProductionRuntime(spreadsheet, properties, { scriptCache });
    const first = firstRuntime.handlers[INTEGRATION_OPERATIONS.adminInsights]?.(context(INTEGRATION_OPERATIONS.adminInsights), {});
    expect(spreadsheet.resolved).toEqual(READ_PLANS.insightCacheMiss);
    expect(entries.size).toBe(1);
    spreadsheet.resolved.length = 0;
    const secondRuntime = createProductionRuntime(spreadsheet, properties, { scriptCache });
    const second = secondRuntime.handlers[INTEGRATION_OPERATIONS.adminInsights]?.(context(INTEGRATION_OPERATIONS.adminInsights), {});
    expect(spreadsheet.resolved).toEqual(READ_PLANS.insightCacheHit);
    expect(spreadsheet.rowReads.get('Users')).toBe(2);
    expect(spreadsheet.rowReads.get('SchedulingRuns')).toBe(2);
    expect(spreadsheet.rowReads.get('Volunteers')).toBe(1);
    expect(second).toMatchObject({ cells: (first as { cells: unknown[] }).cells, leftoverVolunteers: (first as { leftoverVolunteers: unknown[] }).leftoverVolunteers });
    properties.setProperty('TAB_REVISION_Assignments', '1');
    spreadsheet.resolved.length = 0;
    const changed = createProductionRuntime(spreadsheet, properties, { scriptCache }).handlers[INTEGRATION_OPERATIONS.adminInsights]?.(context(INTEGRATION_OPERATIONS.adminInsights), {});
    expect(spreadsheet.resolved).toEqual(READ_PLANS.insightCacheHit);
    expect(changed).toMatchObject({ stale: true });
  });

  it('decodes Users again for each execution before authorizing', () => {
    const spreadsheet = new CountingSpreadsheet();
    seedUser(spreadsheet);
    expect(createProductionRuntime(spreadsheet, new InMemoryProperties()).users[0]?.active).toBe(true);
    spreadsheet.getSheetByName('Users')!.values[1]![5] = false;
    spreadsheet.resolved.length = 0;
    expect(createProductionRuntime(spreadsheet, new InMemoryProperties()).users[0]?.active).toBe(false);
    expect(spreadsheet.resolved).toEqual(['Users']);
  });
});
