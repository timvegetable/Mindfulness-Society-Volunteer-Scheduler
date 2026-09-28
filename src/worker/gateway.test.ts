import { beforeAll, describe, expect, it } from 'vitest';
import gateway, { gatewayObjectName, gatewayOrigins, type GatewayBindings } from './gateway.js';
import { INTEGRATION_OPERATIONS, failure } from '../server/integration/request-policy.js';
import { allowedOrigins } from './config.js';
import { READ_API_CONTENT_TYPE, createReadApi } from './read-api.js';
import { StagingWorkbookHost } from './host.js';
import {
  NOW_MS,
  fakeGoogle,
  idToken,
  request,
  setupSigningKeys,
  stagingBindings
} from './staging-test-support.js';

/**
 * Worker-native tests for the staging gateway: forwarding, streamed responses,
 * CORS admission, oversized and chunked bodies, binding failures, and parity of
 * the gateway's local admission rules with the staging configuration's.
 */

const ORIGINS = 'https://scheduling.example.test';

type Seen = { method: string; path: string; body: string | null; correlation: string | null };

function fakeNamespace(handler: (request: Request) => Promise<Response>, recordBody = true) {
  const names: string[] = [];
  const seen: Seen[] = [];
  const namespace = {
    idFromName: (name: string) => {
      names.push(name);
      return { name };
    },
    get: (_id: unknown) => ({
      fetch: async (request: Request): Promise<Response> => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          // Reading the body consumes it, so forwarding handlers record without it.
          body: !recordBody || request.body === null ? null : await request.text(),
          correlation: request.headers.get('x-staging-correlation-id')
        });
        return handler(request);
      }
    })
  };
  return { namespace, names, seen };
}

function gatewayEnv(overrides: Partial<GatewayBindings> = {}): GatewayBindings {
  return {
    STAGING_HOST: undefined,
    STAGING_WORKBOOK_ID: 'staging-workbook-id',
    STAGING_ALLOWED_ORIGINS: ORIGINS,
    ...overrides
  };
}

function post(path: string, body: string, origin?: string): Request {
  const headers = new Headers({ 'Content-Type': `${READ_API_CONTENT_TYPE};charset=utf-8` });
  if (origin !== undefined) headers.set('Origin', origin);
  return new Request(`https://gateway.example.test${path}`, { method: 'POST', headers, body });
}

async function call(request: Request, env: GatewayBindings): Promise<Response> {
  const handler = (gateway as { fetch(request: Request, env: GatewayBindings): Promise<Response> }).fetch;
  return handler(request, env);
}

beforeAll(setupSigningKeys);

describe('staging gateway forwarding', () => {
  it('forwards the request body and streams the object response through unchanged', async () => {
    const { namespace, seen, names } = fakeNamespace(async () => new Response(
      JSON.stringify({ ok: true, data: { served: true } }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Staging-Sheets-Reads': '1', 'Cache-Control': 'no-store' } }
    ));
    const body = JSON.stringify(request(INTEGRATION_OPERATIONS.me, 'credential-placeholder'));
    const response = await call(post('/exec', body, 'https://scheduling.example.test'), { ...gatewayEnv(), STAGING_HOST: namespace });
    expect(response.status).toBe(200);
    // The object's own headers pass through untouched; the gateway adds only its correlation id.
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('x-staging-sheets-reads')).toBe('1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-staging-correlation-id')).toBeTruthy();
    expect(await response.json()).toEqual({ ok: true, data: { served: true } });
    // The request body reached the object byte-for-byte, with the correlation id attached.
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/exec', body, correlation: response.headers.get('x-staging-correlation-id') });
    // Object selection is config-derived: every request maps to the same name.
    expect(names).toEqual(['staging-workbook-id']);
  });

  it('answers OPTIONS preflight without waking the object', async () => {
    const { namespace, names } = fakeNamespace(async () => new Response('should not be reached'));
    const response = await call(
      new Request('https://gateway.example.test/exec', { method: 'OPTIONS', headers: { Origin: ORIGINS, 'Access-Control-Request-Method': 'POST' } }),
      { ...gatewayEnv(), STAGING_HOST: namespace }
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGINS);
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(names).toEqual([]);
  });

  it('refuses a disallowed origin exactly as the staging transport does', async () => {
    // Differential against the existing transport for the same origin list.
    const gatewayResponse = await call(post('/exec', '{}', 'https://evil.example'), gatewayEnv());
    const transportResponse = await createReadApi({ origins: ['https://scheduling.example.test'], dispatch: () => { throw new Error('unreachable'); } }).fetch(
      new Request('https://host.example.test/exec', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })
    );
    expect(gatewayResponse.status).toBe(403);
    expect(gatewayResponse.status).toBe(transportResponse.status);
    expect(await gatewayResponse.text()).toBe(await transportResponse.text());
    expect(gatewayResponse.headers.get('content-type')).toBe(transportResponse.headers.get('content-type'));
    expect(gatewayResponse.headers.get('cache-control')).toBe('no-store');
  });

  it('maps binding failures to the existing bounded error envelope', async () => {
    const failing = { get: () => { throw new Error('binding is not provisioned'); }, idFromName: () => ({}) };
    const cases: GatewayBindings[] = [
      gatewayEnv(),
      gatewayEnv({ STAGING_WORKBOOK_ID: undefined }),
      gatewayEnv({ STAGING_WORKBOOK_ID: '   ' }),
      gatewayEnv({ STAGING_WORKBOOK_ID: 42 }),
      gatewayEnv({ STAGING_WORKBOOK_ID: 'wb', STAGING_HOST: failing })
    ];
    const expected = JSON.stringify(failure('UNAVAILABLE', 'The staging endpoint is not configured.'));
    for (const env of cases) {
      const response = await call(post('/exec', '{}'), env);
      expect(response.status, String(env.STAGING_WORKBOOK_ID)).toBe(503);
      expect(await response.text()).toBe(expected);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('maps an object-side failure to the bounded envelope without leaking it', async () => {
    const { namespace } = fakeNamespace(async () => { throw new Error('Error 1101: object threw'); });
    const response = await call(post('/exec', '{}'), { ...gatewayEnv(), STAGING_HOST: namespace });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain('UNAVAILABLE');
    expect(text).not.toContain('1101');
  });

  it('forwards oversized and streamed bodies without buffering or truncating them', async () => {
    // 64 KiB + 1: the host's bounded transport refuses this, so the gateway
    // must deliver the whole body to the object rather than enforcing the cap.
    const oversized = 'x'.repeat(64 * 1024 + 1);
    const { namespace, seen } = fakeNamespace(async () => new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }));
    await call(post('/exec', oversized), { ...gatewayEnv(), STAGING_HOST: namespace });
    expect(seen[0]?.body).toBe(oversized);

    // A chunked stream is forwarded as a stream, not parsed.
    const encoder = new TextEncoder();
    const chunks = ['{"operation":', '"session.me"', ',"payload":{}}'];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    });
    const { namespace: streamNamespace, seen: streamSeen } = fakeNamespace(async () => new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }));
    const streamed = new Request('https://gateway.example.test/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: stream
    });
    await call(streamed, { ...gatewayEnv(), STAGING_HOST: streamNamespace });
    expect(streamSeen[0]?.body).toBe(chunks.join(''));
  });

  it('keeps admission parity: gateway origin parsing agrees with the staging configuration parser', () => {
    for (const raw of ['', '   ', ORIGINS, `${ORIGINS},https://other.example.test`, `${ORIGINS}, ${ORIGINS}`]) {
      expect(gatewayOrigins(raw), raw).toEqual(allowedOrigins({ STAGING_ALLOWED_ORIGINS: raw }));
    }
    // Both refuse the same malformed configurations.
    expect(() => gatewayOrigins('https://*.example.test')).toThrow();
    expect(() => allowedOrigins({ STAGING_ALLOWED_ORIGINS: 'https://*.example.test' })).toThrow();
    expect(() => gatewayOrigins('https://a.example.test/path')).toThrow();
    expect(() => allowedOrigins({ STAGING_ALLOWED_ORIGINS: 'https://a.example.test/path' })).toThrow();
    expect(() => gatewayOrigins('ftp://a.example.test')).toThrow();
    expect(() => allowedOrigins({ STAGING_ALLOWED_ORIGINS: 'ftp://a.example.test' })).toThrow();
  });

  it('derives the object name from deployment configuration only', () => {
    expect(gatewayObjectName(' wb-id ')).toBe('wb-id');
    expect(() => gatewayObjectName(undefined)).toThrow();
    expect(() => gatewayObjectName(42)).toThrow();
  });
});

describe('staging gateway to Durable Object host, end to end', () => {
  it('serves an authorized read through gateway → object → staging service', async () => {
    const { fetchImpl } = fakeGoogle();
    const host = new StagingWorkbookHost({ id: { toString: () => 'test-object' } } as unknown as DurableObjectState, stagingBindings(), { fetch: fetchImpl, nowMs: () => NOW_MS });
    const { namespace } = fakeNamespace((forwarded) => host.fetch(forwarded), false);
    const credential = await idToken('admin@example.test');
    const response = await call(post('/exec', JSON.stringify(request(INTEGRATION_OPERATIONS.me, credential)), 'https://scheduling.example.test'), { ...gatewayEnv(), STAGING_HOST: namespace });
    expect(response.status).toBe(200);
    const envelope = await response.json() as { ok: boolean; data?: { email: string } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ email: 'admin@example.test', role: 'administrator' });
    expect(response.headers.get('x-staging-sheets-reads')).toBe('1');
  });

  it('denies an unauthorized caller through the gateway after only the authorization read', async () => {
    const { fetchImpl, sheetsCalls } = fakeGoogle();
    const host = new StagingWorkbookHost({ id: { toString: () => 'test-object' } } as unknown as DurableObjectState, stagingBindings(), { fetch: fetchImpl, nowMs: () => NOW_MS });
    const { namespace } = fakeNamespace((forwarded) => host.fetch(forwarded), false);
    const credential = await idToken('volunteer@example.test');
    const response = await call(post('/exec', JSON.stringify(request(INTEGRATION_OPERATIONS.adminSchedule, credential))), { ...gatewayEnv(), STAGING_HOST: namespace });
    expect(response.status).toBe(200);
    const envelope = await response.json() as { ok: boolean; error?: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({ code: 'FORBIDDEN' });
    // Only the authorization table was read; no domain range reached Sheets.
    expect(sheetsCalls).toHaveLength(1);
    expect(sheetsCalls[0]?.ranges).toEqual([`'Users'!A2:G`]);
  });
});

describe('staging preview benchmark through the gateway', () => {
  it('is disabled by default at the host, so the gateway forwards to a 404 route', async () => {
    const { fetchImpl, sheetsCalls } = fakeGoogle();
    const host = new StagingWorkbookHost({ id: { toString: () => 'test-object' } } as unknown as DurableObjectState, stagingBindings(), { fetch: fetchImpl, nowMs: () => NOW_MS });
    const { namespace } = fakeNamespace((forwarded) => host.fetch(forwarded), false);
    const credential = await idToken('admin@example.test');
    const response = await call(post('/benchmark/schedule-preview', JSON.stringify(request(INTEGRATION_OPERATIONS.adminSchedulePreview, credential))), { ...gatewayEnv(), STAGING_HOST: namespace });
    expect(response.status).toBe(404);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect(sheetsCalls).toEqual([]);
  });
});
