import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AttemptBudget, HOST_VERSION_PROPAGATION_MS, OPERATION_READS, ReadBudget, campaignLedgerPaths, classifyFailure, isStagingHost, parseArguments, planFor, readTimingsFrom, readsFor, summarize, validateManifest } from '../../../scripts/staging/measure-worker.mjs';

/**
 * Contract tests for the campaign harness: the rolling-window Sheets read
 * budget, the failure taxonomy, manifest validation for the benchmark
 * operation, and the staging-host shape guard that also covers the gateway.
 */

describe('workload budget', () => {
  it('shares one delayed first ledger load across concurrent reservations', async () => {
    const now = 1_000_000;
    const readBudget = new ReadBudget(10, 60_000, () => now);
    const readLoads: Array<() => void> = [];
    let readLoadCalls = 0;
    readBudget.loadLedger = async () => {
      readLoadCalls += 1;
      await new Promise<void>((resolve) => { readLoads.push(resolve); });
      readBudget.spent = [now - 1_000];
    };
    const readFirst = readBudget.reserve(1);
    const readSecond = readBudget.reserve(1);
    const concurrentReadLoads = readLoadCalls;
    readLoads[0]?.();
    await readFirst;
    readLoads[1]?.();
    await readSecond;

    const attemptBudget = new AttemptBudget(10);
    const attemptLoads: Array<() => void> = [];
    let attemptLoadCalls = 0;
    attemptBudget.loadLedger = async () => {
      attemptLoadCalls += 1;
      await new Promise<void>((resolve) => { attemptLoads.push(resolve); });
      attemptBudget.spent = 4;
    };
    const attemptFirst = attemptBudget.reserve();
    const attemptSecond = attemptBudget.reserve();
    const concurrentAttemptLoads = attemptLoadCalls;
    attemptLoads[0]?.();
    await attemptFirst;
    attemptLoads[1]?.();
    await attemptSecond;

    expect({
      concurrentReadLoads,
      readReservationsObserved: readBudget.observed(),
      concurrentAttemptLoads,
      attemptsObserved: attemptBudget.observed()
    }).toEqual({
      concurrentReadLoads: 1,
      readReservationsObserved: 3,
      concurrentAttemptLoads: 1,
      attemptsObserved: 6
    });
  });

  it('fails closed for unreadable or malformed existing ledgers while accepting missing ledgers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'staging-invalid-ledger-'));
    const now = 1_000_000;
    try {
      const missingReadBudget = new ReadBudget(10, 60_000, () => now, join(directory, 'missing-read.json'));
      await missingReadBudget.reserve(1);
      expect(missingReadBudget.observed()).toBe(1);

      const malformedReadPath = join(directory, 'malformed-read.json');
      await writeFile(malformedReadPath, '{not-json}\n', 'utf8');
      const malformedReadBudget = new ReadBudget(10, 60_000, () => now, malformedReadPath);
      await expect(malformedReadBudget.reserve(1)).rejects.toThrow(/read-budget ledger is malformed/u);
      expect(malformedReadBudget.observed()).toBe(0);

      const invalidReadPath = join(directory, 'invalid-read.json');
      await writeFile(invalidReadPath, '{"spent":["not-a-timestamp"]}\n', 'utf8');
      const invalidReadBudget = new ReadBudget(10, 60_000, () => now, invalidReadPath);
      await expect(invalidReadBudget.reserve(1)).rejects.toThrow(/read-budget ledger has an invalid format/u);
      expect(invalidReadBudget.observed()).toBe(0);

      const unreadableReadPath = join(directory, 'read-ledger-directory');
      await mkdir(unreadableReadPath);
      const unreadableReadBudget = new ReadBudget(10, 60_000, () => now, unreadableReadPath);
      await expect(unreadableReadBudget.reserve(1)).rejects.toThrow(/read-budget ledger could not be read/u);
      expect(unreadableReadBudget.observed()).toBe(0);

      const unreadableAttemptBudget = new AttemptBudget(10, unreadableReadPath);
      await expect(unreadableAttemptBudget.reserve()).rejects.toThrow(/attempt-budget ledger could not be read/u);
      expect(unreadableAttemptBudget.observed()).toBe(0);

      const malformedAttemptPath = join(directory, 'malformed-attempt.json');
      await writeFile(malformedAttemptPath, '{not-json}\n', 'utf8');
      const malformedAttemptBudget = new AttemptBudget(10, malformedAttemptPath);
      await expect(malformedAttemptBudget.reserve()).rejects.toThrow(/attempt-budget ledger is malformed/u);
      expect(malformedAttemptBudget.observed()).toBe(0);

      const invalidAttemptPath = join(directory, 'invalid-attempt.json');
      await writeFile(invalidAttemptPath, '{"spent":-1}\n', 'utf8');
      const invalidAttemptBudget = new AttemptBudget(10, invalidAttemptPath);
      await expect(invalidAttemptBudget.reserve()).rejects.toThrow(/attempt-budget ledger has an invalid format/u);
      expect(invalidAttemptBudget.observed()).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('budgets the preview operation at two reads like the other domain reads', () => {
    expect(OPERATION_READS['session.me']).toBe(1);
    expect(OPERATION_READS['admin.schedule.read']).toBe(2);
    expect(OPERATION_READS['admin.insights.read']).toBe(2);
    expect(OPERATION_READS['admin.schedule.preview']).toBe(2);
  });

  it('lets a portable manifest declare what a read actually costs, and defaults to the campaign constant', () => {
    const base = { operations: ['admin.schedule.read', 'session.me'] };
    // No override: the archived campaign's counts, so every existing manifest
    // behaves exactly as it did.
    expect(readsFor(base, 'admin.schedule.read')).toBe(2);
    expect(readsFor(base, 'session.me')).toBe(1);
    // A portable deployment pays the bracket's extra control read, and the
    // ledger paces on the reservation, so the manifest has to say so.
    const portable = { operations: ['admin.schedule.read', 'session.me'], readsPerRequest: { 'admin.schedule.read': 3, 'session.me': 1 } };
    expect(readsFor(portable, 'admin.schedule.read')).toBe(3);
    expect(readsFor(portable, 'session.me')).toBe(1);
  });

  it('refuses a read-cost override that would misprice the run', () => {
    const manifest = (readsPerRequest: unknown) => ({
      workerUrl: 'https://volunteer-scheduling-staging-gateway.example.workers.dev/exec',
      origins: ['http://localhost:8788'],
      operations: ['admin.schedule.read'],
      burst: { requests: 1, concurrency: 1 },
      sustained: { requests: 1, concurrency: 1 },
      reportPath: 'staging-local/contract-test-report.json',
      credentialPath: 'staging-local/credential-rehearsal.txt',
      readsPerRequest
    });
    expect(() => validateManifest(manifest([1]))).toThrowError(/readsPerRequest must be a JSON object/u);
    expect(() => validateManifest(manifest({ 'admin.schedule.read': 0 }))).toThrowError(/positive integer/u);
    expect(() => validateManifest(manifest({ 'admin.schedule.read': 2.5 }))).toThrowError(/positive integer/u);
    expect(() => validateManifest(manifest({ 'admin.unknown': 2 }))).toThrowError(/unsupported operation/u);
    expect(validateManifest(manifest({ 'admin.schedule.read': 3 })).readsPerRequest).toEqual({ 'admin.schedule.read': 3 });
  });

  it('keeps one campaign ledger wherever the report is written', () => {
    // Deriving the ledger from the report's directory looked shared but was not:
    // a report in a subdirectory of staging-local started a second rolling
    // window and a second attempt count, so the campaign cap and the per-minute
    // quota were enforced against the wrong numbers.
    const ledgers = campaignLedgerPaths();
    expect(ledgers.read).toBe(resolve('staging-local/.read-budget-ledger.json'));
    expect(ledgers.attempt).toBe(resolve('staging-local/.attempt-budget-ledger.json'));
    // The same two files every other staging tool uses, whatever its report path.
    expect(dirname(ledgers.attempt)).toBe(resolve('staging-local'));
  });

  it('flushes a budget ledger so a finished run is fully recorded', async () => {
    const ledgerPath = resolve('staging-local/.contract-test-flush.json');
    await writeFile(ledgerPath, '{"spent":[]}\n', 'utf8');
    const budget = new ReadBudget(10, 60_000, () => 1_000_000, ledgerPath);
    await budget.loadLedger();
    await budget.reserve(3);
    await budget.flush();
    expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toEqual({ spent: [1_000_000, 1_000_000, 1_000_000] });
    await rm(ledgerPath, { force: true });
  });

  it('paces reads across rolling 60-second windows', async () => {
    const start = Date.now();
    const budget = new ReadBudget(4, 30);
    await budget.reserve(4);
    expect(budget.observed()).toBe(4);
    // The next reservation must wait for the window to roll.
    await budget.reserve(1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
    expect(budget.observed()).toBe(1);
  });

  it('refuses a single request that cannot fit the window at all', async () => {
    const budget = new ReadBudget(4, 60_000);
    await expect(budget.reserve(5)).rejects.toThrow('read budget');
  });

  it('shares one rolling window across harness restarts through the ledger', async () => {
    const ledgerPath = resolve('staging-local/.contract-test-ledger.json');
    await writeFile(ledgerPath, '{"spent":[]}\n', 'utf8');
    let clock = 1_000_000;
    const now = () => clock;
    const first = new ReadBudget(4, 60_000, now, ledgerPath);
    await first.reserve(3);
    expect(first.observed()).toBe(3);
    // A second run (new budget, same ledger) must see the first run's reads.
    const second = new ReadBudget(4, 60_000, now, ledgerPath);
    await second.reserve(1);
    expect(second.observed()).toBe(4);
    // The window rolls for the shared ledger, not just for one process.
    clock += 61_000;
    const third = new ReadBudget(4, 60_000, now, ledgerPath);
    await third.reserve(4);
    expect(third.observed()).toBe(4);
    await rm(ledgerPath, { force: true });
  });
});

describe('failure taxonomy', () => {
  it('keeps every retained failure in exactly one bucket', () => {
    expect(classifyFailure(429, undefined)).toBe('429');
    expect(classifyFailure(503, undefined)).toBe('5xx');
    expect(classifyFailure(500, undefined)).toBe('5xx');
    expect(classifyFailure(200, { ok: false, error: { code: 'FORBIDDEN' } })).toBe('envelope-FORBIDDEN');
    expect(classifyFailure(200, { ok: false, error: { code: 'STALE_REVISION' } })).toBe('envelope-STALE_REVISION');
    expect(classifyFailure(200, { ok: true, data: {} })).toBe('parity-mismatch');
    expect(classifyFailure(0, undefined, Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout');
  });
});

describe('phase summaries', () => {
  it('summarizes each operation while excluding failed and version-lagged responses from latency populations', () => {
    const expectedHostDeployedAt = '2026-09-30T12:00:00.000Z';
    const summary = summarize([
      { operation: 'admin.schedule.read', durationMs: 100, sheetsReads: 3, inFlight: 1, observedMaxInFlightDuringRequest: 3, hostDeployedAt: expectedHostDeployedAt },
      { operation: 'admin.schedule.read', durationMs: 800, sheetsReads: 3, inFlight: 3, observedMaxInFlightDuringRequest: 4, failure: '5xx', hostDeployedAt: expectedHostDeployedAt },
      { operation: 'admin.schedule.read', durationMs: 900, sheetsReads: 1, inFlight: 4, observedMaxInFlightDuringRequest: 4, hostDeployedAt: '2026-09-30T11:00:00.000Z' },
      { operation: 'session.me', durationMs: 200, sheetsReads: 1, inFlight: 2, observedMaxInFlightDuringRequest: 3, hostDeployedAt: expectedHostDeployedAt }
    ], 60_000, expectedHostDeployedAt, ['admin.schedule.read', 'session.me', 'admin.insights.read']);

    // Keep the existing phase-level aggregate alongside the operation split.
    expect(summary).toMatchObject({
      attempts: 4,
      successes: 3,
      failures: { '5xx': 1 },
      versionLag: 1,
      latencyObservations: 2,
      wallTimeMs: { min: 100, p50: 100, p95: 200, p99: 200, max: 200 },
      latencyObservationsAtLeast3InFlight: 2,
      wallTimeMsAtLeast3InFlight: { min: 100, p50: 100, p95: 200, p99: 200, max: 200 },
      byOperation: {
        'admin.schedule.read': {
          attempts: 3,
          successes: 2,
          failures: { '5xx': 1 },
          versionLag: 1,
          latencyObservations: 1,
          wallTimeMs: { min: 100, p50: 100, p95: 100, p99: 100, max: 100 },
          latencyObservationsAtLeast3InFlight: 1,
          wallTimeMsAtLeast3InFlight: { min: 100, p50: 100, p95: 100, p99: 100, max: 100 },
          achieved: {
            observedMaxInFlight: 4,
            attemptsAtLeast3InFlight: 3,
            successfulObservationsAtLeast3InFlight: 1,
            versionLagAtLeast3InFlight: 1
          }
        },
        'session.me': {
          attempts: 1,
          successes: 1,
          failures: {},
          versionLag: 0,
          latencyObservations: 1,
          wallTimeMs: { min: 200, p50: 200, p95: 200, p99: 200, max: 200 },
          latencyObservationsAtLeast3InFlight: 1,
          wallTimeMsAtLeast3InFlight: { min: 200, p50: 200, p95: 200, p99: 200, max: 200 },
          achieved: {
            observedMaxInFlight: 3,
            attemptsAtLeast3InFlight: 1,
            successfulObservationsAtLeast3InFlight: 1,
            versionLagAtLeast3InFlight: 0
          }
        }
      }
    });
    // Failed and stale-version responses remain visible in counts, but cannot
    // distort the warm latency quantiles or the successful concurrency count.
    expect(summary.byOperation['admin.schedule.read']!.wallTimeMs.max).toBe(100);
    expect(summary.byOperation['admin.schedule.read']!.achieved.successfulObservationsAtLeast3InFlight).toBe(1);
    expect(summary.byOperation['admin.insights.read']!).toMatchObject({
      attempts: 0,
      successes: 0,
      failures: {},
      versionLag: 0,
      latencyObservations: 0,
      wallTimeMs: { min: null, p50: null, p95: null, p99: null, max: null },
      latencyObservationsAtLeast3InFlight: 0,
      wallTimeMsAtLeast3InFlight: { min: null, p50: null, p95: null, p99: null, max: null },
      achieved: {
        observedMaxInFlight: 0,
        attemptsAtLeast3InFlight: 0,
        successfulObservationsAtLeast3InFlight: 0,
        versionLagAtLeast3InFlight: 0
      }
    });
  });

  it('parses only complete per-read timing lists', () => {
    expect(readTimingsFrom('5, 10,0', 3)).toEqual([5, 10, 0]);
    expect(readTimingsFrom('5, 10', 3)).toBeNull();
    expect(readTimingsFrom('5, nope', 2)).toBeNull();
    expect(readTimingsFrom(null)).toBeNull();
  });
});

describe('manifest validation', () => {
  const manifest = {
    workerUrl: 'https://volunteer-scheduling-staging-gateway.workers.dev/benchmark/schedule-preview',
    origins: ['https://scheduling.example.test'],
    operations: ['admin.schedule.preview'],
    burst: { requests: 20, concurrency: 4 },
    sustained: { requests: 20, concurrency: 1 },
    reportPath: 'staging-local/measure-preview.json',
    credentialPath: 'staging-local/credential-x.txt'
  };

  it('accepts the benchmark operation and its endpoint', () => {
    const parsed = validateManifest(manifest);
    expect(parsed.operations).toEqual(['admin.schedule.preview']);
    expect(parsed.workerUrl).toContain('/benchmark/schedule-preview');
  });

  it('keeps the staging host guard working for the gateway workers.dev host', () => {
    expect(isStagingHost('volunteer-scheduling-staging-gateway.mnvsctitb.workers.dev')).toBe(true);
    expect(isStagingHost('volunteer-scheduling-staging.mnvsctitb.workers.dev')).toBe(true);
    expect(isStagingHost('example.workers.dev')).toBe(false);
    expect(isStagingHost('example.com')).toBe(false);
  });

  it('refuses an unsupported operation before any request is possible', () => {
    expect(() => validateManifest({ ...manifest, operations: ['admin.schedule.rerun'] })).toThrow('unsupported operation');
  });

  it('keeps report and credential paths inside staging-local', () => {
    expect(() => validateManifest({ ...manifest, reportPath: 'reports/measure.json' })).toThrow('staging-local');
    expect(() => validateManifest({ ...manifest, credentialPath: 'secrets/credential.txt' })).toThrow('staging-local');
  });

  it('requires a canonical deployed-at marker and publishes its readiness guard', () => {
    const hostDeployedAt = '2026-09-30T12:00:00.000Z';
    const parsed = validateManifest({ ...manifest, hostDeployedAt }, { requireHostDeployedAt: true });
    const readiness = planFor(parsed, Date.parse(hostDeployedAt) + HOST_VERSION_PROPAGATION_MS - 1_000).hostReadiness;
    expect(readiness).toEqual({
      required: true,
      minimumDelayMs: 95_000,
      readyAt: new Date(Date.parse(hostDeployedAt) + 95_000).toISOString(),
      waitRemainingMs: 1_000
    });
    expect(() => validateManifest({ ...manifest, hostDeployedAt: 'not-a-date' })).toThrow(/hostDeployedAt/u);
    expect(() => validateManifest({ ...manifest, hostDeployedAt: '2026-09-30' })).toThrow(/hostDeployedAt/u);
    expect(() => validateManifest({ ...manifest, hostDeployedAt: 1 })).toThrow(/hostDeployedAt/u);
    expect(() => validateManifest(manifest, { requireHostDeployedAt: true })).toThrow(/hostDeployedAt is required/u);
  });
});

describe('argument parsing', () => {
  it('requires the explicit confirm flag before sending anything', () => {
    const options = parseArguments(['--manifest', 'staging-local/measure-x.json', '--plan']);
    expect(options.plan).toBe(true);
    expect(options.confirmStaging).toBe(false);
    expect(() => parseArguments(['--unknown'])).toThrow('Unknown argument');
  });
});
