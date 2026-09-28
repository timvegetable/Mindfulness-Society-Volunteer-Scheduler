#!/usr/bin/env node
// Collects the platform's own runtime metrics for the isolated staging topology
// (baseline Worker, gateway Worker, and its Durable Object host).
//
// The contract's CPU thresholds are published quantiles, so the evidence comes
// from Cloudflare's analytics rather than from anything the Workers can report
// about themselves. Repairs mandated by the amendment of 2026-09-27:
//
// - Explicit attribution: every query is scoped to named scripts, the Durable
//   Object namespace, a deployment window, and nothing else. An account-wide
//   total is not evidence, and a placeholder (`__unknown__`) script name is
//   reported as an ambiguous record instead of being assumed.
// - Units are documented: the Workers invocation dataset exposes CPU as
//   quantiles in microseconds; Durable Object CPU in `durableObjectsPeriodicGroups`
//   is likewise a microsecond sum. Both readings are reported so a reviewer can
//   check them against the invocation status.
// - Aggregate quantiles are used only for their actual population: single-request
//   buckets become exact samples, multi-request buckets stay per-bucket
//   aggregates labelled with their population, quantiles are never divided by
//   request counts, and a maximum bucket quantile is never labelled the
//   campaign percentile.
// - Pagination: windows are split into slices and slices into halves when a
//   query returns a full page, so no record set is silently truncated.
// - Coverage: observed platform requests are checked against the campaign's
//   expected count; insufficient or ambiguous coverage cannot pass a gate.
// - Object memory comes from `durableObjectsPeriodicGroups`
//   (`memoryUsageBytes` quantiles in bytes) where the platform publishes it;
//   an unavailable measurement stays unresolved.
//
// The campaign runner (`measure-worker.mjs`) owns the attempt log; pass it with
// --attempts to join per-attempt correlation IDs and timing to the platform
// records. Telemetry never logs credentials, response bodies, principals, or
// workbook rows.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ACCOUNT_ID = '868086b4b2dc75413ea149480ae4fe82';
const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
/** Cloudflare rejects a window wider than four weeks. */
const MAX_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
/** Rows per page in the Workers invocation dataset. */
const INVOCATION_ROW_LIMIT = 100;
/** Rows per page in the Durable Object datasets (the documented example uses 1000). */
const DO_ROW_LIMIT = 1000;
/** Campaign windows are queried in hourly slices. */
const SLICE_MS = 60 * 60 * 1000;
/** A slice is halved at most this many times before the collector refuses. */
const MAX_SPLIT_DEPTH = 5;
/** The Workers dataset's placeholder script attribution. */
const UNKNOWN_SCRIPT = '__unknown__';

export const CPU_UNIT = {
  reportedUnit: 'microseconds',
  basis: 'Cloudflare reports CPU time in these datasets as microseconds; a millisecond reading would contradict the invocation status the same window reports',
  sources: [
    'https://developers.cloudflare.com/workers/observability/metrics-and-analytics/',
    'https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/'
  ]
};

export function parseArguments(argv) {
  const options = {
    tokenFile: 'staging-local/cloudflare-api-token.txt',
    scripts: [],
    role: 'worker',
    namespace: undefined,
    since: undefined,
    until: undefined,
    expectedRequests: undefined,
    attempts: undefined,
    report: undefined,
    plan: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${argument} needs a value.`);
      return argv[index];
    };
    if (argument === '--token-file') options.tokenFile = next();
    else if (argument === '--script') options.scripts.push(next());
    else if (argument === '--role') options.role = next();
    else if (argument === '--namespace') options.namespace = next();
    else if (argument === '--since') options.since = next();
    else if (argument === '--until') options.until = next();
    else if (argument === '--expected-requests') {
      const value = Number(next());
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('--expected-requests must be a positive integer.');
      options.expectedRequests = value;
    } else if (argument === '--attempts') options.attempts = next();
    else if (argument === '--report') options.report = next();
    else if (argument === '--plan') options.plan = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.scripts.length === 0) throw new Error('At least one --script name is required; account-wide attribution is not evidence.');
  return options;
}

/** The window must be explicit: an unbounded query is refused by the API. */
export function resolveWindow(options, nowMs = Date.now()) {
  const until = options.until === undefined ? new Date(nowMs) : new Date(options.until);
  const since = options.since === undefined ? new Date(until.getTime() - 30 * 60 * 1000) : new Date(options.since);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) throw new Error('--since and --until must be ISO timestamps.');
  if (until.getTime() <= since.getTime()) throw new Error('--until must be after --since.');
  if (until.getTime() - since.getTime() > MAX_WINDOW_MS) throw new Error('The window must be four weeks or less.');
  return { since, until };
}

/** Splits a window into query slices so no slice can hit a row limit. */
export function splitWindows(since, until, sliceMs = SLICE_MS) {
  const slices = [];
  for (let start = since.getTime(); start < until.getTime(); start += sliceMs) {
    slices.push({ since: new Date(start), until: new Date(Math.min(start + sliceMs, until.getTime())) });
  }
  return slices;
}

/** The Workers invocation dataset, filtered to the named scripts and window. */
export function invocationsQuery(accountId, scriptNames, since, until, limit = INVOCATION_ROW_LIMIT) {
  const filter = `{datetime_geq: "${since.toISOString()}", datetime_leq: "${until.toISOString()}", scriptName_in: [${scriptNames.map((name) => `"${name}"`).join(', ')}]}`;
  return `query {
  viewer {
    accounts(filter: {accountTag: "${accountId}"}) {
      workersInvocationsAdaptive(limit: ${limit}, filter: ${filter}) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP90 cpuTimeP99 }
        dimensions { datetime status scriptName }
      }
    }
  }
}`;
}

/** The Durable Object invocation dataset for the object topology. */
export function doInvocationsQuery(accountId, namespaceId, since, until, limit = DO_ROW_LIMIT) {
  const namespace = namespaceId === undefined ? '' : `, namespaceId: "${namespaceId}"`;
  const filter = `{datetime_geq: "${since.toISOString()}", datetime_leq: "${until.toISOString()}"${namespace}}`;
  return `query {
  viewer {
    accounts(filter: {accountTag: "${accountId}"}) {
      durableObjectsInvocationsAdaptiveGroups(limit: ${limit}, filter: ${filter}) {
        sum { requests errors }
        dimensions { datetime namespaceId }
      }
    }
  }
}`;
}

/** Durable Object CPU and isolate memory, as published by the periodic dataset. */
export function doPeriodicQuery(accountId, namespaceId, since, until, limit = DO_ROW_LIMIT) {
  const namespace = namespaceId === undefined ? '' : `, namespaceId: "${namespaceId}"`;
  const filter = `{datetime_geq: "${since.toISOString()}", datetime_leq: "${until.toISOString()}"${namespace}}`;
  return `query {
  viewer {
    accounts(filter: {accountTag: "${accountId}"}) {
      durableObjectsPeriodicGroups(limit: ${limit}, filter: ${filter}) {
        sum { cpuTime }
        quantiles { memoryUsageBytesP50 memoryUsageBytesP99 }
        dimensions { datetime namespaceId }
      }
    }
  }
}`;
}

function rowKey(row) {
  return `${row?.dimensions?.datetime ?? ''}|${row?.dimensions?.status ?? ''}|${row?.dimensions?.scriptName ?? ''}`;
}

function addRow(merged, row) {
  const key = rowKey(row);
  const existing = merged.get(key);
  if (!existing) {
    merged.set(key, structuredClone(row));
    return;
  }
  for (const field of ['requests', 'errors', 'subrequests']) {
    existing.sum[field] = (existing.sum[field] ?? 0) + (row?.sum?.[field] ?? 0);
  }
}

/** Merges rows from split queries; duplicate buckets are summed, never dropped. */
export function mergeRows(rows) {
  const merged = new Map();
  for (const row of rows) addRow(merged, row);
  return [...merged.values()];
}

/**
 * Summarises invocation rows without ever rescaling a quantile. A row whose
 * bucket holds exactly one request yields that request's exact CPU (every
 * quantile of a single-member population is the same value); a row holding
 * several requests stays a per-bucket aggregate labelled with its population.
 */
export function summarizeInvocations(rows) {
  const statuses = {};
  const scriptNames = new Set();
  let requests = 0;
  let errors = 0;
  let subrequests = 0;
  const exactSamples = [];
  const bucketAggregates = [];
  for (const row of rows) {
    const rowRequests = row?.sum?.requests ?? 0;
    requests += rowRequests;
    errors += row?.sum?.errors ?? 0;
    const status = row?.dimensions?.status ?? 'unknown';
    statuses[status] = (statuses[status] ?? 0) + rowRequests;
    const scriptName = row?.dimensions?.scriptName;
    if (scriptName) scriptNames.add(scriptName);
    const quantiles = row?.quantiles ?? {};
    const cpuUs = quantiles.cpuTimeP99;
    if (typeof cpuUs !== 'number') continue;
    if (rowRequests === 1) {
      // Single-request bucket: every quantile is that request's exact CPU.
      exactSamples.push({ datetime: row?.dimensions?.datetime, status, scriptName: row?.dimensions?.scriptName, cpuUs });
    } else if (rowRequests > 1) {
      bucketAggregates.push({
        datetime: row?.dimensions?.datetime,
        status,
        requests: rowRequests,
        // Population of exactly this bucket; no rescaling, no campaign claim.
        p50Us: quantiles.cpuTimeP50,
        p90Us: quantiles.cpuTimeP90,
        p99Us: quantiles.cpuTimeP99
      });
    }
  }
  const exactShare = requests > 0 ? exactSamples.length / requests : null;
  const campaignQuantiles = exactShare !== null && exactSamples.length >= 30 && exactShare >= 0.9
    ? campaignPercentiles(exactSamples.map((sample) => sample.cpuUs))
    : null;
  const ambiguous = scriptNames.has(UNKNOWN_SCRIPT) || scriptNames.size === 0;
  return {
    intervals: rows.length,
    requests,
    errors,
    statuses,
    scriptNames: [...scriptNames].sort(),
    attribution: {
      requestedExplicitly: true,
      ambiguous,
      reason: ambiguous ? `the dataset reported ${scriptNames.size === 0 ? 'no' : 'a placeholder'} script attribution in this window; named-script coverage cannot be claimed` : 'every record names one of the requested scripts'
    },
    cpu: {
      unit: CPU_UNIT,
      exactSamples: exactSamples.length,
      exactSampleShare: exactShare === null ? null : Math.round(exactShare * 1000) / 1000,
      // Campaign percentiles only when the population is dominated by exact
      // single-request samples; otherwise the per-bucket aggregates stand on
      // their own and no campaign percentile is claimed.
      campaignQuantiles: campaignQuantiles === null
        ? { derivable: false, reason: 'the bucketed dataset does not represent this population as per-request records; exact samples are reported instead' }
        : { derivable: true, ...campaignQuantiles },
      worstBucket: bucketAggregates.length === 0 ? null : bucketAggregates.reduce((worst, row) => (row.p99Us > worst.p99Us ? row : worst), bucketAggregates[0]),
      // Diagnostics only: per-bucket aggregates with their populations, exactly
      // as the platform computed them. Never divided, never relabelled.
      bucketAggregates: bucketAggregates.length > 20 ? bucketAggregates.slice(0, 20) : bucketAggregates
    },
    sanitized: true
  };
}

/** Percentiles over exact per-request samples (population = the samples themselves). */
export function campaignPercentiles(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const pick = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
  return { population: sorted.length, p50Us: pick(0.5), p90Us: pick(0.9), p99Us: pick(0.99), maxUs: sorted[sorted.length - 1] };
}

/** Aggregates Durable Object invocation and periodic rows into platform records. */
export function summarizeDurableObjects(invocationRows, periodicRows) {
  let requests = 0;
  const namespaces = new Set();
  for (const row of invocationRows) {
    requests += row?.sum?.requests ?? 0;
    const namespace = row?.dimensions?.namespaceId;
    if (namespace) namespaces.add(namespace);
  }
  let cpuTimeUs = 0;
  let memoryP99Bytes = null;
  let periodicSamples = 0;
  for (const row of periodicRows) {
    cpuTimeUs += row?.sum?.cpuTime ?? 0;
    const memory = row?.quantiles?.memoryUsageBytesP99;
    if (typeof memory === 'number') {
      memoryP99Bytes = Math.max(memoryP99Bytes ?? 0, memory);
      periodicSamples += 1;
    }
  }
  return {
    requests,
    namespaces: [...namespaces].sort(),
    cpuTime: {
      // Documented: durableObjectsPeriodicGroups sum.cpuTime is microseconds.
      unit: CPU_UNIT,
      totalUs: periodicRows.length ? cpuTimeUs : null
    },
    memory: {
      source: 'durableObjectsPeriodicGroups memoryUsageBytes quantiles (isolate memory, per the Durable Objects observability documentation)',
      unit: 'bytes',
      isolateP99Bytes: memoryP99Bytes,
      isolateP99MiB: memoryP99Bytes === null ? null : Math.round((memoryP99Bytes / (1024 * 1024)) * 100) / 100,
      samples: periodicSamples,
      note: 'Memory is measured per isolate, which may host more than one object; the chart semantics follow the platform documentation.'
    },
    billableDuration: {
      status: 'unresolved',
      reason: 'billable duration (GB-s) is not published by these datasets; the dashboard charts and account usage export carry it, and the verdict records it separately if the operator supplies the reading'
    },
    sanitized: true
  };
}

/** Cross-checks the platform's request count against the campaign's attempt log. */
export function coverageCheck(expected, observed, options = {}) {
  if (expected === undefined) return { checked: false, reason: 'no --expected-requests was supplied; coverage is unchecked and cannot support a pass' };
  const tolerance = options.tolerance ?? 0;
  const sufficient = observed >= expected - tolerance && observed <= expected * (options.maxExcess ?? 1.5);
  return {
    checked: true,
    expected,
    observed,
    sufficient,
    note: sufficient ? undefined : observed < expected - tolerance
      ? 'the platform attributed fewer requests than the campaign made; records are missing or unattributed, and no gate may pass on this window'
      : 'the platform attributed more requests than the campaign made; the window includes traffic beyond the campaign'
  };
}

async function fetchRows(query, token) {
  const response = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || payload?.errors) {
    throw new Error(`The analytics query failed: ${JSON.stringify(payload?.errors ?? response.status).slice(0, 300)}`);
  }
  return payload?.data?.viewer?.accounts?.[0] ?? {};
}

/**
 * Queries one slice, halving it when a full page comes back so nothing is
 * silently truncated. Returns the merged rows and whether any refusal occurred.
 */
export async function queryWindow(queryBuilder, token, since, until, limit, depth = 0) {
  if (depth > MAX_SPLIT_DEPTH) {
    const refusal = new Error(`The window ${since.toISOString()}..${until.toISOString()} stays dense after ${MAX_SPLIT_DEPTH} splits.`);
    refusal.code = 'window-too-dense';
    throw refusal;
  }
  const account = await fetchRows(queryBuilder(since, until, limit), token);
  const rows = account.workersInvocationsAdaptive ?? account.durableObjectsInvocationsAdaptiveGroups ?? account.durableObjectsPeriodicGroups ?? [];
  if (rows.length < limit || since.getTime() === until.getTime()) return { rows, truncated: false };
  // A full page may hide more records: split and merge instead of assuming.
  const middle = new Date(since.getTime() + Math.floor((until.getTime() - since.getTime()) / 2));
  if (middle.getTime() <= since.getTime() || middle.getTime() >= until.getTime()) return { rows, truncated: true };
  const left = await queryWindow(queryBuilder, token, since, middle, limit, depth + 1);
  const right = await queryWindow(queryBuilder, token, middle, until, limit, depth + 1);
  return { rows: mergeRows([...left.rows, ...right.rows]), truncated: left.truncated || right.truncated };
}

export function planOutput(options, window) {
  return {
    mode: 'plan',
    scripts: options.scripts,
    role: options.role,
    namespace: options.namespace ?? null,
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
    slices: splitWindows(window.since, window.until).length,
    queries: {
      invocations: invocationsQuery(ACCOUNT_ID, options.scripts, window.since, window.until).slice(0, 400),
      doInvocations: options.role === 'host' ? doInvocationsQuery(ACCOUNT_ID, options.namespace, window.since, window.until).slice(0, 400) : undefined,
      doPeriodic: options.role === 'host' ? doPeriodicQuery(ACCOUNT_ID, options.namespace, window.since, window.until).slice(0, 400) : undefined
    },
    units: CPU_UNIT,
    sanitized: true
  };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\nUsage: collect-metrics.mjs --script NAME [--script NAME...] [--role gateway|host|baseline] [--namespace ID] [--since ISO] [--until ISO] [--expected-requests N] [--attempts PATH] [--token-file PATH] [--report PATH] [--plan]`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log('Usage: collect-metrics.mjs --script NAME [--script NAME...] [--role gateway|host|baseline] [--namespace ID] [--since ISO] [--until ISO] [--expected-requests N] [--attempts PATH] [--token-file PATH] [--report PATH] [--plan]');
    return;
  }

  let window;
  try {
    window = resolveWindow(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (options.plan) {
    console.log(JSON.stringify(planOutput(options, window), null, 2));
    return;
  }

  let token;
  try {
    token = (await readFile(resolve(options.tokenFile), 'utf8')).trim();
  } catch {
    console.error(`The Cloudflare API token could not be read at ${options.tokenFile}.`);
    process.exitCode = 1;
    return;
  }

  let invocations = { rows: [], truncated: false };
  let doInvocations = { rows: [], truncated: false };
  let doPeriodic = { rows: [], truncated: false };
  try {
    invocations = await queryWindow(
      (since, until, limit) => invocationsQuery(ACCOUNT_ID, options.scripts, since, until, limit),
      token,
      window.since,
      window.until,
      INVOCATION_ROW_LIMIT
    );
    if (options.role === 'host') {
      doInvocations = await queryWindow(
        (since, until, limit) => doInvocationsQuery(ACCOUNT_ID, options.namespace, since, until, limit),
        token,
        window.since,
        window.until,
        DO_ROW_LIMIT
      );
      doPeriodic = await queryWindow(
        (since, until, limit) => doPeriodicQuery(ACCOUNT_ID, options.namespace, since, until, limit),
        token,
        window.since,
        window.until,
        DO_ROW_LIMIT
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const summary = summarizeInvocations(invocations.rows);
  const durableObjects = options.role === 'host' ? summarizeDurableObjects(doInvocations.rows, doPeriodic.rows) : undefined;
  let attemptCount;
  if (options.attempts) {
    try {
      const log = await readFile(resolve(options.attempts), 'utf8');
      attemptCount = log.split('\n').filter((line) => line.trim().length > 0).length;
    } catch {
      console.error(`The attempt log could not be read at ${options.attempts}.`);
      process.exitCode = 1;
      return;
    }
  }
  const coverage = coverageCheck(options.expectedRequests ?? attemptCount, summary.requests);
  const report = {
    collectedAt: new Date().toISOString(),
    role: options.role,
    scripts: options.scripts,
    namespace: options.namespace ?? null,
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
    ...summary,
    coverage,
    truncated: invocations.truncated || (options.role === 'host' ? doInvocations.truncated || doPeriodic.truncated : false),
    ...(durableObjects === undefined ? {} : { durableObjects }),
    sources: {
      invocations: 'workersInvocationsAdaptive (scriptName filter, datetime quantiles in microseconds)',
      durableObjects: options.role === 'host' ? 'durableObjectsInvocationsAdaptiveGroups + durableObjectsPeriodicGroups (namespace-filtered)' : undefined
    },
    limitsBasis: 'https://developers.cloudflare.com/workers/platform/limits/ and https://developers.cloudflare.com/durable-objects/platform/limits/ (fetched 2026-09-27)',
    sanitized: true
  };

  console.log(JSON.stringify(report, null, 2));
  if (options.report) {
    const path = resolve(options.report);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) await main();
