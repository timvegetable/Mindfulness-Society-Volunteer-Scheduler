// Staging Worker browser probe.
//
// Runs from an allowlisted origin in a real browser, signs in with Google
// Identity Services, and records what the platform — not a loopback stub —
// actually did: the direct-response facts (status, CORS type, redirect, response
// URL, content type) and per-operation wall time. It sends only the three
// feasibility reads, retries nothing, and reports aggregates rather than bodies.

const OPERATIONS = ['session.me', 'admin.schedule.read', 'admin.insights.read'];
const ATTEMPTS_PER_OPERATION = 5;
const MAX_REPORTED_CELLS = 8;
// The contract's wall-time threshold applies to observations taken with at least
// three requests in flight, so the probe drives a real in-flight pool.
const CONCURRENCY = 4;

const statusNode = document.querySelector('#status');
const reportNode = document.querySelector('#report');
const runButton = document.querySelector('#run');
const apiInput = document.querySelector('#api');
const clientInput = document.querySelector('#client');

const parameters = new URLSearchParams(location.search);
apiInput.value = parameters.get('api') ?? '';
clientInput.value = parameters.get('client') ?? '';

let credential;

function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function directResponseFacts(response, expectedUrl) {
  return {
    status: response.status,
    // The resolved Cloudflare point of presence, as the contract requires.
    pointOfPresence: response.headers.get('cf-ray'),
    corsReadable: response.type === 'cors',
    redirected: response.redirected,
    sameUrl: response.url === expectedUrl,
    jsonContentType: (response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'),
    noStore: response.headers.get('cache-control') === 'no-store'
  };
}

async function probeOnce(operation, expectedUrl, inFlight) {
  const startedAt = performance.now();
  const attempt = { operation, durationMs: null, facts: null, errorCode: null, failure: null, inFlight };
  try {
    const response = await fetch(expectedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        operation,
        payload: {},
        idempotencyKey: `staging-browser-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        credential
      })
    });
    attempt.durationMs = Math.round(performance.now() - startedAt);
    attempt.facts = directResponseFacts(response, expectedUrl);
    const body = await response.json().catch(() => undefined);
    if (response.status !== 200) attempt.failure = `status-${response.status}`;
    else if (body?.ok !== true) {
      attempt.errorCode = body?.error?.code ?? 'unknown';
      attempt.failure = `envelope-${attempt.errorCode}`;
    }
  } catch (error) {
    attempt.durationMs = Math.round(performance.now() - startedAt);
    attempt.failure = 'transport';
    attempt.errorCode = error instanceof Error ? error.name : 'unknown';
  }
  return attempt;
}

async function runProbe() {
  const api = apiInput.value.trim();
  let host;
  try {
    host = new URL(api).hostname;
  } catch {
    statusNode.textContent = 'Enter a valid staging Worker URL.';
    return;
  }
  // Refuse anything that is not a staging-shaped target, so a production URL
  // pasted into this page cannot be probed by accident.
  if (!(host.endsWith('.workers.dev') && host.includes('staging'))) {
    statusNode.textContent = `Refusing ${host}: this probe only runs against a *.workers.dev host whose name contains "staging".`;
    return;
  }
  if (!api.startsWith('https://')) {
    statusNode.textContent = 'The staging Worker URL must use https.';
    return;
  }
  if (!credential) {
    statusNode.textContent = 'Sign in first: the probe needs a real Google ID token.';
    return;
  }
  runButton.disabled = true;
  const attempts = [];
  let inFlight = 0;
  const queue = OPERATIONS.flatMap((operation) => Array.from({ length: ATTEMPTS_PER_OPERATION }, (_unused, index) => ({ operation, index })));
  const completed = { count: 0 };
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      inFlight += 1;
      statusNode.textContent = `Running ${next.operation} (${completed.count + 1}/${OPERATIONS.length * ATTEMPTS_PER_OPERATION}, ${inFlight} in flight)…`;
      const attempt = await probeOnce(next.operation, api, inFlight);
      inFlight -= 1;
      completed.count += 1;
      attempts.push(attempt);
    }
  });
  await Promise.all(workers);
  const successes = attempts.filter((attempt) => !attempt.failure);
  const durations = successes.map((attempt) => attempt.durationMs);
  const failureCodes = {};
  for (const attempt of attempts) {
    if (attempt.failure) failureCodes[attempt.failure] = (failureCodes[attempt.failure] ?? 0) + 1;
  }
  const observedFacts = attempts.map((attempt) => attempt.facts).filter(Boolean);
  reportNode.textContent = JSON.stringify({
    api,
    generatedAt: new Date().toISOString(),
    attempts: attempts.length,
    successes: successes.length,
    failureCodes,
    wallTimeMs: {
      min: durations.length ? Math.min(...durations) : null,
      p50: quantile(durations, 0.5),
      p95: quantile(durations, 0.95),
      max: durations.length ? Math.max(...durations) : null
    },
    // The transport evidence the platform alone can give.
    transport: {
      allCorsReadable: observedFacts.every((facts) => facts.corsReadable),
      anyRedirected: observedFacts.some((facts) => facts.redirected),
      allSameUrl: observedFacts.every((facts) => facts.sameUrl),
      allJsonContentType: observedFacts.every((facts) => facts.jsonContentType),
      allNoStore: observedFacts.every((facts) => facts.noStore)
    },
    concurrency: CONCURRENCY,
    observedMaxInFlight: Math.max(0, ...attempts.map((attempt) => attempt.inFlight ?? 0)),
    pointsOfPresence: [...new Set(attempts.map((attempt) => attempt.facts?.pointOfPresence).filter(Boolean))],
    perAttempt: attempts.slice(0, MAX_REPORTED_CELLS * OPERATIONS).map((attempt) => ({
      operation: attempt.operation,
      durationMs: attempt.durationMs,
      failure: attempt.failure,
      status: attempt.facts?.status ?? null,
      corsReadable: attempt.facts?.corsReadable ?? null,
      inFlight: attempt.inFlight
    }))
  }, null, 2);
  statusNode.textContent = `Done: ${successes.length}/${attempts.length} succeeded. Copy the report into the staging evidence directory (sanitized).`;
  runButton.disabled = false;
}

function enableProbe(response) {
  credential = response.credential;
  runButton.disabled = false;
  statusNode.textContent = 'Signed in. Confirm the Worker URL, then run the probe.';
}

function startSignIn() {
  const clientId = clientInput.value.trim();
  if (!clientId) {
    statusNode.textContent = 'Enter the staging OAuth client id to sign in.';
    return;
  }
  if (!window.google?.accounts?.id) {
    statusNode.textContent = 'Google Identity Services has not loaded yet; retry in a moment.';
    return;
  }
  window.google.accounts.id.initialize({ client_id: clientId, callback: enableProbe });
  window.google.accounts.id.prompt();
}

runButton.addEventListener('click', () => { void runProbe(); });
clientInput.addEventListener('change', startSignIn);
