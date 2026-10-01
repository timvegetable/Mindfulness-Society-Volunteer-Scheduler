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
export const HOST_VERSION_PROPAGATION_MS = 95_000;
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
  const stagingDirectory = resolve(REPOSITORY_ROOT, 'staging-local');
  if (!resolved.startsWith(`${stagingDirectory}${sep}`)) {
    throw new Error(`${label} must stay inside staging-local/ so nothing measured is committed.`);
  }
  return resolved;
}

function hostTimestampMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new Error('hostDeployedAt must be a canonical UTC timestamp such as 2026-09-30T12:00:00.000Z.');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error('hostDeployedAt must be a valid canonical UTC timestamp.');
  }
  return timestamp;
}

/** Validates and returns the canonical marker shared by staging manifests. */
export function validateHostDeployedAt(value) {
  hostTimestampMs(value);
  return value;
}

async function readLedgerFile(path, label) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`The shared ${label} ledger could not be read.`, { cause: error });
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`The shared ${label} ledger is malformed.`, { cause: error });
  }
}

/**
 * The Sheets reads one request of `operation` is expected to spend. A manifest
 * may override the archived campaign's constant; the default is that constant.
 */
export function readsFor(manifest, operation) {
  return manifest.readsPerRequest?.[operation] ?? OPERATION_READS[operation];
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
  if (options.requireHostDeployedAt && manifest.hostDeployedAt === undefined) {
    throw new Error('hostDeployedAt is required for a confirmed staging run.');
  }
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
  if (manifest.readsPerRequest !== undefined) {
    // A portable deployment pays more Sheets requests per read than the archived
    // campaign did (the bracket adds a control read), and the rolling ledger
    // paces on the reservation. Reserving the old constant would let a run spend
    // more than the per-minute quota the ledger exists to respect, so a manifest
    // may declare what a read actually costs. Defaults keep every existing
    // manifest's behaviour.
    if (typeof manifest.readsPerRequest !== 'object' || manifest.readsPerRequest === null || Array.isArray(manifest.readsPerRequest)) {
      throw new Error('readsPerRequest must be a JSON object of operation to a positive integer.');
    }
    for (const [operation, reads] of Object.entries(manifest.readsPerRequest)) {
      if (!(operation in OPERATION_READS)) throw new Error(`readsPerRequest names an unsupported operation: ${operation}`);
      if (!Number.isSafeInteger(reads) || reads < 1) throw new Error(`readsPerRequest.${operation} must be a positive integer.`);
    }
  }
  if (manifest.hostDeployedAt !== undefined) hostTimestampMs(manifest.hostDeployedAt);
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
    this.loading = undefined;
  }

  /**
   * Loads timestamps a previous run recorded, so the rolling window is shared
   * across harness restarts: Google's read quota rolls continuously, so two
   * back-to-back manifest runs must not each believe a fresh window began.
   */
  async loadLedger() {
    if (this.ledgerPath === undefined) {
      this.loaded = true;
      return;
    }
    const parsed = await readLedgerFile(this.ledgerPath, 'read-budget');
    if (parsed === undefined) {
      this.spent = [];
    } else if (!Array.isArray(parsed?.spent) || parsed.spent.some((at) => !Number.isSafeInteger(at) || at < 0)) {
      throw new Error('The shared read-budget ledger has an invalid format.');
    } else {
      this.spent = parsed.spent.filter((at) => at > this.now() - this.windowMs);
    }
    this.loaded = true;
  }

  /** Concurrent first reservations share one ledger read before spending. */
  ensureLoaded() {
    if (this.loaded) return Promise.resolve();
    if (this.loading === undefined) {
      this.loading = this.loadLedger()
        .then(() => { this.loaded = true; })
        .catch((error) => {
          this.loading = undefined;
          throw error;
        });
    }
    return this.loading;
  }

  async saveLedger() {
    if (this.ledgerPath === undefined) return;
    await writeFile(this.ledgerPath, `${JSON.stringify({ spent: this.spent })}\n`, 'utf8');
  }

  /** Await any write still in flight, so a finished run is fully recorded. */
  async flush() {
    await (this.saveQueue ?? Promise.resolve());
  }

  /** Reserves `reads` more reads once they fit inside the window. */
  async reserve(reads) {
    if (reads > this.limit) throw new Error(`A single request would exceed the read budget (${reads} > ${this.limit}).`);
    // The ledger is read once per process; within a process the window lives in
    // memory, and saves serialize behind a promise chain so concurrent workers
    // never overwrite each other's reservations.
    await this.ensureLoaded();
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
    this.loading = undefined;
  }

  async loadLedger() {
    if (this.ledgerPath === undefined) {
      this.loaded = true;
      return;
    }
    const parsed = await readLedgerFile(this.ledgerPath, 'attempt-budget');
    if (parsed === undefined) {
      this.spent = 0;
    } else if (!Number.isSafeInteger(parsed?.spent) || parsed.spent < 0) {
      throw new Error('The shared attempt-budget ledger has an invalid format.');
    } else {
      this.spent = parsed.spent;
    }
    this.loaded = true;
  }

  /** Concurrent first reservations share one ledger read before spending. */
  ensureLoaded() {
    if (this.loaded) return Promise.resolve();
    if (this.loading === undefined) {
      this.loading = this.loadLedger()
        .then(() => { this.loaded = true; })
        .catch((error) => {
          this.loading = undefined;
          throw error;
        });
    }
    return this.loading;
  }

  async saveLedger() {
    if (this.ledgerPath === undefined) return;
    await writeFile(this.ledgerPath, `${JSON.stringify({ spent: this.spent })}\n`, 'utf8');
  }

  /** Await any write still in flight, so a finished run is fully recorded. */
  async flush() {
    await (this.saveQueue ?? Promise.resolve());
  }

  /** Reserves one attempt; `false` once the predeclared campaign cap is spent. */
  async reserve() {
    // Loaded once per process; saves serialize so concurrent workers never
    // lose an increment to a concurrent rewrite of the ledger.
    await this.ensureLoaded();
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

/**
 * The campaign-wide ledgers. Both tools that spend attempts or reads use these
 * two files, so a run's spend is visible to every later run.
 */
export function campaignLedgerPaths() {
  const directory = resolve(REPOSITORY_ROOT, 'staging-local');
  return {
    read: resolve(directory, '.read-budget-ledger.json'),
    attempt: resolve(directory, '.attempt-budget-ledger.json')
  };
}

export function planFor(manifest, now = Date.now()) {
  const readyAtMs = manifest.hostDeployedAt === undefined
    ? undefined
    : hostTimestampMs(manifest.hostDeployedAt) + HOST_VERSION_PROPAGATION_MS;
  return {
    workerUrl: manifest.workerUrl,
    operations: manifest.operations,
    cold: manifest.cold ?? null,
    burst: manifest.burst,
    sustained: manifest.sustained,
    expectedReadsPerRequest: Object.fromEntries(manifest.operations.map((operation) => [operation, readsFor(manifest, operation)])),
    readBudgetPerWindow: READ_BUDGET_PER_WINDOW,
    windowSeconds: WINDOW_MS / 1000,
    attemptBudgetPerCampaign: ATTEMPT_BUDGET_PER_CAMPAIGN,
    /** Cold observations count only against the manifest's expected host version. */
    hostDeployedAt: manifest.hostDeployedAt ?? null,
    hostReadiness: {
      required: readyAtMs !== undefined,
      minimumDelayMs: HOST_VERSION_PROPAGATION_MS,
      readyAt: readyAtMs === undefined ? null : new Date(readyAtMs).toISOString(),
      waitRemainingMs: readyAtMs === undefined ? null : Math.max(0, readyAtMs - now)
    },
    retries: 0,
    reportPath: manifest.reportPath,
    attemptLogPath: `${manifest.reportPath}.attempts.jsonl`
  };
}

/** Waits until the expected Durable Object deployment marker has propagated. */
export async function waitForHostVersion(manifest, options = {}) {
  if (manifest.hostDeployedAt === undefined) {
    return { required: false, readyAt: null, waitedMs: 0 };
  }
  const readyAtMs = hostTimestampMs(manifest.hostDeployedAt) + HOST_VERSION_PROPAGATION_MS;
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? ((durationMs) => new Promise((resolveWait) => setTimeout(resolveWait, durationMs)));
  const startedAt = now();
  const waitMs = Math.max(0, readyAtMs - startedAt);
  if (waitMs > 0) await wait(waitMs);
  const finishedAt = now();
  if (finishedAt < readyAtMs) {
    throw new Error(`The staging host version is not ready yet; wait until ${new Date(readyAtMs).toISOString()} before measuring.`);
  }
  return {
    required: true,
    readyAt: new Date(readyAtMs).toISOString(),
    waitedMs: Math.max(0, finishedAt - startedAt)
  };
}

function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

/** Parses the per-request Sheets timings without accepting a partially valid list. */
export function readTimingsFrom(headerValue, expectedReadCount = undefined) {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') return null;
  const parts = headerValue.split(',').map((part) => part.trim());
  if (parts.some((part) => !/^\d+$/u.test(part))) return null;
  if (expectedReadCount !== undefined && parts.length !== expectedReadCount) return null;
  const timings = parts.map((part) => Number(part));
  return timings.every(Number.isSafeInteger) ? timings : null;
}

function observedMaxInFlight(attempt) {
  return attempt.observedMaxInFlightDuringRequest ?? attempt.inFlight ?? 0;
}

/** Summarises one population while keeping failures and expected-version lag explicit. */
function summarizePopulation(attempts, expectedHostDeployedAt) {
  const failures = {};
  for (const attempt of attempts) {
    if (attempt.failure) failures[attempt.failure] = (failures[attempt.failure] ?? 0) + 1;
  }
  const versionLagged = expectedHostDeployedAt === undefined
    ? []
    : attempts.filter((attempt) => !attempt.failure && attempt.hostDeployedAt !== expectedHostDeployedAt);
  const versionLaggedSet = new Set(versionLagged);
  const latencyAttempts = attempts.filter((attempt) => !attempt.failure && !versionLaggedSet.has(attempt));
  const durations = latencyAttempts.map((attempt) => attempt.durationMs);
  const attemptsAtLeast3InFlight = attempts.filter((attempt) => observedMaxInFlight(attempt) >= 3);
  const versionLagAtLeast3InFlight = versionLagged.filter((attempt) => observedMaxInFlight(attempt) >= 3);
  const successfulObservationsAtLeast3InFlight = latencyAttempts.filter((attempt) => observedMaxInFlight(attempt) >= 3);
  const highConcurrencyDurations = successfulObservationsAtLeast3InFlight.map((attempt) => attempt.durationMs);
  return {
    attempts: attempts.length,
    successes: attempts.length - Object.values(failures).reduce((total, count) => total + count, 0),
    failures,
    versionLag: expectedHostDeployedAt === undefined ? null : versionLagged.length,
    latencyObservations: latencyAttempts.length,
    latencyObservationsAtLeast3InFlight: highConcurrencyDurations.length,
    wallTimeMs: {
      min: durations.length ? Math.min(...durations) : null,
      p50: quantile(durations, 0.5),
      p95: quantile(durations, 0.95),
      max: durations.length ? Math.max(...durations) : null,
      // This is the warm end-to-end wall-time p99 used for the latency gate and
      // browser-probe comparison; it is not a platform CPU-time measurement.
      p99: quantile(durations, 0.99)
    },
    wallTimeMsAtLeast3InFlight: {
      min: highConcurrencyDurations.length ? Math.min(...highConcurrencyDurations) : null,
      p50: quantile(highConcurrencyDurations, 0.5),
      p95: quantile(highConcurrencyDurations, 0.95),
      p99: quantile(highConcurrencyDurations, 0.99),
      max: highConcurrencyDurations.length ? Math.max(...highConcurrencyDurations) : null
    },
    achieved: {
      observedMaxInFlight: Math.max(0, ...attempts.map(observedMaxInFlight)),
      attemptsAtLeast3InFlight: attemptsAtLeast3InFlight.length,
      successfulObservationsAtLeast3InFlight: successfulObservationsAtLeast3InFlight.length,
      versionLagAtLeast3InFlight: expectedHostDeployedAt === undefined ? null : versionLagAtLeast3InFlight.length
    }
  };
}

/** Summarises a phase and preserves its aggregate beside operation populations. */
export function summarize(attempts, elapsedMs, expectedHostDeployedAt = undefined, operations = []) {
  const population = summarizePopulation(attempts, expectedHostDeployedAt);
  const reads = attempts.reduce((total, attempt) => total + (attempt.sheetsReads ?? 0), 0);
  const minutes = elapsedMs > 0 ? elapsedMs / 60_000 : 0;
  const grouped = new Map();
  for (const operation of operations) {
    if (typeof operation === 'string' && !grouped.has(operation)) grouped.set(operation, []);
  }
  for (const attempt of attempts) {
    const operation = typeof attempt.operation === 'string' ? attempt.operation : 'unknown';
    const operationAttempts = grouped.get(operation) ?? [];
    operationAttempts.push(attempt);
    grouped.set(operation, operationAttempts);
  }
  const byOperation = Object.fromEntries([...grouped].map(([operation, operationAttempts]) => {
    const operationPopulation = summarizePopulation(operationAttempts, expectedHostDeployedAt);
    const operationReads = operationAttempts.reduce((total, attempt) => total + (attempt.sheetsReads ?? 0), 0);
    return [operation, {
      ...operationPopulation,
      achieved: {
        ...operationPopulation.achieved,
        requestsPerMinute: minutes > 0 ? Math.round((operationAttempts.length / minutes) * 10) / 10 : null,
        sheetsReadsPerMinute: minutes > 0 ? Math.round((operationReads / minutes) * 10) / 10 : null,
        sheetsReadsReportedByWorker: operationReads
      }
    }];
  }));
  return {
    attempts: population.attempts,
    successes: population.successes,
    failures: population.failures,
    versionLag: population.versionLag,
    latencyObservations: population.latencyObservations,
    latencyObservationsAtLeast3InFlight: population.latencyObservationsAtLeast3InFlight,
    wallTimeMs: population.wallTimeMs,
    wallTimeMsAtLeast3InFlight: population.wallTimeMsAtLeast3InFlight,
    // The values the contract requires and the platform does not publish.
    achieved: {
      requestsPerMinute: minutes > 0 ? Math.round((attempts.length / minutes) * 10) / 10 : null,
      sheetsReadsPerMinute: minutes > 0 ? Math.round((reads / minutes) * 10) / 10 : null,
      ...population.achieved,
      sheetsReadsReportedByWorker: reads
    },
    statuses: attempts.reduce((counts, attempt) => {
      counts[String(attempt.status)] = (counts[String(attempt.status)] ?? 0) + 1;
      return counts;
    }, {}),
    snapshotDigests: [...new Set(attempts.map((attempt) => attempt.digest).filter(Boolean))],
    byOperation
  };
}

export async function runPhase(manifest, phase, workload, credential, budget, attemptLedger, fetchImpl, attemptLog, readinessOptions = {}) {
  // Wait before reserving either an attempt or Sheets reads. A redeployed
  // Durable Object must have passed the documented version-propagation window.
  const hostReadiness = await waitForHostVersion(manifest, readinessOptions);
  const attempts = [];
  const startedAt = Date.now();
  let inFlight = 0;
  const activeAttempts = new Set();
  let deferred = 0;
  const deferredAttempts = [];
  const stopState = readinessOptions.stopState ?? { stoppedBy429: false, phase: null };
  const queue = Array.from({ length: workload.requests }, (_unused, index) => index);
  const defer = async (index, reason, operation, attemptReserved = false, readsReserved = false) => {
    const record = {
      phase,
      index,
      operation,
      issued: false,
      deferred: true,
      deferredReason: reason,
      attemptReserved,
      readsReserved,
      status: 0,
      failure: reason === 'http-429' ? 'stopped-after-429' : 'attempt-budget-exhausted'
    };
    deferred += 1;
    deferredAttempts.push(record);
    await appendFile(attemptLog, `${JSON.stringify(record)}\n`, 'utf8');
  };
  const workers = Array.from({ length: workload.concurrency }, async () => {
    for (;;) {
      if (stopState.stoppedBy429) return;
      const index = queue.shift();
      if (index === undefined) return;
      const operation = manifest.operations[index % manifest.operations.length];
      if (stopState.stoppedBy429) {
        await defer(index, 'http-429', operation);
        continue;
      }
      const attemptReserved = await attemptLedger.reserve();
      if (stopState.stoppedBy429) {
        await defer(index, 'http-429', operation, attemptReserved);
        continue;
      }
      if (!attemptReserved) {
        // The campaign's predeclared attempt cap is spent: this request was
        // never issued, and the queue is drained as deferred.
        await defer(index, 'attempt-budget-exhausted', operation);
        continue;
      }
      await budget.reserve(readsFor(manifest, operation));
      if (stopState.stoppedBy429) {
        // The reservation is intentionally retained: an issued 429 stops new
        // target calls, but reservations are never refunded or retried.
        await defer(index, 'http-429', operation, true, true);
        continue;
      }
      inFlight += 1;
      const attemptStartedAt = Date.now();
      const attempt = { phase, index, operation, startedAt: new Date(attemptStartedAt).toISOString(), durationMs: 0, status: 0, inFlight, observedMaxInFlightDuringRequest: inFlight, failure: undefined };
      activeAttempts.add(attempt);
      for (const activeAttempt of activeAttempts) {
        activeAttempt.observedMaxInFlightDuringRequest = Math.max(activeAttempt.observedMaxInFlightDuringRequest, inFlight);
      }
      try {
        const response = await fetchImpl(manifest.workerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ operation, payload: {}, idempotencyKey: `staging-${phase}-${attemptStartedAt}-${index}`, credential })
        });
        attempt.status = response.status;
        if (response.status === 429 && !stopState.stoppedBy429) {
          stopState.stoppedBy429 = true;
          stopState.phase = phase;
        }
        attempt.sheetsReads = Number(response.headers.get('x-staging-sheets-reads') ?? '') || 0;
        attempt.readMs = readTimingsFrom(response.headers.get('x-staging-read-ms'), attempt.sheetsReads);
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
        const successful = response.status === 200 && body?.ok === true;
        attempt.failure = successful ? undefined : classifyFailure(response.status, body, undefined);
      } catch (error) {
        attempt.failure = classifyFailure(0, undefined, error);
      } finally {
        // Include response-body hydration/parsing in end-to-end wall time and
        // in the active-request overlap population.
        attempt.durationMs = Date.now() - attemptStartedAt;
        activeAttempts.delete(attempt);
        inFlight -= 1;
      }
      attempts.push(attempt);
      // Written as it completes, so an aborted run still keeps its evidence.
      await appendFile(attemptLog, `${JSON.stringify(attempt)}\n`, 'utf8');
    }
  });
  await Promise.all(workers);
  if (stopState.stoppedBy429) {
    for (const index of queue.splice(0)) {
      const operation = manifest.operations[index % manifest.operations.length];
      await defer(index, 'http-429', operation);
    }
  }
  return {
    attempts: attempts.sort((left, right) => left.index - right.index),
    elapsedMs: Date.now() - startedAt,
    deferred,
    deferredAttempts,
    stoppedBy429: stopState.stoppedBy429,
    stopPhase: stopState.phase ?? null,
    hostReadiness
  };
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
    manifest = validateManifest(JSON.parse(await readFile(resolve(options.manifest), 'utf8')), {
      allowHost: options.allowHost,
      requireHostDeployedAt: options.confirmStaging
    });
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
  // One campaign ledger, wherever the report happens to be written. Deriving it
  // from the report's directory looked shared but was not: a manifest whose
  // report sat in a subdirectory of staging-local silently started a second
  // rolling window and a second attempt count, and the campaign cap and the
  // per-minute quota were both enforced against the wrong numbers.
  const ledgers = campaignLedgerPaths();
  const budget = new ReadBudget(undefined, undefined, undefined, ledgers.read);
  await budget.loadLedger();
  const attemptLedger = new AttemptBudget(undefined, ledgers.attempt);
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
  const stopState = { stoppedBy429: false, phase: null };
  const phaseOptions = { stopState };

  // Cold observations come first and only from a fresh deployment; the operator
  // passes --cold on the first run after each approved upload.
  const cold = options.cold
    ? await runPhase(manifest, 'cold', { requests: manifest.cold?.requests ?? 5, concurrency: 1 }, credential, budget, attemptLedger, fetch, plan.attemptLogPath, phaseOptions)
    : { attempts: [], elapsedMs: 0, deferred: 0, hostReadiness: { required: manifest.hostDeployedAt !== undefined, readyAt: plan.hostReadiness.readyAt, waitedMs: 0 } };
  const coldBreakdown = cold.attempts.reduce((counts, attempt) => {
    const kind = classifyColdObservation(attempt, expectedHostDeployedAt);
    counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }, {});
  const burst = await runPhase(manifest, 'burst', manifest.burst, credential, budget, attemptLedger, fetch, plan.attemptLogPath, phaseOptions);
  const sustained = await runPhase(manifest, 'sustained', manifest.sustained, credential, budget, attemptLedger, fetch, plan.attemptLogPath, phaseOptions);

  const report = {
    generatedAt: new Date().toISOString(),
    startedAt,
    workerUrl: manifest.workerUrl,
    fixtureDigest: manifest.fixtureDigest ?? null,
    hostDeployedAt: manifest.hostDeployedAt ?? null,
    hostReadiness: {
      required: manifest.hostDeployedAt !== undefined,
      minimumDelayMs: HOST_VERSION_PROPAGATION_MS,
      readyAt: plan.hostReadiness.readyAt,
      waitedMsByPhase: {
        cold: cold.hostReadiness.waitedMs,
        burst: burst.hostReadiness.waitedMs,
        sustained: sustained.hostReadiness.waitedMs
      }
    },
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
        ...summarize(cold.attempts, cold.elapsedMs, expectedHostDeployedAt, manifest.operations),
        deferred: cold.deferred
      }
      : { observations: 0, sufficient: false, note: 'Run with --cold immediately after an approved upload to collect cold observations.' },
    burst: summarize(burst.attempts, burst.elapsedMs, expectedHostDeployedAt, manifest.operations),
    sustained: summarize(sustained.attempts, sustained.elapsedMs, expectedHostDeployedAt, manifest.operations),
    deferredByPhase: { cold: cold.deferred, burst: burst.deferred, sustained: sustained.deferred },
    stopOn429: { stopped: stopState.stoppedBy429, phase: stopState.phase },
    // Sanitization: no credential, no response body, no workbook id, no account id.
    sanitized: true
  };
  await writeFile(manifest.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  // The ledgers save asynchronously as reservations are made; without this the
  // last few of a run's attempts can be missing from the file it just spent
  // against.
  await budget.flush();
  await attemptLedger.flush();
  console.log(`Wrote ${manifest.reportPath} and ${plan.attemptLogPath}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
