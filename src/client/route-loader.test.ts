import { describe, expect, it } from 'vitest';
import { RouteLoader, type RouteIdentity } from './route-loader.js';
import { parseDashboard, parseSchedule } from './main.js';

const volunteer: RouteIdentity = { email: 'volunteer@example.test', role: 'volunteer' };

interface RecordedRead {
  route: string;
  identity: RouteIdentity;
  generation: number;
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** A loader whose reads settle only when a test says so, for in-flight races. */
function deferredLoader() {
  const calls: RecordedRead[] = [];
  const pending: Array<(value: string) => void> = [];
  const loader = new RouteLoader<string>({
    read: (request) => {
      calls.push({ route: request.route, identity: request.identity, generation: request.generation });
      const call = deferredValue<string>();
      pending.push(call.resolve);
      return call.promise;
    }
  });
  loader.setIdentity(volunteer);
  return { loader, calls, settle: (index: number, value: string) => pending[index]?.(value) };
}

/** A loader that answers immediately with a value that names its identity scope. */
function immediateLoader() {
  const calls: RecordedRead[] = [];
  const loader = new RouteLoader<string>({
    read: async (request) => {
      calls.push({ route: request.route, identity: request.identity, generation: request.generation });
      return `${request.identity.email}:${request.identity.role}:${request.route}`;
    }
  });
  loader.setIdentity(volunteer);
  return { loader, calls };
}

describe('identity-scoped route snapshots', () => {
  it('paints the cached snapshot for the same identity and refreshes behind it', async () => {
    const { loader, calls, settle } = deferredLoader();
    const first = loader.load('schedule');
    settle(0, 'first');
    expect(await first).toMatchObject({ status: 'fresh', data: 'first' });
    expect(loader.cached('schedule')).toBe('first');
    expect(loader.cached('dashboard')).toBeUndefined();

    // A revisit can paint 'first' synchronously while the fresh read is in flight.
    const refresh = loader.load('schedule');
    expect(loader.cached('schedule')).toBe('first');
    expect(loader.isLoading('schedule')).toBe(true);
    settle(1, 'second');
    expect(await refresh).toMatchObject({ status: 'fresh', data: 'second' });
    expect(loader.cached('schedule')).toBe('second');
    expect(calls.map((call) => call.route)).toEqual(['schedule', 'schedule']);
  });

  it('keeps cached data when an identical identity is set again, and clears it when the role changes', async () => {
    const { loader, calls } = immediateLoader();
    await loader.load('dashboard');
    expect(loader.cached('dashboard')).toBe('volunteer@example.test:volunteer:dashboard');

    // A credential refresh re-reports the same profile; that must not empty the cache.
    loader.setIdentity({ ...volunteer });
    expect(loader.cached('dashboard')).toBe('volunteer@example.test:volunteer:dashboard');

    loader.setIdentity({ email: volunteer.email, role: 'administrator' });
    expect(loader.cached('dashboard')).toBeUndefined();
    loader.setIdentity({ email: 'other@example.test', role: 'administrator' });
    expect(loader.isLoading('dashboard')).toBe(false);

    const result = await loader.load('dashboard');
    expect(result).toMatchObject({ status: 'fresh', data: 'other@example.test:administrator:dashboard' });
    expect(loader.cached('dashboard')).toBe('other@example.test:administrator:dashboard');
    expect(calls).toHaveLength(2);
  });

  it('clears snapshots and in-flight reads on identity change and discards the late response', async () => {
    const { loader, calls, settle } = deferredLoader();
    const previousIdentity = loader.load('schedule');
    expect(loader.isLoading('schedule')).toBe(true);

    loader.setIdentity({ email: 'other@example.test', role: 'volunteer' });
    expect(loader.isLoading('schedule')).toBe(false);

    const currentIdentity = loader.load('schedule');
    expect(currentIdentity).not.toBe(previousIdentity);
    expect(calls).toHaveLength(2);
    settle(0, 'previous identity');
    settle(1, 'current identity');

    expect((await previousIdentity).status).toBe('discarded');
    expect(await currentIdentity).toMatchObject({ status: 'fresh', data: 'current identity' });
    expect(loader.cached('schedule')).toBe('current identity');
  });

  it('advances the load generation on every load and identity change', async () => {
    const { loader } = immediateLoader();
    const first = await loader.load('dashboard');
    const second = await loader.load('dashboard');
    expect(second.generation).toBeGreaterThan(first.generation);
    loader.setIdentity({ email: 'other@example.test', role: 'volunteer' });
    const third = await loader.load('dashboard');
    expect(third.generation).toBeGreaterThan(second.generation);
  });
});

describe('freshness checks without stale overwrite', () => {
  it('serves one read when two triggers request the same route', async () => {
    const { loader, calls, settle } = deferredLoader();
    const first = loader.load('schedule');
    const second = loader.load('schedule');
    expect(calls).toHaveLength(1);
    expect(second).toBe(first);

    settle(0, 'fresh');
    const [fromFirst, fromSecond] = await Promise.all([first, second]);
    expect(fromSecond).toEqual(fromFirst);
    expect(fromSecond).toMatchObject({ status: 'fresh', data: 'fresh' });
    expect(loader.isLoading('schedule')).toBe(false);
  });

  it('invalidating the active route after a mutation forces a fresh read', async () => {
    const { loader, calls } = immediateLoader();
    await loader.load('schedule');
    loader.invalidate('schedule');
    expect(loader.cached('schedule')).toBeUndefined();

    await loader.load('schedule');
    expect(calls).toHaveLength(2);
    expect(loader.cached('schedule')).toBe('volunteer@example.test:volunteer:schedule');
  });

  it('discards a read that a mutation superseded so it cannot overwrite the fresh result', async () => {
    const { loader, calls, settle } = deferredLoader();
    const beforeMutation = loader.load('schedule');
    // The mutation lands while the background refresh is still in flight.
    loader.invalidate('schedule');
    const afterMutation = loader.load('schedule');
    expect(afterMutation).not.toBe(beforeMutation);
    expect(calls).toHaveLength(2);

    settle(0, 'pre-mutation');
    settle(1, 'post-mutation');
    expect((await beforeMutation).status).toBe('discarded');
    expect(await afterMutation).toMatchObject({ status: 'fresh', data: 'post-mutation' });
    expect(loader.cached('schedule')).toBe('post-mutation');
  });

  it('reports a failed refresh and keeps the already displayed snapshot', async () => {
    let offline = false;
    const loader = new RouteLoader<string>({
      read: async () => {
        if (offline) throw new Error('offline');
        return 'valid data';
      }
    });
    loader.setIdentity(volunteer);
    await loader.load('insights');

    offline = true;
    const failed = await loader.load('insights');
    expect(failed).toMatchObject({ status: 'failed' });
    expect(loader.cached('insights')).toBe('valid data');
    expect(loader.isLoading('insights')).toBe(false);

    offline = false;
    expect(await loader.load('insights')).toMatchObject({ status: 'fresh', data: 'valid data' });
  });

  it('discards a load attempted without an authenticated identity', async () => {
    const { loader } = immediateLoader();
    loader.setIdentity(undefined);
    expect(loader.cached('schedule')).toBeUndefined();
    expect(await loader.load('schedule')).toMatchObject({ status: 'discarded' });
  });
});

// The route parsers live in main.ts, which this slice may only add to through
// exports; the contract they owe the mutation callbacks is asserted here.
describe('read response revision parsing', () => {
  it('takes the top-level revision that mutation callbacks must send', () => {
    const schedule = parseSchedule({
      revision: 12,
      inputRevision: 3,
      scheduleRevision: 11,
      sessions: [
        { id: 'session-1', date: '2026-09-04', start: '09:00', end: '10:00', requiredStaffCount: 1 }
      ]
    });
    expect(schedule.revision).toBe(12);
    expect(parseDashboard({ revision: 9, volunteer: { revision: 4 } }).revision).toBe(9);
  });

  it('parses a response without a top-level revision as undefined instead of throwing', () => {
    expect(parseSchedule({}).revision).toBeUndefined();
    expect(parseDashboard({}).revision).toBeUndefined();
    // A volunteer-scoped revision is not the global revision, so it is never used.
    expect(parseDashboard({ volunteer: { revision: 4 } }).revision).toBeUndefined();
  });
});
