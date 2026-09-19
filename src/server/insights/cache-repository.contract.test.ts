import { describe, expect, it } from 'vitest';
import type { Volunteer } from '../../shared/domain.js';
import { CacheInsightRepository, type ScriptCache } from './cache-repository.js';
import { InsightStore } from './store.js';
import type { InsightConfig, InsightDataset, InsightSourceRevision } from './types.js';

const CONFIG: InsightConfig = {
  timeZone: 'America/New_York',
  incrementMinutes: 30,
  operatingHours: { start: '09:00', end: '21:00' },
};

const NOW = '2026-09-19T12:00:00.000Z';

const volunteer: Volunteer = {
  id: 'volunteer-1',
  name: 'Ada Lovelace',
  email: 'ada@example.edu',
  lifecycleStatus: 'active',
  interviewStatus: 'complete',
  readinessRank: 1,
  recurringAvailability: [{ weekday: 1, start: '09:00', end: '11:00', timeZone: 'America/New_York' }],
  revision: 3,
  source: 'sheet',
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
};

function dataset(overrides: Partial<InsightDataset> = {}): InsightDataset {
  return {
    sourceRevision: { assignmentRevision: 12, assignmentRowsRevision: 13, eligibilityRevision: 4, availabilityRevision: 7 },
    generatedAt: NOW,
    stale: false,
    staleReasons: [],
    leftoverVolunteers: [volunteer],
    cells: [{ weekday: 1, start: '09:00', end: '09:30', timeZone: 'America/New_York', count: 1, volunteerIds: ['volunteer-1'] }],
    ...overrides,
  };
}

class FakeCache implements ScriptCache {
  readonly entries = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string; seconds: number }> = [];
  refusing = false;

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  put(key: string, value: string, seconds: number): void {
    if (this.refusing) throw new Error('cache is unavailable');
    this.entries.set(key, value);
    this.puts.push({ key, value, seconds });
  }
}

function fakeClock(start = NOW) {
  let current = start;
  return {
    now: () => current,
    advance(seconds: number): void {
      current = new Date(Date.parse(current) + seconds * 1000).toISOString();
    },
  };
}

function populate(repository: CacheInsightRepository, value: InsightDataset, cache: FakeCache): string {
  repository.write(value);
  const key = cache.puts[0]?.key;
  if (!key) throw new Error('expected the repository to write a cache entry');
  return key;
}

describe('cached insight repository', () => {
  it('returns an equal, independent copy of a written dataset', () => {
    const cache = new FakeCache();
    const repository = new CacheInsightRepository({ cache, config: CONFIG, clock: fakeClock() });
    const stored = dataset();
    const original = structuredClone(stored);

    repository.write(stored);
    const first = repository.read();
    const second = repository.read();

    expect(first).toEqual(original);
    expect(stored).toEqual(original);
    expect(cache.puts[0]?.seconds).toBe(300);
    expect(first).not.toBe(second);
    expect(first?.leftoverVolunteers[0]).not.toBe(stored.leftoverVolunteers[0]);

    if (!first) throw new Error('expected a cached dataset');
    first.cells[0]!.count = 99;
    first.leftoverVolunteers[0]!.name = 'Changed';
    expect(repository.read()).toEqual(original);
  });

  it('skips the write and reads a miss when the payload exceeds 90 KiB', () => {
    const cache = new FakeCache();
    const repository = new CacheInsightRepository({ cache, config: CONFIG, clock: fakeClock() });
    const oversized = dataset({
      cells: Array.from({ length: 1500 }, (_, index) => ({
        weekday: 1 as const,
        start: '09:00',
        end: '09:30',
        timeZone: 'America/New_York',
        count: 1,
        volunteerIds: ['volunteer-1', `volunteer-${index}`],
      })),
    });
    expect(JSON.stringify(oversized).length).toBeGreaterThan(90 * 1024);

    repository.write(oversized);

    expect(cache.puts).toHaveLength(0);
    expect(cache.entries.size).toBe(0);
    expect(repository.read()).toBeUndefined();
  });

  it('treats an absent, empty, or corrupt entry as a miss instead of throwing', () => {
    const cache = new FakeCache();
    const repository = new CacheInsightRepository({ cache, config: CONFIG, clock: fakeClock() });

    expect(repository.read()).toBeUndefined();

    const key = populate(repository, dataset(), cache);
    for (const corrupt of ['', 'not json at all', '{"fingerprint":"other","expiresAt":1,"sourceRevision":{},"dataset":{}}', '[1,2,3]']) {
      cache.entries.set(key, corrupt);
      expect(repository.read()).toBeUndefined();
    }
  });

  it('misses when the stored revision drifts from the dataset revision', () => {
    const cache = new FakeCache();
    const repository = new CacheInsightRepository({ cache, config: CONFIG, clock: fakeClock() });
    const revision = { assignmentRevision: 12, eligibilityRevision: 4, availabilityRevision: 7, assignmentRowsRevision: 3 } as InsightSourceRevision;

    const key = populate(repository, dataset({ sourceRevision: revision }), cache);
    expect(repository.read()).toBeDefined();

    const stored = JSON.parse(String(cache.entries.get(key))) as {
      sourceRevision: Record<string, number>;
    };
    stored.sourceRevision.assignmentRowsRevision = 4;
    cache.entries.set(key, JSON.stringify(stored));
    expect(repository.read()).toBeUndefined();

    stored.sourceRevision.assignmentRowsRevision = 3;
    stored.sourceRevision.eligibilityRevision = 5;
    cache.entries.set(key, JSON.stringify(stored));
    expect(repository.read()).toBeUndefined();
  });

  it('never serves one configuration from another configuration key', () => {
    const cache = new FakeCache();
    const written = new CacheInsightRepository({ cache, config: CONFIG, clock: fakeClock() });
    const otherHours = new CacheInsightRepository({ cache, config: { ...CONFIG, operatingHours: { start: '10:00', end: '20:00' } }, clock: fakeClock() });
    const otherIncrement = new CacheInsightRepository({ cache, config: { ...CONFIG, incrementMinutes: 15 }, clock: fakeClock() });

    written.write(dataset());

    expect(written.read()).toBeDefined();
    expect(otherHours.read()).toBeUndefined();
    expect(otherIncrement.read()).toBeUndefined();
  });

  it('stops serving an entry once its own 300 second lifetime has passed', () => {
    const cache = new FakeCache();
    const clock = fakeClock();
    const repository = new CacheInsightRepository({ cache, config: CONFIG, clock });

    repository.write(dataset());
    clock.advance(300);
    expect(repository.read()).toBeDefined();
    clock.advance(1);
    expect(repository.read()).toBeUndefined();
  });

  it('serves a derived dataset to a later execution without regenerating it', () => {
    const cache = new FakeCache();
    const clock = fakeClock();
    const first = new InsightStore({ repository: new CacheInsightRepository({ cache, config: CONFIG, clock }), clock });
    const generated = first.regenerate({
      volunteers: [volunteer],
      assignments: [],
      sourceRevision: { assignmentRevision: 0, assignmentRowsRevision: 0, eligibilityRevision: 3, availabilityRevision: 0 },
      config: CONFIG,
    });

    const later = new InsightStore({ repository: new CacheInsightRepository({ cache, config: CONFIG, clock }), clock });
    const cached = later.get(generated.sourceRevision);

    expect(generated.cells).not.toHaveLength(0);
    expect(cached).toEqual(generated);
    expect(cached?.generatedAt).toBe(generated.generatedAt);
    expect(cached?.stale).toBe(false);
  });

  it('survives a cache that refuses the write', () => {
    const cache = new FakeCache();
    cache.refusing = true;
    const repository = new CacheInsightRepository({ cache, config: CONFIG, clock: fakeClock() });

    expect(() => repository.write(dataset())).not.toThrow();
    expect(repository.read()).toBeUndefined();
  });
});
