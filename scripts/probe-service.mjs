#!/usr/bin/env node
// Probes an Apps Script web app deployment the way the browser client calls it:
// a cookieless POST carrying the ID token in the body. The scheduler answers with
// its own JSON envelope; a 302 to ServiceLogin or a 401 HTML page means Google's
// deployment gate rejected the request before Apps Script ran, which no amount of
// correct application code can fix.
//
// Usage: node scripts/probe-service.mjs --url https://script.google.com/macros/s/<id>/exec
//        node scripts/probe-service.mjs --config production.local.json
import { ConfigError, readJsonFile } from './lib/config.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--url', '--config'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    result[arg.slice(2)] = value;
    index += 1;
  }
  if (!result.url && !result.config) throw new Error('--url or --config is required');
  return result;
}

const args = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error('Usage: node scripts/probe-service.mjs --url <apps script /exec url> [--config <private config>]');
    console.error(error.message);
    process.exit(2);
  }
})();

let url = args.url;
if (!url && args.config) {
  const config = await readJsonFile(args.config).catch((error) => {
    throw error instanceof ConfigError ? error : new Error(`could not read ${args.config}`);
  });
  url = typeof config.appsScriptUrl === 'string' ? config.appsScriptUrl : undefined;
  if (!url) {
    console.error(`${args.config} has no appsScriptUrl`);
    process.exit(2);
  }
}

const body = JSON.stringify({ operation: 'session.me', payload: {}, idempotencyKey: 'deployment-probe-0001', credential: 'probe-not-a-real-credential' });
let response;
try {
  response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'text/plain;charset=utf-8', Accept: 'application/json' },
    body
  });
} catch (error) {
  console.log(`unreachable: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
if (response) {
  const location = response.headers.get('location') ?? '';
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (response.status >= 300 && response.status < 400) {
    console.log(`NOT PUBLIC: the deployment redirected to ${location.includes('ServiceLogin') ? 'the Google sign-in page' : location}`);
    console.log('Set the versioned web app deployment to "Who has access: Anyone" and use that deployment URL, not the @HEAD URL.');
    process.exitCode = 1;
  } else if (response.status === 401 || response.status === 403) {
    console.log(`NOT PUBLIC: Google rejected the request with ${response.status} ${contentType || 'text/html'} before Apps Script ran.`);
    console.log('Set the versioned web app deployment to "Who has access: Anyone" and use that deployment URL, not the @HEAD URL.');
    process.exitCode = 1;
  } else if (/^\s*<!DOCTYPE html/i.test(text) || text.includes('ServiceLogin') || text.includes("window['ppConfig']")) {
    // "Anyone with Google account" also lands here: the platform still demands a
    // session, so it renders the sign-in page inline instead of running the app.
    console.log(`NOT PUBLIC: Google served its sign-in page (${response.status} ${contentType}) instead of the scheduler's JSON.`);
    console.log('"Anyone with Google account" is not sufficient: the deployment must be set to "Who has access: Anyone".');
    process.exitCode = 1;
  } else {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log(`REACHABLE but not the scheduler: ${response.status} ${contentType || 'unknown content type'} (${text.slice(0, 120)})`);
      process.exitCode = 1;
    }
    if (parsed) {
      const code = parsed?.error?.code ?? (parsed.ok === true ? 'ok' : 'unknown');
      console.log(`reachable: ${response.status} ${contentType}, envelope code=${code}`);
      console.log(code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'ok'
        ? 'The deployment is public and the scheduler answered, so browser sign-in can reach it.'
        : `Unexpected envelope: ${text.slice(0, 200)}`);
      process.exitCode = code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'ok' ? 0 : 1;
    }
  }
}
