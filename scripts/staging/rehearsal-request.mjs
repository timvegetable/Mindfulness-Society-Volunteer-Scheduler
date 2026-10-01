// A single staging gateway read issued by the portable-state rehearsal.
//
// Keep this on measure-worker's campaign ledgers so its attempt and Sheets-read
// spend is visible to the other staging tools. Reservations happen before a
// request can start, and the one request is retained privately even when the
// response or the concurrent transition fails.
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  AttemptBudget,
  classifyFailure,
  OPERATION_READS,
  ReadBudget,
  waitForHostVersion,
  campaignLedgerPaths
} from './measure-worker.mjs';

const CONSERVATIVE_READS = Object.freeze({
  'session.me': 2,
  'admin.schedule.read': 4,
  'admin.insights.read': 4,
  'admin.schedule.preview': 4
});

/** Return a conservative reservation for a known read operation. */
export function conservativeReadsFor(operation) {
  if (!Object.prototype.hasOwnProperty.call(OPERATION_READS, operation)) {
    throw new Error(`straddle only supports a known read operation; refusing ${operation}.`);
  }
  return CONSERVATIVE_READS[operation] ?? 4;
}

/** Construct the same campaign-scoped ledgers used by the load and matrix tools. */
export function createRehearsalCampaignBudgets(paths = campaignLedgerPaths()) {
  return {
    readBudget: new ReadBudget(undefined, undefined, undefined, paths.read),
    attemptLedger: new AttemptBudget(undefined, paths.attempt)
  };
}

function safeError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

function readResponseHeaders(response) {
  return {
    sheetsReads: Number(response.headers.get('x-staging-sheets-reads') ?? '') || 0,
    readMs: response.headers.get('x-staging-read-ms'),
    hostDeployedAt: response.headers.get('x-staging-host-deployed-at'),
    correlationId: response.headers.get('x-staging-correlation-id')
  };
}

function sanitizedResponse(status, durationMs, body, headers, versionLag) {
  return {
    status,
    durationMs,
    ok: body?.ok === true,
    errorCode: body?.ok === false ? body.error?.code : undefined,
    reason: body?.ok === false ? body.error?.details?.reason : undefined,
    sheetsReads: headers.sheetsReads,
    readMs: headers.readMs,
    hostDeployedAt: headers.hostDeployedAt,
    versionLag,
    hasCorrelationId: headers.correlationId !== null
  };
}

/**
 * Reserves the campaign attempt and conservative Sheet reads before returning
 * a one-shot request starter. Callers must await this before any mutation.
 */
export async function prepareRehearsalGatewayRead(options) {
  const {
    workerUrl,
    operation,
    credential,
    idempotencyKey,
    attemptLogPath,
    expectedHostDeployedAt,
    fetchImpl = fetch
  } = options;
  const reads = conservativeReadsFor(operation);
  const defaults = createRehearsalCampaignBudgets();
  const readBudget = options.readBudget ?? defaults.readBudget;
  const attemptLedger = options.attemptLedger ?? defaults.attemptLedger;

  // Match the harness order: no read reservation is spent when the campaign
  // attempt cap is already exhausted. A false result means no request and no
  // transition may follow.
  if (!await attemptLedger.reserve()) {
    throw new Error('The staging campaign attempt budget is exhausted; the straddle transition was not started.');
  }
  await readBudget.reserve(reads);

  const privateAttemptLog = resolve(attemptLogPath);
  let started = false;
  return {
    attemptLogPath: privateAttemptLog,
    start: async () => {
      if (started) throw new Error('A reserved rehearsal gateway request can only be started once.');
      started = true;
      const startedAt = Date.now();
      const attempt = {
        startedAt: new Date(startedAt).toISOString(),
        operation,
        reservedReads: reads,
        ...(expectedHostDeployedAt === undefined ? {} : { expectedHostDeployedAt }),
        status: 0,
        durationMs: 0
      };
      let result;
      try {
        const response = await fetchImpl(workerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ operation, payload: {}, idempotencyKey, credential })
        });
        attempt.status = response.status;
        const headers = readResponseHeaders(response);
        attempt.sheetsReads = headers.sheetsReads;
        attempt.readMs = headers.readMs;
        attempt.hostDeployedAt = headers.hostDeployedAt ?? undefined;
        attempt.hasCorrelationId = headers.correlationId !== null;

        let body;
        let parseError;
        try {
          body = await response.json();
        } catch (error) {
          parseError = safeError(error);
        }
        const responseFailure = parseError && response.status === 200
          ? 'response-parse'
          : response.status === 200 && body?.ok === true
            ? undefined
            : classifyFailure(response.status, body, undefined);
        const versionLag = expectedHostDeployedAt !== undefined && headers.hostDeployedAt !== expectedHostDeployedAt;
        if (expectedHostDeployedAt !== undefined) {
          attempt.versionLag = versionLag;
          attempt.responseFailure = responseFailure;
        }
        attempt.failure = versionLag ? 'version-lag' : responseFailure;
        if (parseError) attempt.responseParseError = parseError;
        attempt.durationMs = Date.now() - startedAt;
        result = sanitizedResponse(response.status, attempt.durationMs, body, headers, versionLag);
      } catch (error) {
        attempt.durationMs = Date.now() - startedAt;
        attempt.failure = classifyFailure(0, undefined, error);
        attempt.transportError = safeError(error);
        result = undefined;
      }

      // This file is under staging-local in production. It contains only the
      // request outcome summary: never the credential, request body or rows.
      await mkdir(dirname(privateAttemptLog), { recursive: true });
      await appendFile(privateAttemptLog, `${JSON.stringify(attempt)}\n`, 'utf8');
      return { attempt, response: result, attemptLogPath: privateAttemptLog };
    }
  };
}

/** Reserve first, then select the control tuple that the gateway request races. */
export async function reserveThenReadBaseline(options) {
  const prepared = await options.prepare();
  const baseline = await options.readBaseline();
  return { prepared, baseline };
}

/** Wait for the expected deployment marker's 95-second propagation window before spending budget. */
export async function prepareRehearsalStraddle(options) {
  const { expectedHostDeployedAt } = options;
  if (typeof expectedHostDeployedAt !== 'string' || expectedHostDeployedAt.length === 0) {
    throw new Error('A straddle requires the expected host deployment marker.');
  }
  const hostReadiness = await waitForHostVersion(
    { hostDeployedAt: expectedHostDeployedAt },
    options.readinessOptions
  );
  const { prepared, baseline } = await reserveThenReadBaseline(options);
  return { hostReadiness, prepared, baseline };
}

/** A marker mismatch invalidates an otherwise matching pinned refusal. */
export function straddleExpectationPassed(expectation, response, attempt) {
  if (attempt?.versionLag === true || response?.versionLag === true || !response || response.status !== 200) return false;
  const wanted = expectation.startsWith('failed:') ? expectation.slice('failed:'.length).split(':') : expectation.split(':');
  return wanted[0] === 'ok'
    ? response.ok === true
    : response.ok === false && response.errorCode === wanted[0] && (wanted[1] === undefined || response.reason === wanted[1]);
}

/**
 * Preserve the one-process interleaving while settling both sides. Reservation
 * failure prevents the transition callback from running. Request failures are
 * caught immediately, and the attempt is awaited after a transition error so
 * the request cannot become an unhandled rejection or lose its private record.
 */
export async function runRehearsalStraddle(options) {
  const { prepare, fireMs, transition, wait = (duration) => new Promise((resolveWait) => setTimeout(resolveWait, duration)) } = options;
  const prepared = await prepare();
  const gateway = Promise.resolve()
    .then(() => prepared.start())
    .then(
      (value) => ({ value }),
      (error) => ({ error: safeError(error) })
    );

  await wait(fireMs);
  let transitionError;
  try {
    await transition();
  } catch (error) {
    transitionError = safeError(error);
  }

  return { gateway: await gateway, transitionError };
}
