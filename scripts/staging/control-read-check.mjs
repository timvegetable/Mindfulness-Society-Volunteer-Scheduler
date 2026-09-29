// One control-protocol read check against a deployed staging reader.
//
// It answers one question at a time and never decides on its own whether the
// answer is acceptable: it returns what the service said (status, envelope code
// and reason, the Sheets read count the service reports, and whether the two
// server-generated headers are present), and `evaluateExpectation` turns an
// expectation into a pass/fail. No credential, response body or row value is
// ever printed or written by this module.
const DEFAULT_TIMEOUT_MS = 20_000;

/** Sends one read and reports what came back, without interpreting it. */
export async function controlReadCheck(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(options.workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        operation: options.operation,
        payload: {},
        idempotencyKey: options.idempotencyKey ?? `control-read-check-${startedAt}`,
        credential: options.credential
      }),
      signal: controller.signal
    });
    const durationMs = Date.now() - startedAt;
    const body = await response.json().catch(() => undefined);
    return {
      status: response.status,
      durationMs,
      ok: body?.ok === true,
      errorCode: body?.ok === false ? body.error?.code : undefined,
      reason: body?.ok === false ? body.error?.details?.reason : undefined,
      sheetsReads: Number(response.headers.get('x-staging-sheets-reads') ?? '') || 0,
      hasCorrelationId: response.headers.get('x-staging-correlation-id') !== null,
      hasHostMarker: response.headers.get('x-staging-host-deployed-at') !== null
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compares a result with an expectation of the form `ok` or
 * `failed:<CODE>[:<reason>]`. Returns `{ passed, detail }`; the caller decides
 * what a failure means.
 */
export function evaluateExpectation(result, expectation) {
  const parts = String(expectation).split(':');
  if (parts[0] === 'ok') {
    if (result.ok) return { passed: true, detail: 'served' };
    const actual = `${result.errorCode ?? result.status}${result.reason ? `/${result.reason}` : ''}`;
    return { passed: false, detail: `expected a served read, got ${actual}` };
  }
  if (parts[0] !== 'failed' || !parts[1]) return { passed: false, detail: `unparseable expectation ${expectation}` };
  const wantsReason = parts[2];
  const codeMatches = result.ok === false && result.errorCode === parts[1];
  const reasonMatches = wantsReason === undefined || result.reason === wantsReason;
  return {
    passed: codeMatches && reasonMatches,
    detail: codeMatches && reasonMatches
      ? `refused with ${parts[1]}${wantsReason ? `/${wantsReason}` : ''}`
      : `expected ${parts[1]}${wantsReason ? `/${wantsReason}` : ''}, got ${result.ok ? 'served' : `${result.errorCode ?? result.status}${result.reason ? `/${result.reason}` : ''}`}`
  };
}
