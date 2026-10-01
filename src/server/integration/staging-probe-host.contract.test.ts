import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
/** Live portable composition: fused identity/control, domain batch, closing control. */
const PORTABLE_ACTUAL_READS: Record<string, number> = { 'session.me': 1, 'admin.schedule.read': 3, 'admin.insights.read': 3 };

type WallTime = { min: number | null; p50: number | null; p95: number | null; p99: number | null; max: number | null };

type AttemptRecord = {
  operation: string;
  durationMs: number | null;
  failure: string | null;
  status: number | null;
  non2xx: boolean;
  inFlight: number;
  observedMaxInFlightDuringRequest: number | null;
  requestIssued: boolean;
  reservedReads: number | null;
  reservationGranted: boolean;
  hostDeployedAt: string | null;
  versionLag: boolean;
  sheetsReads: number | null;
  readMs: number[] | null;
};

type OperationSummary = {
  operation: string;
  attempts: number;
  successes: number;
  versionLag: number;
  failureCodes: Record<string, number>;
  statuses: Record<string, number>;
  non2xx: number;
  observedMaxInFlight: number;
  sheetsReads: number;
  wallTimeMs: WallTime;
  successfulWarmObservations: number;
  warmAtConcurrency3Plus: { floor: number; observations: number; wallTimeMs: WallTime };
};

type ProbeReport = {
  label: string;
  api: string;
  generatedAt: string;
  attemptsPerOperation: number;
  concurrency: number;
  readPlan: 'legacy' | 'portable';
  readsPerOperation: Record<string, number>;
  expectedHostDeployedAt: string | null;
  minimumHostAgeMs: number | null;
  hostAgeAtStartMs: number | null;
  requestedAttempts: number;
  attempts: number;
  incomplete: boolean;
  stoppedReason: string | null;
  requestIssuedAttempts: number;
  successes: number;
  successfulWarmObservations: number;
  versionLagAttempts: number;
  failureCodes: Record<string, number>;
  successfulWallTimeMs: WallTime;
  wallTimeMs: WallTime;
  perOperation: OperationSummary[];
  readTimings: { attemptsWithReadMs: number; attemptsWithoutReadMs: number };
  transport: { allCorsReadable: boolean; anyRedirected: boolean; allSameUrl: boolean; allJsonContentType: boolean; allNoStore: boolean };
  observedMaxInFlight: number;
  pacedThroughSharedLedger: boolean;
  allTargetReadsReserved: boolean;
  reservedReads: number;
  reservationRefusals: number;
  observedReadsInLastWindow: number | null;
  pointsOfPresence: string[];
  perAttempt: AttemptRecord[];
};

/** One Worker read's scripted answer; the clock advances as the read is issued. */
type ScriptedAttempt = {
  status?: number;
  durationMs?: number;
  bodyDelayMs?: number;
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
  reservationStatus?: number;
  hostDeployedAt?: string;
  actualReads?: Record<string, number>;
  onReserveRequest?: () => void;
  reservationAnswer?: (callIndex: number, reads: number) => Promise<ResponseLike>;
  onTargetStatus?: (status: number) => void;
}) {
  const calls: Array<{ operation: string; body: Record<string, unknown> }> = [];
  let reserveCalls = 0;
  const transport = async (url: string, init?: { body?: string }): Promise<ResponseLike> => {
    if (url === RESERVE) {
      const callIndex = reserveCalls;
      reserveCalls += 1;
      config.onReserveRequest?.();
      const requested = (JSON.parse(String(init?.body)) as { reads: number }).reads;
      if (config.reservationAnswer !== undefined) return config.reservationAnswer(callIndex, requested);
      if (config.reservationStatus !== undefined && config.reservationStatus !== 200) {
        return jsonResponse(config.reservationStatus, { ok: false, error: 'ledger unavailable' });
      }
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
      'x-staging-sheets-reads': String(scripted.sheetsReads ?? config.actualReads?.[body.operation] ?? READ_PLAN[body.operation] ?? 2),
      'x-staging-host-deployed-at': config.hostDeployedAt,
      ...scripted.headers
    };
    let statusObserved = false;
    return {
      ok: status < 400,
      get status() {
        if (!statusObserved) {
          statusObserved = true;
          config.onTargetStatus?.(status);
        }
        return status;
      },
      json: async () => {
        if (scripted.bodyDelayMs !== undefined) {
          await new Promise<void>((settled) => setTimeout(settled, 1));
          config.clock.value += scripted.bodyDelayMs;
        }
        return scripted.body ?? { ok: true, data: {} };
      },
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
async function openProbePage(config: {
  query: string;
  answer: Answer;
  reservationStatus?: number;
  hostDeployedAt?: string;
  actualReads?: Record<string, number>;
  wallClock?: number;
  onWait?: (delayMs: number, status: string, reservationCalls: number) => void;
}): Promise<ProbePage> {
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
    ...(config.reservationStatus === undefined ? {} : { reservationStatus: config.reservationStatus }),
    ...(config.hostDeployedAt === undefined ? {} : { hostDeployedAt: config.hostDeployedAt }),
    ...(config.actualReads === undefined ? {} : { actualReads: config.actualReads }),
    onReport: (report, path) => { captured = { report, path }; finishRun(); },
    onCredential: () => credentialCaptured()
  });
  const pageWallClock = { value: config.wallClock ?? Date.now() };
  class ProbeDate extends Date {
    constructor(value?: string | number) {
      super(value ?? pageWallClock.value);
    }

    static now() {
      return pageWallClock.value;
    }
  }
  const pageSetTimeout = config.onWait === undefined
    ? setTimeout
    : (callback: () => void, delayMs = 0) => {
      config.onWait?.(delayMs, element('#status').textContent, reserveCalls());
      pageWallClock.value += delayMs;
      queueMicrotask(callback);
      return 0;
    };
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
    Date: ProbeDate,
    URL,
    URLSearchParams,
    setTimeout: pageSetTimeout,
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
  readPlan?: 'legacy' | 'portable';
  readsPerOperation?: Record<string, number>;
  expectedHostDeployedAt?: string;
  wallNow?: () => number;
  wait?: (durationMs: number) => Promise<void>;
  onProgress?: (progress: { operation: string; completed: number; total: number; inFlight: number }) => void;
  onVersionWait?: (remainingMs: number) => void;
  fetchImpl?: (url: string, init?: { body?: string }) => Promise<ResponseLike>;
  now?: () => number;
}) => Promise<ProbeReport>;

/**
 * Drives the measurement without the page, through the entry point the script
 * exposes for a console session, so a sequential population can be asserted
 * exactly. The page's own pool stays four wide; see `openProbePage`.
 */
async function runProgrammatically(config: {
  attemptsPerOperation: number;
  concurrency?: number;
  answer: Answer;
  readPlan?: 'legacy' | 'portable';
  readsPerOperation?: Record<string, number>;
  expectedHostDeployedAt?: string;
  wallNow?: () => number;
  wait?: (durationMs: number) => Promise<void>;
  onProgress?: (progress: { operation: string; completed: number; total: number; inFlight: number }) => void;
  onVersionWait?: (remainingMs: number) => void;
  reservationStatus?: number;
  hostDeployedAt?: string;
  actualReads?: Record<string, number>;
  targetBarrier?: number | Record<string, number>;
  onReserveRequest?: () => void;
  reservationAnswer?: (callIndex: number, reads: number) => Promise<ResponseLike>;
  onTargetStatus?: (status: number) => void;
}): Promise<ProbeReport> {
  const source = await servedProbeScript();
  const clock = { value: 0 };
  const { transport } = createProbeTransport({
    clock,
    answer: config.answer,
    ...(config.reservationStatus === undefined ? {} : { reservationStatus: config.reservationStatus }),
    ...(config.hostDeployedAt === undefined ? {} : { hostDeployedAt: config.hostDeployedAt }),
    ...(config.actualReads === undefined ? {} : { actualReads: config.actualReads }),
    ...(config.onReserveRequest === undefined ? {} : { onReserveRequest: config.onReserveRequest }),
    ...(config.reservationAnswer === undefined ? {} : { reservationAnswer: config.reservationAnswer }),
    ...(config.onTargetStatus === undefined ? {} : { onTargetStatus: config.onTargetStatus }),
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
  const targetStarts = new Map<string, number>();
  const targetCohorts = new Map<string, { started: number; promise: Promise<void>; release: () => void }>();
  const targetBarrier = config.targetBarrier ?? 0;
  const fetchImpl = async (url: string, init?: { body?: string }): Promise<ResponseLike> => {
    const response = await transport(url, init);
    if (url !== WORKER_URL) return response;
    const operation = (JSON.parse(String(init?.body)) as { operation: string }).operation;
    const perOperationBarrier = typeof targetBarrier === 'number' ? undefined : targetBarrier[operation];
    const required = perOperationBarrier ?? (typeof targetBarrier === 'number' ? targetBarrier : 0);
    if (required < 1) return response;
    const startKey = perOperationBarrier === undefined ? '*' : operation;
    const started = targetStarts.get(startKey) ?? 0;
    targetStarts.set(startKey, started + 1);
    const cohortIndex = perOperationBarrier === undefined ? 0 : Math.floor(started / required);
    if (perOperationBarrier !== undefined && config.attemptsPerOperation - cohortIndex * required < required) return response;
    if (perOperationBarrier === undefined && started >= required) return response;
    const key = perOperationBarrier === undefined ? '*' : `${operation}:${cohortIndex}`;
    let cohort = targetCohorts.get(key);
    if (cohort === undefined) {
      let release!: () => void;
      const promise = new Promise<void>((settled) => { release = settled; });
      cohort = { started: 0, promise, release };
      targetCohorts.set(key, cohort);
    }
    if (cohort.started < required) {
      cohort.started += 1;
      if (cohort.started === required) cohort.release();
      await cohort.promise;
    }
    return response;
  };
  return entry({
    api: WORKER_URL,
    credential: CREDENTIAL,
    label: 'probe-programmatic',
    attemptsPerOperation: config.attemptsPerOperation,
    concurrency: config.concurrency ?? 1,
    ...(config.readPlan === undefined ? {} : { readPlan: config.readPlan }),
    ...(config.readsPerOperation === undefined ? {} : { readsPerOperation: config.readsPerOperation }),
    ...(config.expectedHostDeployedAt === undefined ? {} : { expectedHostDeployedAt: config.expectedHostDeployedAt }),
    ...(config.wallNow === undefined ? {} : { wallNow: config.wallNow }),
    ...(config.wait === undefined ? {} : { wait: config.wait }),
    ...(config.onProgress === undefined ? {} : { onProgress: config.onProgress }),
    ...(config.onVersionWait === undefined ? {} : { onVersionWait: config.onVersionWait }),
    fetchImpl,
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
    const previousUmask = process.umask(0);
    try {
      const existingCredentialPath = join(stagingDirectory, 'credential-existing.txt');
      await writeFile(existingCredentialPath, 'previous-test-credential', { mode: 0o644 });
      await chmod(existingCredentialPath, 0o644);
      expect((await stat(existingCredentialPath)).mode & 0o777).toBe(0o644);
      const replaced = await fetch(`${base}/__credential`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'existing', credential: 'y'.repeat(40) })
      });
      expect(replaced.status).toBe(200);
      expect(await readFile(existingCredentialPath, 'utf8')).toBe('y'.repeat(40));
      expect((await stat(existingCredentialPath)).mode & 0o777).toBe(0o600);

      const good = await fetch(`${base}/__credential`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'tester', credential: 'x'.repeat(40) })
      });
      expect(good.status).toBe(200);
      const newCredentialPath = join(stagingDirectory, 'credential-tester.txt');
      expect(await readFile(newCredentialPath, 'utf8')).toBe('x'.repeat(40));
      expect((await stat(newCredentialPath)).mode & 0o777).toBe(0o600);

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
    } finally {
      process.umask(previousUmask);
    }
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
    // The archived default keeps its original 1 / 2 / 2 reservation costs.
    expect(report.readPlan).toBe('legacy');
    expect(report.readsPerOperation).toEqual(READ_PLAN);
    expect(report.reservedReads).toBe(10);
    expect(report.perAttempt.map((attempt) => attempt.reservedReads)).toEqual([1, 1, 2, 2, 2, 2]);
    expect(report.pacedThroughSharedLedger).toBe(true);
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

  it('uses conservative portable reservations while reporting the measured read counts', async () => {
    const expectedHostDeployedAt = new Date(Date.now() - 120_000).toISOString();
    const report = await runProgrammatically({
      attemptsPerOperation: 1,
      readPlan: 'portable',
      expectedHostDeployedAt,
      hostDeployedAt: expectedHostDeployedAt,
      actualReads: PORTABLE_ACTUAL_READS,
      answer: () => ({})
    });

    expect(report.readPlan).toBe('portable');
    expect(report.readsPerOperation).toEqual({ 'session.me': 2, 'admin.schedule.read': 4, 'admin.insights.read': 4 });
    expect(report.perAttempt.map((attempt) => [attempt.operation, attempt.reservedReads, attempt.sheetsReads])).toEqual([
      ['session.me', 2, 1],
      ['admin.schedule.read', 4, 3],
      ['admin.insights.read', 4, 3]
    ]);
    expect(report.reservedReads).toBe(10);
    expect(report.pacedThroughSharedLedger).toBe(true);
  });

  it('refuses portable overrides below the measured live per-operation cost before reserving reads', async () => {
    let reserveCalls = 0;
    await expect(runProgrammatically({
      attemptsPerOperation: 1,
      readPlan: 'portable',
      expectedHostDeployedAt: new Date(Date.now() - 120_000).toISOString(),
      readsPerOperation: { 'admin.schedule.read': 2 },
      onReserveRequest: () => { reserveCalls += 1; },
      answer: () => { throw new Error('no target request should be issued'); }
    })).rejects.toThrow('readsPerOperation.admin.schedule.read must be a whole number between 3 and 8 for the portable plan.');
    expect(reserveCalls).toBe(0);
  });

  it('requires a canonical expected host marker for portable runs before reserving reads', async () => {
    let reserveCalls = 0;
    await expect(runProgrammatically({
      attemptsPerOperation: 1,
      readPlan: 'portable',
      onReserveRequest: () => { reserveCalls += 1; },
      answer: () => { throw new Error('no target request should be issued'); }
    })).rejects.toThrow('The portable read plan requires hostDeployedAt');
    await expect(runProgrammatically({
      attemptsPerOperation: 1,
      readPlan: 'portable',
      expectedHostDeployedAt: '2026-10-01',
      onReserveRequest: () => { reserveCalls += 1; },
      answer: () => { throw new Error('no target request should be issued'); }
    })).rejects.toThrow('hostDeployedAt must be a canonical ISO timestamp');
    expect(reserveCalls).toBe(0);
  });

  it('rejects an extended-year deployment marker before reserving reads', async () => {
    let reserveCalls = 0;
    const expectedHostDeployedAt = '+010000-01-01T00:00:00.000Z';
    await expect(runProgrammatically({
      attemptsPerOperation: 1,
      readPlan: 'portable',
      expectedHostDeployedAt,
      wallNow: () => Date.parse(expectedHostDeployedAt) + 120_000,
      onReserveRequest: () => { reserveCalls += 1; },
      answer: () => { throw new Error('no target request should be issued'); }
    })).rejects.toThrow('hostDeployedAt must be a canonical ISO timestamp');
    expect(reserveCalls).toBe(0);
  });

  it('records malformed or count-mismatched per-read timing headers as absent without failing the attempt', async () => {
    const report = await runProgrammatically({
      attemptsPerOperation: 1,
      answer: ({ index }) => index === 0
        ? { sheetsReads: 1, headers: { 'x-staging-read-ms': '7' } }
        : index === 1
          ? { sheetsReads: 2, headers: { 'x-staging-read-ms': '7, not-a-number' } }
          : { sheetsReads: 2, headers: { 'x-staging-read-ms': '7, 8, 9' } }
    });

    // A deployment older than the header answers the same reads: the attempt
    // succeeds and the missing timings are recorded as absent.
    expect(report.successes).toBe(3);
    expect(report.failureCodes).toEqual({});
    expect(report.perAttempt.map((attempt) => attempt.readMs)).toEqual([[7], null, null]);
    // Headers that fail integer parsing or disagree with the reported read
    // count are absent, so timings cannot be misaligned with their plan cost.
    expect(report.perAttempt.map((attempt) => attempt.sheetsReads)).toEqual([1, 2, 2]);
    expect(report.perAttempt.every((attempt) => attempt.failure === null)).toBe(true);
    expect(report.readTimings).toEqual({ attemptsWithReadMs: 1, attemptsWithoutReadMs: 2 });
  });

  it('records unsafe integer timing headers as absent without failing the attempt', async () => {
    const report = await runProgrammatically({
      attemptsPerOperation: 1,
      answer: () => ({ sheetsReads: 1, headers: { 'x-staging-read-ms': '9'.repeat(400) } })
    });

    expect(report.successes).toBe(3);
    expect(report.perAttempt.map((attempt) => attempt.readMs)).toEqual([null, null, null]);
  });

  it('waits out the 95-second host deployment lag before reserving any reads', async () => {
    const marker = '2026-10-01T12:00:00.000Z';
    let wallClock = Date.parse(marker) + 30_000;
    let waitedMs = 0;
    let reservations = 0;
    let waitNoticeCount = 0;
    const report = await runProgrammatically({
      attemptsPerOperation: 1,
      concurrency: 1,
      expectedHostDeployedAt: marker,
      hostDeployedAt: marker,
      wallNow: () => wallClock,
      wait: async (durationMs) => {
        expect(reservations).toBe(0);
        waitedMs += durationMs;
        wallClock += durationMs;
      },
      onVersionWait: (remainingMs) => {
        expect(reservations).toBe(0);
        expect(remainingMs).toBe(65_000);
        waitNoticeCount += 1;
      },
      onReserveRequest: () => { reservations += 1; },
      answer: () => ({ durationMs: 1 })
    });

    expect(waitedMs).toBe(65_000);
    expect(waitNoticeCount).toBe(1);
    expect(reservations).toBe(3);
    expect(report.minimumHostAgeMs).toBe(95_000);
    expect(report.hostAgeAtStartMs).toBe(95_000);
  });

  it('shows the deployment wait in the page and begins reservations only after it ends', async () => {
    const expectedHostDeployedAt = new Date(Date.now() - 30_000).toISOString();
    const page = await openProbePage({
      query: `?api=${encodeURIComponent(WORKER_URL)}&client=staging-client.test&label=probe-age&attempts=1&hostDeployedAt=${encodeURIComponent(expectedHostDeployedAt)}`,
      hostDeployedAt: expectedHostDeployedAt,
      wallClock: Date.parse(expectedHostDeployedAt) + 30_000,
      onWait: (delayMs, status, reservationCalls) => {
        expect(delayMs).toBe(65_000);
        expect(status).toContain('Waiting 65 seconds');
        expect(reservationCalls).toBe(0);
      },
      answer: () => ({ durationMs: 1 })
    });
    page.clickRun();
    await page.finished;
    const report = page.report();
    if (report === undefined) throw new Error(`the page did not capture its post-lag report (status: ${page.status()})`);

    expect(report.hostAgeAtStartMs).toBe(95_000);
    expect(report.minimumHostAgeMs).toBe(95_000);
    expect(page.reserveCalls()).toBe(3);
  });

  it('retains version-lag responses but excludes them from warm distributions', async () => {
    const expectedHostDeployedAt = '2026-09-30T12:00:00.000Z';
    const report = await runProgrammatically({
      attemptsPerOperation: 1,
      concurrency: 1,
      expectedHostDeployedAt,
      hostDeployedAt: expectedHostDeployedAt,
      answer: ({ index }) => ({
        durationMs: (index + 1) * 10,
        ...(index === 0 ? { headers: { 'x-staging-host-deployed-at': '2026-09-30T11:00:00.000Z' } } : {})
      })
    });

    expect(report.successes).toBe(3);
    expect(report.versionLagAttempts).toBe(1);
    expect(report.perAttempt[0]).toMatchObject({ hostDeployedAt: '2026-09-30T11:00:00.000Z', versionLag: true, failure: null });
    expect(report.successfulWallTimeMs).toMatchObject({ min: 10, max: 30 });
    expect(report.wallTimeMs).toMatchObject({ min: 20, max: 30 });
    expect(report.perOperation[0]).toMatchObject({ successfulWarmObservations: 0, wallTimeMs: { min: null, p50: null, p95: null, p99: null, max: null } });
    expect(report.perOperation[1]?.successfulWarmObservations).toBe(1);
  });

  it('measures request overlap through response-body completion instead of trusting pool width', async () => {
    const report = await runProgrammatically({
      attemptsPerOperation: 2,
      concurrency: 4,
      targetBarrier: 4,
      answer: ({ index }) => ({ durationMs: index + 1 })
    });

    expect(report.concurrency).toBe(4);
    expect(report.observedMaxInFlight).toBe(4);
    const independentlyCounted = report.perAttempt.filter((attempt) => (attempt.observedMaxInFlightDuringRequest ?? 0) >= 3).length;
    expect(report.perOperation.reduce((total, operation) => total + operation.warmAtConcurrency3Plus.observations, 0)).toBe(independentlyCounted);
    expect(report.perAttempt.filter((attempt) => attempt.observedMaxInFlightDuringRequest === 4).length).toBeGreaterThanOrEqual(4);
    for (const operation of report.perOperation) {
      expect(operation.warmAtConcurrency3Plus.observations).toBe(
        report.perAttempt.filter((attempt) => attempt.operation === operation.operation
          && !attempt.failure && !attempt.versionLag
          && (attempt.observedMaxInFlightDuringRequest ?? 0) >= 3).length
      );
    }
  });

  it('challenges the full portable population with ledger cost, version lag and per-operation overlap', async () => {
    const expectedHostDeployedAt = new Date(Date.now() - 120_000).toISOString();
    const report = await runProgrammatically({
      attemptsPerOperation: 30,
      concurrency: 4,
      readPlan: 'portable',
      expectedHostDeployedAt,
      hostDeployedAt: expectedHostDeployedAt,
      actualReads: PORTABLE_ACTUAL_READS,
      targetBarrier: {
        'session.me': 4,
        'admin.schedule.read': 4,
        'admin.insights.read': 4
      },
      answer: ({ index }) => ({
        durationMs: index + 1,
        ...(index === 0 ? { headers: { 'x-staging-host-deployed-at': '2026-09-30T11:00:00.000Z' } } : {})
      })
    });

    expect(report).toMatchObject({
      requestedAttempts: 90,
      attempts: 90,
      incomplete: false,
      readPlan: 'portable',
      expectedHostDeployedAt,
      minimumHostAgeMs: 95_000,
      allTargetReadsReserved: true,
      pacedThroughSharedLedger: true,
      reservedReads: 300,
      observedMaxInFlight: 4,
      successes: 90,
      successfulWarmObservations: 89,
      versionLagAttempts: 1
    });
    expect(report.perAttempt.every((attempt) => attempt.reservationGranted
      && attempt.reservedReads === (attempt.operation === 'session.me' ? 2 : 4)
      && attempt.sheetsReads === PORTABLE_ACTUAL_READS[attempt.operation])).toBe(true);
    expect(report.perAttempt[0]).toMatchObject({ versionLag: true, hostDeployedAt: '2026-09-30T11:00:00.000Z' });
    expect(report.perOperation.map((operation) => operation.attempts)).toEqual([30, 30, 30]);
    for (const operation of report.perOperation) {
      const measuredOverlap = report.perAttempt.filter((attempt) => attempt.operation === operation.operation
        && !attempt.failure && !attempt.versionLag
        && (attempt.observedMaxInFlightDuringRequest ?? 0) >= 3).length;
      expect(operation.warmAtConcurrency3Plus.observations).toBe(measuredOverlap);
      expect(operation.warmAtConcurrency3Plus.observations).toBeGreaterThanOrEqual(operation.operation === 'session.me' ? 27 : 28);
      expect(operation.wallTimeMs.min).not.toBeNull();
    }
  });

  it('does not count a request in flight while it waits for its ledger reservation', async () => {
    const progress: Array<{ inFlight: number }> = [];
    const progressCountAtReservation: number[] = [];
    const report = await runProgrammatically({
      attemptsPerOperation: 1,
      concurrency: 1,
      onProgress: (event) => progress.push({ inFlight: event.inFlight }),
      onReserveRequest: () => { progressCountAtReservation.push(progress.length); },
      answer: () => ({})
    });

    expect(progressCountAtReservation[0]).toBe(0);
    expect(progress).toHaveLength(3);
    expect(progress.every((event) => event.inFlight === 1)).toBe(true);
    expect(report.perAttempt.every((attempt) => attempt.inFlight === 1 && attempt.observedMaxInFlightDuringRequest === 1)).toBe(true);
  });

  it('releases the in-flight slot in finally when a target transport fails', async () => {
    const report = await runProgrammatically({
      attemptsPerOperation: 1,
      concurrency: 1,
      answer: ({ index }) => {
        if (index === 0) throw new Error('synthetic transport failure');
        return { durationMs: 1 };
      }
    });

    expect(report.perAttempt[0]).toMatchObject({ failure: 'transport', requestIssued: true, reservationGranted: true, inFlight: 1 });
    expect(report.perAttempt.slice(1).every((attempt) => attempt.inFlight === 1 && attempt.observedMaxInFlightDuringRequest === 1)).toBe(true);
    expect(report.observedMaxInFlight).toBe(1);
  });

  it('includes response-body time in each wall observation', async () => {
    const report = await runProgrammatically({
      attemptsPerOperation: 1,
      concurrency: 1,
      answer: ({ index }) => index === 0 ? { durationMs: 5, bodyDelayMs: 20 } : { durationMs: 1 }
    });

    expect(report.perAttempt[0]?.durationMs).toBe(25);
    expect(report.perAttempt[0]?.observedMaxInFlightDuringRequest).toBe(1);
  });

  it('records a refused ledger reservation and stops without issuing a target read', async () => {
    const page = await openProbePage({
      query: `?api=${encodeURIComponent(WORKER_URL)}&client=staging-client.test&label=probe-reservation-refused&attempts=30`,
      reservationStatus: 503,
      answer: () => { throw new Error('no target read is permitted after refusal'); }
    });
    page.clickRun();
    await page.finished;
    await new Promise((settled) => setTimeout(settled, 0));
    const report = page.report();
    if (report === undefined) throw new Error(`the page did not capture the refused reservation (status: ${page.status()})`);

    expect(report.incomplete).toBe(true);
    expect(report.requestedAttempts).toBe(90);
    expect(report.stoppedReason).toBe('reservation-refused');
    expect(report.reservationRefusals).toBeGreaterThan(0);
    expect(report.pacedThroughSharedLedger).toBe(false);
    expect(report.perAttempt.every((attempt) => attempt.failure === 'reservation-refused' && !attempt.requestIssued && !attempt.reservationGranted)).toBe(true);
    expect(report.requestIssuedAttempts).toBe(0);
    expect(page.workerCalls).toHaveLength(0);
    expect(page.reserveCalls()).toBeLessThan(report.requestedAttempts);
    expect(report.transport).toEqual({
      allCorsReadable: false,
      anyRedirected: false,
      allSameUrl: false,
      allJsonContentType: false,
      allNoStore: false
    });
    expect(page.status()).toContain('Stopped: 0/');
  });

  it('stops after the first HTTP 429, settles issued reads and cancels a pending grant without refund', async () => {
    let releasePendingReservation!: () => void;
    const pendingReservation = new Promise<void>((release) => { releasePendingReservation = release; });
    let markPendingReservationStarted!: () => void;
    const pendingReservationStarted = new Promise<void>((started) => { markPendingReservationStarted = started; });
    let reserveCalls = 0;
    const reportPromise = runProgrammatically({
      attemptsPerOperation: 1,
      concurrency: 3,
      targetBarrier: 2,
      onReserveRequest: () => { reserveCalls += 1; },
      reservationAnswer: async (callIndex, reads) => {
        if (callIndex === 1) {
          markPendingReservationStarted();
          await pendingReservation;
        }
        return jsonResponse(200, { ok: true, reads, observedReadsInLastWindow: reads });
      },
      onTargetStatus: (status) => { if (status === 429) releasePendingReservation(); },
      answer: ({ index }) => index === 0 ? { status: 429 } : { status: 200, bodyDelayMs: 5 }
    });
    await pendingReservationStarted;
    const report = await reportPromise;

    expect(report.stoppedReason).toBe('status-429');
    expect(report.incomplete).toBe(true);
    expect(report.requestIssuedAttempts).toBe(2);
    expect(report.attempts).toBe(3);
    expect(report.perAttempt.filter((attempt) => attempt.requestIssued && attempt.status === 429)).toHaveLength(1);
    expect(report.perAttempt.filter((attempt) => attempt.requestIssued && attempt.status === 200)).toHaveLength(1);
    expect(report.perAttempt.filter((attempt) => attempt.failure === 'reservation-cancelled')).toMatchObject([
      { requestIssued: false, reservationGranted: true, reservedReads: 2 }
    ]);
    expect(report.reservedReads).toBe(5);
    expect(reserveCalls).toBe(3);
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
    const expectedHostDeployedAt = '2026-09-30T00:00:00.000Z';
    const page = await openProbePage({
      query: `?api=${encodeURIComponent(WORKER_URL)}&client=staging-client.test&label=probe-page&attempts=30&readPlan=portable&hostDeployedAt=${encodeURIComponent(expectedHostDeployedAt)}`,
      hostDeployedAt: expectedHostDeployedAt,
      actualReads: PORTABLE_ACTUAL_READS,
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
      readPlan: 'portable',
      readsPerOperation: { 'session.me': 2, 'admin.schedule.read': 4, 'admin.insights.read': 4 },
      expectedHostDeployedAt,
      attempts: 90,
      incomplete: false,
      successes: 89,
      failureCodes: { 'status-503': 1 },
      pacedThroughSharedLedger: true
    });
    expect(report.observedMaxInFlight).toBeGreaterThanOrEqual(1);
    expect(report.observedMaxInFlight).toBeLessThanOrEqual(4);
    expect(report.successfulWarmObservations).toBe(89);
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
    expect(report.reservedReads).toBe(300);
    expect(report.perOperation.map((entry) => entry.successfulWarmObservations).sort((left, right) => left - right)).toEqual([29, 30, 30]);

    // The report shape: aggregates per operation, and one record per attempt
    // carrying what a latency population needs to exclude an attempt.
    expect(Object.keys(report).sort()).toEqual([
      'allTargetReadsReserved', 'api', 'attempts', 'attemptsPerOperation', 'concurrency', 'expectedHostDeployedAt',
      'failureCodes', 'generatedAt', 'hostAgeAtStartMs', 'incomplete', 'label', 'minimumHostAgeMs', 'observedMaxInFlight',
      'observedReadsInLastWindow', 'pacedThroughSharedLedger', 'perAttempt', 'perOperation', 'pointsOfPresence',
      'readPlan', 'readTimings', 'readsPerOperation', 'requestIssuedAttempts', 'requestedAttempts',
      'reservationRefusals', 'reservedReads', 'stoppedReason', 'successes', 'successfulWallTimeMs',
      'successfulWarmObservations', 'transport', 'versionLagAttempts', 'wallTimeMs'
    ]);
    expect(report.perAttempt).toHaveLength(90);
    expect(Object.keys(report.perAttempt[0] ?? {}).sort()).toEqual([
      'corsReadable', 'durationMs', 'errorMessage', 'errorReason', 'failure', 'hostDeployedAt', 'inFlight',
      'non2xx', 'observedMaxInFlightDuringRequest', 'operation', 'readMs', 'requestIssued', 'reservationGranted',
      'reservedReads', 'sheetsReads', 'status', 'versionLag'
    ]);
    expect(Object.keys(report.wallTimeMs).sort()).toEqual(['max', 'min', 'p50', 'p95', 'p99']);
    expect(report.transport).toEqual({
      allCorsReadable: true,
      anyRedirected: false,
      allSameUrl: true,
      allJsonContentType: true,
      allNoStore: true
    });
    expect(report.perAttempt.every((attempt) => attempt.inFlight >= 1 && (attempt.observedMaxInFlightDuringRequest ?? 0) >= attempt.inFlight)).toBe(true);
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
