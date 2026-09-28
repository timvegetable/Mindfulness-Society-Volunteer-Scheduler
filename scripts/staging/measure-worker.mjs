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
  constructor(limit = READ_BUDGET_PER_WINDOW, windowMs = WINDOW_MS, now = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.spent = [];
  }

  /** Waits until `reads` more reads fit inside the window. */
  async reserve(reads) {
    if (reads > this.limit) throw new Error(`A single request would exceed the read budget (${reads} > ${this.limit}).`);
    for (;;) {
      const cutoff = this.now() - this.windowMs;
      this.spent = this.spent.filter((at) => at > cutoff);
      if (this.spent.length + reads <= this.limit) {
        for (let index = 0; index < reads; index += 1) this.spent.push(this.now());
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

async function runPhase(manifest, phase, workload, credential, budget, fetchImpl, attemptLog) {
  const attempts = [];
  const startedAt = Date.now();
  let inFlight = 0;
  const queue = Array.from({ length: workload.requests }, (_unused, index) => index);
  const workers = Array.from({ length: workload.concurrency }, async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
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
  return { attempts: attempts.sort((left, right) => left.index - right.index), elapsedMs: Date.now() - startedAt };
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
  const budget = new ReadBudget();
  const startedAt = new Date().toISOString();
  await mkdir(dirname(manifest.reportPath), { recursive: true });
  await writeFile(plan.attemptLogPath, '', 'utf8');

  // Cold observations come first and only from a fresh deployment; the operator
  // passes --cold on the first run after each approved upload.
  const cold = options.cold
    ? await runPhase(manifest, 'cold', { requests: manifest.cold?.requests ?? 5, concurrency: 1 }, credential, budget, fetch, plan.attemptLogPath)
    : { attempts: [], elapsedMs: 0 };
  const burst = await runPhase(manifest, 'burst', manifest.burst, credential, budget, fetch, plan.attemptLogPath);
  const sustained = await runPhase(manifest, 'sustained', manifest.sustained, credential, budget, fetch, plan.attemptLogPath);

  const report = {
    generatedAt: new Date().toISOString(),
    startedAt,
    workerUrl: manifest.workerUrl,
    fixtureDigest: manifest.fixtureDigest ?? null,
    workload: plan,
    budget: { limit: READ_BUDGET_PER_WINDOW, windowSeconds: WINDOW_MS / 1000, observedReadsInLastWindow: budget.observed() },
    cold: options.cold
      ? { observations: cold.attempts.length, sufficient: cold.attempts.length >= 5, ...summarize(cold.attempts, cold.elapsedMs) }
      : { observations: 0, sufficient: false, note: 'Run with --cold immediately after an approved upload to collect cold observations.' },
    burst: summarize(burst.attempts, burst.elapsedMs),
    sustained: summarize(sustained.attempts, sustained.elapsedMs),
    // Sanitization: no credential, no response body, no workbook id, no account id.
    sanitized: true
  };
  await writeFile(manifest.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${manifest.reportPath} and ${plan.attemptLogPath}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
