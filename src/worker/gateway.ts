/**
 * Thin gateway Worker for the isolated Durable Object staging topology.
 *
 * The browser talks to this script; it forwards the request, untouched, to one
 * stable Durable Object selected from deployment configuration and streams the
 * object's response back without parsing or reserializing it. This module must
 * stay small and dependency-free: it may not import the production runtime,
 * Zod, or Temporal (enforced by the ESLint boundary and the gateway bundle
 * audit), so its admission rules are local copies of the staging transport's
 * semantics, pinned to the originals by `gateway.test.ts`.
 *
 * Transport admission owned here: exact CORS origin allowlisting and OPTIONS
 * preflight. Everything else — path, method, body size, JSON envelope and the
 * three-operation allowlist — is enforced inside the object, which reuses the
 * existing bounded transport unchanged, so forwarded requests keep exactly the
 * behavior the baseline staging Worker has today. Binding failures are mapped
 * to the existing bounded JSON error envelope; configuration details stay in
 * the platform log.
 */

/** Local copy of the bounded failure envelope shape; no request-policy import. */
type GatewayFailureEnvelope = Readonly<{
  ok: false;
  error: Readonly<{ code: string; message: string; details?: Readonly<Record<string, string>> }>;
}>;

const UNAVAILABLE_ENVELOPE: GatewayFailureEnvelope = {
  ok: false,
  error: { code: 'UNAVAILABLE', message: 'The staging endpoint is not configured.' }
};

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export const GATEWAY_ALLOW_METHODS = 'POST, OPTIONS';
export const GATEWAY_ALLOW_HEADERS = 'Accept, Content-Type';
export const GATEWAY_PREFLIGHT_MAX_AGE_SECONDS = '600';

export type GatewayBindings = Readonly<{
  /** Cross-script Durable Object binding to the staging host namespace. */
  STAGING_HOST?: unknown;
  /** Deployment configuration: which synthetic workbook's object receives requests. */
  STAGING_WORKBOOK_ID?: unknown;
  /** Exact allowed origins, comma separated; absent means deny every browser origin. */
  STAGING_ALLOWED_ORIGINS?: unknown;
}>;

/** A minimal structural view of the Durable Object namespace the gateway forwards through. */
type ObjectNamespace = Readonly<{
  idFromName(name: string): unknown;
  get(id: unknown): Readonly<{ fetch(request: Request): Promise<Response> }>;
}>;

function unavailableResponse(): Response {
  return new Response(JSON.stringify(UNAVAILABLE_ENVELOPE), {
    status: 503,
    headers: {
      'Content-Type': JSON_CONTENT_TYPE,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    }
  });
}

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return '';
  }
}

/**
 * Exact origin allowlist with the same parsing semantics as the staging
 * configuration's `allowedOrigins`: comma-separated exact origins, no
 * wildcards, http/https only, bare origins only. An empty or absent binding
 * denies every request that carries an `Origin` header.
 */
export function gatewayOrigins(raw: GatewayBindings['STAGING_ALLOWED_ORIGINS']): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'string') throw new Error('STAGING_ALLOWED_ORIGINS must be a string binding.');
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const origins: string[] = [];
  for (const entry of trimmed.split(',')) {
    const name = entry.trim();
    if (name.length === 0) continue;
    if (name.includes('*')) throw new Error('STAGING_ALLOWED_ORIGINS entries must be exact origins without wildcards.');
    let url: URL;
    try {
      url = new URL(name);
    } catch {
      throw new Error('STAGING_ALLOWED_ORIGINS contains an entry that is not a URL.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('STAGING_ALLOWED_ORIGINS entries must use http or https.');
    if (url.origin !== name) throw new Error('STAGING_ALLOWED_ORIGINS entries must be bare origins without a path, query or trailing slash.');
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

/**
 * The object name never comes from the request. It is derived from the
 * deployment's workbook configuration so two deployed fixtures get two stable
 * objects and no caller can select or guess an object identity.
 */
export function gatewayObjectName(raw: GatewayBindings['STAGING_WORKBOOK_ID']): string {
  if (typeof raw !== 'string') throw new Error('STAGING_WORKBOOK_ID must be a string binding.');
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error('STAGING_WORKBOOK_ID is required for the staging gateway.');
  return trimmed;
}

function isNamespace(value: unknown): value is ObjectNamespace {
  return (
    typeof value === 'object' && value !== null &&
    typeof (value as { idFromName?: unknown }).idFromName === 'function' &&
    typeof (value as { get?: unknown }).get === 'function'
  );
}

export default {
  async fetch(request: Request, env: GatewayBindings = {}): Promise<Response> {
    const correlationId = crypto.randomUUID();
    try {
      // Transport admission: exact origin allowlisting with preflight handling.
      // A request with no `Origin` header is not a browser call and still needs
      // a verified credential inside the object.
      const origin = request.headers.get('origin');
      if (origin !== null && !gatewayOrigins(env.STAGING_ALLOWED_ORIGINS).includes(origin)) {
        return new Response(
          JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'This staging endpoint does not allow that origin.' } } satisfies GatewayFailureEnvelope),
          { status: 403, headers: { 'Content-Type': JSON_CONTENT_TYPE, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' } }
        );
      }
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...(origin === null ? {} : { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }),
            'Access-Control-Allow-Methods': GATEWAY_ALLOW_METHODS,
            'Access-Control-Allow-Headers': GATEWAY_ALLOW_HEADERS,
            'Access-Control-Max-Age': GATEWAY_PREFLIGHT_MAX_AGE_SECONDS,
            'Access-Control-Expose-Headers': 'cf-ray, X-Staging-Sheets-Reads, X-Staging-Snapshot-Digest, X-Staging-Correlation-Id',
            'Cache-Control': 'no-store'
          }
        });
      }

      // Forwarding, with the server-generated correlation ID attached so attempt
      // logs, gateway telemetry and object telemetry can be joined without any
      // request payload ever being parsed here.
      const objectName = gatewayObjectName(env.STAGING_WORKBOOK_ID);
      const namespace = env.STAGING_HOST;
      if (!isNamespace(namespace)) throw new Error('STAGING_HOST binding is missing or invalid.');
      const headers = new Headers(request.headers);
      headers.set('X-Staging-Correlation-Id', correlationId);
      let forwarded: Request;
      try {
        forwarded = new Request(request, { headers });
      } catch {
        // Streaming bodies can refuse header-preserving reconstruction; the
        // request is still forwarded, only without the correlation header.
        forwarded = request;
      }
      const response = await namespace.get(namespace.idFromName(objectName)).fetch(forwarded);
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('X-Staging-Correlation-Id', correlationId);
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    } catch (error) {
      // One bounded line, no binding details, no URLs, no request data.
      console.warn(`staging gateway refused a request: ${error instanceof Error ? error.message : 'unknown failure'} (correlation=${correlationId}, path=${requestPath(request)})`);
      return unavailableResponse();
    }
  }
} satisfies ExportedHandler<GatewayBindings>;
