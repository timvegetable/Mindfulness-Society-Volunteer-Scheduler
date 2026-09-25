import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../shared/domain.js';
import { INTEGRATION_OPERATIONS, failure } from '../server/integration/request-policy.js';
import { READ_API_MAX_REQUEST_BYTES, READ_API_OPERATIONS, createReadApi, type ReadDispatch } from './read-api.js';

const ALLOWED_ORIGIN = 'https://scheduling.example.test';
const URL_UNDER_TEST = 'https://staging.example.test/exec';

function apiWith(dispatch: ReadDispatch, origins: readonly string[] = [ALLOWED_ORIGIN], maxRequestBytes?: number) {
  return createReadApi({
    origins,
    dispatch,
    ...(maxRequestBytes === undefined ? {} : { maxRequestBytes })
  });
}

function envelopeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_UNDER_TEST, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8', ...headers },
    body: JSON.stringify(body)
  });
}

function readBody(operation: string) {
  return { operation, payload: {}, idempotencyKey: `probe-${operation}` };
}

const okDispatch: ReadDispatch = async () => ({ ok: true, data: { served: true } }) as ApiResponse<unknown>;

describe('read API transport', () => {
  it('serves an allowlisted operation as direct JSON with no-store headers', async () => {
    const response = await apiWith(okDispatch).fetch(envelopeRequest(readBody(INTEGRATION_OPERATIONS.me)));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    // No redirect handoff: the browser receives the application envelope itself.
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({ ok: true, data: { served: true } });
  });

  it('forwards the parsed request object to the dispatcher unchanged', async () => {
    const dispatch = vi.fn(okDispatch);
    const body = readBody(INTEGRATION_OPERATIONS.adminSchedule);
    await apiWith(dispatch).fetch(envelopeRequest(body));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toEqual(body);
  });

  it('refuses an origin that is not exactly allowlisted and sends no CORS header', async () => {
    const dispatch = vi.fn(okDispatch);
    const response = await apiWith(dispatch).fetch(envelopeRequest(readBody(INTEGRATION_OPERATIONS.me), { Origin: 'https://evil.example.test' }));
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses a suffix or prefix of an allowlisted origin', async () => {
    const dispatch = vi.fn(okDispatch);
    for (const origin of [`${ALLOWED_ORIGIN}.evil.test`, 'https://scheduling.example.te', 'https://scheduling.example.test:8443']) {
      const response = await apiWith(dispatch).fetch(envelopeRequest(readBody(INTEGRATION_OPERATIONS.me), { Origin: origin }));
      expect(response.status).toBe(403);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('allows an allowlisted origin and marks the response as origin-varying', async () => {
    const response = await apiWith(okDispatch).fetch(envelopeRequest(readBody(INTEGRATION_OPERATIONS.me), { Origin: ALLOWED_ORIGIN }));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('allows a request with no Origin header, which still needs a verified credential', async () => {
    const response = await apiWith(okDispatch).fetch(envelopeRequest(readBody(INTEGRATION_OPERATIONS.me)));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('denies every browser origin when the allowlist is empty', async () => {
    const dispatch = vi.fn(okDispatch);
    const response = await apiWith(dispatch, []).fetch(envelopeRequest(readBody(INTEGRATION_OPERATIONS.me), { Origin: ALLOWED_ORIGIN }));
    expect(response.status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('answers the preflight with the allowed methods and headers', async () => {
    const response = await apiWith(okDispatch).fetch(new Request(URL_UNDER_TEST, {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' }
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toBe('Accept, Content-Type');
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });

  it('returns 404 for any other path and 405 for a non-POST method', async () => {
    const notFound = await apiWith(okDispatch).fetch(new Request('https://staging.example.test/other', { method: 'POST', body: '{}' }));
    expect(notFound.status).toBe(404);
    const wrongMethod = await apiWith(okDispatch).fetch(new Request(URL_UNDER_TEST, { method: 'GET' }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST, OPTIONS');
  });

  it('rejects an unparsable Content-Length without calling the dispatcher', async () => {
    const dispatch = vi.fn(okDispatch);
    const response = await apiWith(dispatch).fetch(new Request(URL_UNDER_TEST, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': 'not-a-number' },
      body: '{}'
    }));
    expect(response.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a declared body larger than the limit before reading it', async () => {
    const dispatch = vi.fn(okDispatch);
    const response = await apiWith(dispatch, [ALLOWED_ORIGIN], 128).fetch(new Request(URL_UNDER_TEST, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': String(READ_API_MAX_REQUEST_BYTES + 1) },
      body: '{}'
    }));
    expect(response.status).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a streamed body that exceeds the limit while it is arriving', async () => {
    const dispatch = vi.fn(okDispatch);
    const chunk = new Uint8Array(64).fill(65);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 16; index += 1) controller.enqueue(chunk);
        controller.close();
      }
    });
    const response = await apiWith(dispatch, [ALLOWED_ORIGIN], 128).fetch(new Request(URL_UNDER_TEST, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body,
      // A stream body carries no Content-Length, so only the byte cap can stop it.
      duplex: 'half'
    } as RequestInit));
    expect(response.status).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a content type the browser client would never send', async () => {
    const dispatch = vi.fn(okDispatch);
    const response = await apiWith(dispatch).fetch(new Request(URL_UNDER_TEST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readBody(INTEGRATION_OPERATIONS.me))
    }));
    expect(response.status).toBe(415);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a body that is not valid JSON', async () => {
    const dispatch = vi.fn(okDispatch);
    const response = await apiWith(dispatch).fetch(new Request(URL_UNDER_TEST, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{not json'
    }));
    expect(response.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses every operation outside the three-operation allowlist before dispatch', async () => {
    const dispatch = vi.fn(okDispatch);
    const outside = Object.values(INTEGRATION_OPERATIONS).filter((operation) => !READ_API_OPERATIONS.has(operation));
    expect(READ_API_OPERATIONS.size).toBe(3);
    expect(outside).toHaveLength(13);
    for (const operation of outside) {
      const response = await apiWith(dispatch).fetch(envelopeRequest(readBody(operation)));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses a request whose operation is absent or not a string', async () => {
    const dispatch = vi.fn(okDispatch);
    for (const body of [{}, { operation: 42 }, { operation: 'session.me ' }, { operation: ['session.me'] }]) {
      const response = await apiWith(dispatch).fetch(envelopeRequest(body));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('forwards a malformed envelope on an allowlisted operation, because the dispatcher owns payload policy', async () => {
    // The transport must not grow a second, divergent copy of the envelope rules;
    // the shared seam rejects this one (payload must be an object).
    const dispatch = vi.fn(okDispatch);
    const response = await apiWith(dispatch).fetch(envelopeRequest({ operation: INTEGRATION_OPERATIONS.me, payload: [], idempotencyKey: 'too-short' }));
    expect(response.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('maps a thrown dispatcher error to a bounded envelope without the original detail', async () => {
    const response = await apiWith(async () => {
      throw new Error('service account key not found at /secrets/staging.json');
    }).fetch(envelopeRequest(readBody(INTEGRATION_OPERATIONS.adminInsights)));
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('/secrets/staging.json');
  });

  it('never answers with a body that is not the application envelope', async () => {
    // Unreachable through today's entry point, but the transport is the seam the
    // real dispatcher is injected into, so a non-envelope result must not reach
    // the client as if it were one.
    const badResults: unknown[] = [undefined, () => undefined, 10n, null, 42, new Map([['a', 1]]), Symbol('nope')];
    for (const bad of badResults) {
      const response = await apiWith((async () => bad) as unknown as ReadDispatch).fetch(envelopeRequest(readBody(INTEGRATION_OPERATIONS.me)));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.length, String(bad)).toBeGreaterThan(0);
      expect(JSON.parse(text), String(bad)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    }
    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;
    const cyclicResponse = await apiWith((async () => cyclic) as unknown as ReadDispatch).fetch(envelopeRequest(readBody(INTEGRATION_OPERATIONS.me)));
    expect(JSON.parse(await cyclicResponse.text())).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('passes a dispatcher failure envelope through unchanged', async () => {
    const response = await apiWith(async () => failure('UNAUTHORIZED', 'Authentication is required.')).fetch(envelopeRequest(readBody(INTEGRATION_OPERATIONS.me)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' } });
  });

  it('rejects an impossible configured limit instead of silently accepting any body', () => {
    expect(() => apiWith(okDispatch, [ALLOWED_ORIGIN], 0)).toThrow();
  });
});
