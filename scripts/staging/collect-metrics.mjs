#!/usr/bin/env node
// Collects the platform's own runtime metrics for the staging Worker.
//
// The contract's CPU threshold is a published quantile, so the evidence comes from
// Cloudflare's analytics rather than from anything the Worker can report about
// itself. This queries the Workers invocation dataset for a bounded window and
// prints the sums and quantiles the verdict needs, plus the invocation statuses
// that say whether anything exceeded the runtime limits.
import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ACCOUNT_ID = '868086b4b2dc75413ea149480ae4fe82';
const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
/** Cloudflare rejects a window wider than four weeks. */
const MAX_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;

export function parseArguments(argv) {
  const options = { tokenFile: 'staging-local/cloudflare-api-token.txt', script: 'volunteer-scheduling-staging', since: undefined, until: undefined, report: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${argument} needs a value.`);
      return argv[index];
    };
    if (argument === '--token-file') options.tokenFile = next();
    else if (argument === '--script') options.script = next();
    else if (argument === '--since') options.since = next();
    else if (argument === '--until') options.until = next();
    else if (argument === '--report') options.report = next();
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
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

/**
 * Cloudflare reports `scriptName` as `__unknown__` for this deployment, so the
 * filter is by account and window only and the observed script names are reported
 * instead of assumed. The account holds exactly this one Worker.
 */
export function buildQuery(accountId, _script, since, until) {
  const filter = `{datetime_geq: "${since.toISOString()}", datetime_leq: "${until.toISOString()}"}`;
  return `query {
  viewer {
    accounts(filter: {accountTag: "${accountId}"}) {
      workersInvocationsAdaptive(limit: 100, filter: ${filter}) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP90 cpuTimeP99 }
        dimensions { datetime status scriptName }
      }
    }
  }
}`;
}

function summarize(rows) {
  const statuses = {};
  const scriptNames = new Set();
  let requests = 0;
  let errors = 0;
  let subrequests = 0;
  let cpuP50 = null;
  let cpuP90 = null;
  let cpuP99 = null;
  for (const row of rows) {
    requests += row?.sum?.requests ?? 0;
    errors += row?.sum?.errors ?? 0;
    subrequests += row?.sum?.subrequests ?? 0;
    const status = row?.dimensions?.status ?? 'unknown';
    statuses[status] = (statuses[status] ?? 0) + (row?.sum?.requests ?? 0);
    if (row?.dimensions?.scriptName) scriptNames.add(row.dimensions.scriptName);
    // The worst interval is what a threshold has to survive.
    cpuP50 = Math.max(cpuP50 ?? 0, row?.quantiles?.cpuTimeP50 ?? 0);
    cpuP90 = Math.max(cpuP90 ?? 0, row?.quantiles?.cpuTimeP90 ?? 0);
    cpuP99 = Math.max(cpuP99 ?? 0, row?.quantiles?.cpuTimeP99 ?? 0);
  }
  return {
    intervals: rows.length,
    requests,
    errors,
    subrequests,
    statuses,
    scriptNames: [...scriptNames].sort(),
    // The dataset exposes CPU only as these quantiles, and their unit is
    // microseconds: the values observed here (p50 1154, p99 5492) interpreted as
    // milliseconds would be 1.2 s and 5.5 s of CPU on a plan whose limit is 10 ms,
    // which every invocation in the same window reports as `success` rather than
    // `exceededResources`. Both readings are reported so a reviewer can check.
    worstIntervalCpu: {
      reportedUnit: 'microseconds',
      unitBasis: 'a millisecond reading would exceed the 10 ms free-plan limit on an invocation reported as success',
      p50Us: rows.length ? cpuP50 : null,
      p90Us: rows.length ? cpuP90 : null,
      p99Us: rows.length ? cpuP99 : null,
      p50Ms: rows.length ? cpuP50 / 1000 : null,
      p90Ms: rows.length ? cpuP90 / 1000 : null,
      p99Ms: rows.length ? cpuP99 / 1000 : null
    }
  };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\nUsage: collect-metrics.mjs [--since ISO] [--until ISO] [--script NAME] [--token-file PATH] [--report PATH]`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log('Usage: collect-metrics.mjs [--since ISO] [--until ISO] [--script NAME] [--token-file PATH] [--report PATH]');
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

  let token;
  try {
    token = (await readFile(resolve(options.tokenFile), 'utf8')).trim();
  } catch {
    console.error(`The Cloudflare API token could not be read at ${options.tokenFile}.`);
    process.exitCode = 1;
    return;
  }

  const response = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: buildQuery(ACCOUNT_ID, options.script, window.since, window.until) })
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || payload?.errors) {
    console.error(`The analytics query failed: ${JSON.stringify(payload?.errors ?? response.status).slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }

  const rows = payload?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  const report = {
    collectedAt: new Date().toISOString(),
    accountId: ACCOUNT_ID,
    script: options.script,
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
    ...summarize(rows),
    // The platform's own record, not a Worker self-report. The dataset reports a
    // placeholder script name for this deployment, so the account filter is what
    // scopes it; the account holds one Worker.
    source: 'workersInvocationsAdaptive',
    requestsAreAccountScoped: true,
    memory: 'not published by this dataset; read the Memory usage percentile chart in the dashboard',
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
