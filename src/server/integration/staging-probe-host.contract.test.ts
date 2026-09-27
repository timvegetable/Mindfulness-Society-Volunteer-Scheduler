import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProbeServer } from '../../../scripts/staging/serve-probe.mjs';

/**
 * The probe host exists so a browser can hand a real Google credential to the
 * measurement harness. It must serve one directory, write only inside the ignored
 * staging directory, and refuse anything else.
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
});
