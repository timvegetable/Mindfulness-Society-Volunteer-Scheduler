import { describe, expect, it } from 'vitest';
import { createSheetsReadClient } from './sheets.js';
import type { FetchLike } from '../google/index.js';
import { requestedRange } from '../../server/workbook/batch-read.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('Sheets read timing order', () => {
  it('keeps timing entries in request-start order when concurrent responses finish in reverse', async () => {
    let clock = 0;
    const startedRanges: string[] = [];
    const pendingResponses = new Map<string, (response: Response) => void>();
    const bothStarted = deferred<void>();
    const fetch: FetchLike = async (input) => {
      const range = new URL(input).searchParams.get('ranges');
      if (range === null) throw new Error('the Sheets range is required');
      startedRanges.push(range);
      const response = deferred<Response>();
      pendingResponses.set(range, response.resolve);
      if (startedRanges.length === 2) bothStarted.resolve();
      return response.promise;
    };
    const client = createSheetsReadClient({
      spreadsheetId: 'test-workbook',
      accessToken: async () => 'test-token',
      fetch,
      nowMs: () => clock
    });

    const users = client.readTab('Users');
    const sessions = client.readTab('Sessions');
    await bothStarted.promise;

    expect(startedRanges).toEqual([requestedRange('Users'), requestedRange('Sessions')]);
    clock = 20;
    pendingResponses.get(requestedRange('Sessions'))?.(new Response(JSON.stringify({
      spreadsheetId: 'test-workbook',
      valueRanges: [{ range: requestedRange('Sessions'), values: [] }]
    }), { headers: { 'Content-Type': 'application/json' } }));
    await sessions;

    clock = 70;
    pendingResponses.get(requestedRange('Users'))?.(new Response(JSON.stringify({
      spreadsheetId: 'test-workbook',
      valueRanges: [{ range: requestedRange('Users'), values: [] }]
    }), { headers: { 'Content-Type': 'application/json' } }));
    await users;

    expect(client.readCount()).toBe(2);
    expect(client.readDurationsMs()).toEqual([70, 20]);
  });
});
