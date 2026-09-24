import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { MemoryTokenVerifier, MemoryUserDirectory } from './integration/auth.js';
import { createIntegrationDispatcher, INTEGRATION_OPERATIONS, IntegrationError, type HandlerContext } from './integration/dispatcher.js';
import { createProductionRuntime } from './runtime.js';
import { readOnlyRouteParityReport, runtimeBatchReader } from './main.js';
import { BATCH_READ_PLANS, type BatchReadPlan, type BatchReadTab, type WorkbookBatchReader } from './workbook/batch-read.js';
import { InMemoryProperties, InMemorySpreadsheet } from './workbook/in-memory-sheet.js';
import { WORKBOOK_TABS } from './workbook/schema.js';

class CountingSpreadsheet extends InMemorySpreadsheet {
  readonly resolved: string[] = [];
  override getSheetByName(name: string) {
    this.resolved.push(name);
    return super.getSheetByName(name);
  }
}

const actor = {
  claims: { iss: 'https://accounts.google.com', aud: 'client', sub: 'sub-1', email: 'admin@example.test', email_verified: true, exp: 4102444800 },
  email: 'admin@example.test',
  user: { id: 'admin', email: 'admin@example.test', roles: ['administrator'], active: true, revision: 0 }
} as unknown as HandlerContext['actor'];

function context(operation: HandlerContext['operation']): HandlerContext {
  return { actor, operation, idempotencyKey: 'batch-contract', now: '2026-09-19T00:00:00.000Z' };
}

function fixture() {
  const spreadsheet = new CountingSpreadsheet();
  spreadsheet.getSheetByName('Users')?.appendRow(['admin', 'admin@example.test', '["administrator"]', '', '[]', true, 0]);
  spreadsheet.getSheetByName('Volunteers')?.appendRow(['vol-1', 'Example Volunteer', 'volunteer@example.test', 'active', 'complete', 1, 0, 'roster', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
  spreadsheet.getSheetByName('RecurringAvailability')?.appendRow(['availability-1', 'vol-1', 1, '09:00', '20:00', 'America/New_York', 0, 'whenisgood', '2026-09-01T00:00:00.000Z']);
  const tabs = new Set<BatchReadTab>([...BATCH_READ_PLANS.publishedSchedule, ...BATCH_READ_PLANS.insightCacheMiss]);
  const rows = new Map([...tabs].map((tab) => [tab, spreadsheet.getSheetByName(tab)!.values.slice(1).map((row) => [...row])] as const));
  spreadsheet.resolved.length = 0;
  return { spreadsheet, rows };
}

function reader(rows: ReadonlyMap<BatchReadTab, readonly (readonly unknown[])[]>, onRead?: (plan: BatchReadPlan) => void) {
  const plans: BatchReadPlan[] = [];
  const batchReader: WorkbookBatchReader = {
    read(plan) {
      plans.push(plan);
      onRead?.(plan);
      return new Map(BATCH_READ_PLANS[plan].map((tab) => [tab, rows.get(tab) ?? []] as const));
    }
  };
  return { plans, batchReader };
}

describe('batched runtime reads', () => {
  it('requires a bound ID and enabled service before activation', () => {
    const spreadsheet = new InMemorySpreadsheet();
    expect(runtimeBatchReader(spreadsheet, false, undefined)).toBeUndefined();
    expect(() => runtimeBatchReader(spreadsheet, true, undefined)).toThrow('bound workbook ID');

    const bound = Object.assign(spreadsheet, { getId: () => 'bound-workbook' });
    expect(() => runtimeBatchReader(bound, true, undefined)).toThrow('Advanced Sheets batch read service');
    let calls = 0;
    const values = {
      batchGet(spreadsheetId: string, request: { ranges: string[] }) {
        expect(this).toBe(values);
        expect(spreadsheetId).toBe('bound-workbook');
        calls += 1;
        return { spreadsheetId, valueRanges: request.ranges.map((range) => ({ range, values: [] })) };
      }
    };
    runtimeBatchReader(bound, true, { Spreadsheets: { Values: values } })?.read('insightCacheHit');
    expect(calls).toBe(1);
  });

  it('keeps Users fresh and batches Schedule only after its handler is called', () => {
    const { spreadsheet, rows } = fixture();
    const { plans, batchReader } = reader(rows);
    const runtime = createProductionRuntime(spreadsheet, new InMemoryProperties(), { batchReader });
    expect(spreadsheet.resolved).toEqual(['Users']);
    expect(plans).toEqual([]);

    const schedule = runtime.handlers[INTEGRATION_OPERATIONS.adminSchedule]?.(context(INTEGRATION_OPERATIONS.adminSchedule), {});
    expect(schedule).toMatchObject({ sessions: [] });
    expect(plans).toEqual(['publishedSchedule']);
    expect(spreadsheet.resolved).toEqual(['Users']);
  });

  it('matches the SpreadsheetApp Schedule projection for workbook-zone date cells', () => {
    const spreadsheet = new CountingSpreadsheet('America/Detroit');
    spreadsheet.getSheetByName('Users')?.appendRow(['admin', 'admin@example.test', '["administrator"]', '', '[]', true, 0]);
    const workbookDate = new Date(Temporal.ZonedDateTime.from({ timeZone: 'America/Detroit', year: 2026, month: 9, day: 21 }).epochMilliseconds);
    const workbookClock = (hour: number, minute: number) => new Date(Temporal.ZonedDateTime.from({ timeZone: 'America/Detroit', year: 1899, month: 12, day: 30, hour, minute }).epochMilliseconds);
    spreadsheet.getSheetByName('Sessions')?.appendRow(['session-1', 'center', 'center-1', 'Center session', workbookDate, workbookClock(9, 0), workbookClock(9, 45), 'America/Detroit', 1, 'locked', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
    const properties = new InMemoryProperties();
    const baseline = createProductionRuntime(spreadsheet, properties).handlers[INTEGRATION_OPERATIONS.adminSchedule]?.(context(INTEGRATION_OPERATIONS.adminSchedule), {});
    const tabs = new Set<BatchReadTab>(BATCH_READ_PLANS.publishedSchedule);
    const rows = new Map([...tabs].map((tab) => [tab, spreadsheet.getSheetByName(tab)!.values.slice(1).map((row) => [...row])] as const));
    const serialSession = rows.get('Sessions')?.[0] as unknown[];
    serialSession[4] = Temporal.PlainDate.from('1899-12-30').until(Temporal.PlainDate.from('2026-09-21'), { largestUnit: 'day' }).days;
    serialSession[5] = 9 / 24;
    serialSession[6] = 9.75 / 24;
    spreadsheet.resolved.length = 0;

    const { batchReader } = reader(rows);
    const batched = createProductionRuntime(spreadsheet, properties, { batchReader }).handlers[INTEGRATION_OPERATIONS.adminSchedule]?.(context(INTEGRATION_OPERATIONS.adminSchedule), {});
    expect(batched).toEqual(baseline);
    expect(spreadsheet.resolved).toEqual(['Users']);
  });

  it('reads Insights source rows only after a cache miss', () => {
    const { spreadsheet, rows } = fixture();
    const properties = new InMemoryProperties();
    const entries = new Map<string, string>();
    const scriptCache = { get: (key: string) => entries.get(key) ?? null, put: (key: string, value: string) => { entries.set(key, value); } };
    const firstReader = reader(rows);
    const first = createProductionRuntime(spreadsheet, properties, { scriptCache, batchReader: firstReader.batchReader });
    const firstProjection = first.handlers[INTEGRATION_OPERATIONS.adminInsights]?.(context(INTEGRATION_OPERATIONS.adminInsights), {});
    expect(firstReader.plans).toEqual(['insightCacheHit', 'insightCacheMiss']);
    expect(spreadsheet.resolved).toEqual(['Users']);

    spreadsheet.resolved.length = 0;
    const secondReader = reader(rows);
    const second = createProductionRuntime(spreadsheet, properties, { scriptCache, batchReader: secondReader.batchReader });
    const secondProjection = second.handlers[INTEGRATION_OPERATIONS.adminInsights]?.(context(INTEGRATION_OPERATIONS.adminInsights), {});
    expect(secondReader.plans).toEqual(['insightCacheHit']);
    expect(secondProjection).toMatchObject({ cells: (firstProjection as { cells: unknown[] }).cells });
    expect(spreadsheet.resolved).toEqual(['Users']);
  });

  it('fails when revisions move between the two Insights batches', () => {
    const { spreadsheet, rows } = fixture();
    const properties = new InMemoryProperties();
    const { batchReader } = reader(rows, (plan) => {
      if (plan === 'insightCacheMiss') properties.setProperty('TAB_REVISION_Assignments', '1');
    });
    const runtime = createProductionRuntime(spreadsheet, properties, { batchReader });
    expect(() => runtime.handlers[INTEGRATION_OPERATIONS.adminInsights]?.(context(INTEGRATION_OPERATIONS.adminInsights), {})).toThrow(IntegrationError);
  });

  it('does not call the batch reader for an identity denied by the dispatcher', () => {
    const { spreadsheet, rows } = fixture();
    const { plans, batchReader } = reader(rows);
    const runtime = createProductionRuntime(spreadsheet, new InMemoryProperties(), { batchReader });
    const dispatcher = createIntegrationDispatcher({
      verifier: new MemoryTokenVerifier({ outsider: { iss: 'https://accounts.google.com', aud: 'client', sub: 'outsider', email: 'outsider@example.test', email_verified: true, exp: 4102444800 } }),
      users: new MemoryUserDirectory(runtime.users),
      handlers: runtime.handlers,
      revision: { current: () => 0 }
    });
    const response = dispatcher.dispatch({ operation: INTEGRATION_OPERATIONS.adminSchedule, payload: {}, idempotencyKey: 'denied-batch', credential: 'outsider' });
    expect(response).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(plans).toEqual([]);
  });

  it('compares read-only route projections without returning workbook data', () => {
    const { spreadsheet } = fixture();
    const bound = Object.assign(spreadsheet, { getId: () => 'bound-workbook' });
    const properties = new InMemoryProperties();
    properties.setProperty('WRITE_ENABLED', 'false');
    const before = new Map(WORKBOOK_TABS.map(({ name }) => [name, JSON.stringify(spreadsheet.getSheetByName(name)?.values)]));
    let batchCalls = 0;
    const sheets = {
      Spreadsheets: {
        Values: {
          batchGet(spreadsheetId: string, request: { ranges: string[] }) {
            batchCalls += 1;
            return {
              spreadsheetId,
              valueRanges: request.ranges.map((range) => {
                const tab = range.split('!')[0]?.replaceAll("'", '');
                const rows = spreadsheet.getSheetByName(tab ?? '')?.values.slice(1).map((row) => [...row]) ?? [];
                return { range, values: rows };
              })
            };
          }
        }
      }
    };

    const report = readOnlyRouteParityReport(bound, properties, sheets);
    expect(report).toMatchObject({
      passed: true,
      revisionsStable: true,
      writeGateStayedDisabled: true,
      schedule: { matches: true, differingFields: [] },
      insights: { matches: true, differingFields: [], ignoredFields: ['generatedAt'] },
      rowValuesIncluded: false
    });
    expect(batchCalls).toBe(3);
    expect(JSON.stringify(report)).not.toContain('Example Volunteer');
    expect(new Map(WORKBOOK_TABS.map(({ name }) => [name, JSON.stringify(spreadsheet.getSheetByName(name)?.values)]))).toEqual(before);
  });

  it('refuses the editor parity diagnostic unless writes are explicitly disabled', () => {
    const { spreadsheet } = fixture();
    const bound = Object.assign(spreadsheet, { getId: () => 'bound-workbook' });
    const properties = new InMemoryProperties();
    properties.setProperty('WRITE_ENABLED', 'true');
    const report = readOnlyRouteParityReport(bound, properties, undefined);
    expect(report).toEqual({ passed: false, stage: 'preflight', reason: 'WRITE_ENABLED must be exactly false', rowValuesIncluded: false });
  });
});
