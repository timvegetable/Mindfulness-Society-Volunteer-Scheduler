import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The staging measurement harness must be impossible to run by accident: it
 * needs an explicit manifest, refuses a non-https target, and refuses to send
 * anything without `--confirm-staging`. These checks never contact the network.
 */

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const HARNESS = join(ROOT, 'scripts/staging/measure-worker.mjs');
// The feasibility change's evidence was archived with its change folder; the
// staging manifest's probes live there now.
const STAGING_MANIFEST = join(ROOT, 'openspec/changes/archive/2026-09-29-validate-worker-backend-feasibility/evidence/staging-manifest.md');

const VALID_MANIFEST = {
  workerUrl: 'https://volunteer-scheduling-staging.example.workers.dev/exec',
  origins: ['https://scheduling.example.test'],
  operations: ['session.me', 'admin.schedule.read', 'admin.insights.read'],
  burst: { requests: 20, concurrency: 4 },
  sustained: { requests: 100, concurrency: 1 },
  reportPath: 'staging-local/report.json',
  credentialPath: 'staging-local/credential.txt'
};

function run(args: string[], cwd = ROOT) {
  const result = spawnSync(process.execPath, [HARNESS, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function withManifest(manifest: unknown, run_: (path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'staging-harness-'));
  const path = join(directory, 'manifest.json');
  await writeFile(path, JSON.stringify(manifest), 'utf8');
  try {
    await run_(path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('staging measurement harness', () => {
  it('refuses to run without a manifest', () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--manifest path is required');
  });

  it('refuses an unknown argument rather than ignoring it', () => {
    const result = run(['--target', 'https://elsewhere.example.test']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown argument');
  });

  it('refuses a manifest whose target is not https, without contacting it', async () => {
    await withManifest({ ...VALID_MANIFEST, workerUrl: 'http://localhost:8787/exec' }, async (path) => {
      const result = run(['--manifest', path]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('https');
    });
  });

  it('refuses a target that is not a staging-shaped Worker host', async () => {
    for (const workerUrl of ['https://scheduling.example.test/exec', 'https://volunteer-scheduling.workers.dev/exec', 'https://api.example.workers.dev/exec']) {
      await withManifest({ ...VALID_MANIFEST, workerUrl }, async (path) => {
        const result = run(['--manifest', path]);
        expect(result.status, workerUrl).toBe(1);
        expect(result.stderr).toContain('does not look like a staging Worker');
      });
    }
  });

  it('accepts an unusual host only when it is named explicitly', async () => {
    await withManifest({ ...VALID_MANIFEST, workerUrl: 'https://probe.example.test/exec' }, async (path) => {
      const refused = run(['--manifest', path]);
      expect(refused.status).toBe(1);
      const allowed = run(['--manifest', path, '--plan', '--allow-host', 'probe.example.test']);
      expect(allowed.status).toBe(0);
    });
  });

  it('refuses a report or credential path outside staging-local', async () => {
    for (const override of [
      { reportPath: 'reports/report.json' },
      { credentialPath: '/tmp/credential.txt' },
      { reportPath: 'staging-local/../escape.json' },
      { reportPath: 'staging-local-extra/report.json' },
      { credentialPath: 'staging-local-extra/credential.txt' },
      { reportPath: 'staging-local/../staging-local-extra/report.json' }
    ]) {
      await withManifest({ ...VALID_MANIFEST, ...override }, async (path) => {
        const result = run(['--manifest', path, '--plan']);
        expect(result.status, JSON.stringify(override)).toBe(1);
        expect(result.stderr).toMatch(/staging-local|inside the repository/);
      });
    }
  });

  it('classifies failures into the contract taxonomy', async () => {
    const module = await import('../../../scripts/staging/measure-worker.mjs') as { classifyFailure: (status: number, body: unknown, error?: Error) => string };
    expect(module.classifyFailure(429, undefined)).toBe('429');
    expect(module.classifyFailure(500, undefined)).toBe('5xx');
    expect(module.classifyFailure(200, { ok: false, error: { code: 'UNAVAILABLE' } })).toBe('5xx');
    expect(module.classifyFailure(200, { ok: false, error: { code: 'FORBIDDEN' } })).toBe('envelope-FORBIDDEN');
    expect(module.classifyFailure(200, { ok: true })).toBe('parity-mismatch');
    expect(module.classifyFailure(0, undefined, Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout');
    expect(module.classifyFailure(0, undefined, new Error('x'))).toBe('transport');
  });

  it('refuses a manifest that names an operation the slice does not serve', async () => {
    await withManifest({ ...VALID_MANIFEST, operations: ['admin.schedule.rerun'] }, async (path) => {
      const result = run(['--manifest', path]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unsupported operation');
    });
  });

  it('prints the plan and sends nothing without --confirm-staging', async () => {
    await withManifest(VALID_MANIFEST, async (path) => {
      const result = run(['--manifest', path, '--plan']);
      expect(result.status).toBe(0);
      const plan = JSON.parse(result.stdout) as { expectedReadsPerRequest: Record<string, number>; readBudgetPerWindow: number; retries: number };
      expect(plan.expectedReadsPerRequest).toEqual({ 'session.me': 1, 'admin.schedule.read': 2, 'admin.insights.read': 2 });
      expect(plan.readBudgetPerWindow).toBe(40);
      expect(plan.retries).toBe(0);
    });
  });

  it('requires a canonical host deployment marker before any confirmed harness run', async () => {
    await withManifest(VALID_MANIFEST, async (path) => {
      const confirmed = run(['--manifest', path, '--confirm-staging']);
      expect(confirmed.status).toBe(1);
      expect(confirmed.stderr).toContain('hostDeployedAt is required for a confirmed staging run');
      expect(confirmed.stderr).not.toContain('credential file could not be read');
    });
  });

  it('refuses to send requests when confirmation is absent even with a valid manifest', async () => {
    await withManifest(VALID_MANIFEST, async (path) => {
      const result = run(['--manifest', path]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Refusing to send any request');
      expect(result.stdout).toContain('"workerUrl"');
    });
  });

  it('refuses a manifest path that would write outside the repository', async () => {
    await withManifest({ ...VALID_MANIFEST, reportPath: '../escape.json' }, async (path) => {
      const result = run(['--manifest', path]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('inside the repository');
    });
  });

  it('keeps the read budget at the contract ceiling', async () => {
    const source = await readFile(HARNESS, 'utf8');
    expect(source).toContain('const READ_BUDGET_PER_WINDOW = 40;');
    // A single request must never be allowed to exceed the whole window.
    expect(source).toContain('A single request would exceed the read budget');
  });

  it('keeps the campaign attempt budget at the predeclared cap across restarts', async () => {
    const module = await import('../../../scripts/staging/measure-worker.mjs') as {
      AttemptBudget: new (limit?: number, ledgerPath?: string) => { loadLedger(): Promise<void>; reserve(): Promise<boolean>; observed(): number };
      ATTEMPT_BUDGET_PER_CAMPAIGN: number;
    };
    expect(module.ATTEMPT_BUDGET_PER_CAMPAIGN).toBe(1_000);
    const directory = await mkdtemp(join(tmpdir(), 'staging-attempts-'));
    const ledger = join(directory, '.attempt-budget-ledger.json');
    try {
      const first = new module.AttemptBudget(3, ledger);
      expect(await first.reserve()).toBe(true);
      expect(await first.reserve()).toBe(true);
      // A restart shares the same campaign counter through the ledger file.
      const second = new module.AttemptBudget(3, ledger);
      await second.loadLedger();
      expect(second.observed()).toBe(2);
      expect(await second.reserve()).toBe(true);
      expect(await second.reserve()).toBe(false);
      expect(await second.reserve()).toBe(false);
      // The refused reserve must not have advanced the ledger.
      const third = new module.AttemptBudget(3, ledger);
      await third.loadLedger();
      expect(third.observed()).toBe(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('counts a cold observation only when the object answered with the expected version', async () => {
    const module = await import('../../../scripts/staging/measure-worker.mjs') as {
      classifyColdObservation: (attempt: { failure?: string; hostDeployedAt?: string }, expectedHostDeployedAt?: string) => string;
    };
    expect(module.classifyColdObservation({ hostDeployedAt: '2026-09-29T07:00:00.000Z' }, '2026-09-29T07:00:00.000Z')).toBe('genuine');
    expect(module.classifyColdObservation({ hostDeployedAt: '2026-09-29T06:00:00.000Z' }, '2026-09-29T07:00:00.000Z')).toBe('version-lag');
    expect(module.classifyColdObservation({}, '2026-09-29T07:00:00.000Z')).toBe('version-lag');
    expect(module.classifyColdObservation({ failure: 'transport' }, '2026-09-29T07:00:00.000Z')).toBe('failed');
    expect(module.classifyColdObservation({ hostDeployedAt: 'x' }, undefined)).toBe('unexpected-marker');
    expect(module.classifyColdObservation({}, undefined)).toBe('unverified');
  });

  it('paces the browser probe through the shared read ledger', async () => {
    const source = await readFile(join(ROOT, 'scripts/staging/browser-probe.js'), 'utf8');
    // The probe reserves through the host's ledger endpoint instead of keeping
    // a browser-local window: the two sides must hold one shared budget.
    expect(source).toContain("'/__reserve'");
    expect(source).not.toContain('spentReads');
    const probeHost = await readFile(join(ROOT, 'scripts/staging/serve-probe.mjs'), 'utf8');
    expect(probeHost).toContain("url.pathname === '/__reserve'");
    expect(probeHost).toContain("resolve(stagingDirectory, '.read-budget-ledger.json')");
  });

  it('retains every attempt as it completes, including transport failures', async () => {
    const module = await import('../../../scripts/staging/measure-worker.mjs') as unknown as {
      runPhase: (manifest: { workerUrl: string; operations: string[] }, phase: string, workload: { requests: number; concurrency: number }, credential: string, budget: unknown, attemptLedger: unknown, fetchImpl: (url: string, init: unknown) => Promise<never>, attemptLog: string) => Promise<{ attempts: Array<{ failure?: string; index: number }>; deferred: number }>;
      ReadBudget: new () => unknown;
      AttemptBudget: new () => unknown;
    };
    const directory = await mkdtemp(join(tmpdir(), 'staging-attempts-'));
    try {
      const attemptLog = join(directory, 'attempts.jsonl');
      const result = await module.runPhase(
        { workerUrl: 'https://volunteer-scheduling-staging.example.workers.dev/exec', operations: ['session.me'] },
        'burst',
        { requests: 3, concurrency: 2 },
        'credential-placeholder',
        new module.ReadBudget(),
        new module.AttemptBudget(),
        async () => { throw new Error('connection refused'); },
        attemptLog
      );
      // Every attempt is retained exactly once, failure or not.
      expect(result.attempts).toHaveLength(3);
      expect(result.attempts.every((attempt) => attempt.failure === 'transport')).toBe(true);
      expect(result.deferred).toBe(0);
      const lines = (await readFile(attemptLog, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines.map((line) => JSON.parse(line) as { index: number }).sort((left, right) => left.index - right.index).map((attempt) => attempt.index)).toEqual([0, 1, 2]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains per-read timings and measures valid mixed-operation overlap', async () => {
    const module = await import('../../../scripts/staging/measure-worker.mjs') as unknown as {
      runPhase: (
        manifest: { workerUrl: string; operations: string[] },
        phase: string,
        workload: { requests: number; concurrency: number },
        credential: string,
        budget: unknown,
        attemptLedger: unknown,
        fetchImpl: (url: string, init: unknown) => Promise<unknown>,
        attemptLog: string,
        readiness?: { now: () => number; wait: (durationMs: number) => Promise<void> }
      ) => Promise<{ attempts: Array<{ failure?: string; index: number; readMs?: number[] | null; observedMaxInFlightDuringRequest?: number }>; deferred: number }>;
      summarize: (attempts: Array<{ failure?: string; index: number; operation?: string; hostDeployedAt?: string; durationMs?: number; inFlight?: number; observedMaxInFlightDuringRequest?: number }>, elapsedMs: number, expectedHostDeployedAt?: string) => {
        byOperation: Record<string, {
          attempts: number;
          successes: number;
          failures: Record<string, number>;
          versionLag: number | null;
          latencyObservations: number;
          latencyObservationsAtLeast3InFlight: number;
          wallTimeMsAtLeast3InFlight: { min: number | null; p50: number | null; p95: number | null; p99: number | null; max: number | null };
          achieved: {
            observedMaxInFlight: number;
            attemptsAtLeast3InFlight: number;
            successfulObservationsAtLeast3InFlight: number;
            versionLagAtLeast3InFlight: number | null;
          };
        }>;
      };
      ReadBudget: new (limit?: number, windowMs?: number, now?: () => number) => unknown;
      AttemptBudget: new (limit?: number) => unknown;
    };
    const directory = await mkdtemp(join(tmpdir(), 'staging-mixed-phase-'));
    const expectedHostDeployedAt = '2026-09-30T12:00:00.000Z';
    let releaseRequests!: () => void;
    const allRequestsStarted = new Promise<void>((resolveRequests) => { releaseRequests = resolveRequests; });
    let enteredRequests = 0;

    try {
      const attempts = await module.runPhase(
        {
          workerUrl: 'https://volunteer-scheduling-staging.example.workers.dev/exec',
          operations: ['admin.schedule.read', 'session.me']
        },
        'burst',
        { requests: 4, concurrency: 4 },
        'credential-placeholder',
        new module.ReadBudget(40),
        new module.AttemptBudget(4),
        async (_url, init) => {
          const request = init as { body: string };
          const envelope = JSON.parse(request.body) as { idempotencyKey: string };
          const index = Number(envelope.idempotencyKey.split('-').at(-1));
          enteredRequests += 1;
          if (enteredRequests === 4) releaseRequests();
          await allRequestsStarted;

          const responseHeaders: Record<string, string> = {
            'x-staging-sheets-reads': index % 2 === 0 ? '3' : '1',
            // The failure at index 2 claims three reads but returns only two
            // timings; the harness must retain it as unattributable.
            'x-staging-read-ms': ['3,11,13', '5', '7,8', '10'][index] ?? '',
            'x-staging-host-deployed-at': index === 1 ? '2026-09-30T11:00:00.000Z' : expectedHostDeployedAt
          };
          const failed = index === 2;
          return {
            status: failed ? 503 : 200,
            headers: { get: (name: string) => responseHeaders[name.toLowerCase()] ?? null },
            json: async () => failed
              ? { ok: false, error: { code: 'UNAVAILABLE' } }
              : { ok: true, data: {} }
          };
        },
        join(directory, 'attempts.jsonl')
      );
      const summary = module.summarize(attempts.attempts as never, 1_000, expectedHostDeployedAt);

      expect(attempts.deferred).toBe(0);
      expect(attempts.attempts.map((attempt) => attempt.readMs)).toEqual([[3, 11, 13], [5], null, [10]]);
      // These values measure overlap while fetch/body consumption is active;
      // waiting for a budget reservation cannot inflate them.
      expect(attempts.attempts.map((attempt) => attempt.observedMaxInFlightDuringRequest)).toEqual([4, 4, 4, 4]);
      expect(summary.byOperation['admin.schedule.read']).toMatchObject({
        attempts: 2,
        successes: 1,
        failures: { '5xx': 1 },
        versionLag: 0,
        latencyObservations: 1,
        achieved: {
          observedMaxInFlight: 4,
          attemptsAtLeast3InFlight: 2,
          successfulObservationsAtLeast3InFlight: 1,
          versionLagAtLeast3InFlight: 0
        },
        latencyObservationsAtLeast3InFlight: 1,
        wallTimeMsAtLeast3InFlight: { min: expect.any(Number), p50: expect.any(Number), p95: expect.any(Number), p99: expect.any(Number), max: expect.any(Number) }
      });
      expect(summary.byOperation['session.me']).toMatchObject({
        attempts: 2,
        successes: 2,
        failures: {},
        versionLag: 1,
        latencyObservations: 1,
        achieved: {
          observedMaxInFlight: 4,
          attemptsAtLeast3InFlight: 2,
          successfulObservationsAtLeast3InFlight: 1,
          versionLagAtLeast3InFlight: 1
        },
        latencyObservationsAtLeast3InFlight: 1,
        wallTimeMsAtLeast3InFlight: { min: expect.any(Number), p50: expect.any(Number), p95: expect.any(Number), p99: expect.any(Number), max: expect.any(Number) }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not treat an ok envelope on HTTP 429 as a successful observation', async () => {
    const module = await import('../../../scripts/staging/measure-worker.mjs') as unknown as {
      runPhase: (
        manifest: { workerUrl: string; operations: string[] },
        phase: string,
        workload: { requests: number; concurrency: number },
        credential: string,
        budget: unknown,
        attemptLedger: unknown,
        fetchImpl: (url: string, init: unknown) => Promise<unknown>,
        attemptLog: string
      ) => Promise<{ attempts: Array<{ failure?: string; envelopeOk?: boolean; operation?: string; durationMs?: number }> ; elapsedMs: number }>;
      summarize: (attempts: Array<{ failure?: string; envelopeOk?: boolean; operation?: string; durationMs?: number }>, elapsedMs: number, expectedHostDeployedAt?: string, operations?: string[]) => {
        successes: number;
        failures: Record<string, number>;
        latencyObservations: number;
        byOperation: Record<string, { successes: number; failures: Record<string, number>; latencyObservations: number }>;
      };
    };
    const directory = await mkdtemp(join(tmpdir(), 'staging-429-ok-envelope-'));
    try {
      const phase = await module.runPhase(
        { workerUrl: 'https://volunteer-scheduling-staging.example.workers.dev/exec', operations: ['session.me'] },
        'burst',
        { requests: 1, concurrency: 1 },
        'credential-placeholder',
        { reserve: async () => undefined },
        { reserve: async () => true },
        async () => ({
          status: 429,
          headers: { get: (name: string) => ({ 'x-staging-sheets-reads': '1', 'x-staging-read-ms': '5' } as Record<string, string>)[name.toLowerCase()] ?? null },
          json: async () => ({ ok: true, data: {} })
        }),
        join(directory, 'attempts.jsonl')
      );
      const summary = module.summarize(phase.attempts, phase.elapsedMs, undefined, ['session.me']);

      expect(phase.attempts[0]).toMatchObject({ failure: '429', envelopeOk: true });
      expect(summary).toMatchObject({
        successes: 0,
        failures: { '429': 1 },
        latencyObservations: 0,
        byOperation: { 'session.me': { successes: 0, failures: { '429': 1 }, latencyObservations: 0 } }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stops new target calls on the first 429 and retains queued and reserved cancellations', async () => {
    const module = await import('../../../scripts/staging/measure-worker.mjs') as unknown as {
      runPhase: (
        manifest: { workerUrl: string; operations: string[] },
        phase: string,
        workload: { requests: number; concurrency: number },
        credential: string,
        budget: { reserve: () => Promise<void> },
        attemptLedger: { reserve: () => Promise<boolean>; observed?: () => number },
        fetchImpl: (url: string, init: unknown) => Promise<unknown>,
        attemptLog: string,
        readiness?: { stopState?: { stoppedBy429: boolean; phase?: string | null } }
      ) => Promise<{
        attempts: Array<{ index: number; status: number; failure?: string }>;
        deferred: number;
        stoppedBy429: boolean;
        stopPhase: string | null;
        deferredAttempts: Array<{ index: number; deferredReason: string; attemptReserved: boolean; readsReserved: boolean }>;
      }>;
    };
    const directory = await mkdtemp(join(tmpdir(), 'staging-stop-429-'));
    let release429!: () => void;
    let releaseConcurrent!: () => void;
    let releaseThirdReservation!: () => void;
    let signalFetches!: () => void;
    let signalThirdReservation!: () => void;
    const firstGate = new Promise<void>((resolveGate) => { release429 = resolveGate; });
    const secondGate = new Promise<void>((resolveGate) => { releaseConcurrent = resolveGate; });
    const thirdGate = new Promise<void>((resolveGate) => { releaseThirdReservation = resolveGate; });
    const twoFetches = new Promise<void>((resolveGate) => { signalFetches = resolveGate; });
    const thirdEntered = new Promise<void>((resolveGate) => { signalThirdReservation = resolveGate; });
    let fetchCalls = 0;
    let attemptReservations = 0;
    let readReservations = 0;
    const attemptLog = join(directory, 'attempts.jsonl');

    try {
      const pending = module.runPhase(
        { workerUrl: 'https://volunteer-scheduling-staging.example.workers.dev/exec', operations: ['session.me'] },
        'burst',
        { requests: 5, concurrency: 3 },
        'credential-placeholder',
        { reserve: async () => {
          readReservations += 1;
          if (readReservations === 3) {
            signalThirdReservation();
            await thirdGate;
          }
        } },
        { reserve: async () => { attemptReservations += 1; return true; } },
        async () => {
          const index = fetchCalls++;
          if (fetchCalls === 2) signalFetches();
          await (index === 0 ? firstGate : secondGate);
          return {
            status: index === 0 ? 429 : 200,
            headers: { get: () => '1' },
            json: async () => index === 0 ? { ok: false, error: { code: 'RATE_LIMITED' } } : { ok: true, data: {} }
          };
        },
        attemptLog
      );

      await Promise.all([twoFetches, thirdEntered]);
      release429();
      // Let the already-issued response latch stop state before the delayed
      // reservation resolves; that reservation must be retained, not issued.
      await Promise.resolve();
      await Promise.resolve();
      releaseThirdReservation();
      releaseConcurrent();
      const result = await pending;
      const records = (await readFile(attemptLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      const deferred = records.filter((record) => record.deferred === true);

      expect(fetchCalls).toBe(2);
      expect(attemptReservations).toBe(3);
      expect(readReservations).toBe(3);
      expect(result.attempts.map(({ index, status }) => ({ index, status }))).toEqual([{ index: 0, status: 429 }, { index: 1, status: 200 }]);
      expect(result).toMatchObject({ deferred: 3, stoppedBy429: true, stopPhase: 'burst' });
      expect(deferred).toHaveLength(3);
      expect(deferred.find((record) => record.index === 2)).toMatchObject({ deferredReason: 'http-429', attemptReserved: true, readsReserved: true });
      expect(deferred.filter((record) => record.index === 3 || record.index === 4)).toEqual(expect.arrayContaining([
        expect.objectContaining({ index: 3, issued: false, deferred: true, attemptReserved: false, readsReserved: false }),
        expect.objectContaining({ index: 4, issued: false, deferred: true, attemptReserved: false, readsReserved: false })
      ]));
    } finally {
      release429();
      releaseConcurrent();
      releaseThirdReservation();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits until the manifest deployment marker is 95 seconds old before issuing requests', async () => {
    const module = await import('../../../scripts/staging/measure-worker.mjs') as unknown as {
      runPhase: (
        manifest: { workerUrl: string; operations: string[]; hostDeployedAt: string },
        phase: string,
        workload: { requests: number; concurrency: number },
        credential: string,
        budget: unknown,
        attemptLedger: unknown,
        fetchImpl: (url: string, init: unknown) => Promise<unknown>,
        attemptLog: string,
        readiness: { now: () => number; wait: (durationMs: number) => Promise<void> }
      ) => Promise<{ attempts: Array<{ failure?: string }> }>;
    };
    const directory = await mkdtemp(join(tmpdir(), 'staging-ready-phase-'));
    const hostDeployedAt = '2026-09-30T12:00:00.000Z';
    const readyAt = Date.parse(hostDeployedAt) + 95_000;
    let now = readyAt - 1_000;
    const waits: number[] = [];
    let fetchStartedAt: number | undefined;
    let readReservations = 0;
    let attemptReservations = 0;

    try {
      const result = await module.runPhase(
        {
          workerUrl: 'https://volunteer-scheduling-staging.example.workers.dev/exec',
          operations: ['session.me'],
          hostDeployedAt
        },
        'burst',
        { requests: 1, concurrency: 1 },
        'credential-placeholder',
        { reserve: async () => { readReservations += 1; } },
        { reserve: async () => { attemptReservations += 1; return true; } },
        async () => {
          fetchStartedAt = now;
          return {
            status: 200,
            headers: { get: (name: string) => ({
              'x-staging-sheets-reads': '1',
              'x-staging-read-ms': '5',
              'x-staging-host-deployed-at': hostDeployedAt
            } as Record<string, string>)[name.toLowerCase()] ?? null },
            json: async () => ({ ok: true, data: {} })
          };
        },
        join(directory, 'attempts.jsonl'),
        {
          now: () => now,
          wait: async (durationMs) => {
            waits.push(durationMs);
            expect(readReservations).toBe(0);
            expect(attemptReservations).toBe(0);
            now += durationMs;
          }
        }
      );

      expect(waits).toEqual([1_000]);
      expect(readReservations).toBe(1);
      expect(attemptReservations).toBe(1);
      expect(fetchStartedAt).toBe(readyAt);
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]?.failure).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('measures end-to-end duration through response body hydration', async () => {
    const module = await import('../../../scripts/staging/measure-worker.mjs') as unknown as {
      runPhase: (
        manifest: { workerUrl: string; operations: string[] },
        phase: string,
        workload: { requests: number; concurrency: number },
        credential: string,
        budget: unknown,
        attemptLedger: unknown,
        fetchImpl: (url: string, init: unknown) => Promise<unknown>,
        attemptLog: string
      ) => Promise<{ attempts: Array<{ durationMs: number }> }>;
      ReadBudget: new (limit?: number) => unknown;
      AttemptBudget: new (limit?: number) => unknown;
    };
    const directory = await mkdtemp(join(tmpdir(), 'staging-body-duration-'));
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    let releaseBody!: () => void;
    let bodyStarted!: () => void;
    const bodyStartedPromise = new Promise<void>((resolveBody) => { bodyStarted = resolveBody; });
    const bodyGate = new Promise<void>((resolveBody) => { releaseBody = resolveBody; });

    try {
      const phase = module.runPhase(
        {
          workerUrl: 'https://volunteer-scheduling-staging.example.workers.dev/exec',
          operations: ['session.me']
        },
        'burst',
        { requests: 1, concurrency: 1 },
        'credential-placeholder',
        new module.ReadBudget(40),
        new module.AttemptBudget(1),
        async () => ({
          status: 200,
          headers: { get: (name: string) => ({
            'x-staging-sheets-reads': '1',
            'x-staging-read-ms': '5'
          } as Record<string, string>)[name.toLowerCase()] ?? null },
          json: async () => {
            bodyStarted();
            await bodyGate;
            return { ok: true, data: {} };
          }
        }),
        join(directory, 'attempts.jsonl')
      );
      await bodyStartedPromise;
      now += 37;
      releaseBody();
      const result = await phase;
      expect(result.attempts[0]?.durationMs).toBe(37);
    } finally {
      releaseBody();
      Date.now = originalNow;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('documents that the browser probe is the only CORS evidence', async () => {
    const manifest = await readFile(STAGING_MANIFEST, 'utf8');
    expect(manifest).toContain('browser-probe.html');
    expect(manifest).toContain('wrangler delete --env staging');
    expect(manifest).toContain('workflow_dispatch');
  });
});
