import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlReadCheck, evaluateExpectation, type ControlReadCheckResult } from '../../../scripts/staging/control-read-check.mjs';
import { AttemptBudget, ReadBudget } from '../../../scripts/staging/measure-worker.mjs';
import { createReadApi } from '../../worker/read-api.js';
import { INTEGRATION_OPERATIONS, OPERATION_POLICIES } from './request-policy.js';
import {
  exitCodeFor,
  planFor,
  reportFor,
  runReadChecks,
  validateCheckList,
  type ReadCheckEntry
} from '../../../scripts/staging/control-read-checks.mjs';

/**
 * The control read check is a measurement tool, so its contract is: it reports
 * exactly what the service said, it never puts a credential or a row value into
 * its result, and the expectation comparison is strict about the failure reason.
 * The read-matrix driver adds the rehearsal's rules: one paced read and one
 * campaign attempt per declared check, every field a matrix row needs retained,
 * and a nonzero command whenever an expectation is unmet. These tests contact
 * nothing.
 */

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const DRIVER = join(ROOT, 'scripts/staging/control-read-checks.mjs');
const WORKER_URL = 'https://volunteer-scheduling-staging-gateway.example-account.workers.dev/exec';
const EXPECTED_HOST_DEPLOYED_AT = '2026-09-29T21:47:50.265Z';

/** A declared list, normalized exactly as the command validates it. */
function checkList(checks: ReadCheckEntry[], hostDeployedAt = EXPECTED_HOST_DEPLOYED_AT) {
  return validateCheckList({
    workerUrl: WORKER_URL,
    hostDeployedAt,
    credentialPath: 'staging-local/credential-rehearsal.txt',
    reportPath: 'staging-local/read-matrix-representative.json',
    checks
  });
}

/** One scripted answer per read, so pacing and retention are observable. */
function fetchSequence(answers: Array<{ status?: number; body: unknown; headers?: Record<string, string> } | Error>) {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const index = calls.length;
    calls.push(init);
    const answer = answers[index];
    if (answer === undefined) throw new Error(`unexpected read ${index + 1}`);
    if (answer instanceof Error) throw answer;
    return {
      status: answer.status ?? 200,
      headers: { get: (name: string) => (answer.headers ?? {})[name.toLowerCase()] ?? null },
      json: async () => answer.body
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'staging-readcheck-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runDriver(args: string[]) {
  const result = spawnSync(process.execPath, [DRIVER, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function withChecks(list: unknown, run: (path: string) => Promise<void>): Promise<void> {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, 'checks.json');
    await writeFile(path, JSON.stringify(list), 'utf8');
    await run(path);
  });
}

const servedAnswer = { body: { ok: true, data: { revision: 43 } }, headers: { 'x-staging-sheets-reads': '4', 'x-staging-read-ms': '3,5,8,13', 'x-staging-correlation-id': 'corr-1', 'x-staging-host-deployed-at': EXPECTED_HOST_DEPLOYED_AT } };

function fetchReturning(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => body
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const servedHeaders = { 'x-staging-sheets-reads': '4', 'x-staging-read-ms': '3,5,8,13', 'x-staging-correlation-id': 'corr-1', 'x-staging-host-deployed-at': EXPECTED_HOST_DEPLOYED_AT };

describe('control read check', () => {
  it('posts the operation envelope with the credential and reports the service answer', async () => {
    const { fetchImpl, calls } = fetchReturning(200, { ok: true, data: { revision: 43 } }, servedHeaders);

    const result = await controlReadCheck({ workerUrl: 'https://staging.example/exec', operation: 'admin.schedule.read', credential: 'credential-value', idempotencyKey: 'check-1', fetchImpl });

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ operation: 'admin.schedule.read', idempotencyKey: 'check-1', credential: 'credential-value' });
    expect(calls[0]?.init.method).toBe('POST');
    expect(result).toEqual({
      status: 200,
      durationMs: expect.any(Number) as unknown as number,
      ok: true,
      errorCode: undefined,
      reason: undefined,
      sheetsReads: 4,
      readMs: [3, 5, 8, 13],
      hostDeployedAt: EXPECTED_HOST_DEPLOYED_AT,
      expectedHostDeployedAt: null,
      versionMatch: null,
      hasCorrelationId: true,
      hasHostMarker: true
    });
    // No credential or row value may appear anywhere in the result.
    expect(JSON.stringify(result)).not.toContain('credential-value');
  });

  it('reports a bounded refusal with its code and reason', async () => {
    const { fetchImpl } = fetchReturning(200, { ok: false, error: { code: 'UNAVAILABLE', message: 'not now', details: { reason: 'control-pending' } } }, { 'x-staging-sheets-reads': '1' });

    const result = await controlReadCheck({ workerUrl: 'https://staging.example/exec', operation: 'admin.schedule.read', credential: 'c', fetchImpl });

    expect(result).toMatchObject({ ok: false, errorCode: 'UNAVAILABLE', reason: 'control-pending', sheetsReads: 1, hasCorrelationId: false, hasHostMarker: false });
  });

  it('never throws on a response that is not JSON', async () => {
    const fetchImpl = (async () => ({ status: 503, headers: { get: () => null }, json: async () => { throw new Error('not json'); } }) as unknown as Response) as unknown as typeof fetch;

    const result = await controlReadCheck({ workerUrl: 'https://staging.example/exec', operation: 'admin.schedule.read', credential: 'c', fetchImpl });

    expect(result).toMatchObject({ status: 503, ok: false, errorCode: undefined, sheetsReads: null, readMs: null, hostDeployedAt: null });
  });

  it('keeps absent read counts unknown and rejects timings that do not align with the reported count', async () => {
    const missing = await controlReadCheck({
      workerUrl: 'https://staging.example/exec',
      operation: 'admin.schedule.read',
      credential: 'c',
      fetchImpl: fetchReturning(200, { ok: true }, { 'x-staging-read-ms': '5,10' }).fetchImpl
    });
    const mismatch = await controlReadCheck({
      workerUrl: 'https://staging.example/exec',
      operation: 'admin.schedule.read',
      credential: 'c',
      fetchImpl: fetchReturning(200, { ok: true }, { 'x-staging-sheets-reads': '3', 'x-staging-read-ms': '5,10' }).fetchImpl
    });

    expect(missing).toMatchObject({ sheetsReads: null, readMs: null });
    expect(mismatch).toMatchObject({ sheetsReads: 3, readMs: null });
  });

  it('measures through response body hydration with an injected clock', async () => {
    let now = 1_000;
    const { fetchImpl } = fetchReturning(200, { ok: true }, servedHeaders);
    const delayedFetch = (async (url: string, init: RequestInit) => {
      const response = await fetchImpl(url, init) as unknown as Response;
      return {
        status: response.status,
        headers: response.headers,
        json: async () => {
          now += 41;
          return response.json();
        }
      } as unknown as Response;
    }) as typeof fetch;

    const result = await controlReadCheck({ workerUrl: 'https://staging.example/exec', operation: 'admin.schedule.read', credential: 'c', fetchImpl: delayedFetch, now: () => now });

    expect(result.durationMs).toBe(41);
  });
});

describe('expectation comparison', () => {
  const served: ControlReadCheckResult = { status: 200, durationMs: 12, ok: true, sheetsReads: 4, readMs: null, hostDeployedAt: EXPECTED_HOST_DEPLOYED_AT, expectedHostDeployedAt: null, versionMatch: null, hasCorrelationId: true, hasHostMarker: true };
  const refused = (code: string, reason: string): ControlReadCheckResult => ({ status: 200, durationMs: 9, ok: false, errorCode: code, reason, sheetsReads: 1, readMs: null, hostDeployedAt: EXPECTED_HOST_DEPLOYED_AT, expectedHostDeployedAt: null, versionMatch: null, hasCorrelationId: true, hasHostMarker: true });

  it('accepts a served read against the served expectation', () => {
    expect(evaluateExpectation(served, 'ok')).toMatchObject({ passed: true });
  });

  it('requires both the code and the named reason for a refusal', () => {
    expect(evaluateExpectation(refused('UNAVAILABLE', 'control-pending'), 'failed:UNAVAILABLE:control-pending')).toMatchObject({ passed: true });
    expect(evaluateExpectation(refused('UNAVAILABLE', 'control-missing'), 'failed:UNAVAILABLE:control-pending').passed).toBe(false);
    expect(evaluateExpectation(refused('STALE_REVISION', 'control-generation_changed'), 'failed:UNAVAILABLE').passed).toBe(false);
    expect(evaluateExpectation(served, 'failed:UNAVAILABLE').passed).toBe(false);
  });

  it('reports a mismatch with what actually happened', () => {
    expect(evaluateExpectation(served, 'failed:UNAVAILABLE:control-pending').detail).toContain('got served');
    expect(evaluateExpectation(refused('UNAVAILABLE', 'control-pending'), 'ok').detail).toContain('control-pending');
  });

  it('refuses an unparseable expectation rather than passing it', () => {
    expect(evaluateExpectation(served, 'anything').passed).toBe(false);
    expect(evaluateExpectation(served, 'failed').passed).toBe(false);
  });

  it('does not accept a matching error envelope on HTTP 429 or 500', () => {
    expect(evaluateExpectation({ ...refused('UNAUTHORIZED', ''), status: 429 }, 'failed:UNAUTHORIZED').passed).toBe(false);
    expect(evaluateExpectation({ ...refused('UNAUTHORIZED', ''), status: 500 }, 'failed:UNAUTHORIZED').passed).toBe(false);
  });

  it('requires HTTP 200, the expected host marker, and a reported zero-read policy refusal', () => {
    expect(evaluateExpectation({ ...served, status: 429 }, 'ok').passed).toBe(false);
    expect(evaluateExpectation({ ...refused('FORBIDDEN', ''), status: 500 }, 'failed:FORBIDDEN').passed).toBe(false);
    expect(evaluateExpectation({ ...served, expectedHostDeployedAt: EXPECTED_HOST_DEPLOYED_AT, versionMatch: true }, 'ok').passed).toBe(true);
    expect(evaluateExpectation({ ...served, expectedHostDeployedAt: EXPECTED_HOST_DEPLOYED_AT, hostDeployedAt: '2026-09-28T21:47:50.265Z', versionMatch: false }, 'ok').passed).toBe(false);
    expect(evaluateExpectation({ ...served, expectedHostDeployedAt: EXPECTED_HOST_DEPLOYED_AT, hostDeployedAt: null, versionMatch: false }, 'failed:FORBIDDEN').passed).toBe(false);
    expect(evaluateExpectation({ ...refused('FORBIDDEN', ''), sheetsReads: null }, 'failed:FORBIDDEN', { requireZeroReads: true }).passed).toBe(false);
    expect(evaluateExpectation({ ...refused('FORBIDDEN', ''), sheetsReads: 1 }, 'failed:FORBIDDEN', { requireZeroReads: true }).passed).toBe(false);
    expect(evaluateExpectation({ ...refused('FORBIDDEN', ''), sheetsReads: 0 }, 'failed:FORBIDDEN', { requireZeroReads: true }).passed).toBe(true);
  });
});

describe('read-matrix driver', () => {
  it('runs a declared list, records every matrix field and keeps one attempt per check', async () => {
    await withTemporaryDirectory(async (directory) => {
      const attemptLog = join(directory, 'matrix.json.attempts.jsonl');
      const budget = new ReadBudget(undefined, undefined, undefined, join(directory, '.read-budget-ledger.json'));
      const attemptLedger = new AttemptBudget(undefined, join(directory, '.attempt-budget-ledger.json'));
      const { fetchImpl, calls } = fetchSequence([
        servedAnswer,
        { body: { ok: false, error: { code: 'UNAVAILABLE', details: { reason: 'control-pending' } } }, headers: { 'x-staging-sheets-reads': '1', 'x-staging-host-deployed-at': EXPECTED_HOST_DEPLOYED_AT } }
      ]);
      const list = checkList([
        { label: 'served domain read', operation: 'admin.schedule.read', expectation: 'ok' },
        { label: 'pending refusal', operation: 'admin.schedule.read', expectation: 'failed:UNAVAILABLE:control-pending', reads: 1 }
      ]);

      const { results, passed } = await runReadChecks(list, { credential: 'credential-value', budget, attemptLedger, attemptLog, fetchImpl });

      expect(passed).toBe(true);
      expect(calls).toHaveLength(2);
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        index: 0,
        label: 'served domain read',
        operation: 'admin.schedule.read',
        expectation: 'ok',
        issued: true,
        status: 200,
        code: null,
        reason: null,
        reads: 4,
        readMs: [3, 5, 8, 13],
        hostDeployedAt: EXPECTED_HOST_DEPLOYED_AT,
        expectedHostDeployedAt: EXPECTED_HOST_DEPLOYED_AT,
        versionMatch: true,
        plannedReads: 2,
        durationMs: expect.any(Number) as unknown as number,
        observedInFlight: 1,
        passed: true,
        detail: 'served'
      });
      expect(results[1]).toMatchObject({
        index: 1,
        label: 'pending refusal',
        operation: 'admin.schedule.read',
        expectation: 'failed:UNAVAILABLE:control-pending',
        status: 200,
        code: 'UNAVAILABLE',
        reason: 'control-pending',
        reads: 1,
        hostDeployedAt: EXPECTED_HOST_DEPLOYED_AT,
        versionMatch: true,
        plannedReads: 1,
        observedInFlight: 1,
        passed: true
      });
      // No credential or row value may appear anywhere in a result.
      expect(JSON.stringify(results)).not.toContain('credential-value');
      // Retention is one line per check, in check order.
      const lines = (await readFile(attemptLog, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => (JSON.parse(line) as { index: number }).index)).toEqual([0, 1]);
      expect(attemptLedger.observed()).toBe(2);
    });
  });

  it('reports an unmet expectation without stopping the rest of the matrix', async () => {
    await withTemporaryDirectory(async (directory) => {
      const list = checkList([
        { operation: 'admin.schedule.read', expectation: 'ok' },
        { operation: 'session.me', expectation: 'ok' }
      ]);
      const { fetchImpl, calls } = fetchSequence([
        { body: { ok: false, error: { code: 'UNAVAILABLE', details: { reason: 'control-authority_mismatch' } } }, headers: { 'x-staging-sheets-reads': '1', 'x-staging-host-deployed-at': EXPECTED_HOST_DEPLOYED_AT } },
        servedAnswer
      ]);

      const { results, passed } = await runReadChecks(list, {
        credential: 'c',
        budget: new ReadBudget(),
        attemptLedger: new AttemptBudget(),
        attemptLog: join(directory, 'matrix.jsonl'),
        fetchImpl
      });

      expect(passed).toBe(false);
      expect(calls).toHaveLength(2);
      expect(results[0]).toMatchObject({ passed: false, code: 'UNAVAILABLE', reason: 'control-authority_mismatch' });
      expect(results[0]?.detail).toContain('expected a served read');
      expect(results[1]?.passed).toBe(true);
    });
  });

  it('retains a read that failed in transport as a spent attempt and never retries it', async () => {
    await withTemporaryDirectory(async (directory) => {
      const list = checkList([{ operation: 'admin.schedule.read', expectation: 'ok' }]);
      for (const [error, failure] of [
        [new Error('connection refused'), 'transport'],
        [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout']
      ] as const) {
        const { fetchImpl, calls } = fetchSequence([error]);
        const attemptLedger = new AttemptBudget();
        const { results, passed } = await runReadChecks(list, {
          credential: 'c',
          budget: new ReadBudget(),
          attemptLedger,
          attemptLog: join(directory, `${failure}.jsonl`),
          fetchImpl
        });

        expect(passed, failure).toBe(false);
        expect(calls, failure).toHaveLength(1);
        expect(results[0], failure).toMatchObject({ issued: true, status: 0, reads: null, observedInFlight: 1, passed: false, failure });
        expect(attemptLedger.observed(), failure).toBe(1);
      }
    });
  });

  it('spends its declared reads inside the shared rolling window', async () => {
    await withTemporaryDirectory(async (directory) => {
      const ledgerPath = join(directory, '.read-budget-ledger.json');
      const budget = new ReadBudget(undefined, undefined, undefined, ledgerPath);
      const list = checkList([
        { operation: 'session.me', expectation: 'ok' },
        { operation: 'admin.schedule.read', expectation: 'ok', reads: 4 }
      ]);
      const { fetchImpl } = fetchSequence([servedAnswer, servedAnswer]);

      const { passed } = await runReadChecks(list, {
        credential: 'c',
        budget,
        attemptLedger: new AttemptBudget(),
        attemptLog: join(directory, 'matrix.jsonl'),
        fetchImpl
      });

      expect(passed).toBe(true);
      // The identity read's pinned cost plus the domain check's declared cost: a
      // portable read reserves what it actually spends.
      expect(budget.observed()).toBe(5);
      // A second process shares the same window through the ledger file.
      const reopened = new ReadBudget(undefined, undefined, undefined, ledgerPath);
      await reopened.loadLedger();
      expect(reopened.observed()).toBe(5);
      expect((JSON.parse(await readFile(ledgerPath, 'utf8')) as { spent: number[] }).spent).toHaveLength(5);
    });
  });

  it('refuses a check larger than the whole window before spending an attempt', async () => {
    await withTemporaryDirectory(async (directory) => {
      const attemptLedger = new AttemptBudget();
      const list = checkList([{ operation: 'admin.schedule.read', expectation: 'ok', reads: 41 }]);
      const { fetchImpl, calls } = fetchSequence([servedAnswer]);

      await expect(runReadChecks(list, {
        credential: 'c',
        budget: new ReadBudget(),
        attemptLedger,
        attemptLog: join(directory, 'matrix.jsonl'),
        fetchImpl
      })).rejects.toThrow('more than the whole 40-read window');

      expect(calls).toHaveLength(0);
      expect(attemptLedger.observed()).toBe(0);
    });
  });

  it('shares the campaign attempt ledger across restarts and stops at its cap', async () => {
    await withTemporaryDirectory(async (directory) => {
      const ledgerPath = join(directory, '.attempt-budget-ledger.json');
      const threeChecks = checkList([
        { operation: 'session.me', expectation: 'ok' },
        { operation: 'admin.schedule.read', expectation: 'ok' },
        { operation: 'admin.insights.read', expectation: 'ok' }
      ]);
      const { fetchImpl, calls } = fetchSequence([servedAnswer, servedAnswer, servedAnswer]);
      const attemptLedger = new AttemptBudget(undefined, ledgerPath);

      const { passed } = await runReadChecks(threeChecks, {
        credential: 'c',
        budget: new ReadBudget(),
        attemptLedger,
        attemptLog: join(directory, 'matrix.jsonl'),
        fetchImpl
      });

      expect(passed).toBe(true);
      expect(calls).toHaveLength(3);
      expect(attemptLedger.observed()).toBe(3);
      expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toEqual({ spent: 3 });
      // A restart continues the campaign count instead of believing a new one began.
      const reopened = new AttemptBudget(undefined, ledgerPath);
      await reopened.loadLedger();
      expect(reopened.observed()).toBe(3);

      // A spent cap stops the run rather than over-issuing; the check that could
      // not reserve an attempt is retained as not issued.
      const cappedLedger = new AttemptBudget(1, join(directory, '.capped-ledger.json'));
      const capped = fetchSequence([servedAnswer]);
      const cappedRun = await runReadChecks(checkList([
        { operation: 'session.me', expectation: 'ok' },
        { operation: 'session.me', expectation: 'ok' }
      ]), {
        credential: 'c',
        budget: new ReadBudget(),
        attemptLedger: cappedLedger,
        attemptLog: join(directory, 'capped.jsonl'),
        fetchImpl: capped.fetchImpl
      });

      expect(cappedRun.passed).toBe(false);
      expect(capped.calls).toHaveLength(1);
      expect(cappedLedger.observed()).toBe(1);
      expect(cappedRun.results[1]).toMatchObject({ issued: false, status: 0, reads: null, observedInFlight: 0, passed: false });
      expect(cappedRun.results[1]?.detail).toContain('attempt budget is spent');
    });
  });
});

describe('read-matrix driver command', () => {
  const validList = {
    workerUrl: WORKER_URL,
    credentialPath: 'staging-local/credential-rehearsal.txt',
    reportPath: 'staging-local/read-matrix-representative.json',
    checks: [
      { label: 'served Schedule', operation: 'admin.schedule.read', expectation: 'ok' },
      { label: 'pending refusal', operation: 'admin.schedule.read', expectation: 'failed:UNAVAILABLE:control-pending', reads: 1 }
    ]
  };

  it('requires a canonical marker for confirmed runs while allowing an unmarked dry plan', () => {
    const legacyPlan = validateCheckList(validList);
    expect(planFor(legacyPlan, new ReadBudget(), new AttemptBudget(), 0).hostReadiness).toEqual({
      required: false,
      minimumDelayMs: 95_000,
      readyAt: null,
      waitRemainingMs: null
    });
    expect(() => validateCheckList(validList, { requireHostDeployedAt: true })).toThrow(/hostDeployedAt is required/u);
    expect(() => validateCheckList({ ...validList, hostDeployedAt: 'not-a-time' })).toThrow(/hostDeployedAt/u);
  });

  it('allows only the named registered rerun mutator as a conservative zero-read policy probe', async () => {
    const operation = INTEGRATION_OPERATIONS.adminScheduleRerun;
    expect(operation).toBe('admin.schedule.rerun');
    expect(OPERATION_POLICIES[operation].mutating).toBe(true);

    const normalized = checkList([{ operation, expectation: 'failed:FORBIDDEN' }]);
    expect(normalized.checks[0]).toMatchObject({ operation, expectation: 'failed:FORBIDDEN', reads: 2, policyRefusal: true });

    expect(() => checkList([{ operation, expectation: 'ok' }])).toThrow(/requires expectation failed:FORBIDDEN/u);
    expect(() => checkList([{ operation, expectation: 'failed:READ_ONLY' }])).toThrow(/requires expectation failed:FORBIDDEN/u);
    expect(() => checkList([{ operation, expectation: 'failed:FORBIDDEN', reads: 1 }])).toThrow(/at least 2 reads/u);
    expect(() => checkList([{ operation: 'admin.insights.refresh', expectation: 'failed:FORBIDDEN' }])).toThrow(/unsupported operation/u);

    let dispatchCalls = 0;
    const api = createReadApi({
      origins: [],
      dispatch: async () => {
        dispatchCalls += 1;
        return { ok: true, data: {} } as never;
      }
    });
    const response = await api.fetch(new Request('https://staging.example/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ operation, payload: {}, idempotencyKey: 'read-only-policy-probe', credential: 'test-only' })
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(dispatchCalls).toBe(0);
  });

  it('passes the rerun refusal only with an explicit zero-read header and matching marker', async () => {
    await withTemporaryDirectory(async (directory) => {
      const operation = INTEGRATION_OPERATIONS.adminScheduleRerun;
      const list = checkList([{ operation, expectation: 'failed:FORBIDDEN' }]);
      const answer = {
        body: { ok: false, error: { code: 'FORBIDDEN' } },
        headers: { 'x-staging-sheets-reads': '0', 'x-staging-host-deployed-at': EXPECTED_HOST_DEPLOYED_AT }
      };
      const budget = new ReadBudget();
      const attemptLedger = new AttemptBudget();
      const passing = await runReadChecks(list, {
        credential: 'c',
        budget,
        attemptLedger,
        attemptLog: join(directory, 'policy-zero-reads.jsonl'),
        fetchImpl: fetchSequence([answer]).fetchImpl
      });
      expect(passing.passed).toBe(true);
      expect(passing.results[0]).toMatchObject({ reads: 0, readMs: null, versionMatch: true, passed: true, policyRefusal: true });
      expect(budget.observed()).toBe(2);
      expect(attemptLedger.observed()).toBe(1);

      const incompleteHeaders: Array<Record<string, string>> = [
        { 'x-staging-host-deployed-at': EXPECTED_HOST_DEPLOYED_AT },
        { 'x-staging-sheets-reads': '1', 'x-staging-host-deployed-at': EXPECTED_HOST_DEPLOYED_AT }
      ];
      for (const [index, headers] of incompleteHeaders.entries()) {
        const result = await runReadChecks(list, {
          credential: 'c',
          budget: new ReadBudget(),
          attemptLedger: new AttemptBudget(),
          attemptLog: join(directory, `policy-not-zero-${index}.jsonl`),
          fetchImpl: fetchSequence([{ ...answer, headers }]).fetchImpl
        });
        expect(result.passed).toBe(false);
        expect(result.results[0]?.detail).toMatch(/expected zero reported Sheets reads/u);
      }
    });
  });

  it('omits a per-check credential in none mode and retains the measured zero-read header', async () => {
    await withTemporaryDirectory(async (directory) => {
      const list = checkList([{ operation: 'session.me', expectation: 'failed:UNAUTHORIZED', credentialMode: 'none' }]);
      const { fetchImpl, calls } = fetchSequence([{
        body: { ok: false, error: { code: 'UNAUTHORIZED' } },
        headers: { 'x-staging-sheets-reads': '0', 'x-staging-host-deployed-at': EXPECTED_HOST_DEPLOYED_AT }
      }]);
      const result = await runReadChecks(list, {
        credential: 'captured-admin-credential',
        budget: new ReadBudget(),
        attemptLedger: new AttemptBudget(),
        attemptLog: join(directory, 'no-credential.jsonl'),
        fetchImpl
      });
      const body = JSON.parse(String(calls[0]?.body)) as Record<string, unknown>;
      expect(Object.hasOwn(body, 'credential')).toBe(false);
      expect(result.passed).toBe(true);
      expect(result.results[0]).toMatchObject({ issued: true, credentialMode: 'none', reads: 0, versionMatch: true, passed: true });
    });
  });

  it('stops the sequential matrix after the first HTTP 429 and records deferred checks', async () => {
    await withTemporaryDirectory(async (directory) => {
      const list = checkList([
        { operation: 'session.me', expectation: 'ok' },
        { operation: 'admin.schedule.read', expectation: 'ok' },
        { operation: 'admin.insights.read', expectation: 'ok' }
      ]);
      const { fetchImpl, calls } = fetchSequence([{
        status: 429,
        body: { ok: false, error: { code: 'RATE_LIMITED' } },
        headers: { 'x-staging-sheets-reads': '0', 'x-staging-host-deployed-at': EXPECTED_HOST_DEPLOYED_AT }
      }]);
      const budget = new ReadBudget();
      const attemptLedger = new AttemptBudget();
      const attemptLog = join(directory, 'stopped-matrix.jsonl');
      const result = await runReadChecks(list, { credential: 'c', budget, attemptLedger, attemptLog, fetchImpl });

      expect(calls).toHaveLength(1);
      expect(result).toMatchObject({ passed: false, stoppedOn429: true });
      expect(result.results[0]).toMatchObject({ issued: true, status: 429, passed: false });
      expect(result.results.slice(1)).toEqual(expect.arrayContaining([
        expect.objectContaining({ issued: false, deferred: true, deferredReason: 'http-429', status: 0 }),
        expect.objectContaining({ issued: false, deferred: true, deferredReason: 'http-429', status: 0 })
      ]));
      expect(attemptLedger.observed()).toBe(1);
      expect(budget.observed()).toBe(1);
      expect((await readFile(attemptLog, 'utf8')).trim().split('\n')).toHaveLength(3);
    });
  });

  it('requires the expected version marker for served and policy-refusal observations', async () => {
    const cases: Array<{ checks: ReadCheckEntry[]; body: unknown; headers: Record<string, string> }> = [
      {
        checks: [{ operation: 'session.me', expectation: 'ok' }],
        body: { ok: true, data: {} },
        headers: { 'x-staging-sheets-reads': '1' }
      },
      {
        checks: [{ operation: INTEGRATION_OPERATIONS.adminScheduleRerun, expectation: 'failed:FORBIDDEN' }],
        body: { ok: false, error: { code: 'FORBIDDEN' } },
        headers: { 'x-staging-sheets-reads': '0', 'x-staging-host-deployed-at': '2026-09-28T21:47:50.265Z' }
      }
    ];
    await withTemporaryDirectory(async (directory) => {
      for (const [index, item] of cases.entries()) {
        const { fetchImpl } = fetchSequence([{ body: item.body, headers: item.headers }]);
        const { results, passed } = await runReadChecks(checkList(item.checks), {
          credential: 'c',
          budget: new ReadBudget(),
          attemptLedger: new AttemptBudget(),
          attemptLog: join(directory, `marker-mismatch-${index}.jsonl`),
          fetchImpl
        });
        expect(passed).toBe(false);
        expect(results[0]).toMatchObject({
          expectedHostDeployedAt: EXPECTED_HOST_DEPLOYED_AT,
          versionMatch: false,
          passed: false
        });
        expect(results[0]?.detail).toContain('expected host marker');
      }
    });
  });

  it('waits 95 seconds before any matrix attempt or read reservation', async () => {
    await withTemporaryDirectory(async (directory) => {
      const hostDeployedAt = '2026-09-29T21:47:50.265Z';
      const readyAt = Date.parse(hostDeployedAt) + 95_000;
      let now = readyAt - 1_000;
      expect(planFor(checkList([{ operation: 'session.me', expectation: 'ok' }], hostDeployedAt), new ReadBudget(), new AttemptBudget(), now).hostReadiness).toMatchObject({
        required: true,
        minimumDelayMs: 95_000,
        readyAt: new Date(readyAt).toISOString(),
        waitRemainingMs: 1_000
      });
      const waits: number[] = [];
      const budget = new ReadBudget();
      const attemptLedger = new AttemptBudget();
      let readsReserved = 0;
      let attemptsReserved = 0;
      budget.reserve = async () => { readsReserved += 1; };
      attemptLedger.reserve = async () => { attemptsReserved += 1; return true; };

      const { results, passed, hostReadiness } = await runReadChecks(checkList([{ operation: 'session.me', expectation: 'ok' }], hostDeployedAt), {
        credential: 'c',
        budget,
        attemptLedger,
        attemptLog: join(directory, 'attempts.jsonl'),
        now: () => now,
        wait: async (durationMs) => {
          waits.push(durationMs);
          expect(readsReserved).toBe(0);
          expect(attemptsReserved).toBe(0);
          now += durationMs;
        },
        fetchImpl: fetchSequence([{
          body: { ok: true, data: {} },
          headers: { 'x-staging-sheets-reads': '1', 'x-staging-read-ms': '8', 'x-staging-host-deployed-at': hostDeployedAt }
        }]).fetchImpl
      });

      expect(waits).toEqual([1_000]);
      expect(attemptsReserved).toBe(1);
      expect(readsReserved).toBe(1);
      expect(passed).toBe(true);
      expect(results[0]).toMatchObject({ versionMatch: true, readMs: [8] });
      expect(hostReadiness).toMatchObject({ required: true, readyAt: new Date(readyAt).toISOString(), waitedMs: 1_000 });
    });
  });

  it('refuses a missing marker before spending either budget', async () => {
    const list = validateCheckList({
      workerUrl: WORKER_URL,
      credentialPath: 'staging-local/credential-rehearsal.txt',
      reportPath: 'staging-local/read-matrix-representative.json',
      checks: [{ operation: 'session.me', expectation: 'ok' }]
    });
    const budget = new ReadBudget();
    const attemptLedger = new AttemptBudget();
    let calls = 0;

    await expect(runReadChecks(list, {
      credential: 'c',
      budget,
      attemptLedger,
      attemptLog: join(tmpdir(), 'staging-readcheck-no-marker.jsonl'),
      fetchImpl: async () => { calls += 1; throw new Error('unexpected fetch'); }
    })).rejects.toThrow(/hostDeployedAt is required/u);

    expect(calls).toBe(0);
    expect(budget.observed()).toBe(0);
    expect(attemptLedger.observed()).toBe(0);
  });

  it('prints the checks as a plan and sends nothing without --confirm-staging', async () => {
    await withChecks(validList, async (path) => {
      const planned = runDriver(['--checks', path, '--plan']);
      expect(planned.status).toBe(0);
      const plan = JSON.parse(planned.stdout) as {
        checks: Array<{ operation: string; expectation: string; reads: number }>;
        expectedReads: number;
        retries: number;
        reportPath: string;
        attemptLogPath: string;
      };
      expect(plan.checks.map((check) => check.expectation)).toEqual(['ok', 'failed:UNAVAILABLE:control-pending']);
      // The domain check's pinned 2 reads plus the pending path's declared 1.
      expect(plan.expectedReads).toBe(3);
      expect(plan.retries).toBe(0);
      expect(plan.reportPath).toBe(join(ROOT, 'staging-local/read-matrix-representative.json'));
      expect(plan.attemptLogPath).toBe(`${plan.reportPath}.attempts.jsonl`);

      const unconfirmed = runDriver(['--checks', path]);
      expect(unconfirmed.status).toBe(1);
      expect(unconfirmed.stderr).toContain('Refusing to send any read');

      const unmarkedConfirmed = runDriver(['--checks', path, '--confirm-staging']);
      expect(unmarkedConfirmed.status).toBe(1);
      expect(unmarkedConfirmed.stderr).toContain('hostDeployedAt is required');
    });
  });

  it('assembles the report the CLI writes, including both ledger readings', async () => {
    // The confirmed CLI path cannot be reached from a test without sending real
    // reads, and an undefined field there once crashed a live run after its
    // attempts were spent. The report is therefore built by an exported pure
    // function and asserted here.
    const results = [
      { index: 0, label: 'served identity', operation: 'session.me', expectation: 'ok', issued: true, status: 200, code: null, reason: null, reads: 1, readMs: [10], hostDeployedAt: EXPECTED_HOST_DEPLOYED_AT, expectedHostDeployedAt: EXPECTED_HOST_DEPLOYED_AT, versionMatch: true, policyRefusal: false, credentialMode: 'configured' as const, plannedReads: 1, durationMs: 120, observedInFlight: 1, passed: true, detail: 'served' },
      { index: 1, label: 'pending refusal', operation: 'admin.schedule.read', expectation: 'failed:UNAVAILABLE:control-pending', issued: true, status: 200, code: 'UNAVAILABLE', reason: 'control-pending', reads: 1, readMs: null, hostDeployedAt: EXPECTED_HOST_DEPLOYED_AT, expectedHostDeployedAt: EXPECTED_HOST_DEPLOYED_AT, versionMatch: true, policyRefusal: false, credentialMode: 'configured' as const, plannedReads: 3, durationMs: 90, observedInFlight: 1, passed: true, detail: 'refused' }
    ];
    const report = reportFor(
      { workerUrl: WORKER_URL, credentialPath: 'staging-local/credential-rehearsal.txt', reportPath: 'staging-local/read-matrix-representative.json', hostDeployedAt: EXPECTED_HOST_DEPLOYED_AT, checks: [] },
      results,
      {
        startedAt: '2026-09-30T02:40:00.000Z',
        budget: { limit: 40, windowMs: 60_000, observed: () => 5 } as unknown as ReadBudget,
        attemptLedger: { limit: 1_000, observed: () => 531 } as unknown as AttemptBudget,
        attemptsBeforeRun: 529,
        attemptLogPath: 'staging-local/read-matrix-representative.json.attempts.jsonl',
        hostReadiness: { required: true, readyAt: new Date(Date.parse(EXPECTED_HOST_DEPLOYED_AT) + 95_000).toISOString(), waitedMs: 0 }
      }
    );

    expect(report).toMatchObject({
      startedAt: '2026-09-30T02:40:00.000Z',
      passed: true,
      stoppedOn429: false,
      sanitized: true,
      retries: 0,
      summary: { checks: 2, passed: 2, failed: 0, issued: 2, deferred: 0, reads: 2, readCountObservations: 2, unreportedReadChecks: 0, versionMatchedObservations: 2, versionLaggedObservations: 0, readTimingObservations: 1, plannedReads: 4, observedMaxInFlight: 1 },
      budget: { limit: 40, windowSeconds: 60, observedReadsInLastWindow: 5, attempts: { limit: 1_000, spentBeforeRun: 529, spentAfterRun: 531 } }
    });
    // A run that leaves an expectation unmet is not a passing report.
    const unmet: typeof results = [{ ...results[0]!, passed: false }];
    expect(reportFor({ workerUrl: WORKER_URL, credentialPath: 'x', reportPath: 'y', checks: [] }, unmet, {
      startedAt: 'now',
      budget: { limit: 40, windowMs: 60_000, observed: () => 0 } as unknown as ReadBudget,
      attemptLedger: { limit: 1_000, observed: () => 1 } as unknown as AttemptBudget,
      attemptsBeforeRun: 0,
      attemptLogPath: 'z',
      hostReadiness: { required: false, readyAt: null, waitedMs: 0 }
    }).passed).toBe(false);
  });

  it('fails the command when any expectation is unmet', () => {
    expect(exitCodeFor(false)).toBe(1);
    expect(exitCodeFor(true)).toBe(0);
  });

  it('refuses a missing or unknown argument', () => {
    const missing = runDriver([]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('--checks path is required');

    const unknown = runDriver(['--checks', 'checks.json', '--target', 'elsewhere']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Unknown argument');

    const valueless = runDriver(['--checks']);
    expect(valueless.status).toBe(1);
    expect(valueless.stderr).toContain('--checks needs a value');
  });

  it('refuses a check list that would measure the wrong thing', async () => {
    for (const [override, fragment] of [
      [{ reportPath: 'reports/matrix.json' }, 'inside staging-local'],
      [{ reportPath: 'staging-local/../escape.json' }, 'inside staging-local'],
      [{ credentialPath: '../credential.txt' }, 'inside staging-local'],
      [{ workerUrl: 'https://api.example.test/exec' }, 'does not look like a staging Worker'],
      [{ workerUrl: 'http://localhost:8787/exec' }, 'https'],
      [{ checks: [{ operation: 'admin.schedule.rerun', expectation: 'ok' }] }, 'requires expectation failed:FORBIDDEN'],
      [{ checks: [{ operation: 'session.me', expectation: 'anything' }] }, 'must be `ok` or `failed:CODE[:reason]`'],
      [{ checks: [{ operation: 'session.me', expectation: 'failed' }] }, 'must be `ok` or `failed:CODE[:reason]`'],
      [{ checks: [{ operation: 'session.me', expectation: 'ok', credentialMode: 'automatic' }] }, 'credentialMode must be `none` or `configured`'],
      [{ checks: [] }, 'at least one check']
    ] as const) {
      await withChecks({ ...validList, ...override }, async (path) => {
        const result = runDriver(['--checks', path, '--plan']);
        expect(result.status, JSON.stringify(override)).toBe(1);
        expect(result.stderr, JSON.stringify(override)).toContain(fragment);
      });
    }
  });

  it('keeps every written path inside staging-local, including --report', async () => {
    await withChecks(validList, async (path) => {
      const result = runDriver(['--checks', path, '--plan', '--report', 'staging-local/read-matrix-larger.json']);
      expect(result.status).toBe(0);
      const plan = JSON.parse(result.stdout) as { reportPath: string; attemptLogPath: string };
      expect(plan.reportPath).toBe(join(ROOT, 'staging-local/read-matrix-larger.json'));
      expect(plan.attemptLogPath).toBe(`${plan.reportPath}.attempts.jsonl`);

      const escaping = runDriver(['--checks', path, '--plan', '--report', '../matrix.json']);
      expect(escaping.status).toBe(1);
      expect(escaping.stderr).toContain('inside staging-local');
    });
  });

  it('accepts a non-staging host only when it is named explicitly', async () => {
    await withChecks({ ...validList, workerUrl: 'https://probe.example.test/exec' }, async (path) => {
      expect(runDriver(['--checks', path, '--plan']).status).toBe(1);
      expect(runDriver(['--checks', path, '--plan', '--allow-host', 'probe.example.test']).status).toBe(0);
    });
  });
});
