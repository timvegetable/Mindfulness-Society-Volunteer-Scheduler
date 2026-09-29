#!/usr/bin/env node
// Paced load harness for the staging Worker feasibility slice.
//
// It never runs by accident: a manifest, a staging-shaped target and an explicit
// --confirm-staging flag are all required, and --plan validates everything
// without contacting anything. The read budget from the experiment contract (at
// most 40 Sheets reads in any 60-second window) is enforced here rather than
// left to the operator, no request is retried, and every attempt is written to
// disk as it completes so an aborted run still retains its evidence.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPERATION_READS = {
  'session.me': 1,
  'admin.schedule.read': 2,
  'admin.insights.read': 2,
  // The benchmark route costs one authorization read plus one schema-derived batch.
  'admin.schedule.preview': 2
};
const READ_BUDGET_PER_WINDOW = 40;
const WINDOW_MS = 60_000;
/** The predeclared campaign cap: at most 1,000 attempts, shared across restarts. */
export const ATTEMPT_BUDGET_PER_CAMPAIGN = 1_000;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Contract failure taxonomy: every retained failure lands in exactly one bucket. */
export function classifyFailure(status, body, error) {
  if (error) return error.name === 'AbortError' ? 'timeout' : 'transport';
  if (status === 429) return '429';
  if (status === 503 || status >= 500) return '5xx';
  if (status !== 200) return 'wrong-status';
  const code = body?.ok === false ? body.error?.code : undefined;
  if (code === 'UNAVAILABLE') return '5xx';
  if (code === undefined) return 'parity-mismatch';
  return `envelope-${code}`;
}

export function parseArguments(argv) {
  const options = { manifest: undefined, confirmStaging: false, plan: false, allowHost: undefined, cold: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--manifest') {
      options.manifest = argv[index + 1];
      index += 1;
    } else if (argument === '--allow-host') {
      options.allowHost = argv[index + 1];
      index += 1;
    } else if (argument === '--confirm-staging') {
      options.confirmStaging = true;
    } else if (argument === '--cold') {
      options.cold = true;
    } else if (argument === '--plan') {
      options.plan = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

/** A staging target is a `*.workers.dev` host whose name says staging. */
export function isStagingHost(hostname) {
  return hostname.endsWith('.workers.dev') && hostname.includes('staging');
}

function resolveInsideRepository(path, label) {
  const resolved = resolve(REPOSITORY_ROOT, path);
  if (resolved !== REPOSITORY_ROOT && !resolved.startsWith(`${REPOSITORY_ROOT}${sep}`)) {
    throw new Error(`${label} must resolve inside the repository.`);
  }
  if (!resolved.startsWith(resolve(REPOSITORY_ROOT, 'staging-local'))) {
    throw new Error(`${label} must stay inside staging-local/ so nothing measured is committed.`);
  }
  return resolved;
}

export function validateManifest(value, options = {}) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('The manifest must be a JSON object.');
  const manifest = value;
  if (typeof manifest.workerUrl !== 'string' || !manifest.workerUrl.startsWith('https://')) {
    throw new Error('workerUrl must be an https URL.');
  }
  const hostname = new URL(manifest.workerUrl).hostname;
  if (!isStagingHost(hostname) && options.allowHost !== hostname) {
    throw new Error(`workerUrl host ${hostname} does not look like a staging Worker; pass --allow-host ${hostname} to confirm the target explicitly.`);
  }
  if (!Array.isArray(manifest.origins) || manifest.origins.length === 0 || manifest.origins.some((origin) => typeof origin !== 'string')) {
    throw new Error('origins must list at least one allowed origin.');
  }
  if (!Array.isArray(manifest.operations) || manifest.operations.length === 0) throw new Error('operations must list at least one operation.');
  for (const operation of manifest.operations) {
    if (!(operation in OPERATION_READS)) throw new Error(`operations contains an unsupported operation: ${operation}`);
  }
  for (const phase of ['burst', 'sustained']) {
    const workload = manifest[phase];
    if (typeof workload !== 'object' || workload === null) throw new Error(`${phase} must describe the workload.`);
    if (!Number.isSafeInteger(workload.requests) || workload.requests < 1) throw new Error(`${phase}.requests must be a positive integer.`);
    if (!Number.isSafeInteger(workload.concurrency) || workload.concurrency < 1) throw new Error(`${phase}.concurrency must be a positive integer.`);
  }
  if (manifest.cold !== undefined) {
    if (typeof manifest.cold !== 'object' || manifest.cold === null) throw new Error('cold must describe the cold workload.');
    if (!Number.isSafeInteger(manifest.cold.requests) || manifest.cold.requests < 1) throw new Error('cold.requests must be a positive integer.');
  }
  if (typeof manifest.reportPath !== 'string' || manifest.reportPath.length === 0) throw new Error('reportPath is required.');
  if (typeof manifest.credentialPath !== 'string' || manifest.credentialPath.length === 0) throw new Error('credentialPath is required.');
  const reportPath = resolveInsideRepository(manifest.reportPath, 'reportPath');
  const credentialPath = resolveInsideRepository(manifest.credentialPath, 'credentialPath');
  return { ...manifest, reportPath, credentialPath };
}

/** Sliding-window budget over the Sheets reads the run is expected to spend. */
export class ReadBudget {
  constructor(limit = READ_BUDGET_PER_WINDOW, windowMs = WINDOW_MS, now = () => Date.now(), ledgerPath = undefined) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.spent = [];
    this.ledgerPath = ledgerPath;
  }

  /**
   * Loads timestamps a previous run recorded, so the rolling window is shared
   * across harness restarts: Google's read quota rolls continuously, so two
   * back-to-back manifest runs must not each believe a fresh window began.
   */
  async loadLedger() {
    if (this.ledgerPath === undefined) return;
    try {
      const parsed = JSON.parse(await readFile(this.ledgerPath, 'utf8'));
      if (Array.isArray(parsed?.spent)) this.spent = parsed.spent.filter((at) => typeof at === 'number' && at > this.now() - this.windowMs);
    } catch {
      // No ledger yet: the window starts empty for this run.
    }
  }

  async saveLedger() {
    if (this.ledgerPath === undefined) return;
    await writeFile(this.ledgerPath, `${JSON.stringify({ spent: this.spent })}\n`, 'utf8');
  }

  /** Reserves `reads` more reads once they fit inside the window. */
  async reserve(reads) {
    if (reads > this.limit) throw new Error(`A single request would exceed the read budget (${reads} > ${this.limit}).`);
    // The ledger is read once per process; within a process the window lives in
    // memory, and saves serialize behind a promise chain so concurrent workers
    // never overwrite each other's reservations.
    if (!this.loaded) {
      await this.loadLedger();
      this.loaded = true;
    }
    for (;;) {
      const cutoff = this.now() - this.windowMs;
      this.spent = this.spent.filter((at) => at > cutoff);
      if (this.spent.length + reads <= this.limit) {
        for (let index = 0; index < reads; index += 1) this.spent.push(this.now());
        this.saveQueue = (this.saveQueue ?? Promise.resolve()).then(() => this.saveLedger());
        await this.saveQueue;
        return;
      }
      const oldest = this.spent[0] ?? this.now();
      const waitMs = Math.max(1, oldest + this.windowMs - this.now());
      await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
    }
  }

  observed() {
    const cutoff = this.now() - this.windowMs;
    return this.spent.filter((at) => at > cutoff).length;
  }
}

/**
 * The campaign's attempt budget, shared across harness restarts like the read
 * budget: Google's and Cloudflare's quotas roll continuously, so two
 * back-to-back runs must not each believe a fresh campaign began. Every issued
 * request is one attempt whether it succeeded, failed, or was killed by the
 * platform, and a run that reaches the predeclared cap stops issuing rather
 * than continuing.
 */
export class AttemptBudget {
  constructor(limit = ATTEMPT_BUDGET_PER_CAMPAIGN, ledgerPath = undefined) {
    this.limit = limit;
    this.ledgerPath = ledgerPath;
    this.spent = 0;
  }

  async loadLedger() {
    if (this.ledgerPath === undefined) return;
    try {
      const parsed = JSON.parse(await readFile(this.ledgerPath, 'utf8'));
      if (Number.isSafeInteger(parsed?.spent) && parsed.spent >= 0) this.spent = parsed.spent;
    } catch {
      // No ledger yet: the campaign counter starts at zero for this run.
    }
  }

  async saveLedger() {
    if (this.ledgerPath === undefined) return;
    await writeFile(this.ledgerPath, `${JSON.stringify({ spent: this.spent })}\n`, 'utf8');
  }

  /** Reserves one attempt; `false` once the predeclared campaign cap is spent. */
  async reserve() {
    // Loaded once per process; saves serialize so concurrent workers never
    // lose an increment to a concurrent rewrite of the ledger.
    if (!this.loaded) {
      await this.loadLedger();
      this.loaded = true;
    }
    if (this.spent >= this.limit) return false;
    this.spent += 1;
    this.saveQueue = (this.saveQueue ?? Promise.resolve()).then(() => this.saveLedger());
    await this.saveQueue;
    return true;
  }

  observed() {
    return this.spent;
  }
}

/**
 * The Durable Object version-lag check for a cold attempt. A cold observation
 * counts as genuine only when the object answered with the manifest's expected
 * deployment marker; a lagging object is retained as evidence but not counted.
 */
export function classifyColdObservation(attempt, expectedHostDeployedAt) {
  if (attempt.failure) return 'failed';
  if (expectedHostDeployedAt === undefined) {
    return attempt.hostDeployedAt === undefined ? 'unverified' : 'unexpected-marker';
  }
  if (attempt.hostDeployedAt === undefined) return 'version-lag';
  return attempt.hostDeployedAt === expectedHostDeployedAt ? 'genuine' : 'version-lag';
}

export function planFor(manifest) {
  return {
    workerUrl: manifest.workerUrl,
    operations: manifest.operations,
    cold: manifest.cold ?? null,
    burst: manifest.burst,
    sustained: manifest.sustained,
    expectedReadsPerRequest: Object.fromEntries(manifest.operations.map((operation) => [operation, OPERATION_READS[operation]])),
    readBudgetPerWindow: READ_BUDGET_PER_WINDOW,
    windowSeconds: WINDOW_MS / 1000,
    attemptBudgetPerCampaign: ATTEMPT_BUDGET_PER_CAMPAIGN,
    /** Cold observations count only against the manifest's expected host version. */
    hostDeployedAt: manifest.hostDeployedAt ?? null,
    retries: 0,
    reportPath: manifest.reportPath,
    attemptLogPath: `${manifest.reportPath}.attempts.jsonl`
  };
}

function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

/** Summarises one phase, separating cold from warm and counting every failure. */
export function summarize(attempts, elapsedMs) {
  const durations = attempts.filter((attempt) => !attempt.failure).map((attempt) => attempt.durationMs);
  const failures = {};
  for (const attempt of attempts) {
    if (attempt.failure) failures[attempt.failure] = (failures[attempt.failure] ?? 0) + 1;
  }
  const reads = attempts.reduce((total, attempt) => total + (attempt.sheetsReads ?? 0), 0);
  const minutes = elapsedMs > 0 ? elapsedMs / 60_000 : 0;
  return {
    attempts: attempts.length,
    successes: attempts.length - Object.values(failures).reduce((total, count) => total + count, 0),
    failures,
    wallTimeMs: {
      min: durations.length ? Math.min(...durations) : null,
      p50: quantile(durations, 0.5),
      p95: quantile(durations, 0.95),
      max: durations.length ? Math.max(...durations) : null,
      // The contract's threshold statistic is the platform's warm CPU p99; this
      // wall-time p99 is reported for the browser-probe comparison only.
      p99: quantile(durations, 0.99)
    },
    // The values the contract requires and the platform does not publish.
    achieved: {
      requestsPerMinute: minutes > 0 ? Math.round((attempts.length / minutes) * 10) / 10 : null,
      sheetsReadsPerMinute: minutes > 0 ? Math.round((reads / minutes) * 10) / 10 : null,
      observedMaxInFlight: Math.max(0, ...attempts.map((attempt) => attempt.inFlight ?? 0)),
      sheetsReadsReportedByWorker: reads
    },
    statuses: attempts.reduce((counts, attempt) => {
      counts[String(attempt.status)] = (counts[String(attempt.status)] ?? 0) + 1;
      return counts;
    }, {}),
    snapshotDigests: [...new Set(attempts.map((attempt) => attempt.digest).filter(Boolean))]
  };
}

export async function runPhase(manifest, phase, workload, credential, budget, attemptLedger, fetchImpl, attemptLog) {
  const attempts = [];
  const startedAt = Date.now();
  let inFlight = 0;
  let deferred = 0;
  const queue = Array.from({ length: workload.requests }, (_unused, index) => index);
  const workers = Array.from({ length: workload.concurrency }, async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      if (!await attemptLedger.reserve()) {
        // The campaign's predeclared attempt cap is spent: this request was
        // never issued, and the queue is drained as deferred.
        deferred += 1;
        continue;
      }
      const operation = manifest.operations[index % manifest.operations.length];
      await budget.reserve(OPERATION_READS[operation]);
      inFlight += 1;
      const attemptStartedAt = Date.now();
      const attempt = { phase, index, operation, startedAt: new Date(attemptStartedAt).toISOString(), durationMs: 0, status: 0, inFlight, failure: undefined };
      try {
        const response = await fetchImpl(manifest.workerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ operation, payload: {}, idempotencyKey: `staging-${phase}-${attemptStartedAt}-${index}`, credential })
        });
        attempt.durationMs = Date.now() - attemptStartedAt;
        attempt.status = response.status;
        attempt.sheetsReads = Number(response.headers.get('x-staging-sheets-reads') ?? '') || 0;
        attempt.digest = response.headers.get('x-staging-snapshot-digest') ?? undefined;
        // The host version marker is the Durable Object version-lag check: a
        // cold observation counts only when the object answered with the
        // freshly deployed version, not with a lagging one.
        attempt.hostDeployedAt = response.headers.get('x-staging-host-deployed-at') ?? undefined;
        // The server-generated correlation id joins this attempt to gateway and
        // object telemetry; it is printed by the platform, never by us.
        attempt.correlationId = response.headers.get('x-staging-correlation-id') ?? undefined;
        const body = await response.json().catch(() => undefined);
        attempt.envelopeOk = body?.ok === true;
        attempt.errorCode = body?.ok === false ? body.error?.code : undefined;
        attempt.failure = body?.ok === true ? undefined : classifyFailure(response.status, body, undefined);
      } catch (error) {
        attempt.durationMs = Date.now() - attemptStartedAt;
        attempt.failure = classifyFailure(0, undefined, error);
      } finally {
        inFlight -= 1;
      }
      attempts.push(attempt);
      // Written as it completes, so an aborted run still keeps its evidence.
      await appendFile(attemptLog, `${JSON.stringify(attempt)}\n`, 'utf8');
    }
  });
  await Promise.all(workers);
  return { attempts: attempts.sort((left, right) => left.index - right.index), elapsedMs: Date.now() - startedAt, deferred };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\nUsage: measure-worker.mjs --manifest PATH [--plan] [--cold] [--allow-host HOST] --confirm-staging`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log('Usage: measure-worker.mjs --manifest PATH [--plan] [--cold] [--allow-host HOST] --confirm-staging');
    return;
  }
  if (!options.manifest) {
    console.error('A --manifest path is required; refusing to guess a staging target.');
    process.exitCode = 1;
    return;
  }

  let manifest;
  try {
    manifest = validateManifest(JSON.parse(await readFile(resolve(options.manifest), 'utf8')), { allowHost: options.allowHost });
  } catch (error) {
    console.error(`The manifest is not usable: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (options.plan || !options.confirmStaging) {
    console.log(JSON.stringify(planFor(manifest), null, 2));
    if (!options.confirmStaging) {
      console.error('Refusing to send any request: pass --confirm-staging once the staging deployment is approved and reachable.');
      process.exitCode = options.plan ? 0 : 1;
    }
    return;
  }

  let credential;
  try {
    credential = (await readFile(manifest.credentialPath, 'utf8')).trim();
  } catch {
    console.error(`The credential file could not be read at ${manifest.credentialPath}.`);
    process.exitCode = 1;
    return;
  }
  if (credential.length === 0) {
    console.error('The credential file is empty.');
    process.exitCode = 1;
    return;
  }

  const plan = planFor(manifest);
  // The ledgers live next to the report in staging-local/, so every harness
  // run in the campaign shares one rolling read window and one attempt count;
  // neither quota resets when a new process starts.
  const budget = new ReadBudget(undefined, undefined, undefined, resolve(dirname(manifest.reportPath), '.read-budget-ledger.json'));
  await budget.loadLedger();
  const attemptLedger = new AttemptBudget(undefined, resolve(dirname(manifest.reportPath), '.attempt-budget-ledger.json'));
  await attemptLedger.loadLedger();
  const attemptsBeforeRun = attemptLedger.observed();
  const startedAt = new Date().toISOString();
  await mkdir(dirname(manifest.reportPath), { recursive: true });
  await writeFile(plan.attemptLogPath, '', 'utf8');

  // Cold observations come first and only from a fresh deployment; the operator
  // passes --cold on the first run after each approved upload. A cold attempt
  // counts as a genuine cold observation only when the object answered with the
  // manifest's expected host version; a lagging object is retained as evidence
  // but not counted, so a stale version can never be measured as a cold start.
  const expectedHostDeployedAt = manifest.hostDeployedAt ?? undefined;

  // Cold observations come first and only from a fresh deployment; the operator
  // passes --cold on the first run after each approved upload.
  const cold = options.cold
    ? await runPhase(manifest, 'cold', { requests: manifest.cold?.requests ?? 5, concurrency: 1 }, credential, budget, attemptLedger, fetch, plan.attemptLogPath)
    : { attempts: [], elapsedMs: 0, deferred: 0 };
  const coldBreakdown = cold.attempts.reduce((counts, attempt) => {
    const kind = classifyColdObservation(attempt, expectedHostDeployedAt);
    counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }, {});
  const burst = await runPhase(manifest, 'burst', manifest.burst, credential, budget, attemptLedger, fetch, plan.attemptLogPath);
  const sustained = await runPhase(manifest, 'sustained', manifest.sustained, credential, budget, attemptLedger, fetch, plan.attemptLogPath);

  const report = {
    generatedAt: new Date().toISOString(),
    startedAt,
    workerUrl: manifest.workerUrl,
    fixtureDigest: manifest.fixtureDigest ?? null,
    hostDeployedAt: manifest.hostDeployedAt ?? null,
    workload: plan,
    budget: {
      limit: READ_BUDGET_PER_WINDOW,
      windowSeconds: WINDOW_MS / 1000,
      observedReadsInLastWindow: budget.observed(),
      attempts: { limit: ATTEMPT_BUDGET_PER_CAMPAIGN, spentBeforeRun: attemptsBeforeRun, spentAfterRun: attemptLedger.observed() }
    },
    cold: options.cold
      ? {
        observations: cold.attempts.length,
        expectedHostDeployedAt: expectedHostDeployedAt ?? null,
        breakdown: coldBreakdown,
        genuineObservations: coldBreakdown.genuine ?? 0,
        sufficient: (coldBreakdown.genuine ?? 0) >= 5,
        ...summarize(cold.attempts, cold.elapsedMs),
        deferred: cold.deferred
      }
      : { observations: 0, sufficient: false, note: 'Run with --cold immediately after an approved upload to collect cold observations.' },
    burst: summarize(burst.attempts, burst.elapsedMs),
    sustained: summarize(sustained.attempts, sustained.elapsedMs),
    deferredByPhase: { cold: cold.deferred, burst: burst.deferred, sustained: sustained.deferred },
    // Sanitization: no credential, no response body, no workbook id, no account id.
    sanitized: true
  };
  await writeFile(manifest.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${manifest.reportPath} and ${plan.attemptLogPath}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
