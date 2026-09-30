import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATION_READS, ReadBudget, campaignLedgerPaths, classifyFailure, isStagingHost, parseArguments, readsFor, validateManifest } from '../../../scripts/staging/measure-worker.mjs';

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
    await writeFile(ledgerPath, '{"spent":0}\n', 'utf8');
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
