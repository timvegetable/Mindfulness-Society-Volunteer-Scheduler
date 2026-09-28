import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATION_READS, ReadBudget, classifyFailure, isStagingHost, parseArguments, validateManifest } from '../../../scripts/staging/measure-worker.mjs';

/**
 * Contract tests for the campaign harness: the rolling-window Sheets read
 * budget, the failure taxonomy, manifest validation for the benchmark
 * operation, and the staging-host shape guard that also covers the gateway.
 */

describe('workload budget', () => {
  it('budgets the preview operation at two reads like the other domain reads', () => {
    expect(OPERATION_READS['session.me']).toBe(1);
    expect(OPERATION_READS['admin.schedule.read']).toBe(2);
    expect(OPERATION_READS['admin.insights.read']).toBe(2);
    expect(OPERATION_READS['admin.schedule.preview']).toBe(2);
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
    await writeFile(ledgerPath, '[]\n', 'utf8');
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
});

describe('argument parsing', () => {
  it('requires the explicit confirm flag before sending anything', () => {
    const options = parseArguments(['--manifest', 'staging-local/measure-x.json', '--plan']);
    expect(options.plan).toBe(true);
    expect(options.confirmStaging).toBe(false);
    expect(() => parseArguments(['--unknown'])).toThrow('Unknown argument');
  });
});
