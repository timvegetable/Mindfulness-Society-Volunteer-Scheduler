#!/usr/bin/env node
// Read-matrix driver: runs a declarative list of control-protocol read checks
// against a deployed staging reader and retains what each one did.
//
// The committed replacement for the untracked throwaway that ran the 2026-09-29
// reader checks one operation at a time. It answers one question per check —
// which envelope, code, reason and Sheets read count the served path returns —
// and decides nothing silently: every check declares its expectation up front,
// every read is paced through the same rolling read budget the harness and the
// browser probe share, every check spends exactly one attempt from the shared
// attempt ledger, and one unmet expectation makes the run exit nonzero. Nothing
// runs without --confirm-staging, reports and attempt logs stay under
// staging-local/, and no credential, response body or row value is recorded.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlReadCheck, evaluateExpectation } from './control-read-check.mjs';
import { AttemptBudget, HOST_VERSION_PROPAGATION_MS, OPERATION_READS, ReadBudget, isStagingHost, validateHostDeployedAt, waitForHostVersion } from './measure-worker.mjs';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const STAGING_DIRECTORY = resolve(REPOSITORY_ROOT, 'staging-local');
const USAGE = 'Usage: control-read-checks.mjs --checks PATH [--report PATH] [--allow-host HOST] [--plan] --confirm-staging';
/** `ok`, `failed:<CODE>` or `failed:<CODE>:<reason>`; nothing else is a check. */
const EXPECTATION_PATTERN = /^(?:ok|failed:[^:]+(?::[^:]+)?)$/;
/** One registered mutator may appear only as an explicit no-write policy probe. */
const POLICY_REFUSAL_CHECKS = Object.freeze({
  'admin.schedule.rerun': { expectation: 'failed:FORBIDDEN', minimumReads: 2 }
});

export function parseArguments(argv) {
  const options = { checks: undefined, report: undefined, allowHost: undefined, confirmStaging: false, plan: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${argument} needs a value.`);
      return argv[index];
    };
    if (argument === '--checks') options.checks = next();
    else if (argument === '--report') options.report = next();
    else if (argument === '--allow-host') options.allowHost = next();
    else if (argument === '--confirm-staging') options.confirmStaging = true;
    else if (argument === '--plan') options.plan = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

/** Every path a run reads or writes stays in the ignored staging directory. */
function resolveInsideStaging(path, label) {
  const resolved = resolve(REPOSITORY_ROOT, path);
  if (resolved !== STAGING_DIRECTORY && !resolved.startsWith(`${STAGING_DIRECTORY}${sep}`)) {
    throw new Error(`${label} must stay inside staging-local/ so nothing measured is committed.`);
  }
  return resolved;
}

/** The attempt log sits beside its report and never leaves staging-local/. */
function attemptLogFor(reportPath) {
  return `${reportPath}.attempts.jsonl`;
}

export function validateCheckList(value, options = {}) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('The check list must be a JSON object.');
  const list = value;
  if (typeof list.workerUrl !== 'string' || !list.workerUrl.startsWith('https://')) {
    throw new Error('workerUrl must be an https URL.');
  }
  const hostname = new URL(list.workerUrl).hostname;
  if (!isStagingHost(hostname) && options.allowHost !== hostname) {
    throw new Error(`workerUrl host ${hostname} does not look like a staging Worker; pass --allow-host ${hostname} to confirm the target explicitly.`);
  }
  if (!Array.isArray(list.checks) || list.checks.length === 0) throw new Error('checks must list at least one check.');
  if (options.requireHostDeployedAt && list.hostDeployedAt === undefined) {
    throw new Error('hostDeployedAt is required for a confirmed read-matrix run.');
  }
  if (list.hostDeployedAt !== undefined) validateHostDeployedAt(list.hostDeployedAt);
  const checks = list.checks.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`checks[${index}] must be an object.`);
    const policyRefusal = typeof entry.operation === 'string' && Object.hasOwn(POLICY_REFUSAL_CHECKS, entry.operation);
    if (typeof entry.operation !== 'string' || (!Object.hasOwn(OPERATION_READS, entry.operation) && !policyRefusal)) {
      throw new Error(`checks[${index}] names an unsupported operation: ${entry.operation}`);
    }
    // The expectation is checked here as well as compared later: a typo must not
    // spend a paced read or a campaign attempt to discover that it is unparseable.
    if (typeof entry.expectation !== 'string' || !EXPECTATION_PATTERN.test(entry.expectation)) {
      throw new Error(`checks[${index}] expectation ${entry.expectation} must be \`ok\` or \`failed:CODE[:reason]\`.`);
    }
    if (policyRefusal && entry.expectation !== POLICY_REFUSAL_CHECKS[entry.operation].expectation) {
      throw new Error(`checks[${index}] policy-refusal operation ${entry.operation} requires expectation ${POLICY_REFUSAL_CHECKS[entry.operation].expectation}.`);
    }
    if (entry.label !== undefined && typeof entry.label !== 'string') throw new Error(`checks[${index}].label must be a string.`);
    const credentialMode = entry.credentialMode ?? 'configured';
    if (credentialMode !== 'none' && credentialMode !== 'configured') {
      throw new Error(`checks[${index}].credentialMode must be \`none\` or \`configured\`.`);
    }
    // A portable read costs more than the archived counts, so a check may declare
    // what it reserves; the default is the operation's pinned cost.
    const reads = entry.reads ?? (policyRefusal ? POLICY_REFUSAL_CHECKS[entry.operation].minimumReads : OPERATION_READS[entry.operation]);
    if (!Number.isSafeInteger(reads) || reads < 1) throw new Error(`checks[${index}].reads must be a positive integer.`);
    if (policyRefusal && reads < POLICY_REFUSAL_CHECKS[entry.operation].minimumReads) {
      throw new Error(`checks[${index}] policy-refusal operation ${entry.operation} must reserve at least ${POLICY_REFUSAL_CHECKS[entry.operation].minimumReads} reads.`);
    }
    return { index, label: entry.label ?? entry.operation, operation: entry.operation, expectation: entry.expectation, reads, policyRefusal, credentialMode };
  });
  if (typeof list.reportPath !== 'string' || list.reportPath.length === 0) throw new Error('reportPath is required.');
  if (typeof list.credentialPath !== 'string' || list.credentialPath.length === 0) throw new Error('credentialPath is required.');
  return {
    workerUrl: list.workerUrl,
    hostDeployedAt: list.hostDeployedAt,
    checks,
    reportPath: resolveInsideStaging(options.report ?? list.reportPath, 'reportPath'),
    credentialPath: resolveInsideStaging(list.credentialPath, 'credentialPath')
  };
}

/** The reviewable dry run: the checks, the paths and the ceilings, no reads. */
export function planFor(checkList, budget, attemptLedger, now = Date.now()) {
  const readyAtMs = checkList.hostDeployedAt === undefined
    ? undefined
    : Date.parse(checkList.hostDeployedAt) + HOST_VERSION_PROPAGATION_MS;
  return {
    workerUrl: checkList.workerUrl,
    hostDeployedAt: checkList.hostDeployedAt ?? null,
    hostReadiness: {
      required: readyAtMs !== undefined,
      minimumDelayMs: HOST_VERSION_PROPAGATION_MS,
      readyAt: readyAtMs === undefined ? null : new Date(readyAtMs).toISOString(),
      waitRemainingMs: readyAtMs === undefined ? null : Math.max(0, readyAtMs - now)
    },
    checks: checkList.checks,
    expectedReads: checkList.checks.reduce((total, check) => total + check.reads, 0),
    readBudgetPerWindow: budget.limit,
    windowSeconds: budget.windowMs / 1000,
    attemptBudgetPerCampaign: attemptLedger.limit,
    retries: 0,
    reportPath: checkList.reportPath,
    attemptLogPath: attemptLogFor(checkList.reportPath)
  };
}

/**
 * The report one run writes. Pure and exported: the CLI path that assembles it
 * is not otherwise reachable from a test without sending real reads, and an
 * undefined field there once crashed a live run after its attempts were spent.
 */
export function reportFor(checkList, results, options) {
  const failed = results.filter((result) => !result.passed).length;
  const reportedReads = results.filter((result) => typeof result.reads === 'number');
  const versionMatched = results.filter((result) => result.issued && result.versionMatch === true);
  const versionLagged = checkList.hostDeployedAt === undefined
    ? null
    : results.filter((result) => result.issued && result.status !== 0 && result.versionMatch !== true).length;
  return {
    generatedAt: new Date().toISOString(),
    startedAt: options.startedAt,
    workerUrl: checkList.workerUrl,
    hostDeployedAt: checkList.hostDeployedAt ?? null,
    hostReadiness: options.hostReadiness,
    checks: results,
    summary: {
      checks: results.length,
      passed: results.length - failed,
      failed,
      issued: results.filter((result) => result.issued).length,
      deferred: results.filter((result) => !result.issued).length,
      // `reads` sums reported values only; missing headers stay visibly unknown.
      reads: reportedReads.reduce((total, result) => total + result.reads, 0),
      readCountObservations: reportedReads.length,
      unreportedReadChecks: results.filter((result) => result.issued && result.reads === null).length,
      versionMatchedObservations: checkList.hostDeployedAt === undefined ? null : versionMatched.length,
      versionLaggedObservations: versionLagged,
      readTimingObservations: results.filter((result) => Array.isArray(result.readMs) && (result.versionMatch !== false)).length,
      plannedReads: results.reduce((total, result) => total + result.plannedReads, 0),
      observedMaxInFlight: Math.max(0, ...results.map((result) => result.observedInFlight))
    },
    passed: failed === 0,
    stoppedOn429: results.some((result) => result.issued && result.status === 429),
    budget: {
      limit: options.budget.limit,
      windowSeconds: options.budget.windowMs / 1000,
      observedReadsInLastWindow: options.budget.observed(),
      attempts: {
        limit: options.attemptLedger.limit,
        spentBeforeRun: options.attemptsBeforeRun,
        spentAfterRun: options.attemptLedger.observed()
      }
    },
    attemptLogPath: options.attemptLogPath,
    retries: 0,
    // Sanitization: no credential, no response body, no row value.
    sanitized: true
  };
}

/**
 * A run that leaves one expectation unmet fails the command, so a matrix result
 * can never be mistaken for a passing one when a shell ignores stderr.
 */
export function exitCodeFor(passed) {
  return passed ? 0 : 1;
}

/**
 * Runs the checks in order, one paced read each. The budget is the shared
 * rolling window and the ledger is the shared campaign counter, so a matrix run
 * cannot exceed what the other staging tools have already spent. Each result is
 * appended to the attempt log as it completes, so an aborted run still retains
 * what it already did.
 */
export async function runReadChecks(checkList, options) {
  const { budget, attemptLedger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  if (checkList.hostDeployedAt === undefined) {
    throw new Error('hostDeployedAt is required before a read-matrix run can reserve attempts or reads.');
  }
  // A single check may never exceed the whole rolling window; refusing here
  // keeps a pacing error from spending an attempt before it is discovered.
  for (const check of checkList.checks) {
    if (check.reads > budget.limit) {
      throw new Error(`checks[${check.index}] reserves ${check.reads} reads, more than the whole ${budget.limit}-read window.`);
    }
  }
  const hostReadiness = await waitForHostVersion(checkList, { now, wait: options.wait });
  await mkdir(dirname(options.attemptLog), { recursive: true });
  await writeFile(options.attemptLog, '', 'utf8');

  const results = [];
  let inFlight = 0;
  let stoppedOn429 = false;
  for (const check of checkList.checks) {
    if (stoppedOn429) {
      const deferred = {
        index: check.index,
        label: check.label,
        operation: check.operation,
        expectation: check.expectation,
        issued: false,
        deferred: true,
        deferredReason: 'http-429',
        status: 0,
        code: null,
        reason: null,
        reads: null,
        readMs: null,
        hostDeployedAt: null,
        expectedHostDeployedAt: checkList.hostDeployedAt ?? null,
        versionMatch: null,
        policyRefusal: check.policyRefusal,
        credentialMode: check.credentialMode,
        plannedReads: check.reads,
        durationMs: null,
        observedInFlight: 0,
        passed: false,
        detail: 'not issued: an earlier target response returned HTTP 429'
      };
      results.push(deferred);
      await appendFile(options.attemptLog, `${JSON.stringify(deferred)}\n`, 'utf8');
      continue;
    }
    if (check.credentialMode === 'configured' && typeof options.credential !== 'string') {
      throw new Error(`checks[${check.index}] requires a configured credential.`);
    }
    if (!await attemptLedger.reserve()) {
      const deferred = {
        index: check.index,
        label: check.label,
        operation: check.operation,
        expectation: check.expectation,
        issued: false,
        status: 0,
        code: null,
        reason: null,
        reads: null,
        readMs: null,
        hostDeployedAt: null,
        expectedHostDeployedAt: checkList.hostDeployedAt ?? null,
        versionMatch: null,
        policyRefusal: check.policyRefusal,
        credentialMode: check.credentialMode,
        plannedReads: check.reads,
        durationMs: null,
        observedInFlight: 0,
        passed: false,
        detail: `not issued: the campaign attempt budget is spent (${attemptLedger.observed()}/${attemptLedger.limit})`
      };
      results.push(deferred);
      await appendFile(options.attemptLog, `${JSON.stringify(deferred)}\n`, 'utf8');
      continue;
    }
    await budget.reserve(check.reads);
    inFlight += 1;
    const observedInFlight = inFlight;
    const startedAt = now();
    let attempt;
    try {
      const read = await controlReadCheck({
        workerUrl: checkList.workerUrl,
        operation: check.operation,
        credential: check.credentialMode === 'none' ? undefined : options.credential,
        idempotencyKey: `readcheck-${startedAt}-${check.index}`,
        fetchImpl,
        expectedHostDeployedAt: checkList.hostDeployedAt,
        now
      });
      const verdict = evaluateExpectation(read, check.expectation, { requireZeroReads: check.policyRefusal });
      if (read.status === 429) stoppedOn429 = true;
      attempt = {
        issued: true,
        status: read.status,
        code: read.errorCode ?? null,
        reason: read.reason ?? null,
        reads: read.sheetsReads,
        readMs: read.readMs,
        hostDeployedAt: read.hostDeployedAt,
        expectedHostDeployedAt: read.expectedHostDeployedAt,
        versionMatch: read.versionMatch,
        policyRefusal: check.policyRefusal,
        credentialMode: check.credentialMode,
        durationMs: read.durationMs,
        passed: verdict.passed,
        detail: verdict.detail
      };
    } catch (error) {
      // A transport failure is retained, never retried: the attempt is spent and
      // the expectation can only be unmet.
      const failure = error?.name === 'AbortError' ? 'timeout' : 'transport';
      attempt = {
        issued: true,
        status: 0,
        code: null,
        reason: null,
        reads: null,
        readMs: null,
        hostDeployedAt: null,
        expectedHostDeployedAt: checkList.hostDeployedAt ?? null,
        versionMatch: null,
        policyRefusal: check.policyRefusal,
        credentialMode: check.credentialMode,
        durationMs: now() - startedAt,
        passed: false,
        failure,
        detail: `the read failed before an envelope arrived (${failure})`
      };
    } finally {
      inFlight -= 1;
    }
    const result = {
      index: check.index,
      label: check.label,
      operation: check.operation,
      expectation: check.expectation,
      ...attempt,
      plannedReads: check.reads,
      observedInFlight
    };
    results.push(result);
    await appendFile(options.attemptLog, `${JSON.stringify(result)}\n`, 'utf8');
  }
  return { results, passed: results.every((result) => result.passed), stoppedOn429, hostReadiness };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!options.checks) {
    console.error(`A --checks path is required; refusing to guess a read matrix.\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  let checkList;
  try {
    checkList = validateCheckList(JSON.parse(await readFile(resolve(options.checks), 'utf8')), {
      allowHost: options.allowHost,
      report: options.report,
      requireHostDeployedAt: options.confirmStaging
    });
  } catch (error) {
    console.error(`The check list is not usable: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  // The ledgers live in staging-local/, so every tool in the campaign shares one
  // rolling read window and one attempt count across processes.
  const budget = new ReadBudget(undefined, undefined, undefined, resolve(STAGING_DIRECTORY, '.read-budget-ledger.json'));
  const attemptLedger = new AttemptBudget(undefined, resolve(STAGING_DIRECTORY, '.attempt-budget-ledger.json'));
  const attemptLogPath = attemptLogFor(checkList.reportPath);

  if (options.plan || !options.confirmStaging) {
    console.log(JSON.stringify(planFor(checkList, budget, attemptLedger), null, 2));
    if (!options.confirmStaging) {
      console.error('Refusing to send any read: pass --confirm-staging once the staging deployment and the check list are approved.');
      process.exitCode = options.plan ? 0 : 1;
    }
    return;
  }

  let credential;
  try {
    credential = (await readFile(checkList.credentialPath, 'utf8')).trim();
  } catch {
    console.error(`The credential file could not be read at ${checkList.credentialPath}.`);
    process.exitCode = 1;
    return;
  }
  if (credential.length === 0) {
    console.error('The credential file is empty.');
    process.exitCode = 1;
    return;
  }

  await budget.loadLedger();
  await attemptLedger.loadLedger();
  const attemptsBeforeRun = attemptLedger.observed();
  const startedAt = new Date().toISOString();

  const { results, passed, hostReadiness } = await runReadChecks(checkList, {
    credential,
    budget,
    attemptLedger,
    attemptLog: attemptLogPath,
    fetchImpl: fetch,
    now: () => Date.now()
  });

  const failed = results.filter((result) => !result.passed).length;
  const report = reportFor(checkList, results, { startedAt, budget, attemptLedger, attemptsBeforeRun, attemptLogPath, hostReadiness });
  await mkdir(dirname(checkList.reportPath), { recursive: true });
  await writeFile(checkList.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ passed, summary: report.summary, reportPath: checkList.reportPath, attemptLogPath }, null, 2));
  if (!passed) {
    console.error(`${failed} of ${results.length} checks did not meet their expectation.`);
  }
  process.exitCode = exitCodeFor(passed);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
