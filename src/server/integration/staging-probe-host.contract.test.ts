import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createProbeServer } from '../../../scripts/staging/serve-probe.mjs';

/**
 * The probe host exists so a browser can hand a real Google credential to the
 * measurement harness. It must serve one directory, write only inside the ignored
 * staging directory, and refuse anything else.
 *
 * The probe page is driven here too: a DOM double stands in for the form and a
 * transport double for the Worker, so the served script's population size, read
 * accounting, quantiles and report shape are contract-tested without contacting
 * Google or Cloudflare. The reservation path and the report capture stay real —
 * both go to the probe host on loopback.
 */

const PORT = 8791;
let server: Awaited<ReturnType<typeof createProbeServer>>['server'];
let stagingDirectory: string;

beforeAll(async () => {
  stagingDirectory = await mkdtemp(join(tmpdir(), 'probe-host-'));
  const created = createProbeServer({ port: PORT, stagingDirectory });
  server = created.server;
  await new Promise<void>((ready) => server.listen(PORT, '127.0.0.1', ready));
});

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
  await rm(stagingDirectory, { recursive: true, force: true });
});

const base = `http://127.0.0.1:${PORT}`;

const WORKER_URL = 'https://volunteer-scheduling-staging.workers.dev/exec';
/** A stand-in credential: never a real token, never printed. */
const CREDENTIAL = 'x'.repeat(40);
/** The read plan the Worker prices each operation at, used to fill the header. */
const READ_PLAN: Record<string, number> = { 'session.me': 1, 'admin.schedule.read': 2, 'admin.insights.read': 2 };

type WallTime = { min: number | null; p50: number | null; p95: number | null; p99: number | null; max: number | null };

type AttemptRecord = {
  operation: string;
  durationMs: number | null;
  failure: string | null;
  status: number | null;
  non2xx: boolean;
  inFlight: number;
  sheetsReads: number | null;
  readMs: number[] | null;
};

type OperationSummary = {
  operation: string;
  attempts: number;
  successes: number;
  failureCodes: Record<string, number>;
  statuses: Record<string, number>;
  non2xx: number;
  observedMaxInFlight: number;
  sheetsReads: number;
  wallTimeMs: WallTime;
};

type ProbeReport = {
  label: string;
  api: string;
  generatedAt: string;
  attemptsPerOperation: number;
  concurrency: number;
  attempts: number;
  successes: number;
  failureCodes: Record<string, number>;
  wallTimeMs: WallTime;
  perOperation: OperationSummary[];
  readTimings: { attemptsWithReadMs: number; attemptsWithoutReadMs: number };
  transport: { allCorsReadable: boolean; anyRedirected: boolean; allSameUrl: boolean; allJsonContentType: boolean; allNoStore: boolean };
  observedMaxInFlight: number;
  pacedThroughSharedLedger: boolean;
  reservedReads: number;
  observedReadsInLastWindow: number | null;
  pointsOfPresence: string[];
  perAttempt: AttemptRecord[];
};

/** One Worker read's scripted answer; the clock advances as the read is issued. */
type ScriptedAttempt = {
  status?: number;
  durationMs?: number;
  sheetsReads?: number;
  headers?: Record<string, string | undefined>;
  body?: unknown;
};
type Answer = (call: { operation: string; index: number }) => ScriptedAttempt;

/** The response surface the probe touches, doubled for the Worker. */
type ResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  headers: { get: (name: string) => string | null };
  type: string;
  redirected: boolean;
  url: string;
};

function jsonResponse(status: number, body: unknown): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
    type: 'basic',
    redirected: false,
    url: ''
  };
}

async function servedProbeScript(): Promise<string> {
  // The served bytes are what the browser runs, so they are what the test drives.
  const response = await fetch(`${base}/browser-probe.js`);
  expect(response.status).toBe(200);
  return response.text();
}

const RESERVE = '/__reserve';

/**
 * The probe's transport: the Worker is answered from the script, the host's
 * `/__reserve`, `/__credential` and `/__report` endpoints are the real ones on
 * loopback, and the clock only moves when a read is issued.
 */
function createProbeTransport(config: {
  clock: { value: number };
  answer: Answer;
  onReport: (report: ProbeReport, path: string) => void;
  onCredential: () => void;
}) {
  const calls: Array<{ operation: string; body: Record<string, unknown> }> = [];
  let reserveCalls = 0;
  const transport = async (url: string, init?: { body?: string }): Promise<ResponseLike> => {
    if (url === RESERVE) {
      reserveCalls += 1;
      const requested = (JSON.parse(String(init?.body)) as { reads: number }).reads;
      return jsonResponse(200, { ok: true, reads: requested, observedReadsInLastWindow: requested });
    }
    if (url === '/__credential' || url === '/__report') {
      const forwarded = await fetch(`${base}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: String(init?.body)
      });
      const payload = (await forwarded.json()) as { path?: string };
      if (url === '/__report') {
        config.onReport((JSON.parse(String(init?.body)) as { report: ProbeReport }).report, payload.path ?? '');
      } else {
        config.onCredential();
      }
      return jsonResponse(forwarded.status, payload);
    }
    const body = JSON.parse(String(init?.body)) as { operation: string };
    const index = calls.length;
    calls.push({ operation: body.operation, body });
    const scripted = config.answer({ operation: body.operation, index });
    config.clock.value += scripted.durationMs ?? 1;
    const status = scripted.status ?? 200;
    const headers: Record<string, string | undefined> = {
      'cf-ray': 'test-pop',
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-staging-sheets-reads': String(scripted.sheetsReads ?? READ_PLAN[body.operation] ?? 2),
      ...scripted.headers
    };
    return {
      ok: status < 400,
      status,
      json: async () => scripted.body ?? { ok: true, data: {} },
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      type: 'cors',
      redirected: false,
      url
    };
  };
  return { transport, calls, reserveCalls: () => reserveCalls };
}

type ProbeElement = {
  value: string;
  textContent: string;
  disabled: boolean;
  innerHTML: string;
  addEventListener: (type: string, handler: () => void) => void;
  click: () => void;
};

function createDocumentDouble() {
  const elements = new Map<string, ProbeElement>();
  const element = (selector: string): ProbeElement => {
    const existing = elements.get(selector);
    if (existing) return existing;
    const listeners = new Map<string, () => void>();
    const created: ProbeElement = {
      value: '',
      textContent: '',
      disabled: false,
      innerHTML: '',
      addEventListener: (type, handler) => { listeners.set(type, handler); },
      click: () => listeners.get('click')?.()
    };
    elements.set(selector, created);
    return created;
  };
  return { element, document: { querySelector: (selector: string) => element(selector) } };
}

type ProbePage = {
  clickRun: () => void;
  finished: Promise<void>;
  report: () => ProbeReport | undefined;
  reportPath: () => string;
  reportText: () => string;
  status: () => string;
  workerCalls: Array<{ operation: string; body: Record<string, unknown> }>;
  reserveCalls: () => number;
};

/**
 * Opens the served page the way a browser would: the form arrives from the query
 * string, Google's rendered button hands over a credential, and the run button
 * starts the probe. Nothing is asserted here; the caller drives and inspects it.
 */
async function openProbePage(config: { query: string; answer: Answer }): Promise<ProbePage> {
  const source = await servedProbeScript();
  const clock = { value: 0 };
  const { element, document: documentDouble } = createDocumentDouble();
  let captured: { report: ProbeReport; path: string } | undefined;
  let finishRun: () => void = () => undefined;
  const finished = new Promise<void>((resolveFinish) => { finishRun = resolveFinish; });
  let credentialCaptured: () => void = () => undefined;
  const credentials = new Promise<void>((resolveCredential) => { credentialCaptured = resolveCredential; });
  const { transport, calls, reserveCalls } = createProbeTransport({
    clock,
    answer: config.answer,
    onReport: (report, path) => { captured = { report, path }; finishRun(); },
    onCredential: () => credentialCaptured()
  });
  let signIn: ((response: { credential: string }) => void) | undefined;
  const sandbox: Record<string, unknown> = {
    document: documentDouble,
    location: { search: config.query },
    window: {
      google: {
        accounts: {
          id: {
            initialize: (configuration: { callback: (response: { credential: string }) => void }) => { signIn = configuration.callback; },
            renderButton: () => undefined
          }
        }
      }
    },
    performance: { now: () => clock.value },
    fetch: transport,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console
  };
  runInNewContext(source, sandbox);
  const callback = signIn;
  if (callback === undefined) throw new Error('the served probe page did not mount Google sign-in');
  callback({ credential: CREDENTIAL });
  await credentials;
  return {
    clickRun: () => element('#run').click(),
    finished,
    report: () => captured?.report,
    reportPath: () => captured?.path ?? '',
    reportText: () => element('#report').textContent,
    status: () => element('#status').textContent,
    workerCalls: calls,
    reserveCalls: () => reserveCalls()
  };
}

type BrowserProbeEntry = (options: {
  api: string;
  credential: string;
  label?: string;
  attemptsPerOperation?: number;
  concurrency?: number;
  fetchImpl?: (url: string, init?: { body?: string }) => Promise<ResponseLike>;
  now?: () => number;
}) => Promise<ProbeReport>;

/**
 * Drives the measurement without the page, through the entry point the script
 * exposes for a console session, so a sequential population can be asserted
 * exactly. The page's own pool stays four wide; see `openProbePage`.
 */
async function runProgrammatically(config: { attemptsPerOperation: number; concurrency?: number; answer: Answer }): Promise<ProbeReport> {
  const source = await servedProbeScript();
  const clock = { value: 0 };
  const { transport } = createProbeTransport({
    clock,
    answer: config.answer,
    onReport: () => { throw new Error('the programmatic entry must not capture a report'); },
    onCredential: () => { throw new Error('the programmatic entry must not capture a credential'); }
  });
  const { document: documentDouble } = createDocumentDouble();
  const sandbox: Record<string, unknown> = {
    document: documentDouble,
    location: { search: '' },
    window: {},
    performance: { now: () => clock.value },
    fetch: () => { throw new Error('the programmatic entry must use its injected transport'); },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console
  };
  runInNewContext(source, sandbox);
  const entry = sandbox.runStagingBrowserProbe as BrowserProbeEntry | undefined;
  if (entry === undefined) throw new Error('the served probe page did not expose runStagingBrowserProbe');
  return entry({
    api: WORKER_URL,
    credential: CREDENTIAL,
    label: 'probe-programmatic',
    attemptsPerOperation: config.attemptsPerOperation,
    concurrency: config.concurrency ?? 1,
    fetchImpl: transport,
    now: () => clock.value
  });
}

describe('staging probe host', () => {
  it('serves the probe page and its script', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('browser-probe.js');
    const script = await fetch(`${base}/browser-probe.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');
  });

  it('refuses a traversal path and any non-GET method on the static route', async () => {
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: 'DELETE' })).status).toBe(405);
  });

  it('captures a credential only for a safe label', async () => {
    const good = await fetch(`${base}/__credential`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'tester', credential: 'x'.repeat(40) })
    });
    expect(good.status).toBe(200);
    expect(await readFile(join(stagingDirectory, 'credential-tester.txt'), 'utf8')).toBe('x'.repeat(40));

    for (const label of ['../escape', 'UPPER CASE', '', 'a'.repeat(41)]) {
      const refused = await fetch(`${base}/__credential`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, credential: 'x'.repeat(40) })
      });
      expect(refused.status, label).toBe(400);
    }
    const short = await fetch(`${base}/__credential`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'tester', credential: 'too-short' })
    });
    expect(short.status).toBe(400);
  });

  it('writes a probe report into the staging directory', async () => {
    const response = await fetch(`${base}/__report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'tester', report: { attempts: 3, successes: 3 } })
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { path: string };
    expect(body.path.startsWith(stagingDirectory)).toBe(true);
    expect(JSON.parse(await readFile(body.path, 'utf8'))).toEqual({ attempts: 3, successes: 3 });
    const refused = await fetch(`${base}/__report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'tester', report: null })
    });
    expect(refused.status).toBe(400);
  });

  it('reserves probe reads in the shared ledger and refuses an oversized request', async () => {
    const granted = await fetch(`${base}${RESERVE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reads: 2 })
    });
    expect(granted.status).toBe(200);
    // The window the host reports is the same rolling 60-second budget the
    // paced harness holds, so the browser's reads are spent inside it.
    expect(await granted.json()).toMatchObject({ ok: true, reads: 2, observedReadsInLastWindow: 2 });

    const refused = await fetch(`${base}${RESERVE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reads: 9 })
    });
    expect(refused.status).toBe(400);
  });
});

describe('browser probe', () => {
  it("records each attempt's read count and the Worker's per-read timings in call order", async () => {
    const report = await runProgrammatically({
      attemptsPerOperation: 2,
      answer: ({ operation, index }) => {
        const reads = READ_PLAN[operation] ?? 2;
        return {
          durationMs: index + 1,
          sheetsReads: reads,
          headers: {
            'x-staging-read-ms': Array.from({ length: reads }, (_unused, position) => (index + 1) * 10 + position + 1).join(',')
          }
        };
      }
    });

    expect(report.attempts).toBe(6);
    expect(report.successes).toBe(6);
    // Two reads in call order: the timings keep the Worker's positions, and the
    // list is exactly as long as the read count the same response reported.
    expect(report.perAttempt.map((attempt) => [attempt.operation, attempt.sheetsReads, attempt.readMs])).toEqual([
      ['session.me', 1, [11]],
      ['session.me', 1, [21]],
      ['admin.schedule.read', 2, [31, 32]],
      ['admin.schedule.read', 2, [41, 42]],
      ['admin.insights.read', 2, [51, 52]],
      ['admin.insights.read', 2, [61, 62]]
    ]);
    expect(report.perAttempt.every((attempt) => attempt.readMs?.length === attempt.sheetsReads)).toBe(true);
    expect(report.readTimings).toEqual({ attemptsWithReadMs: 6, attemptsWithoutReadMs: 0 });
    expect(report.perOperation.map((entry) => [entry.operation, entry.sheetsReads])).toEqual([
      ['session.me', 2],
      ['admin.schedule.read', 4],
      ['admin.insights.read', 4]
    ]);
  });

  it('records an absent per-read timing header without failing the attempt', async () => {
    const report = await runProgrammatically({
      attemptsPerOperation: 1,
      answer: ({ index }) => index === 0
        ? { sheetsReads: 1, headers: { 'x-staging-read-ms': '7' } }
        : index === 1
          ? { sheetsReads: 2, headers: { 'x-staging-read-ms': '7, not-a-number' } }
          : {}
    });

    // A deployment older than the header answers the same reads: the attempt
    // succeeds and the missing timings are recorded as absent.
    expect(report.successes).toBe(3);
    expect(report.failureCodes).toEqual({});
    expect(report.perAttempt.map((attempt) => attempt.readMs)).toEqual([[7], null, null]);
    // A header that does not parse as a list of integers is absent too: a
    // partially parsed list would misalign the positions it is priced with.
    expect(report.perAttempt.map((attempt) => attempt.sheetsReads)).toEqual([1, 2, 2]);
    expect(report.perAttempt.every((attempt) => attempt.failure === null)).toBe(true);
    expect(report.readTimings).toEqual({ attemptsWithReadMs: 1, attemptsWithoutReadMs: 2 });
  });

  it('computes per-operation wall quantiles on a known sample', async () => {
    const report = await runProgrammatically({
      attemptsPerOperation: 30,
      concurrency: 1,
      answer: ({ index }) => ({ durationMs: index + 1 })
    });

    // Sequential, so each attempt measures exactly its scripted duration: 1–30
    // for the first operation, 31–60 for the second, 61–90 for the third.
    expect(report.attemptsPerOperation).toBe(30);
    expect(report.concurrency).toBe(1);
    expect(report.attempts).toBe(90);
    expect(report.perOperation.map((entry) => [entry.operation, entry.wallTimeMs])).toEqual([
      ['session.me', { min: 1, p50: 15, p95: 29, p99: 30, max: 30 }],
      ['admin.schedule.read', { min: 31, p50: 45, p95: 59, p99: 60, max: 60 }],
      ['admin.insights.read', { min: 61, p50: 75, p95: 89, p99: 90, max: 90 }]
    ]);
    expect(report.wallTimeMs).toEqual({ min: 1, p50: 45, p95: 86, p99: 90, max: 90 });
    expect(report.perOperation.map((entry) => entry.successes)).toEqual([30, 30, 30]);
    expect(report.observedMaxInFlight).toBe(1);
    expect(report.pacedThroughSharedLedger).toBe(true);
  });

  it("drives the page at the rehearsal's population and keeps the report in staging-local", async () => {
    const page = await openProbePage({
      query: `?api=${encodeURIComponent(WORKER_URL)}&client=staging-client.test&label=probe-page&attempts=30`,
      answer: ({ index }) => index === 3
        ? {
            status: 503,
            durationMs: 2,
            body: { ok: false, error: { code: 'UNAVAILABLE', message: 'not now', details: { reason: 'bracket-hold' } } }
          }
        : { durationMs: 1 }
    });
    page.clickRun();
    await page.finished;
    // The page writes its closing status line one microtask after the host
    // captures the report; let it land before reading it.
    await new Promise((settled) => setTimeout(settled, 0));
    const report = page.report();
    if (report === undefined) throw new Error(`the page did not capture a report (status: ${page.status()})`);

    expect(report).toMatchObject({
      label: 'probe-page',
      api: WORKER_URL,
      attemptsPerOperation: 30,
      concurrency: 4,
      attempts: 90,
      successes: 89,
      failureCodes: { 'status-503': 1 },
      observedMaxInFlight: 4,
      pacedThroughSharedLedger: true
    });
    expect(report.perOperation.map((entry) => [entry.operation, entry.attempts])).toEqual([
      ['session.me', 30],
      ['admin.schedule.read', 30],
      ['admin.insights.read', 30]
    ]);
    // Exactly one attempt was refused, so exactly one operation's population is
    // one short; which one depends only on the pool's pickup order.
    expect(report.perOperation.map((entry) => entry.successes).sort((left, right) => left - right)).toEqual([29, 30, 30]);
    // One reservation per attempt, in the host's shared ledger.
    expect(page.reserveCalls()).toBe(90);
    expect(report.reservedReads).toBe(150);

    // The report shape: aggregates per operation, and one record per attempt
    // carrying what a latency population needs to exclude an attempt.
    expect(Object.keys(report).sort()).toEqual([
      'api', 'attempts', 'attemptsPerOperation', 'concurrency', 'failureCodes', 'generatedAt', 'label',
      'observedMaxInFlight', 'observedReadsInLastWindow', 'pacedThroughSharedLedger', 'perAttempt', 'perOperation',
      'pointsOfPresence', 'readTimings', 'reservedReads', 'successes', 'transport', 'wallTimeMs'
    ]);
    expect(report.perAttempt).toHaveLength(90);
    expect(Object.keys(report.perAttempt[0] ?? {}).sort()).toEqual([
      'corsReadable', 'durationMs', 'errorMessage', 'errorReason', 'failure', 'inFlight', 'non2xx', 'operation',
      'readMs', 'sheetsReads', 'status'
    ]);
    expect(Object.keys(report.wallTimeMs).sort()).toEqual(['max', 'min', 'p50', 'p95', 'p99']);
    expect(report.transport).toEqual({
      allCorsReadable: true,
      anyRedirected: false,
      allSameUrl: true,
      allJsonContentType: true,
      allNoStore: true
    });
    expect(report.perAttempt.every((attempt) => attempt.inFlight >= 1)).toBe(true);
    expect(report.perAttempt.every((attempt) => (attempt.durationMs ?? 0) >= 1)).toBe(true);
    expect(report.perAttempt.filter((attempt) => attempt.status === 200).every((attempt) => attempt.non2xx === false)).toBe(true);

    // The interrupted attempt is recorded with its status, its in-flight count
    // and the failure code, so it can be dropped instead of averaged in.
    const interrupted = report.perAttempt.filter((attempt) => attempt.non2xx);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ status: 503, failure: 'status-503', non2xx: true });
    expect(interrupted[0]?.inFlight).toBeGreaterThanOrEqual(1);
    const interruptedOperation = interrupted[0]?.operation ?? '';
    expect(report.perOperation.find((entry) => entry.operation === interruptedOperation)).toMatchObject({
      attempts: 30,
      successes: 29,
      failureCodes: { 'status-503': 1 },
      statuses: { '200': 29, '503': 1 },
      non2xx: 1
    });

    // The report reaches the page and the ignored staging directory unchanged,
    // and the credential it was measured with appears nowhere in it.
    expect(page.status()).toBe('Done: 89/90 succeeded, and the report was saved locally.');
    expect(JSON.parse(page.reportText())).toEqual(report);
    expect(page.reportPath().startsWith(stagingDirectory)).toBe(true);
    expect(JSON.parse(await readFile(page.reportPath(), 'utf8'))).toEqual(report);
    expect(JSON.stringify(report)).not.toContain(CREDENTIAL);
    expect(page.workerCalls).toHaveLength(90);
    expect(page.workerCalls.every((call) => call.body.credential === CREDENTIAL)).toBe(true);
  });

  it('refuses an unusable attempts parameter instead of measuring a different population', async () => {
    for (const attempts of ['zero', '0', '61']) {
      const page = await openProbePage({
        query: `?api=${encodeURIComponent(WORKER_URL)}&client=staging-client.test&label=probe-refused&attempts=${attempts}`,
        answer: () => ({})
      });
      page.clickRun();
      expect(page.status(), attempts).toBe(`attempts: expected a whole number between 1 and 60, got "${attempts}"`);
      expect(page.workerCalls, attempts).toHaveLength(0);
      expect(page.reserveCalls(), attempts).toBe(0);
      expect(page.report(), attempts).toBeUndefined();
    }
  });
});
