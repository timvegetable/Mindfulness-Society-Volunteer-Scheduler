import { describe, expect, it, vi } from 'vitest';
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

const scheduleData = { dataRevision: 1, schedulingInputRevision: 1, run: null, assignments: [], backups: [], shortfalls: [], sessions: [], volunteers: [], centers: [], stale: true };
const reply = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
const sessionData = (credential: string, expiresAt = Date.now() + 600000) => ({ dataRevision: 1, schedulingInputRevision: 1,
  user: { id: 'admin', email: 'admin@example.test', roles: ['administrator'], volunteerId: null, centerIds: [], active: true },
  centers: [], scheduleRead: { credential, expiresAt } });
describe('schedule read sessions', () => {
  it('uses a memory-only read ticket for schedules and keeps Google credentials for other operations', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const api = new ApiClient(async (input, init) => {
      const body = JSON.parse(String(init?.body)); calls.push({ path: String(input), body });
      if (body.operation === 'session.me') return reply(sessionData('read-ticket'));
      if (body.operation === 'admin.schedule.read') return reply(scheduleData);
      return success();
    });
    api.signIn('google'); await api.call('session.me', {}); await api.call('admin.schedule.read', {});
    await api.call('volunteer.availability.recurring.update', { intervals: [] }, 1);
    expect(calls.map(call => [call.path, call.body.credential])).toEqual([['/api','google'],['/api/schedule','read-ticket'],['/api','google']]);
  });
  it('shares an expiry-triggered exchange between concurrent explicit reads', async () => {
    let exchanges = 0, reads = 0;
    const api = new ApiClient(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.operation === 'session.me') return reply(sessionData(++exchanges === 1 ? 'expired' : 'renewed', exchanges === 1 ? 0 : Date.now()+600000));
      reads++; expect(body.credential).toBe('renewed'); return reply(scheduleData);
    });
    api.signIn('google'); await api.call('session.me', {});
    await Promise.all([api.call('admin.schedule.read', {}),api.call('admin.schedule.read', {})]);
    expect(exchanges).toBe(2); expect(reads).toBe(2);
  });
  it('renews once after an invalid read ticket, but never retries a forbidden read', async () => {
    let exchanges = 0, reads = 0;
    const api = new ApiClient(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.operation === 'session.me') return reply(sessionData('ticket-'+(++exchanges)));
      reads++;
      if (reads === 1) return new Response(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Expired' } }), { status: 401 });
      if (reads === 3) return new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'Revoked' } }), { status: 403 });
      return reply(scheduleData);
    });
    api.signIn('google'); await api.call('session.me', {}); await api.call('admin.schedule.read', {});
    await expect(api.call('admin.schedule.read', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(exchanges).toBe(2); expect(reads).toBe(3);
  });
  it('does not restore an old read ticket after sign-out races an exchange', async () => {
    let resolve!: (response: Response) => void;
    const api = new ApiClient(() => new Promise<Response>(done => { resolve = done; }));
    api.signIn('google'); const pending = api.call('session.me', {}); api.signOut();
    resolve(reply(sessionData('old-ticket')));
    await expect(pending).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(api.call('admin.schedule.read', {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

it('acquires a read session when cutover happens while the new client is already open', async () => {
  const paths: string[] = [];
  const api = new ApiClient(async (input, init) => {
    paths.push(String(input)); const body = JSON.parse(String(init?.body));
    if (body.operation === 'session.me') return reply(sessionData('cutover-ticket'));
    if (input === '/api') return new Response(JSON.stringify({ ok: false, error: { code: 'INVALID_REQUEST',
      message: 'Refresh this application to read the schedule.', details: { scheduleReadProtocol: 1 } } }), { status: 400 });
    expect(body.credential).toBe('cutover-ticket'); return reply(scheduleData);
  });
  api.signIn('google');
  expect(await api.call('admin.schedule.read', {})).toEqual(scheduleData);
  expect(paths).toEqual(['/api','/api','/api/schedule']);
});

const readSessionData = (credential: string, expiresAt = Date.now() + 600000) => {
  const { scheduleRead: _legacy, ...session } = sessionData(credential, expiresAt);
  return { ...session, readSession: { credential, expiresAt } };
};
const proposalsData = { dataRevision: 1, schedulingInputRevision: 1, centers: [], candidates: [] };
describe('general read sessions', () => {
  it('uses the same bounded read session across schedule and other reads while writes keep Google credentials', async () => {
    const calls: { path: string; credential: string }[] = [];
    const api = new ApiClient(async (input, init) => {
      const body = JSON.parse(String(init?.body)); calls.push({ path: String(input), credential: body.credential });
      if (body.operation === 'session.me') return reply(readSessionData('r2.read-session'));
      if (body.operation === 'admin.schedule.read') return reply(scheduleData);
      if (body.operation === 'center.candidate.read') return reply(proposalsData);
      return success();
    });
    api.signIn('google'); await api.call('session.me', {});
    await api.call('center.candidate.read', {}); await api.call('admin.schedule.read', {});
    await api.call('volunteer.availability.recurring.update', { intervals: [] }, 1);
    expect(calls).toEqual([{ path: '/api', credential: 'google' }, { path: '/api', credential: 'r2.read-session' },
      { path: '/api/schedule', credential: 'r2.read-session' }, { path: '/api', credential: 'google' }]);
  });
  it('shares expiry renewal across mixed explicit reads and never retries forbidden reads', async () => {
    let exchanges = 0, reads = 0;
    const api = new ApiClient(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.operation === 'session.me') return reply(readSessionData('r2.'+(++exchanges), exchanges === 1 ? 0 : Date.now()+600000));
      reads++; expect(body.credential).toBe('r2.2');
      if (reads === 3) return new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'Revoked' } }), { status: 403 });
      return reply(body.operation === 'admin.schedule.read' ? scheduleData : proposalsData);
    });
    api.signIn('google'); await api.call('session.me', {});
    await Promise.all([api.call('center.candidate.read', {}), api.call('admin.schedule.read', {})]);
    await expect(api.call('center.candidate.read', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(exchanges).toBe(2); expect(reads).toBe(3);
  });
  it('renews once after invalidation and recovers a live protocol cutover without a Google read fallback', async () => {
    let exchanges = 0, reads = 0;
    const api = new ApiClient(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.operation === 'session.me') return reply(readSessionData('r2.'+(++exchanges)));
      reads++;
      if (body.credential === 'google') return new Response(JSON.stringify({ ok: false, error: { code: 'INVALID_REQUEST',
        message: 'Reload', details: { readSessionProtocol: 2 } } }), { status: 400 });
      if (body.credential === 'r2.1' && reads > 2) return new Response(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Expired' } }), { status: 401 });
      return reply(proposalsData);
    });
    api.signIn('google'); await api.call('center.candidate.read', {}); await api.call('center.candidate.read', {});
    expect(exchanges).toBe(2); expect(reads).toBe(4);
  });
});

describe('split sign-in exchange', () => {
  const upgrade = () => new Response(JSON.stringify({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Use split sign-in.', details: { signInProtocol: 3 } } }), { status: 400 });
  // The server validates proof times; browser clock skew must not reject a valid handoff.
  const proof = () => reply({ credential: 'g1.proof', expiresAt: 1 });
  it('learns the protocol, keeps the proof out of writes, and shares renewal across reads', async () => {
    const calls: { path: string; credential: string }[] = []; let exchanges = 0;
    const api = new ApiClient(async (input, init) => {
      const body = JSON.parse(String(init?.body)); calls.push({ path: String(input), credential: body.credential });
      if (input === '/api/identity') return proof();
      if (body.operation === 'session.me') {
        if (body.credential === 'google') return upgrade();
        expect(body.credential).toBe('g1.proof');
        const data = sessionData('unused'); const { scheduleRead: _, ...session } = data;
        return reply({ ...session, readSession: { credential: 'r2.read', expiresAt: ++exchanges === 1 ? 0 : Date.now() + 900000 } });
      }
      if (body.operation === 'admin.schedule.read') return reply(scheduleData);
      if (body.operation === 'admin.sync.read') return reply({ dataRevision: 1, schedulingInputRevision: 1, status: null, history: [], pending: [], mappings: [], volunteers: [], job: null });
      return success();
    });
    api.signIn('google'); await api.call('session.me', {});
    await Promise.all([api.call('admin.schedule.read', {}), api.call('admin.schedule.read', {})]);
    await api.call('volunteer.availability.recurring.update', { intervals: [] }, 1);
    expect(calls.map(call => [call.path, call.credential])).toEqual([
      ['/api','google'], ['/api/identity','google'], ['/api','g1.proof'],
      ['/api/identity','google'], ['/api','g1.proof'], ['/api/schedule','r2.read'], ['/api/schedule','r2.read'], ['/api','google'],
    ]);
  });
  it('does not exchange a proof after sign-out races Google verification', async () => {
    let done!: (response: Response) => void; let calls = 0;
    const api = new ApiClient(async (input) => {
      calls++; return input === '/api' ? upgrade() : new Promise<Response>(resolve => { done = resolve; });
    });
    api.signIn('google'); const pending = api.call('session.me', {});
    await vi.waitFor(() => expect(done).toBeTypeOf('function'));
    api.signOut(); done(proof());
    await expect(pending).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(calls).toBe(2);
  });
  it('propagates verification failures and rejects invalid proofs without retrying', async () => {
    for (const response of [
      new Response(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid Google sign-in.' } }), { status: 401 }),
      reply({ credential: 'r2.wrong-purpose', expiresAt: Date.now() + 60000 }),
      reply({ credential: 'g1.' + 'x'.repeat(8192), expiresAt: 1 }),
      reply({ credential: 'g1.proof', expiresAt: -1 }),
      new Response('invalid JSON'),
    ]) {
      let calls = 0;
      const api = new ApiClient(async input => { calls++; return input === '/api' ? upgrade() : response; });
      api.signIn('google'); await expect(api.call('session.me', {})).rejects.toThrow(); expect(calls).toBe(2);
    }
  });
});


it('requests the compact synchronization response contract explicitly', async () => {
  const api = new ApiClient(async (_input, init) => {
    expect(new Headers(init?.headers).get('X-Sync-Read-Protocol')).toBe('2');
    return reply({ dataRevision: 1, schedulingInputRevision: 1,
      status: { lastAttemptAt: null, lastSuccessAt: null, effectiveChangeAt: null, outcome: 'never', diagnostic: null, participantCount: 0, matchedCount: 0, pendingCount: 0 },
      pending: [], imports: [], volunteers: [] });
  });
  api.signIn('google');
  expect((await api.call('admin.sync.read', {})).imports).toEqual([]);
});
