import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttemptBudget, ReadBudget, campaignLedgerPaths } from '../../../scripts/staging/measure-worker.mjs';
import {
  conservativeReadsFor,
  createRehearsalCampaignBudgets,
  prepareRehearsalGatewayRead,
  prepareRehearsalStraddle,
  reserveThenReadBaseline,
  runRehearsalStraddle,
  straddleExpectationPassed
} from '../../../scripts/staging/rehearsal-request.mjs';

const CREDENTIAL = 'never-write-this-test-credential';
const HOST_DEPLOYED_AT = '2026-09-30T12:00:00.000Z';

describe('rehearsal gateway request budget and attempt contract', () => {
  let temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
    temporaryDirectories = [];
  });

  async function attemptLogPath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'rehearsal-request-contract-'));
    temporaryDirectories.push(directory);
    return join(directory, 'gateway-attempts.jsonl');
  }

  it('binds its default budget objects to measure-worker campaign ledger paths', () => {
    const paths = campaignLedgerPaths();
    const budgets = createRehearsalCampaignBudgets();
    expect((budgets.readBudget as ReadBudget & { ledgerPath: string }).ledgerPath).toBe(paths.read);
    expect((budgets.attemptLedger as AttemptBudget & { ledgerPath: string }).ledgerPath).toBe(paths.attempt);
  });

  it('reserves one attempt and four conservative reads before its one-shot gateway fetch', async () => {
    const order: string[] = [];
    const readBudget = { reserve: vi.fn(async (reads: number) => { order.push(`reads:${reads}`); }) };
    const attemptLedger = { reserve: vi.fn(async () => { order.push('attempt'); return true; }) };
    const fetchImpl = vi.fn(async () => {
      order.push('fetch');
      return new Response(JSON.stringify({ ok: true, rows: ['private rows'] }), {
        status: 200,
        headers: {
          'x-staging-sheets-reads': '3',
          'x-staging-read-ms': '1,2,3',
          'x-staging-host-deployed-at': '2026-09-30T00:00:00.000Z',
          'x-staging-correlation-id': 'corr-test'
        }
      });
    });
    const path = await attemptLogPath();
    const prepared = await prepareRehearsalGatewayRead({
      workerUrl: 'https://volunteer-scheduling-staging-gateway.example.workers.dev/exec',
      operation: 'admin.schedule.read',
      credential: CREDENTIAL,
      idempotencyKey: 'test-straddle',
      attemptLogPath: path,
      readBudget,
      attemptLedger,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(order).toEqual(['attempt', 'reads:4']);
    expect(fetchImpl).not.toHaveBeenCalled();
    const result = await prepared.start();
    expect(order).toEqual(['attempt', 'reads:4', 'fetch']);
    expect(result.response).toMatchObject({ status: 200, ok: true, sheetsReads: 3, readMs: '1,2,3', hasCorrelationId: true });
    expect(result.attempt.failure).toBeUndefined();
    await expect(prepared.start()).rejects.toThrowError(/only be started once/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const log = await readFile(path, 'utf8');
    expect(log).toContain('"reservedReads":4');
    expect(log).toContain('"status":200');
    expect(log).not.toContain(CREDENTIAL);
    expect(log).not.toContain('private rows');
  });

  it('uses conservative identity reads and rejects unknown or non-read gateway operations', () => {
    expect(conservativeReadsFor('session.me')).toBe(2);
    expect(conservativeReadsFor('admin.insights.read')).toBe(4);
    expect(() => conservativeReadsFor('admin.schedule.rebuild')).toThrowError(/known read operation/u);
  });

  it('fails before the transition or fetch when the campaign attempt budget is exhausted', async () => {
    const readBudget = { reserve: vi.fn(async () => undefined) };
    const attemptLedger = { reserve: vi.fn(async () => false) };
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const transition = vi.fn(async () => undefined);
    const path = await attemptLogPath();

    await expect(runRehearsalStraddle({
      prepare: () => prepareRehearsalGatewayRead({
        workerUrl: 'https://volunteer-scheduling-staging-gateway.example.workers.dev/exec',
        operation: 'admin.schedule.read',
        credential: CREDENTIAL,
        idempotencyKey: 'exhausted-straddle',
        attemptLogPath: path,
        readBudget,
        attemptLedger,
        fetchImpl: fetchImpl as unknown as typeof fetch
      }),
      fireMs: 0,
      transition
    })).rejects.toThrowError(/attempt budget is exhausted/u);

    expect(attemptLedger.reserve).toHaveBeenCalledTimes(1);
    expect(readBudget.reserve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('rereads the control baseline after a paced reservation and before starting the fetch', async () => {
    const order: string[] = [];
    let resumeReservation: (() => void) | undefined;
    const paced = new Promise<void>((resolvePaced) => { resumeReservation = resolvePaced; });
    const path = await attemptLogPath();
    const prepareAndRead = reserveThenReadBaseline({
      prepare: () => prepareRehearsalGatewayRead({
        workerUrl: 'https://volunteer-scheduling-staging-gateway.example.workers.dev/exec',
        operation: 'admin.schedule.read',
        credential: CREDENTIAL,
        idempotencyKey: 'paced-straddle',
        attemptLogPath: path,
        attemptLedger: { reserve: async () => { order.push('attempt-reserved'); return true; } },
        readBudget: { reserve: async () => { order.push('read-reservation-started'); await paced; order.push('read-reservation-finished'); } },
        fetchImpl: (async () => {
          order.push('fetch');
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch
      }),
      readBaseline: async () => { order.push('baseline-reread'); return 'fresh-control-tuple'; }
    });

    await vi.waitFor(() => expect(order).toContain('read-reservation-started'));
    expect(order).toEqual(['attempt-reserved', 'read-reservation-started']);
    expect(resumeReservation).toBeDefined();
    resumeReservation?.();
    const { prepared, baseline } = await prepareAndRead;
    expect(baseline).toBe('fresh-control-tuple');
    expect(order).toEqual(['attempt-reserved', 'read-reservation-started', 'read-reservation-finished', 'baseline-reread']);

    await runRehearsalStraddle({
      prepare: () => prepared,
      fireMs: 0,
      transition: async () => { order.push('transition'); }
    });
    expect(order.indexOf('baseline-reread')).toBeLessThan(order.indexOf('fetch'));
    expect(order.indexOf('fetch')).toBeLessThan(order.indexOf('transition'));
  });

  it('enforces the 95-second host wait before reserving either campaign budget', async () => {
    let now = Date.parse(HOST_DEPLOYED_AT);
    const order: string[] = [];
    const path = await attemptLogPath();
    const result = await prepareRehearsalStraddle({
      expectedHostDeployedAt: HOST_DEPLOYED_AT,
      readinessOptions: {
        now: () => now,
        wait: async (durationMs: number) => {
          order.push(`host-wait:${durationMs}`);
          now += durationMs;
        }
      },
      prepare: () => prepareRehearsalGatewayRead({
        workerUrl: 'https://volunteer-scheduling-staging-gateway.example.workers.dev/exec',
        operation: 'admin.schedule.read',
        credential: CREDENTIAL,
        idempotencyKey: 'host-ready-straddle',
        attemptLogPath: path,
        expectedHostDeployedAt: HOST_DEPLOYED_AT,
        attemptLedger: { reserve: async () => { order.push('attempt-reserved'); return true; } },
        readBudget: { reserve: async () => { order.push('reads-reserved'); } },
        fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'x-staging-host-deployed-at': HOST_DEPLOYED_AT }
        })) as typeof fetch
      }),
      readBaseline: async () => { order.push('baseline-reread'); return 'fresh-tuple'; }
    });

    expect(result.hostReadiness).toMatchObject({ required: true, waitedMs: 95_000 });
    expect(order).toEqual(['host-wait:95000', 'attempt-reserved', 'reads-reserved', 'baseline-reread']);
    const attempt = await result.prepared.start();
    expect(attempt.attempt.failure).toBeUndefined();
    expect(straddleExpectationPassed('ok', attempt.response, attempt.attempt)).toBe(true);
  });

  it('records marker mismatch as version-lag and rejects an otherwise matching pinned refusal', async () => {
    const path = await attemptLogPath();
    const prepared = await prepareRehearsalGatewayRead({
      workerUrl: 'https://volunteer-scheduling-staging-gateway.example.workers.dev/exec',
      operation: 'admin.schedule.read',
      credential: CREDENTIAL,
      idempotencyKey: 'lagging-straddle',
      attemptLogPath: path,
      expectedHostDeployedAt: HOST_DEPLOYED_AT,
      readBudget: { reserve: async () => undefined },
      attemptLedger: { reserve: async () => true },
      fetchImpl: (async () => new Response(JSON.stringify({
        ok: false,
        error: { code: 'STALE_REVISION', details: { reason: 'control-generation_changed' } }
      }), {
        status: 200,
        headers: { 'x-staging-host-deployed-at': '2026-09-30T11:59:59.000Z' }
      })) as typeof fetch
    });

    const result = await prepared.start();
    expect(result.attempt).toMatchObject({
      expectedHostDeployedAt: HOST_DEPLOYED_AT,
      hostDeployedAt: '2026-09-30T11:59:59.000Z',
      versionLag: true,
      failure: 'version-lag',
      responseFailure: 'envelope-STALE_REVISION'
    });
    expect(result.response).toMatchObject({
      status: 200,
      errorCode: 'STALE_REVISION',
      reason: 'control-generation_changed',
      versionLag: true
    });
    expect(straddleExpectationPassed('STALE_REVISION:control-generation_changed', result.response, result.attempt)).toBe(false);
    expect(straddleExpectationPassed('STALE_REVISION:control-generation_changed', {
      status: 503,
      ok: false,
      errorCode: 'STALE_REVISION',
      reason: 'control-generation_changed'
    }, {})).toBe(false);
    const log = await readFile(path, 'utf8');
    expect(log).toContain('"failure":"version-lag"');
    expect(log).not.toContain(CREDENTIAL);
  });

  it('retains a transport failure when the straddle transition also fails, without retrying', async () => {
    const order: string[] = [];
    const readBudget = { reserve: vi.fn(async (reads: number) => { order.push(`reads:${reads}`); }) };
    const attemptLedger = { reserve: vi.fn(async () => { order.push('attempt'); return true; }) };
    const fetchImpl = vi.fn(async () => {
      order.push('fetch');
      throw new TypeError('connection reset');
    });
    const transition = vi.fn(async () => {
      order.push('transition');
      throw new Error('control write failed');
    });
    const path = await attemptLogPath();
    const outcome = await runRehearsalStraddle({
      prepare: () => prepareRehearsalGatewayRead({
        workerUrl: 'https://volunteer-scheduling-staging-gateway.example.workers.dev/exec',
        operation: 'admin.schedule.read',
        credential: CREDENTIAL,
        idempotencyKey: 'transport-straddle',
        attemptLogPath: path,
        readBudget,
        attemptLedger,
        fetchImpl: fetchImpl as unknown as typeof fetch
      }),
      fireMs: 0,
      transition,
      wait: async () => { order.push('wait'); }
    });

    expect(outcome.transitionError).toMatchObject({ name: 'Error', message: 'control write failed' });
    expect(outcome.gateway).toMatchObject({ value: { attempt: { failure: 'transport' } } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(order.indexOf('fetch')).toBeLessThan(order.indexOf('transition'));
    const log = await readFile(path, 'utf8');
    expect(log).toContain('"failure":"transport"');
    expect(log).toContain('connection reset');
    expect(log).not.toContain(CREDENTIAL);
    expect(attemptLedger.reserve).toHaveBeenCalledTimes(1);
    expect(readBudget.reserve).toHaveBeenCalledWith(4);
  });

  it('retains a failed HTTP response as a single private attempt', async () => {
    const path = await attemptLogPath();
    const prepared = await prepareRehearsalGatewayRead({
      workerUrl: 'https://volunteer-scheduling-staging-gateway.example.workers.dev/exec',
      operation: 'admin.insights.read',
      credential: CREDENTIAL,
      idempotencyKey: 'http-failure',
      attemptLogPath: path,
      readBudget: { reserve: async () => undefined },
      attemptLedger: { reserve: async () => true },
      fetchImpl: (async () => new Response(JSON.stringify({ ok: false, error: { code: 'UNAVAILABLE' } }), { status: 503 })) as typeof fetch
    });

    const result = await prepared.start();
    expect(result.response).toMatchObject({ status: 503, ok: false, errorCode: 'UNAVAILABLE' });
    expect(result.attempt.failure).toBe('5xx');
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
});
