import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { cellClock, cellDate, cellInstant } from './sheet-values.js';
import {
  BATCH_READ_PLANS,
  WorkbookBatchReadError,
  createWorkbookBatchReader,
  type BatchGetValuesRequest,
  type BatchReadPlan,
  type BatchReadTab,
  type BatchGetValuesService
} from './batch-read.js';

const SPREADSHEET_ID = 'bound-workbook-id';

function fakeService(respond: (spreadsheetId: string, request: BatchGetValuesRequest) => unknown): BatchGetValuesService {
  return { batchGet: respond };
}

function rowsResponse(spreadsheetId: string, request: BatchGetValuesRequest, rowsByTab: Partial<Record<BatchReadTab, unknown[][]>> = {}): unknown {
  return {
    spreadsheetId,
    valueRanges: request.ranges.map((range) => {
      const match = /^'([^']+)'!A2:([A-Z]+)$/u.exec(range);
      const tab = match?.[1] as BatchReadTab | undefined;
      const width = match?.[2];
      const letterNumber = width ? width.charCodeAt(0) - 64 : 1;
      const rows = rowsByTab[tab ?? 'SchedulingRuns'] ?? [];
      // The response may report only the used columns and rows for an open range.
      const usedWidth = Math.max(1, ...rows.map((row) => row.length));
      const endColumn = String.fromCharCode(64 + Math.min(letterNumber, usedWidth));
      const endRow = rows.length > 0 ? String(rows.length + 1) : '';
      return { range: `'${tab}'!A2:${endColumn}${endRow}`, values: rows };
    })
  };
}

function serialFromCivil(value: string): number {
  const dateTime = Temporal.PlainDateTime.from(value);
  const days = Temporal.PlainDate.from('1899-12-30').until(dateTime.toPlainDate(), { largestUnit: 'day' }).days;
  const milliseconds = ((dateTime.hour * 60 + dateTime.minute) * 60 + dateTime.second) * 1000 + dateTime.millisecond;
  return days + milliseconds / (24 * 60 * 60 * 1000);
}

describe('workbook batched reads', () => {
  it('uses schema-bounded unformatted ranges, excludes Users, and pads shortened rows', () => {
    let seenSpreadsheetId = '';
    let seenRequest: BatchGetValuesRequest | undefined;
    const reader = createWorkbookBatchReader({
      boundSpreadsheetId: SPREADSHEET_ID,
      service: fakeService((spreadsheetId, request) => {
        seenSpreadsheetId = spreadsheetId;
        seenRequest = request;
        return rowsResponse(spreadsheetId, request, {
          SchedulingRuns: [['run-1', 2, 4, 'completed', 46200.5]],
          Assignments: [['assignment-1', 'session-1']],
          Backups: [],
          Sessions: [['session-1', 'center', '', '', 46200, 0.375]],
          Volunteers: [['vol-1', 'Example Volunteer']],
          Centers: [['center-1', 'Example Center']]
        });
      })
    });

    const rows = reader.read('publishedSchedule');
    expect(seenSpreadsheetId).toBe(SPREADSHEET_ID);
    expect(seenRequest).toMatchObject({
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER'
    });
    expect(seenRequest?.ranges).toEqual(BATCH_READ_PLANS.publishedSchedule.map((tab) => {
      const width = tab === 'SchedulingRuns' ? 'J' : tab === 'Assignments' ? 'H' : tab === 'Backups' ? 'F' : tab === 'Sessions' ? 'N' : tab === 'Volunteers' ? 'J' : 'F';
      return `'${tab}'!A2:${width}`;
    }));
    expect(seenRequest?.ranges.some((range) => range.includes('Users'))).toBe(false);
    expect(rows.get('SchedulingRuns')?.[0]).toEqual(['run-1', 2, 4, 'completed', 46200.5, '', '', '', '', '']);
    expect(rows.get('Sessions')?.[0]).toHaveLength(14);
    expect(rows.get('Backups')).toEqual([]);
  });

  it('extends an Insights snapshot with only newly required tabs and keeps it request-local', () => {
    const requests: BatchGetValuesRequest[] = [];
    const service = fakeService((spreadsheetId, request) => {
      requests.push(request);
      const byTab: Partial<Record<BatchReadTab, unknown[][]>> = {};
      request.ranges.forEach((range) => {
        const tab = range.split('!')[0]?.replaceAll("'", '') as BatchReadTab | undefined;
        if (tab) byTab[tab] = [[`${tab}-row`]];
      });
      return rowsResponse(spreadsheetId, request, byTab);
    });
    const firstRequest = createWorkbookBatchReader({ boundSpreadsheetId: SPREADSHEET_ID, service });

    const cacheHit = firstRequest.read('insightCacheHit');
    const cacheMiss = firstRequest.read('insightCacheMiss');
    const repeated = firstRequest.read('insightCacheMiss');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.ranges).toEqual(["'SchedulingRuns'!A2:J"]);
    expect(requests[1]?.ranges).toEqual(["'Volunteers'!A2:J", "'RecurringAvailability'!A2:I", "'Assignments'!A2:H"]);
    expect(cacheHit.get('SchedulingRuns')).toBe(cacheMiss.get('SchedulingRuns'));
    expect(repeated.get('Assignments')).toBe(cacheMiss.get('Assignments'));
    expect(cacheMiss.size).toBe(4);

    const nextRequest = createWorkbookBatchReader({ boundSpreadsheetId: SPREADSHEET_ID, service });
    nextRequest.read('insightCacheHit');
    expect(requests).toHaveLength(3);
  });

  it('rejects a missing workbook ID, a different response workbook, and unplanned reads', () => {
    expect(() => createWorkbookBatchReader({ boundSpreadsheetId: '  ', service: fakeService(() => ({})) })).toThrow(WorkbookBatchReadError);
    expect(() => createWorkbookBatchReader({ boundSpreadsheetId: SPREADSHEET_ID, service: fakeService(() => ({ spreadsheetId: 'other-workbook', valueRanges: [] })) }).read('insightCacheHit')).toThrow(/different workbook/u);
    expect(() => createWorkbookBatchReader({ boundSpreadsheetId: SPREADSHEET_ID, service: fakeService(() => ({})) }).read('anything' as BatchReadPlan)).toThrow(/not allowlisted/u);
    expect(() => createWorkbookBatchReader({ boundSpreadsheetId: SPREADSHEET_ID, service: {} as BatchGetValuesService })).toThrow(/unavailable/u);
  });

  it('fails closed on omitted, reordered, mismatched, or malformed range results', () => {
    const runRequest = { ranges: ["'SchedulingRuns'!A2:J"], majorDimension: 'ROWS', valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' } as const;
    const readerFor = (response: unknown) => createWorkbookBatchReader({ boundSpreadsheetId: SPREADSHEET_ID, service: fakeService(() => response) });
    expect(() => readerFor({ spreadsheetId: SPREADSHEET_ID }).read('insightCacheHit')).toThrow(/incomplete batch response/u);
    expect(() => readerFor({ spreadsheetId: SPREADSHEET_ID, valueRanges: [{ range: "'Volunteers'!A2:J", values: [] }] }).read('insightCacheHit')).toThrow(/unexpected range/u);
    expect(() => readerFor({ spreadsheetId: SPREADSHEET_ID, valueRanges: [{ range: "'SchedulingRuns'!A1:J2", values: [] }] }).read('insightCacheHit')).toThrow(/unexpected range/u);
    expect(() => readerFor({ spreadsheetId: SPREADSHEET_ID, valueRanges: [{ range: "'SchedulingRuns'!A2:J2", values: [['run', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]] }] }).read('insightCacheHit')).toThrow(/malformed row/u);
    expect(runRequest.majorDimension).toBe('ROWS');
  });

  it('decodes Google Sheets serial dates, clocks, and instants in workbook-local time', () => {
    for (const [civil, timeZone] of [
      ['2026-09-04T09:32:00', 'America/New_York'],
      ['2026-11-01T01:30:00', 'America/New_York'],
      ['1899-12-30T09:00:00', 'America/Detroit']
    ] as const) {
      const serial = serialFromCivil(civil);
      const plain = Temporal.PlainDateTime.from(civil);
      const expected = Temporal.ZonedDateTime.from({
        timeZone,
        year: plain.year,
        month: plain.month,
        day: plain.day,
        hour: plain.hour,
        minute: plain.minute,
        second: plain.second
      }, { disambiguation: 'compatible' });
      const batchContext = { timeZone, numericDateTimeSerials: true };
      expect(cellDate(serial, batchContext)).toBe(plain.toPlainDate().toString());
      expect(cellClock(serial, { timeZone })).toBe(plain.toPlainTime().toString({ smallestUnit: 'minute' }));
      const existingDateCell = new Date(expected.epochMilliseconds);
      expect(cellInstant(serial, batchContext)).toBe(cellInstant(existingDateCell, { timeZone }));
      expect(cellDate(serial, batchContext)).toBe(cellDate(existingDateCell, { timeZone }));
      expect(cellClock(serial, { timeZone })).toBe(cellClock(existingDateCell, { timeZone }));
      expect(cellDate(serial, { timeZone })).toBe(String(serial));
      expect(cellInstant(serial, { timeZone })).toBe(String(serial));
    }

    const outOfCalendarSerial = 1e100;
    expect(cellDate(outOfCalendarSerial, { numericDateTimeSerials: true })).toBe(String(outOfCalendarSerial));
    expect(cellInstant(outOfCalendarSerial, { numericDateTimeSerials: true })).toBe(String(outOfCalendarSerial));
  });
});
