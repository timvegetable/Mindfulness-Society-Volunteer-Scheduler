// Staging Worker browser probe.
//
// Runs from an allowlisted origin in a real browser, signs in with Google
// Identity Services, and records what the platform — not a loopback stub —
// actually did: the direct-response facts (status, CORS type, redirect, response
// URL, content type), per-operation wall time, and what each attempt cost in
// Sheets reads, including the Worker's own per-read timings. It sends only the
// three feasibility reads, retries nothing, and reports aggregates plus one
// record per attempt rather than response bodies.
//
// Query parameters, all optional except `api`:
//   api       the staging Worker /exec URL, prefilled into the form
//   client    the staging OAuth client id, prefilled into the form
//   label     the report label and captured-credential name (default "probe")
//   attempts  attempts per operation (default 5, at most 60; the 2026-09-30
//             rehearsal runs 30)
//
// `globalThis.runStagingBrowserProbe({ api, credential, ... })` runs the same
// measurement without the page, so a console session or the contract test can
// drive it with its own transport and clock.

const OPERATIONS = ['session.me', 'admin.schedule.read', 'admin.insights.read'];
const DEFAULT_ATTEMPTS_PER_OPERATION = 5;
// Beyond this, one leg would spend the whole paced window on its own; an
// operator who asks for more is refused rather than paced for an hour.
const MAX_ATTEMPTS_PER_OPERATION = 60;
// The read budget from the experiment contract: at most 40 Sheets reads in any
// 60-second window. Each operation costs a known number of reads, and every
// attempt reserves them in the probe host's shared ledger first, so the window
// is held by the host rather than re-derived in the browser.
// Keep the original rehearsal prices as the default. Portable reads have a
// larger bracket and reserve conservatively at 2 identity / 4 domain reads,
// even though the current live composition has been measured at 1 / 3 / 3.
const READ_PLANS = {
  legacy: { 'session.me': 1, 'admin.schedule.read': 2, 'admin.insights.read': 2 },
  portable: { 'session.me': 2, 'admin.schedule.read': 4, 'admin.insights.read': 4 }
};
const MIN_READS_BY_PLAN = {
  legacy: READ_PLANS.legacy,
  portable: { 'session.me': 1, 'admin.schedule.read': 3, 'admin.insights.read': 3 }
};
const DEFAULT_READ_PLAN = 'legacy';
const WARM_CONCURRENCY_FLOOR = 3;
const MIN_HOST_AGE_MS = 95_000;
// The contract's wall-time threshold applies to observations taken with at least
// three requests in flight, so the probe drives a real in-flight pool. The width
// is fixed here: a URL parameter must not be able to produce a population below
// the contract's floor by accident.
const CONCURRENCY = 4;

const statusNode = document.querySelector('#status');
const reportNode = document.querySelector('#report');
const runButton = document.querySelector('#run');
const apiInput = document.querySelector('#api');
const clientInput = document.querySelector('#client');

const parameters = new URLSearchParams(location.search);
apiInput.value = parameters.get('api') ?? '';
clientInput.value = parameters.get('client') ?? '';
const accountLabel = parameters.get('label') ?? 'probe';

function requestedReadPlan() {
  const raw = parameters.get('readPlan');
  const value = raw === null || raw.trim() === '' ? DEFAULT_READ_PLAN : raw.trim();
  if (!Object.hasOwn(READ_PLANS, value)) return { error: `readPlan must be "legacy" or "portable", got "${raw}"` };
  return { value };
}

function requestedHostDeployedAt() {
  const value = parameters.get('hostDeployedAt')?.trim();
  return value ? value : undefined;
}

let credential;

/**
 * The page's population size, from `?attempts=`. An absent parameter takes the
 * recorded default; a parameter that is present but unusable refuses the run
 * rather than silently measuring a different population than the operator asked
 * for.
 */
function requestedAttempts() {
  const raw = parameters.get('attempts');
  if (raw === null || raw.trim() === '') return { value: DEFAULT_ATTEMPTS_PER_OPERATION };
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_ATTEMPTS_PER_OPERATION) {
    return { error: `expected a whole number between 1 and ${MAX_ATTEMPTS_PER_OPERATION}, got "${raw}"` };
  }
  return { value: parsed };
}

/**
 * Refuses anything that is not a staging-shaped target, so a production URL
 * pasted into this page cannot be probed by accident. Returns the message the
 * page should show, or undefined when the target is allowed.
 */
function stagingTargetRefusal(api) {
  let host;
  try {
    host = new URL(api).hostname;
  } catch {
    return 'Enter a valid staging Worker URL.';
  }
  if (!api.startsWith('https://')) return 'The staging Worker URL must use https.';
  if (!(host.endsWith('.workers.dev') && host.includes('staging'))) {
    return `Refusing ${host}: this probe only runs against a *.workers.dev host whose name contains "staging".`;
  }
  return undefined;
}

/** Nearest-rank quantile over `values`; the shape the paced harness reports. */
function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

/** min/p50/p95/p99/max over the population that belongs in the distribution. */
function wallTimeSummary(values) {
  return {
    min: values.length ? Math.min(...values) : null,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    max: values.length ? Math.max(...values) : null
  };
}

/** Counts keyed by label, for failure codes and response statuses. */
function countBy(labels) {
  const counts = {};
  for (const label of labels) counts[label] = (counts[label] ?? 0) + 1;
  return counts;
}

/**
 * Parses `X-Staging-Read-Ms`: the milliseconds the Worker spent on each Sheets
 * request, in call order. An absent header (a deployment older than the header),
 * a blank one, or one that does not parse as a list of integers is recorded as
 * absent rather than as a plausible-looking reading: a partially parsed list
 * would silently misalign the positions the read plan is priced with.
 */
function readTimingsFrom(headerValue, reportedReadCount) {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') return undefined;
  if (!Number.isSafeInteger(reportedReadCount) || reportedReadCount < 0) return undefined;
  const parts = headerValue.split(',').map((part) => part.trim());
  if (parts.length !== reportedReadCount || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  const timings = parts.map((part) => Number(part));
  return timings.every(Number.isSafeInteger) ? timings : undefined;
}

/** Parses `X-Staging-Sheets-Reads` into the attempt's read count, or null. */
function readCountFrom(headerValue) {
  if (typeof headerValue !== 'string' || !/^\d+$/.test(headerValue.trim())) return null;
  return Number(headerValue.trim());
}

function canonicalDeploymentTime(marker) {
  if (typeof marker !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(marker)) return undefined;
  const parsed = Date.parse(marker);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== marker) return undefined;
  return parsed;
}

/** Waits until the expected Durable Object version has completed its lag window. */
async function waitForHostAge(marker, { wallNow, wait, onVersionWait }) {
  if (marker === undefined) return null;
  const deployedAt = canonicalDeploymentTime(marker);
  if (deployedAt === undefined) throw new Error('hostDeployedAt must be a canonical ISO timestamp such as 2026-09-30T12:34:56.000Z.');
  for (;;) {
    const ageMs = wallNow() - deployedAt;
    const remainingMs = MIN_HOST_AGE_MS - ageMs;
    if (remainingMs <= 0) return ageMs;
    onVersionWait(remainingMs);
    await wait(remainingMs);
  }
}

function directResponseFacts(response, expectedUrl, status = response.status) {
  return {
    status,
    // The resolved Cloudflare point of presence, as the contract requires.
    pointOfPresence: response.headers.get('cf-ray'),
    corsReadable: response.type === 'cors',
    redirected: response.redirected,
    sameUrl: response.url === expectedUrl,
    jsonContentType: (response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'),
    noStore: response.headers.get('cache-control') === 'no-store'
  };
}

/**
 * One operation's population: wall time over its successful attempts, with the
 * failures, statuses and in-flight counts kept beside it so a latency analysis
 * can exclude refused or instrumented attempts instead of averaging them in.
 */
function summarizeOperation(operation, attempts) {
  const successful = attempts.filter((attempt) => !attempt.failure);
  const warm = attempts.filter((attempt) => !attempt.failure && !attempt.versionLag);
  const warmAtConcurrencyFloor = warm.filter((attempt) => (attempt.observedMaxInFlightDuringRequest ?? 0) >= WARM_CONCURRENCY_FLOOR);
  return {
    operation,
    attempts: attempts.length,
    successes: successful.length,
    versionLag: attempts.filter((attempt) => attempt.versionLag).length,
    failureCodes: countBy(attempts.filter((attempt) => attempt.failure).map((attempt) => attempt.failure)),
    statuses: countBy(attempts.map((attempt) => String(attempt.facts?.status ?? 'none'))),
    non2xx: attempts.filter((attempt) => attempt.non2xx === true).length,
    observedMaxInFlight: Math.max(0, ...attempts.map((attempt) => attempt.observedMaxInFlightDuringRequest ?? 0)),
    sheetsReads: attempts.reduce((total, attempt) => total + (attempt.sheetsReads ?? 0), 0),
    // `wallTimeMs` is the verified warm population when a host marker is
    // expected. Version-lag attempts remain in perAttempt and successes, but
    // cannot contaminate this distribution.
    wallTimeMs: wallTimeSummary(warm.map((attempt) => attempt.durationMs)),
    successfulWarmObservations: warm.length,
    warmAtConcurrency3Plus: {
      floor: WARM_CONCURRENCY_FLOOR,
      observations: warmAtConcurrencyFloor.length,
      wallTimeMs: wallTimeSummary(warmAtConcurrencyFloor.map((attempt) => attempt.durationMs))
    }
  };
}

/** One attempt as the report retains it; no body and no credential. */
function attemptRecord(attempt) {
  return {
    operation: attempt.operation,
    durationMs: attempt.durationMs,
    failure: attempt.failure,
    errorReason: attempt.errorReason ?? null,
    errorMessage: attempt.errorMessage ?? null,
    status: attempt.facts?.status ?? null,
    // A refused or rate-limited attempt must be droppable from a latency
    // population, so the status is recorded rather than folded into the failure.
    non2xx: attempt.non2xx === true,
    corsReadable: attempt.facts?.corsReadable ?? null,
    inFlight: attempt.inFlight,
    observedMaxInFlightDuringRequest: attempt.observedMaxInFlightDuringRequest ?? null,
    requestIssued: attempt.requestIssued === true,
    reservedReads: attempt.reservedReads ?? null,
    reservationGranted: attempt.reservationGranted === true,
    hostDeployedAt: attempt.hostDeployedAt ?? null,
    versionLag: attempt.versionLag === true,
    // What the attempt cost in Sheets reads, and the per-read timings behind
    // that count, in call order. `readMs` is null when the deployment predates
    // X-Staging-Read-Ms.
    sheetsReads: attempt.sheetsReads ?? null,
    readMs: attempt.readMs ?? null
  };
}

function buildReport({ label, api, attempts, pacing, attemptsPerOperation, concurrency, readPlan, readsPerOperation, expectedHostDeployedAt, hostAgeAtStartMs, stopReason }) {
  const successful = attempts.filter((attempt) => !attempt.failure);
  const warm = attempts.filter((attempt) => !attempt.failure && !attempt.versionLag);
  const requestedAttempts = OPERATIONS.length * attemptsPerOperation;
  const perAttemptReservedReads = attempts.reduce((total, attempt) => total + (attempt.reservedReads ?? 0), 0);
  const issued = attempts.filter((attempt) => attempt.requestIssued);
  const allTargetReadsReserved = issued.length > 0 && issued.every((attempt) => attempt.reservationGranted === true
    && attempt.reservedReads === readsPerOperation[attempt.operation]);
  const observedMaxInFlight = Math.max(0, ...attempts.map((attempt) => attempt.observedMaxInFlightDuringRequest ?? 0));
  const observedFacts = attempts.map((attempt) => attempt.facts).filter(Boolean);
  const withReadTimings = attempts.filter((attempt) => Array.isArray(attempt.readMs)).length;
  return {
    label,
    api,
    generatedAt: new Date().toISOString(),
    attemptsPerOperation,
    concurrency,
    readPlan,
    readsPerOperation,
    expectedHostDeployedAt: expectedHostDeployedAt ?? null,
    minimumHostAgeMs: expectedHostDeployedAt === undefined ? null : MIN_HOST_AGE_MS,
    hostAgeAtStartMs,
    requestedAttempts,
    attempts: attempts.length,
    incomplete: issued.length < requestedAttempts,
    stoppedReason: stopReason ?? null,
    requestIssuedAttempts: issued.length,
    successes: successful.length,
    successfulWarmObservations: warm.length,
    versionLagAttempts: attempts.filter((attempt) => attempt.versionLag).length,
    failureCodes: countBy(attempts.filter((attempt) => attempt.failure).map((attempt) => attempt.failure)),
    successfulWallTimeMs: wallTimeSummary(successful.map((attempt) => attempt.durationMs)),
    wallTimeMs: wallTimeSummary(warm.map((attempt) => attempt.durationMs)),
    // The contract's gate is per read operation, so the distribution is reported
    // per operation as well as over the whole run.
    perOperation: OPERATIONS.map((operation) => summarizeOperation(operation, attempts.filter((attempt) => attempt.operation === operation))),
    // Whether the Worker exposed per-read timings at all: an old deployment
    // answers the same reads without the header.
    readTimings: { attemptsWithReadMs: withReadTimings, attemptsWithoutReadMs: attempts.length - withReadTimings },
    // The transport evidence the platform alone can give.
    transport: {
      allCorsReadable: observedFacts.length > 0 && observedFacts.every((facts) => facts.corsReadable),
      anyRedirected: observedFacts.some((facts) => facts.redirected),
      allSameUrl: observedFacts.length > 0 && observedFacts.every((facts) => facts.sameUrl),
      allJsonContentType: observedFacts.length > 0 && observedFacts.every((facts) => facts.jsonContentType),
      allNoStore: observedFacts.length > 0 && observedFacts.every((facts) => facts.noStore)
    },
    observedMaxInFlight,
    // The pacing evidence: every attempt reserved its reads in the shared
    // ledger first, closing the pacing gap the 2026-09-28 verdict recorded.
    pacedThroughSharedLedger: issued.length > 0 && allTargetReadsReserved && pacing.reservedReads === perAttemptReservedReads,
    allTargetReadsReserved,
    reservedReads: pacing.reservedReads,
    reservationRefusals: attempts.filter((attempt) => attempt.failure === 'reservation-refused' || attempt.failure === 'reservation-transport' || attempt.failure === 'reservation-invalid-response').length,
    observedReadsInLastWindow: pacing.observedReadsInLastWindow ?? null,
    pointsOfPresence: [...new Set(attempts.map((attempt) => attempt.facts?.pointOfPresence).filter(Boolean))],
    // Every attempt, not a sample: the rehearsal's latency population is built
    // from these records, so a truncated list would be a silently smaller study.
    perAttempt: attempts.map(attemptRecord)
  };
}

/**
 * Reserves `reads` in the probe host's shared read ledger before an attempt. The
 * budget itself lives in the host beside the paced harness's, so the browser's
 * Sheets reads and the harness's attempts hold one rolling window.
 */
async function reserveReads(reads, { fetchImpl, pacing }) {
  statusNode.textContent = `Holding for the shared read budget (reserving ${reads} reads)…`;
  let response;
  try {
    response = await fetchImpl('/__reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reads })
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown';
    throw Object.assign(new Error(`The probe host could not be reached for read pacing (${reason}).`), { code: 'reservation-transport' });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`The probe host refused the read reservation (HTTP ${response.status}).`), { code: 'reservation-refused' });
  }
  const granted = await response.json().catch(() => undefined);
  if (granted?.ok !== true || granted.reads !== reads) {
    throw Object.assign(new Error('The probe host returned an invalid read reservation.'), { code: 'reservation-invalid-response' });
  }
  pacing.reservedReads += reads;
  pacing.observedReadsInLastWindow = granted.observedReadsInLastWindow ?? null;
  return reads;
}

async function probeOnce({ operation, expectedUrl, credential: token, reads, expectedHostDeployedAt, fetchImpl, now, pacing, onRequestStart, onRequestFinish, canStartRequest, getStopReason, onTargetResponseStatus, onProgress }) {
  const attempt = {
    operation, durationMs: null, facts: null, errorCode: null, failure: null, inFlight: 0,
    observedMaxInFlightDuringRequest: null, requestIssued: false, reservedReads: null,
    reservationGranted: false, hostDeployedAt: undefined, versionLag: false,
    non2xx: false, sheetsReads: null, readMs: undefined
  };
  try {
    attempt.reservedReads = await reserveReads(reads, { fetchImpl, pacing });
    attempt.reservationGranted = true;
  } catch (error) {
    attempt.failure = error?.code ?? 'reservation-invalid-response';
    attempt.errorCode = attempt.failure;
    attempt.errorMessage = error instanceof Error ? error.message : 'Read reservation failed.';
    return attempt;
  }
  // A latched stop condition stops new target requests. A reservation already
  // granted by a racing worker stays in the ledger and is retained here.
  if (!canStartRequest()) {
    attempt.failure = 'reservation-cancelled';
    attempt.errorMessage = `Stopped after ${getStopReason() ?? 'another request failed'}; the reservation remains spent and no target request was issued.`;
    return attempt;
  }
  const requestState = onRequestStart();
  attempt.inFlight = requestState.inFlightAtStart;
  attempt.requestIssued = true;
  onProgress({ operation, inFlight: requestState.inFlightAtStart });
  const startedAt = now();
  try {
    const response = await fetchImpl(expectedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        operation,
        payload: {},
        idempotencyKey: `staging-browser-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        credential: token
      })
    });
    const responseStatus = response.status;
    onTargetResponseStatus(responseStatus);
    attempt.facts = directResponseFacts(response, expectedUrl, responseStatus);
    attempt.non2xx = attempt.facts.status < 200 || attempt.facts.status >= 300;
    attempt.sheetsReads = readCountFrom(response.headers.get('x-staging-sheets-reads'));
    attempt.readMs = readTimingsFrom(response.headers.get('x-staging-read-ms'), attempt.sheetsReads);
    attempt.hostDeployedAt = response.headers.get('x-staging-host-deployed-at') ?? undefined;
    attempt.versionLag = expectedHostDeployedAt !== undefined && attempt.hostDeployedAt !== expectedHostDeployedAt;
    const body = await response.json().catch(() => undefined);
    if (response.status !== 200) attempt.failure = `status-${response.status}`;
    else if (body?.ok !== true) {
      attempt.errorCode = body?.error?.code ?? 'unknown';
      // The reason and message are what make a field failure diagnosable.
      attempt.errorReason = body?.error?.details?.reason;
      attempt.errorMessage = body?.error?.message;
      attempt.failure = `envelope-${attempt.errorCode}`;
    }
  } catch (error) {
    attempt.failure = 'transport';
    attempt.errorCode = error instanceof Error ? error.name : 'unknown';
  } finally {
    // Include response-envelope consumption in wall time; the request remains
    // in flight until the complete body has been read.
    attempt.durationMs = Math.round(now() - startedAt);
    onRequestFinish(requestState);
    attempt.observedMaxInFlightDuringRequest = requestState.observedMaxInFlightDuringRequest;
  }
  return attempt;
}

/**
 * Runs the measurement and returns the report. The page supplies the form's URL,
 * credential and label; a console session or the contract test may inject the
 * transport, the clock and the population size.
 */
async function runProbe(options = {}) {
  const api = options.api;
  const token = options.credential;
  const label = options.label ?? 'probe';
  const attemptsPerOperation = options.attemptsPerOperation ?? DEFAULT_ATTEMPTS_PER_OPERATION;
  const concurrency = options.concurrency ?? CONCURRENCY;
  const readPlan = options.readPlan ?? DEFAULT_READ_PLAN;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  const wait = options.wait ?? ((durationMs) => new Promise((resolveWait) => setTimeout(resolveWait, durationMs)));
  const onProgress = options.onProgress ?? (() => undefined);
  const onVersionWait = options.onVersionWait ?? ((remainingMs) => {
    statusNode.textContent = `Waiting ${Math.ceil(remainingMs / 1000)} seconds for the expected Worker version…`;
  });
  const refusal = stagingTargetRefusal(api);
  if (refusal) throw new Error(refusal);
  if (typeof token !== 'string' || token.length === 0) throw new Error('The probe needs a real Google ID token: sign in first.');
  if (!Number.isSafeInteger(attemptsPerOperation) || attemptsPerOperation < 1 || attemptsPerOperation > MAX_ATTEMPTS_PER_OPERATION) {
    throw new Error(`attempts per operation must be a whole number between 1 and ${MAX_ATTEMPTS_PER_OPERATION}.`);
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('The in-flight pool must be between 1 and 8 requests wide.');
  }
  if (typeof readPlan !== 'string' || !Object.hasOwn(READ_PLANS, readPlan)) throw new Error('readPlan must be "legacy" or "portable".');
  const readsPerOperation = { ...READ_PLANS[readPlan] };
  if (options.readsPerOperation !== undefined) {
    if (typeof options.readsPerOperation !== 'object' || options.readsPerOperation === null || Array.isArray(options.readsPerOperation)) {
      throw new Error('readsPerOperation must be an operation-to-integer object.');
    }
    for (const [operation, reads] of Object.entries(options.readsPerOperation)) {
      if (!OPERATIONS.includes(operation)) throw new Error(`readsPerOperation names an unsupported operation: ${operation}`);
      const minimum = MIN_READS_BY_PLAN[readPlan][operation];
      if (!Number.isSafeInteger(reads) || reads < minimum || reads > 8) {
        throw new Error(`readsPerOperation.${operation} must be a whole number between ${minimum} and 8 for the ${readPlan} plan.`);
      }
      readsPerOperation[operation] = reads;
    }
  }
  const expectedHostDeployedAt = options.expectedHostDeployedAt;
  if (expectedHostDeployedAt !== undefined && (typeof expectedHostDeployedAt !== 'string' || expectedHostDeployedAt.trim() === '')) {
    throw new Error('expectedHostDeployedAt must be a non-empty deployment marker when supplied.');
  }
  if (readPlan === 'portable' && expectedHostDeployedAt === undefined) {
    throw new Error('The portable read plan requires hostDeployedAt so the expected Worker version can be verified.');
  }
  if (expectedHostDeployedAt !== undefined && canonicalDeploymentTime(expectedHostDeployedAt) === undefined) {
    throw new Error('hostDeployedAt must be a canonical ISO timestamp such as 2026-09-30T12:34:56.000Z.');
  }
  // Do not spend a read reservation or count a target attempt while the
  // Durable Object may still be serving its previous deployment.
  const hostAgeAtStartMs = await waitForHostAge(expectedHostDeployedAt, { wallNow, wait, onVersionWait });
  const pacing = { reservedReads: 0, observedReadsInLastWindow: null };
  const attempts = [];
  const activeRequests = new Map();
  let nextRequestId = 0;
  let inFlight = 0;
  let stopReason;
  const queue = OPERATIONS.flatMap((operation) => Array.from({ length: attemptsPerOperation }, (_unused, index) => ({ operation, index })));
  const completed = { count: 0 };
  const onRequestStart = () => {
    inFlight += 1;
    const requestState = { id: ++nextRequestId, inFlightAtStart: inFlight, observedMaxInFlightDuringRequest: inFlight };
    activeRequests.set(requestState.id, requestState);
    // Every active request records the maximum overlap observed during its own
    // lifetime, including requests that started before the pool filled.
    for (const active of activeRequests.values()) {
      active.observedMaxInFlightDuringRequest = Math.max(active.observedMaxInFlightDuringRequest, inFlight);
    }
    return requestState;
  };
  const onRequestFinish = (requestState) => {
    activeRequests.delete(requestState.id);
    inFlight = Math.max(0, inFlight - 1);
  };
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      if (stopReason) return;
      const next = queue.shift();
      if (!next) return;
      const attempt = await probeOnce({
        operation: next.operation,
        expectedUrl: api,
        credential: token,
        reads: readsPerOperation[next.operation],
        expectedHostDeployedAt,
        fetchImpl,
        now,
        pacing,
        onRequestStart,
        onRequestFinish,
        canStartRequest: () => stopReason === undefined,
        getStopReason: () => stopReason,
        onTargetResponseStatus: (status) => {
          if (status === 429) stopReason ??= 'status-429';
        },
        onProgress: ({ operation, inFlight: active }) => onProgress({ operation, completed: completed.count + 1, total: OPERATIONS.length * attemptsPerOperation, inFlight: active })
      });
      if (attempt.failure === 'reservation-refused' || attempt.failure === 'reservation-transport' || attempt.failure === 'reservation-invalid-response') {
        stopReason ??= attempt.failure;
      }
      completed.count += 1;
      attempts.push(attempt);
    }
  });
  await Promise.all(workers);
  return buildReport({ label, api, attempts, pacing, attemptsPerOperation, concurrency, readPlan, readsPerOperation, expectedHostDeployedAt, hostAgeAtStartMs, stopReason });
}

/** The page's run: the form's URL and credential, the URL's population size. */
async function runPageProbe() {
  const attempts = requestedAttempts();
  if (attempts.error) {
    statusNode.textContent = `attempts: ${attempts.error}`;
    return;
  }
  const readPlan = requestedReadPlan();
  if (readPlan.error) {
    statusNode.textContent = readPlan.error;
    return;
  }
  const api = apiInput.value.trim();
  const refusal = stagingTargetRefusal(api);
  if (refusal) {
    statusNode.textContent = refusal;
    return;
  }
  if (!credential) {
    statusNode.textContent = 'Sign in first: the probe needs a real Google ID token.';
    return;
  }
  runButton.disabled = true;
  let report;
  try {
    report = await runProbe({
      api,
      credential,
      label: accountLabel,
      attemptsPerOperation: attempts.value,
      readPlan: readPlan.value,
      expectedHostDeployedAt: requestedHostDeployedAt(),
      onVersionWait: (remainingMs) => {
        statusNode.textContent = `Waiting ${Math.ceil(remainingMs / 1000)} seconds for the expected Worker version…`;
      },
      onProgress: ({ operation, completed, total, inFlight }) => {
        statusNode.textContent = `Running ${operation} (${completed}/${total}, ${inFlight} in flight)…`;
      }
    });
  } catch (error) {
    statusNode.textContent = error instanceof Error ? error.message : 'The probe stopped before it ran.';
    runButton.disabled = false;
    return;
  }
  reportNode.textContent = JSON.stringify(report, null, 2);
  await captureReport(report);
  runButton.disabled = false;
}

/**
 * Hands the report to the local probe host, which writes it inside
 * staging-local/, and reports where it went. A capture failure is never fatal:
 * the report is on the page and the measurement is not lost.
 */
async function captureReport(report) {
  const summary = report.incomplete
    ? `Stopped: ${report.successes}/${report.attempts} completed before ${report.stoppedReason ?? 'the requested population'}`
    : `Done: ${report.successes}/${report.attempts} succeeded`;
  try {
    const captured = await fetch('/__report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: accountLabel, report })
    });
    statusNode.textContent = captured.ok ? `${summary}, and the report was saved locally.` : `${summary}. Copy the report below.`;
  } catch {
    statusNode.textContent = `${summary}. Copy the report below.`;
  }
}

async function enableProbe(response) {
  credential = response.credential;
  runButton.disabled = false;
  statusNode.textContent = 'Signed in. Confirm the Worker URL, then run the probe.';
  // Hand the credential to the local probe host so the paced Node harness can
  // reuse it while it is still valid. It is never logged or displayed.
  try {
    const captured = await fetch('/__credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: accountLabel, credential })
    });
    if (captured.ok) statusNode.textContent = 'Signed in and captured. Run the probe.';
  } catch {
    statusNode.textContent = 'Signed in. Run the probe (the credential could not be captured locally).';
  }
}

const buttonContainer = document.querySelector('#gsi-button');

/** Waits for the Google Identity Services script, which loads asynchronously. */
function whenGoogleReady(action, attempt = 0) {
  if (window.google?.accounts?.id) {
    action();
    return;
  }
  if (attempt > 100) {
    statusNode.textContent = 'Google Identity Services did not load. Check the network and reload this page.';
    return;
  }
  setTimeout(() => whenGoogleReady(action, attempt + 1), 100);
}

/**
 * Renders Google's own sign-in button. A rendered button is the reliable path:
 * the One Tap `prompt()` needs a signed-in Google session and is blocked in many
 * browsers, and a prefilled client id never fires a change event to trigger it.
 */
function mountSignIn() {
  const clientId = clientInput.value.trim();
  if (!clientId) {
    statusNode.textContent = 'Enter the staging OAuth client id to sign in.';
    return;
  }
  statusNode.textContent = 'Loading the Google sign-in button…';
  whenGoogleReady(() => {
    buttonContainer.innerHTML = '';
    window.google.accounts.id.initialize({ client_id: clientId, callback: enableProbe, auto_select: false });
    window.google.accounts.id.renderButton(buttonContainer, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 280 });
    statusNode.textContent = 'Click the Google button above and choose the staging account named in the URL. '
      + 'If nothing happens, this origin may not be authorised for the client id.';
  });
}

// The programmatic entry point: a console session, or a contract test, can run
// the same measurement with its own transport, clock and population.
globalThis.runStagingBrowserProbe = runProbe;

runButton.addEventListener('click', () => { void runPageProbe(); });
document.querySelector('#retry-signin').addEventListener('click', mountSignIn);
clientInput.addEventListener('change', mountSignIn);

// Mount immediately: the client id arrives prefilled from the URL.
mountSignIn();
