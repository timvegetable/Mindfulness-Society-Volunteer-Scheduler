import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { INTEGRATION_OPERATIONS } from '../server/integration/request-policy.js';
import worker from './entry.js';

/**
 * End-to-end tests through the real Worker entry point, running in workerd.
 * They cover the deployed request path — transport, allowlist and the
 * fail-closed staging composition — without Cloudflare or Google credentials.
 */

const ENDPOINT = 'https://staging.example.test/exec';
// From wrangler.jsonc's top-level vars, i.e. the local/test environment.
const ALLOWED_ORIGIN = 'http://localhost:8788';

function post(body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8', ...headers },
    body: JSON.stringify(body)
  });
}

describe('staging Worker entry point', () => {
  it('serves the allowlisted read path over the real fetch handler and fails closed until identity exists', async () => {
    const response = await post({ operation: INTEGRATION_OPERATIONS.me, payload: {}, idempotencyKey: 'entry-probe-1' }, { Origin: ALLOWED_ORIGIN });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });

  it('refuses a mutation at the endpoint before any handler can run', async () => {
    for (const operation of [INTEGRATION_OPERATIONS.adminScheduleRerun, INTEGRATION_OPERATIONS.recurringAvailabilityUpdate, INTEGRATION_OPERATIONS.adminInsightsRefresh]) {
      const response = await post({ operation, payload: {}, idempotencyKey: 'entry-probe-mutation' }, { Origin: ALLOWED_ORIGIN });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
  });

  it('refuses an unlisted origin and an unknown route', async () => {
    const origin = await post({ operation: INTEGRATION_OPERATIONS.me, payload: {}, idempotencyKey: 'entry-probe-2' }, { Origin: 'https://evil.example.test' });
    expect(origin.status).toBe(403);
    const route = await SELF.fetch('https://staging.example.test/nope', { method: 'POST', body: '{}' });
    expect(route.status).toBe(404);
  });

  it('refuses a GET and an oversized body', async () => {
    const get = await SELF.fetch(ENDPOINT, { method: 'GET' });
    expect(get.status).toBe(405);
    const oversized = await post({ operation: INTEGRATION_OPERATIONS.me, payload: { filler: 'x'.repeat(70 * 1024) }, idempotencyKey: 'entry-probe-3' }, { Origin: ALLOWED_ORIGIN });
    expect(oversized.status).toBe(413);
  });

  it('fails closed with a bounded envelope when the allowlist binding is invalid', async () => {
    const request = new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ operation: INTEGRATION_OPERATIONS.me, payload: {}, idempotencyKey: 'entry-probe-4' })
    });
    for (const bindings of [{ STAGING_ALLOWED_ORIGINS: '*' }, { STAGING_ALLOWED_ORIGINS: 'https://a.example.test/path' }]) {
      const response = await worker.fetch(request.clone(), bindings);
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json() as { ok: boolean; error: { code: string; message: string } };
      expect(body).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
      // The binding name and the offending value must not reach the caller.
      expect(JSON.stringify(body)).not.toContain('STAGING_ALLOWED_ORIGINS');
      expect(JSON.stringify(body)).not.toContain('a.example.test');
    }
  });
});

describe('staging response headers', () => {
  it('publishes the request read count and snapshot digest for measurement', async () => {
    // The staging vars in wrangler.jsonc are placeholders, so this request is
    // refused before any read; the counters still describe this request only.
    const response = await post({ operation: INTEGRATION_OPERATIONS.me, payload: {}, idempotencyKey: 'entry-probe-headers' }, { Origin: ALLOWED_ORIGIN });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-staging-sheets-reads')).toBe('0');
    expect(response.headers.get('x-staging-snapshot-digest')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
