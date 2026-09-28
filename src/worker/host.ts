import { allowedOrigins, type StagingBindings } from './config.js';
import { READ_API_MAX_REQUEST_BYTES, createReadApi } from './read-api.js';
import { createStagingReadService, type StagingServiceOptions } from './staging.js';
import { failure } from '../server/integration/request-policy.js';

/**
 * Durable Object host for the isolated staging topology (task 3.5).
 *
 * The gateway forwards each request to one stable object of this class. Inside
 * the object the existing bounded transport and staging service are reused
 * unchanged: Google verification, a fresh Users lookup, role checks,
 * schema-derived Sheets ranges, the synchronous domain runtime, and JSON
 * serialization. Each request builds its own service, snapshot, counters and
 * principal; the only state kept across requests is the existing expiring
 * Google key/token cache, and no application state is ever written to the
 * object's storage.
 *
 * The object is registered through a SQLite migration (`new_sqlite_classes`)
 * and has no public route or workers.dev endpoint: the only caller is the
 * gateway's cross-script binding. The benchmark route `POST
 * /benchmark/schedule-preview` is served here and stays disabled unless the
 * deployment explicitly sets `STAGING_PREVIEW_BENCHMARK_ENABLED` to `true`.
 */

/**
 * Enables the staging preview benchmark only for the exact literal `true`.
 * Anything else — absent, blank, any other casing or value — is disabled, so a
 * default deployment never exposes the benchmark route.
 */
export function benchmarkPreviewEnabled(bindings: StagingBindings): boolean {
  const value = bindings.STAGING_PREVIEW_BENCHMARK_ENABLED;
  if (value === undefined || value === null) return false;
  if (typeof value !== 'string') return false;
  return value.trim() === 'true';
}

/**
 * One stable object per configured synthetic workbook. The gateway derives the
 * name from its deployment configuration with `gatewayObjectName`; the class
 * itself never trusts request input for identity or workbook selection.
 */
export class StagingWorkbookHost {
  private activated = false;

  constructor(
    /** Unused on purpose: the object holds no application state in storage. */
    private readonly state: DurableObjectState,
    private readonly env: StagingBindings,
    /** Test-only injection of transport/clock doubles; production passes nothing. */
    private readonly serviceOptions: StagingServiceOptions = {}
  ) {
    // Isolate/object-start marker for cold-start attribution. Sanitized: no
    // credentials, principals, URLs or row values are ever logged.
    console.log(`staging host object constructed: object=${this.state.id.toString()}`);
  }

  async fetch(request: Request): Promise<Response> {
    const correlationId = request.headers.get('x-staging-correlation-id') ?? undefined;
    if (!this.activated) {
      this.activated = true;
      // Distinguishes a freshly constructed object's first request from later
      // warm requests, and from the isolate-level cold start that platform
      // telemetry reports on script deployment.
      console.log(`staging host object first use${correlationId === undefined ? '' : ` (correlation=${correlationId})`}`);
    }
    try {
      // One service per request, so its counters describe this request only.
      const benchmarkEnabled = benchmarkPreviewEnabled(this.env);
      const service = createStagingReadService(this.env, { ...this.serviceOptions, benchmarkPreview: benchmarkEnabled });
      const api = createReadApi({
        origins: allowedOrigins(this.env),
        dispatch: (input, route) => service.handle(input, route),
        maxRequestBytes: READ_API_MAX_REQUEST_BYTES,
        responseHeaders: () => {
          const stats = service.stats();
          return {
            'X-Staging-Sheets-Reads': String(stats.sheetsReads),
            ...(stats.digest === undefined ? {} : { 'X-Staging-Snapshot-Digest': stats.digest })
          };
        },
        benchmarkPreview: { enabled: benchmarkEnabled }
      });
      return await api.fetch(request);
    } catch {
      // Configuration errors can name bindings and hosts, and an unexpected
      // transport failure would otherwise become a platform error page. The
      // caller receives a bounded envelope either way; the detail stays in the
      // platform log.
      return new Response(JSON.stringify(failure('UNAVAILABLE', 'The staging endpoint is not configured.')), {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY'
        }
      });
    }
  }
}

/**
 * The host has no public route or workers.dev endpoint. This default handler
 * exists only so a misconfiguration cannot serve anything: any request that
 * somehow reaches the script directly is answered with the bounded envelope.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response(JSON.stringify(failure('UNAVAILABLE', 'The staging endpoint is not configured.')), {
      status: 503,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
      }
    });
  }
} satisfies ExportedHandler;
