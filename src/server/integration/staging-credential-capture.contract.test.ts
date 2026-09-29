import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPrivatePath, inspectIdToken, signInPage, startCredentialCapture } from '../../../scripts/staging/capture-credential.mjs';

/**
 * The capture helper is a local tool with one job: take a token the operator's
 * browser produced, refuse anything that is not a token for the expected
 * audience, and write it to ignored private storage without ever echoing it.
 * These tests use synthetic unsigned tokens and a temporary private directory.
 */
const AUDIENCE = 'staging-client.apps.googleusercontent.com';
const NOW = Date.UTC(2026, 8, 29, 21, 0, 0);

function tokenFor(claims: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'RS256', kid: 'test' })}.${segment(claims)}.signature`;
}

const validClaims = { aud: AUDIENCE, exp: Math.floor(NOW / 1000) + 3600, email: 'operator@example.test', email_verified: true };

const created: string[] = [];
afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function workdir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'credential-capture-'));
  created.push(directory);
  return directory;
}

describe('credential capture', () => {
  it('accepts a token for the expected audience and reports only its summary', () => {
    const summary = inspectIdToken(tokenFor(validClaims), AUDIENCE, NOW);

    expect(summary).toEqual({
      audience: AUDIENCE,
      expiresAt: '2026-09-29T22:00:00.000Z',
      minutesRemaining: 60,
      hasEmail: true,
      emailVerified: true
    });
    // The summary is safe to print: it carries no token material.
    expect(JSON.stringify(summary)).not.toContain('signature');
  });

  it.each([
    ['an empty body', ''],
    ['a token that is not three parts', 'not-a-token'],
    ['a token for another audience', tokenFor({ ...validClaims, aud: 'someone-else.apps.googleusercontent.com' })],
    ['an expired token', tokenFor({ ...validClaims, exp: Math.floor(NOW / 1000) - 10 })],
    ['a token with no expiry', tokenFor({ aud: AUDIENCE })],
    ['a payload that is not JSON', 'aaa.bbb.ccc']
  ])('refuses %s', (_label, token) => {
    expect(() => inspectIdToken(token, AUDIENCE, NOW)).toThrowError(/./u);
  });

  it('refuses a destination outside ignored private storage', () => {
    for (const path of ['../outside.txt', 'src/server/credential.txt', '/tmp/credential.txt']) {
      expect(() => assertPrivatePath(path)).toThrowError(/staging-local/u);
    }
    expect(assertPrivatePath('staging-local/credential-rehearsal.txt')).toContain('staging-local/credential-rehearsal.txt');
  });

  it('serves a page with the audience and nothing secret', () => {
    const page = signInPage(AUDIENCE, 'http://localhost:8788');

    expect(page).toContain(AUDIENCE);
    expect(page).toContain('accounts.google.com/gsi/client');
    expect(page).toContain("fetch('/credential'");
    // Nothing that looks like a captured token can be baked into the page.
    expect(page).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/u);
  });

  it('writes a captured token to a private file and never returns it', async () => {
    const directory = await workdir();
    const previous = process.cwd();
    process.chdir(directory);
    try {
      const token = tokenFor(validClaims);
      const captured: unknown[] = [];
      const capture = await startCredentialCapture({ audience: AUDIENCE, out: 'staging-local/credential.txt', port: 0, nowMs: () => NOW, onCaptured: (summary) => captured.push(summary) });

      const page = await fetch(`${capture.origin}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(AUDIENCE);

      const response = await fetch(`${capture.origin}/credential`, { method: 'POST', body: token });
      const body = await response.json() as { message?: string };
      expect(response.status).toBe(200);
      // The response must not echo the token.
      expect(JSON.stringify(body)).not.toContain('signature');

      const written = await readFile(join(directory, 'staging-local/credential.txt'), 'utf8');
      expect(written.trim()).toBe(token);
      expect((await stat(join(directory, 'staging-local/credential.txt'))).mode & 0o777).toBe(0o600);
      expect(captured).toHaveLength(1);

      const refused = await fetch(`${capture.origin}/credential`, { method: 'POST', body: 'not-a-token' });
      expect(refused.status).toBe(400);
      // A refused token must not overwrite the captured one.
      expect((await readFile(join(directory, 'staging-local/credential.txt'), 'utf8')).trim()).toBe(token);

      await capture.close();
    } finally {
      process.chdir(previous);
    }
  });
});
