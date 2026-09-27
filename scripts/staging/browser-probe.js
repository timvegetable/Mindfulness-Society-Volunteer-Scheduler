// Staging Worker browser probe.
//
// Runs from an allowlisted origin in a real browser, signs in with Google
// Identity Services, and records what the platform — not a loopback stub —
// actually did: the direct-response facts (status, CORS type, redirect, response
// URL, content type) and per-operation wall time. It sends only the three
// feasibility reads, retries nothing, and reports aggregates rather than bodies.

const OPERATIONS = ['session.me', 'admin.schedule.read', 'admin.insights.read'];
const ATTEMPTS_PER_OPERATION = 5;
// The read budget from the experiment contract: at most 40 Sheets reads in any
// 60-second window. Each operation costs a known number of reads, and the probe
// refuses to exceed the budget rather than discovering it as a 429.
const OPERATION_READS = { 'session.me': 1, 'admin.schedule.read': 2, 'admin.insights.read': 2 };
const READ_BUDGET = 40;
const BUDGET_WINDOW_MS = 60_000;
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
const accountLabel = parameters.get('label') ?? 'probe';

let credential;
const spentReads = [];

/** Waits until `reads` more reads fit inside the contract's sliding window. */
async function reserveReads(reads) {
  for (;;) {
    const cutoff = Date.now() - BUDGET_WINDOW_MS;
    while (spentReads.length > 0 && spentReads[0] < cutoff) spentReads.shift();
    if (spentReads.length + reads <= READ_BUDGET) {
      for (let index = 0; index < reads; index += 1) spentReads.push(Date.now());
      return;
    }
    const waitMs = Math.max(50, spentReads[0] + BUDGET_WINDOW_MS - Date.now());
    statusNode.textContent = `Holding to stay inside the Sheets read budget (${spentReads.length}/${READ_BUDGET} reads this minute)…`;
    await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  }
}

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
  await reserveReads(OPERATION_READS[operation] ?? 2);
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
    attempt.sheetsReads = response.headers.get('x-staging-sheets-reads');
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
  const report = {
    label: accountLabel,
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
    perAttempt: attempts.slice(0, MAX_REPORTED_CELLS * OPERATIONS.length).map((attempt) => ({
      operation: attempt.operation,
      durationMs: attempt.durationMs,
      failure: attempt.failure,
      errorReason: attempt.errorReason ?? null,
      errorMessage: attempt.errorMessage ?? null,
      sheetsReads: attempt.sheetsReads ?? null,
      status: attempt.facts?.status ?? null,
      corsReadable: attempt.facts?.corsReadable ?? null,
      inFlight: attempt.inFlight
    }))
  };
  reportNode.textContent = JSON.stringify(report, null, 2);
  try {
    const captured = await fetch('/__report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: accountLabel, report })
    });
    statusNode.textContent = captured.ok
      ? `Done: ${successes.length}/${attempts.length} succeeded, and the report was saved locally.`
      : `Done: ${successes.length}/${attempts.length} succeeded. Copy the report below.`;
  } catch {
    statusNode.textContent = `Done: ${successes.length}/${attempts.length} succeeded. Copy the report below.`;
  }
  runButton.disabled = false;
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

runButton.addEventListener('click', () => { void runProbe(); });
document.querySelector('#retry-signin').addEventListener('click', mountSignIn);
clientInput.addEventListener('change', mountSignIn);

// Mount immediately: the client id arrives prefilled from the URL.
mountSignIn();
