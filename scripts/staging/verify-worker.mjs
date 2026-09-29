#!/usr/bin/env node
// Verifies the deployed staging endpoint's refusal paths.
//
// These checks need no Google credential, so they can run immediately after a
// deploy: the endpoint must refuse an unauthenticated caller, an unlisted origin,
// a mutation, an unknown operation, the wrong method, path, content type and an
// oversized body — and it must do so with the application envelope, no redirect
// and no-store. A real browser supplies the CORS-readable evidence separately;
// this script reports what a non-browser client can prove.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SERVED = 'session.me';
const MUTATION = 'admin.schedule.rerun';

export function parseArguments(argv) {
  const options = { url: undefined, origin: 'http://localhost:8788', report: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${argument} needs a value.`);
      return argv[index];
    };
    if (argument === '--url') options.url = next();
    else if (argument === '--origin') options.origin = next();
    else if (argument === '--report') options.report = next();
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function envelope(body) {
  return { operation: body.operation, payload: {}, idempotencyKey: `verify-${body.operation}-${Date.now()}` };
}

export async function checkEndpoint({ execUrl, origin }) {
  const otherOrigin = 'https://not-allowlisted.example.test';
  const cases = [];
  const record = async (name, expectation, run) => {
    const started = Date.now();
    let requestedUrl = execUrl;
    try {
      const { status, headers, body, redirected, url, requested } = await run();
      requestedUrl = requested ?? execUrl;
      cases.push({
        name,
        expectation,
        status,
        code: body?.error?.code ?? (body?.ok === true ? 'ok' : undefined),
        contentType: headers.get('content-type'),
        cacheControl: headers.get('cache-control'),
        allowOrigin: headers.get('access-control-allow-origin'),
        redirected,
        // No redirect: the response URL is the URL that was requested.
        sameUrl: url === requestedUrl,
        durationMs: Date.now() - started
      });
    } catch (error) {
      cases.push({ name, expectation, status: 0, failure: error instanceof Error ? error.name : 'error' });
    }
  };

  const post = async (payload, extraHeaders = {}, target = execUrl) => {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8', ...extraHeaders },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => undefined), redirected: response.redirected, url: response.url, requested: target };
  };

  await record('unauthenticated served read', 'UNAUTHORIZED', () => post(envelope({ operation: SERVED })));
  await record('unlisted origin', 'FORBIDDEN https 403', () => post(envelope({ operation: SERVED }), { Origin: otherOrigin }));
  await record('allowlisted origin', 'UNAUTHORIZED with CORS header', () => post(envelope({ operation: SERVED }), { Origin: origin }));
  await record('mutation', 'FORBIDDEN', () => post(envelope({ operation: MUTATION })));
  // The transport allowlist answers first, so an operation this endpoint does not
  // serve is refused before any envelope or payload rule is consulted.
  await record('unregistered operation', 'FORBIDDEN', () => post(envelope({ operation: 'admin.not.a.real.operation' })));
  await record('registered but unserved operation', 'FORBIDDEN', () => post(envelope({ operation: 'volunteer.dashboard' })));
  await record('malformed envelope on a served read', 'INVALID_REQUEST', () => post({ operation: SERVED, payload: {}, idempotencyKey: 'short' }));
  await record('wrong method', '405', async () => {
    const response = await fetch(execUrl, { method: 'GET' });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => undefined), redirected: response.redirected, url: response.url };
  });
  await record('wrong content type', '415', async () => {
    const response = await fetch(execUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => undefined), redirected: response.redirected, url: response.url };
  });
  await record('oversized body', '413', () => post({ operation: SERVED, payload: { filler: 'x'.repeat(70 * 1024) }, idempotencyKey: `verify-oversized-${Date.now()}` }));
  await record('unknown route', '404', async () => {
    const target = new URL('/not-the-exec-path', execUrl).toString();
    const response = await fetch(target, { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => undefined), redirected: response.redirected, url: response.url, requested: target };
  });
  // The preview benchmark is disabled unless the host deployment explicitly
  // enables it, and the 404 is answered before any body read or Sheets access.
  await record('benchmark route with benchmark disabled', '404', async () => {
    const target = new URL('/benchmark/schedule-preview', execUrl).toString();
    const response = await fetch(target, { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => undefined), redirected: response.redirected, url: response.url, requested: target };
  });

  return cases;
}

function summarize(cases) {
  const failed = cases.filter((entry) => {
    if (entry.failure) return true;
    switch (entry.expectation) {
      case 'UNAUTHORIZED': return entry.status !== 200 || entry.code !== 'UNAUTHORIZED';
      case 'FORBIDDEN https 403': return entry.status !== 403;
      case 'UNAUTHORIZED with CORS header': return entry.status !== 200 || entry.code !== 'UNAUTHORIZED' || entry.allowOrigin !== undefined && entry.allowOrigin === null;
      case 'FORBIDDEN': return entry.status !== 200 || entry.code !== 'FORBIDDEN';
      case 'INVALID_REQUEST': return entry.status !== 200 || entry.code !== 'INVALID_REQUEST';
      default: return String(entry.status) !== entry.expectation;
    }
  });
  const redirected = cases.filter((entry) => entry.redirected === true || entry.sameUrl === false);
  return { total: cases.length, failed: failed.map((entry) => entry.name), redirected: redirected.map((entry) => entry.name) };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\nUsage: verify-worker.mjs --url https://<worker>.workers.dev/exec [--origin http://localhost:8788] [--report PATH]`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log('Usage: verify-worker.mjs --url https://<worker>.workers.dev/exec [--origin http://localhost:8788] [--report PATH]');
    return;
  }
  if (!options.url?.startsWith('https://')) {
    console.error('--url must be the staging Worker https endpoint.');
    process.exitCode = 1;
    return;
  }
  const hostname = new URL(options.url).hostname;
  if (!(hostname.endsWith('.workers.dev') && hostname.includes('staging'))) {
    console.error(`Refusing ${hostname}: this verifier only runs against a staging-shaped *.workers.dev host.`);
    process.exitCode = 1;
    return;
  }

  const cases = await checkEndpoint({ execUrl: options.url, origin: options.origin });
  const summary = summarize(cases);
  const report = { verifiedAt: new Date().toISOString(), execUrl: options.url, origin: options.origin, summary, cases, sanitized: true };
  console.log(JSON.stringify(report, null, 2));
  if (options.report) {
    const path = resolve(options.report);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (summary.failed.length > 0 || summary.redirected.length > 0) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) await main();
