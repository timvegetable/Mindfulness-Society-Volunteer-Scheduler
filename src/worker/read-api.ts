import type { ApiResponse, ErrorCode } from '../shared/domain.js';
import { DEFAULT_MAX_PAYLOAD_BYTES, INTEGRATION_OPERATIONS, failure } from '../server/integration/request-policy.js';

/**
 * Bounded direct-JSON transport for the feasibility slice.
 *
 * This replaces the prototype's loopback `node:http` server with a Worker fetch
 * handler and keeps the prototype's observable contract: one POST path, exact
 * origin allowlisting, `text/plain` JSON bodies, a 64 KiB envelope, direct JSON
 * responses, and no redirects. It deliberately performs no authentication and no
 * workbook access; the injected `dispatch` owns that, so the transport rules can
 * be tested — and reviewed — on their own.
 */

export const READ_API_PATH = '/exec';
/**
 * Secondary route for the staging `admin.schedule.preview` benchmark, served by
 * the Durable Object host only. It is disabled unless the deployment explicitly
 * sets `STAGING_PREVIEW_BENCHMARK_ENABLED`; a disabled request is answered with
 * the same 404 envelope as any unknown route, before any body read.
 */
export const BENCHMARK_PREVIEW_PATH = '/benchmark/schedule-preview';
export const READ_API_MAX_REQUEST_BYTES = DEFAULT_MAX_PAYLOAD_BYTES;
export const READ_API_CONTENT_TYPE = 'text/plain';
export const READ_API_ALLOW_METHODS = 'POST, OPTIONS';
export const READ_API_ALLOW_HEADERS = 'Accept, Content-Type';
export const READ_API_PREFLIGHT_MAX_AGE_SECONDS = '600';

/**
 * The only operations this endpoint serves. Every other registered operation —
 * including the nine whose shared policy is `mutating`, and the four read-only
 * ones outside this slice — is refused here, before any identity or workbook
 * access, so a rejected request cannot reach a handler.
 *
 * This allowlist is load-bearing beyond convenience: `admin.import.whenIsGood.preview`
 * is registered read-only even though its handler writes an `Imports` row (see the
 * experiment contract), so for that operation the read-only policy would not stop
 * execution and this list is the only barrier. Adding an operation here means
 * re-checking its actual effects first.
 */
export const READ_API_OPERATIONS: ReadonlySet<string> = new Set([
  INTEGRATION_OPERATIONS.me,
  INTEGRATION_OPERATIONS.adminSchedule,
  INTEGRATION_OPERATIONS.adminInsights
]);

/**
 * The benchmark route serves exactly one operation, and the preview is never
 * accepted through `/exec`: this set is what keeps the two routes disjoint even
 * when the benchmark is enabled.
 */
export const BENCHMARK_PREVIEW_OPERATIONS: ReadonlySet<string> = new Set([INTEGRATION_OPERATIONS.adminSchedulePreview]);

/** Which transport route served a request. The staging dispatch uses it to pick the route-aware allowlist. */
export type ReadRoute = 'exec' | 'benchmark';

export type ReadDispatch = (input: unknown, route: ReadRoute) => Promise<ApiResponse<unknown>> | ApiResponse<unknown>;

export type ReadApiOptions = Readonly<{
  /** Exact allowed origins. An empty list denies every request that sends `Origin`. */
  origins: readonly string[];
  dispatch: ReadDispatch;
  maxRequestBytes?: number;
  /**
   * Extra response headers, evaluated after the dispatcher returns. The staging
   * slice uses it to publish the request's Sheets read count and snapshot digest
   * so a measurement run records what actually happened.
   */
  responseHeaders?: () => Record<string, string>;
  /**
   * Enables the staging preview benchmark route. Absent (the default) keeps
   * `/benchmark/schedule-preview` answering 404 like any unknown route.
   */
  benchmarkPreview?: Readonly<{ enabled: boolean }>;
}>;

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Every response carries the application envelope, so a dispatch result that is
 * not an `ApiResponse` — undefined, a cycle, a BigInt, or any object without an
 * `ok` boolean — must not be handed to the client as if it were one.
 */
function serialize(body: unknown): string {
  try {
    const record = body as { ok?: unknown } | null;
    const isEnvelope = typeof body === 'object' && body !== null && typeof record?.ok === 'boolean';
    if (isEnvelope) {
      const text = JSON.stringify(body);
      if (text !== undefined) return text;
    }
  } catch {
    // Fall through to the bounded failure envelope below.
  }
  return JSON.stringify(failure('INTERNAL_ERROR', 'The staging read service could not complete the request.'));
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(serialize(body), {
    status,
    headers: {
      'Content-Type': JSON_CONTENT_TYPE,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      ...headers
    }
  });
}

function fail(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(failure(code, message), status, headers);
}

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return '';
  }
}

function declaredLength(request: Request): number | undefined | typeof Number.NaN {
  const value = request.headers.get('content-length');
  if (value === null) return undefined;
  if (!/^\d+$/.test(value.trim())) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function contentType(request: Request): string {
  return (request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * Reads the body with a hard byte cap, so an oversized request is refused while
 * it is still arriving instead of after it has been buffered whole.
 */
async function readBoundedBody(request: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; tooLarge: boolean }> {
  if (!request.body) return { ok: true, text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, tooLarge: false };
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

export type ReadApi = Readonly<{ fetch(request: Request): Promise<Response> }>;

export function createReadApi(options: ReadApiOptions): ReadApi {
  const origins = new Set(options.origins);
  const maxRequestBytes = options.maxRequestBytes ?? READ_API_MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw new Error('maxRequestBytes must be a positive integer.');
  }

  /**
   * Returns the CORS headers for an allowed origin, or a refusal. A request with
   * no `Origin` header is allowed through without CORS headers: it is not a
   * browser cross-origin call, and it still needs a verified credential.
   */
  const corsHeaders = (origin: string | null): { ok: true; headers: Record<string, string> } | { ok: false } => {
    if (origin === null) return { ok: true, headers: {} };
    if (!origins.has(origin)) return { ok: false };
    return {
      ok: true,
      headers: {
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        // The browser probe records the point of presence, the request's read
        // count, the per-read timings and the snapshot digest; without this a
        // cross-origin caller can see none of them.
        'Access-Control-Expose-Headers': 'cf-ray, X-Staging-Sheets-Reads, X-Staging-Read-Ms, X-Staging-Snapshot-Digest'
      }
    };
  };

  const handle = async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    const cors = corsHeaders(origin);
    if (!cors.ok) return fail(403, 'FORBIDDEN', 'This staging endpoint does not allow that origin.');
    const headers = cors.headers;
    const path = requestPath(request);
    const benchmarkEnabled = options.benchmarkPreview?.enabled === true;
    const route: ReadRoute = path === BENCHMARK_PREVIEW_PATH ? 'benchmark' : 'exec';
    const benchmarkRoute = route === 'benchmark';

    if (request.method === 'OPTIONS' && (path === READ_API_PATH || (benchmarkRoute && benchmarkEnabled))) {
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          'Access-Control-Allow-Methods': READ_API_ALLOW_METHODS,
          'Access-Control-Allow-Headers': READ_API_ALLOW_HEADERS,
          'Access-Control-Max-Age': READ_API_PREFLIGHT_MAX_AGE_SECONDS,
          'Cache-Control': 'no-store'
        }
      });
    }
    // A disabled benchmark route is indistinguishable from an unknown route:
    // 404 before any body read, with no workbook or identity access.
    if (path !== READ_API_PATH && !(benchmarkRoute && benchmarkEnabled)) {
      return fail(404, 'NOT_FOUND', 'Route not found.', headers);
    }
    if (request.method !== 'POST') {
      return fail(405, 'INVALID_REQUEST', 'Use POST for the read API.', { ...headers, Allow: READ_API_ALLOW_METHODS });
    }

    const length = declaredLength(request);
    if (Number.isNaN(length)) return fail(400, 'INVALID_REQUEST', 'Content-Length is invalid.', headers);
    if (length !== undefined && length > maxRequestBytes) {
      return fail(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.', headers);
    }
    if (contentType(request) !== READ_API_CONTENT_TYPE) {
      return fail(415, 'INVALID_REQUEST', 'Use the browser client text/plain request format.', headers);
    }

    const body = await readBoundedBody(request, maxRequestBytes);
    if (!body.ok) {
      return body.tooLarge
        ? fail(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.', headers)
        : fail(400, 'INVALID_REQUEST', 'Request body could not be read.', headers);
    }

    let input: unknown;
    try {
      input = JSON.parse(body.text) as unknown;
    } catch {
      return fail(400, 'INVALID_REQUEST', 'Request body must be a JSON object.', headers);
    }

    const operation = typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as { operation?: unknown }).operation
      : undefined;
    const routeOperations = benchmarkRoute ? BENCHMARK_PREVIEW_OPERATIONS : READ_API_OPERATIONS;
    if (typeof operation !== 'string' || !routeOperations.has(operation)) {
      return jsonResponse(
        failure(
          'FORBIDDEN',
          benchmarkRoute
            ? 'This staging benchmark endpoint only serves the schedule preview operation.'
            : 'This staging endpoint only serves the allowlisted read operations.'
        ),
        200,
        headers
      );
    }

    try {
      const response = await options.dispatch(input, route);
      return jsonResponse(response, 200, { ...headers, ...options.responseHeaders?.() });
    } catch {
      // The caller learns only that the service failed; configuration and
      // credential details stay out of the response.
      return jsonResponse(failure('INTERNAL_ERROR', 'The staging read service could not complete the request.'), 200, headers);
    }
  };

  return { fetch: handle };
}
