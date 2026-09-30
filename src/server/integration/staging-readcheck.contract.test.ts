import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlReadCheck, evaluateExpectation, type ControlReadCheckResult } from '../../../scripts/staging/control-read-check.mjs';
import { AttemptBudget, ReadBudget } from '../../../scripts/staging/measure-worker.mjs';
import {
  exitCodeFor,
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

/** A declared list, normalized exactly as the command validates it. */
function checkList(checks: ReadCheckEntry[]) {
  return validateCheckList({
    workerUrl: WORKER_URL,
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

const servedAnswer = { body: { ok: true, data: { revision: 43 } }, headers: { 'x-staging-sheets-reads': '4', 'x-staging-correlation-id': 'corr-1', 'x-staging-host-deployed-at': '2026-09-29T21:47:50.265Z' } };

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

const servedHeaders = { 'x-staging-sheets-reads': '4', 'x-staging-correlation-id': 'corr-1', 'x-staging-host-deployed-at': '2026-09-29T21:47:50.265Z' };

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

    expect(result).toMatchObject({ status: 503, ok: false, errorCode: undefined, sheetsReads: 0 });
  });
});

describe('expectation comparison', () => {
  const served: ControlReadCheckResult = { status: 200, durationMs: 12, ok: true, sheetsReads: 4, hasCorrelationId: true, hasHostMarker: true };
  const refused = (code: string, reason: string): ControlReadCheckResult => ({ status: 200, durationMs: 9, ok: false, errorCode: code, reason, sheetsReads: 1, hasCorrelationId: true, hasHostMarker: true });

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
});

describe('read-matrix driver', () => {
  it('runs a declared list, records every matrix field and keeps one attempt per check', async () => {
    await withTemporaryDirectory(async (directory) => {
      const attemptLog = join(directory, 'matrix.json.attempts.jsonl');
      const budget = new ReadBudget(undefined, undefined, undefined, join(directory, '.read-budget-ledger.json'));
      const attemptLedger = new AttemptBudget(undefined, join(directory, '.attempt-budget-ledger.json'));
      const { fetchImpl, calls } = fetchSequence([
        servedAnswer,
        { body: { ok: false, error: { code: 'UNAVAILABLE', details: { reason: 'control-pending' } } }, headers: { 'x-staging-sheets-reads': '1' } }
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
        { body: { ok: false, error: { code: 'UNAVAILABLE', details: { reason: 'control-authority_mismatch' } } }, headers: { 'x-staging-sheets-reads': '1' } },
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
    });
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
      [{ checks: [{ operation: 'admin.schedule.rerun', expectation: 'ok' }] }, 'unsupported operation'],
      [{ checks: [{ operation: 'session.me', expectation: 'anything' }] }, 'must be `ok` or `failed:CODE[:reason]`'],
      [{ checks: [{ operation: 'session.me', expectation: 'failed' }] }, 'must be `ok` or `failed:CODE[:reason]`'],
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
