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
    for (const override of [{ reportPath: 'reports/report.json' }, { credentialPath: '/tmp/credential.txt' }, { reportPath: 'staging-local/../escape.json' }]) {
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

  it('documents that the browser probe is the only CORS evidence', async () => {
    const manifest = await readFile(STAGING_MANIFEST, 'utf8');
    expect(manifest).toContain('browser-probe.html');
    expect(manifest).toContain('wrangler delete --env staging');
    expect(manifest).toContain('workflow_dispatch');
  });
});
