#!/usr/bin/env node
// Hosts the browser probe on the allowlisted localhost origin and captures what
// the measurement needs from it.
//
// A real Google ID token can only come from an interactive sign-in, so the page
// does that part. The credential it receives is written to the ignored staging
// directory for the paced harness to reuse while it is still valid, and the
// probe's report is written there too. The server binds to loopback only, serves
// one directory, and refuses any write outside staging-local/.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '..', '..');
const STAGING_DIRECTORY = resolve(REPOSITORY_ROOT, 'staging-local');
const DEFAULT_PORT = 8788;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

function safeLabel(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,40}$/.test(value)) return undefined;
  return value;
}

async function readJsonBody(request, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(text);
}

/**
 * Creates the probe host. `port` is fixed at 8788 because that origin is what the
 * staging Worker allowlists; changing it would require a redeploy.
 */
export function createProbeServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const stagingDirectory = options.stagingDirectory ?? STAGING_DIRECTORY;

  const writeIntoStaging = async (name, contents) => {
    if (!/^[a-z0-9.-]+$/i.test(name)) throw new Error('unsafe file name');
    const target = resolve(join(stagingDirectory, name));
    if (!target.startsWith(`${stagingDirectory}/`)) throw new Error('refusing to write outside staging-local');
    await mkdir(stagingDirectory, { recursive: true });
    await writeFile(target, contents, 'utf8');
    return target;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);

    if (request.method === 'POST' && url.pathname === '/__credential') {
      try {
        const body = await readJsonBody(request);
        const label = safeLabel(body?.label);
        if (!label || typeof body?.credential !== 'string' || body.credential.length < 20) {
          json(response, 400, { ok: false, error: 'a label and a credential are required' });
          return;
        }
        // The credential is written, never logged and never returned.
        const path = await writeIntoStaging(`credential-${label}.txt`, body.credential);
        console.log(`captured a credential for ${label}`);
        json(response, 200, { ok: true, path });
      } catch (error) {
        json(response, 400, { ok: false, error: error instanceof Error ? error.message : 'bad request' });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/__report') {
      try {
        const body = await readJsonBody(request);
        const label = safeLabel(body?.label);
        if (!label || typeof body?.report !== 'object' || body.report === null) {
          json(response, 400, { ok: false, error: 'a label and a report are required' });
          return;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const path = await writeIntoStaging(`browser-probe-${label}-${stamp}.json`, `${JSON.stringify(body.report, null, 2)}\n`);
        console.log(`captured a probe report for ${label}`);
        json(response, 200, { ok: true, path });
      } catch (error) {
        json(response, 400, { ok: false, error: error instanceof Error ? error.message : 'bad request' });
      }
      return;
    }

    if (request.method !== 'GET') {
      json(response, 405, { ok: false, error: 'use GET' });
      return;
    }

    const requested = url.pathname === '/' ? '/browser-probe.html' : url.pathname;
    const target = resolve(join(HERE, normalize(requested).replace(/^(\.\.[/\\])+/, '')));
    if (!target.startsWith(`${HERE}/`)) {
      json(response, 403, { ok: false, error: 'outside the probe directory' });
      return;
    }
    try {
      const contents = await readFile(target);
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      response.end(contents);
    } catch {
      json(response, 404, { ok: false, error: 'not found' });
    }
  });

  return { server, port, stagingDirectory };
}

async function main() {
  const { server, port } = createProbeServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  console.log(`Probe host listening on http://localhost:${port}/ (loopback only; writes go to staging-local/)`);
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) await main();
