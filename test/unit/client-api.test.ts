import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../src/client/api';
const success = () => new Response(JSON.stringify({ ok: true, data: { dataRevision: 2, schedulingInputRevision: 1, intervals: [] } }), { headers: { 'Content-Type': 'application/json' } });
describe('client API intent and response handling', () => {
  it('keeps a key for retries of an unconfirmed intent and consumes it on success', async () => {
    const requests: Record<string, unknown>[] = [];
    let sequence = 0;
    const api = new ApiClient(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) throw new TypeError('network failure');
      return success();
    }, () => `intent-${++sequence}`);
    api.signIn('memory-credential');
    await expect(api.call('volunteer.availability.recurring.update', { intervals: [] }, 1)).rejects.toThrow('retry');
    await api.call('volunteer.availability.recurring.update', { intervals: [] }, 1);
    await api.call('volunteer.availability.recurring.update', { intervals: [] }, 2);
    expect(requests.map(item => item.idempotencyKey)).toEqual(['intent-1', 'intent-1', 'intent-2']);
    expect(requests[0]).toMatchObject({ credential: 'memory-credential', expectedRevision: 1 });
  });
  it('returns stale revisions to the user without silently retrying writes', async () => {
    let calls = 0;
    const api = new ApiClient(async () => { calls++; return new Response(JSON.stringify({ ok: false, error: { code: 'STALE_REVISION', message: 'Please reload.' } }), { status: 409 }); }, () => 'key');
    api.signIn('credential');
    await expect(api.call('volunteer.availability.recurring.update', { intervals: [] }, 1)).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(calls).toBe(1);
  });
  it('validates payloads and results against shared schemas', async () => {
    let calls = 0;
    const api = new ApiClient(async () => { calls++; return new Response(JSON.stringify({ ok: true, data: { intervals: [] } })); }, () => 'key');
    api.signIn('credential');
    await expect(api.call('volunteer.availability.recurring.update', { intervals: [{ weekday: 1, start: '12:00', end: '09:00', timeZone: 'America/New_York' }] }, 1)).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(api.call('volunteer.availability.recurring.update', { intervals: [] }, 1)).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('requires a current revision and clears credentials on sign out', async () => {
    let calls = 0;
    const api = new ApiClient(async () => { calls++; return success(); }, () => 'key');
    api.signIn('credential');
    await expect(api.call('volunteer.availability.recurring.update', { intervals: [] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    api.signOut();
    await expect(api.call('session.me', {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(calls).toBe(0);
  });
  it('rejects unexpected response envelopes and unreadable JSON', async () => {
    for (const body of ['not JSON', JSON.stringify({ data: {} }), JSON.stringify({ ok: true, data: {}, extra: true })]) {
      const api = new ApiClient(async () => new Response(body), () => 'key'); api.signIn('credential');
      await expect(api.call('session.me', {})).rejects.toThrow();
    }
  });
});
