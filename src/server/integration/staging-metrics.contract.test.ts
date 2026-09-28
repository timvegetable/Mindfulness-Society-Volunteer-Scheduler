import { describe, expect, it } from 'vitest';
import {
  campaignPercentiles,
  coverageCheck,
  invocationsQuery,
  mergeRows,
  resolveWindow,
  splitWindows,
  summarizeDurableObjects,
  summarizeInvocations
} from '../../../scripts/staging/collect-metrics.mjs';

/**
 * Metric-logic contract tests for the platform attribution repair (task 3.5).
 *
 * The collector's pure functions are pinned here because the verdict's gates
 * depend on them: explicit attribution, documented units, quantiles used only
 * for their actual population, pagination and window splitting, ambiguity and
 * truncation detection, and coverage that can fail a gate.
 */

const row = (datetime: string, status: string, scriptName: string, requests: number, cpu?: { p50: number; p90: number; p99: number }) => ({
  sum: { requests, errors: 0, subrequests: 0 },
  quantiles: cpu === undefined ? {} : { cpuTimeP50: cpu.p50, cpuTimeP90: cpu.p90, cpuTimeP99: cpu.p99 },
  dimensions: { datetime, status, scriptName }
});

describe('attribution and quantile semantics', () => {
  it('reports only the scripts the platform named and flags placeholder attribution as ambiguous', () => {
    const named = summarizeInvocations([row('2026-09-27T23:00:00Z', 'success', 'volunteer-scheduling-staging-gateway', 12, { p50: 900, p90: 2000, p99: 3000 })]);
    expect(named.scriptNames).toEqual(['volunteer-scheduling-staging-gateway']);
    expect(named.attribution.ambiguous).toBe(false);

    const placeholder = summarizeInvocations([row('2026-09-27T23:00:00Z', 'success', '__unknown__', 12, { p50: 900, p90: 2000, p99: 3000 })]);
    expect(placeholder.attribution.ambiguous).toBe(true);

    const empty = summarizeInvocations([]);
    expect(empty.attribution.ambiguous).toBe(true);
  });

  it('treats a single-request bucket as an exact sample and never rescales it', () => {
    const summary = summarizeInvocations([row('2026-09-27T23:00:01Z', 'success', 'gateway', 1, { p50: 4200, p90: 4200, p99: 4200 })]);
    expect(summary.cpu.exactSamples).toBe(1);
    expect(summary.cpu.bucketAggregates).toEqual([]);
    // The exact sample is preserved as-is; no division by request counts.
    expect(summary.cpu.campaignQuantiles.derivable).toBe(false);
  });

  it('keeps multi-request buckets as aggregates with their population and derives nothing from them', () => {
    const summary = summarizeInvocations([
      row('2026-09-27T23:00:01Z', 'success', 'gateway', 4, { p50: 1000, p90: 2000, p99: 8000 }),
      row('2026-09-27T23:00:02Z', 'success', 'gateway', 2, { p50: 500, p90: 900, p99: 1200 })
    ]);
    expect(summary.requests).toBe(6);
    expect(summary.cpu.exactSamples).toBe(0);
    expect(summary.cpu.bucketAggregates).toHaveLength(2);
    expect(summary.cpu.bucketAggregates[0]).toMatchObject({ requests: 4, p50Us: 1000, p99Us: 8000 });
    // A maximum bucket quantile is never labelled the campaign percentile.
    expect(summary.cpu.campaignQuantiles.derivable).toBe(false);
    expect(summary.cpu.worstBucket).toMatchObject({ requests: 4, p99Us: 8000 });
  });

  it('derives campaign percentiles only from a population dominated by exact samples', () => {
    const rows = Array.from({ length: 45 }, (_unused, index) =>
      row(`2026-09-27T23:00:${String(index % 60).padStart(2, '0')}Z${index}`, 'success', 'gateway', 1, { p50: 1000 + index, p90: 1000 + index, p99: 1000 + index }));
    const summary = summarizeInvocations(rows);
    expect(summary.cpu.exactSamples).toBe(45);
    expect(summary.cpu.campaignQuantiles.derivable).toBe(true);
    if (summary.cpu.campaignQuantiles.derivable) {
      expect(summary.cpu.campaignQuantiles.population).toBe(45);
      expect(summary.cpu.campaignQuantiles.p99Us).toBe(1044);
      expect(summary.cpu.campaignQuantiles.maxUs).toBe(1044);
    }
    const pooled = campaignPercentiles([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000]);
    expect(pooled).toMatchObject({ population: 10, p50Us: 5000, p99Us: 10_000, maxUs: 10_000 });
  });
});

describe('window splitting and merge semantics', () => {
  it('splits a window into hourly slices', () => {
    const slices = splitWindows(new Date('2026-09-27T22:00:00Z'), new Date('2026-09-27T23:30:00Z'));
    expect(slices).toHaveLength(2);
    expect(slices[0]?.until.toISOString()).toBe('2026-09-27T23:00:00.000Z');
    expect(slices[1]?.since.toISOString()).toBe('2026-09-27T23:00:00.000Z');
  });

  it('merges duplicate buckets by summing instead of dropping', () => {
    const merged = mergeRows([
      row('2026-09-27T23:00:00Z', 'success', 'gateway', 2, { p50: 100, p90: 200, p99: 300 }),
      row('2026-09-27T23:00:00Z', 'success', 'gateway', 3, { p50: 150, p90: 250, p99: 350 })
    ]);
    expect(merged).toHaveLength(1);
    expect((merged[0] as { sum: { requests: number } }).sum.requests).toBe(5);
  });

  it('scopes the invocation query to the named scripts and a bounded window', () => {
    const since = new Date('2026-09-27T23:00:00Z');
    const until = new Date('2026-09-27T23:10:00Z');
    const query = invocationsQuery('account', ['gateway', 'host'], since, until);
    expect(query).toContain('scriptName_in: ["gateway", "host"]');
    expect(query).toContain('datetime_geq: "2026-09-27T23:00:00.000Z"');
    expect(query).toContain('workersInvocationsAdaptive(limit: 100');
    expect(query).not.toContain('__unknown__');
  });
});

describe('coverage gates', () => {
  it('refuses to pass on missing or unattributed records', () => {
    expect(coverageCheck(100, 80).sufficient).toBe(false);
    expect(coverageCheck(100, 100).sufficient).toBe(true);
    expect(coverageCheck(100, 101).sufficient).toBe(true);
    const unchecked = coverageCheck(undefined, 50);
    expect(unchecked.checked).toBe(false);
    expect(unchecked.reason).toContain('cannot support a pass');
  });

  it('keeps the window resolver explicit', () => {
    const window = resolveWindow({ since: '2026-09-27T23:00:00Z', until: '2026-09-27T23:10:00Z' });
    expect(window.until.getTime() - window.since.getTime()).toBe(10 * 60 * 1000);
    expect(() => resolveWindow({ since: 'nope', until: '2026-09-27T23:10:00Z' })).toThrow('ISO');
  });
});

describe('Durable Object platform records', () => {
  it('reports object requests, CPU in microseconds and isolate memory in bytes', () => {
    const summary = summarizeDurableObjects(
      [{ sum: { requests: 12 }, dimensions: { datetime: '2026-09-27T23:00:00Z', namespaceId: 'ns-1' } }],
      [{ sum: { cpuTime: 1_500_000 }, quantiles: { memoryUsageBytesP50: 30 * 1024 * 1024, memoryUsageBytesP99: 41 * 1024 * 1024 }, dimensions: { datetime: '2026-09-27T23:00:00Z', namespaceId: 'ns-1' } }]
    );
    expect(summary.requests).toBe(12);
    expect(summary.namespaces).toEqual(['ns-1']);
    expect(summary.cpuTime.totalUs).toBe(1_500_000);
    expect(summary.memory.isolateP99MiB).toBeCloseTo(41, 1);
    expect(summary.memory.samples).toBe(1);
  });

  it('leaves billable duration unresolved when the platform does not publish it', () => {
    const summary = summarizeDurableObjects([], []);
    expect(summary.billableDuration.status).toBe('unresolved');
    expect(summary.memory.isolateP99Bytes).toBeNull();
  });
});
