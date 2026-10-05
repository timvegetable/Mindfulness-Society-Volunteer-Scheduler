import { describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { Bindings } from '../../src/worker/runtime/live';

const env = {
  OAUTH_CLIENT_ID: 'public-client', TIME_ZONE: 'America/New_York', EMAIL_API_KEY: 'never-expose',
  ASSETS: { fetch: async () => new Response('static asset') },
} as unknown as Bindings;

describe('Worker HTTP boundary', () => {
  it('exposes only the public client configuration', async () => {
    const response = await worker.fetch(new Request('http://local/client-config'), env);
    expect(await response.json()).toEqual({ oauthClientId: 'public-client', timeZone: 'America/New_York' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('serves the client through the static assets binding', async () => {
    expect(await (await worker.fetch(new Request('http://local/schedule'), env)).text()).toBe('static asset');
  });
  it('rejects GET on the mutation-capable endpoint', async () => {
    const response = await worker.fetch(new Request('http://local/api'), env);
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });
  it('rejects wrong content type, malformed and oversized JSON before authentication', async () => {
    for (const [body, type, status] of [['{}', 'text/plain', 415], ['{', 'application/json', 400], [JSON.stringify('x'.repeat(65536)), 'application/json', 400]] as const) {
      const response = await worker.fetch(new Request('http://local/api', { method: 'POST', headers: { 'Content-Type': type }, body }), env);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    }
  });
});
