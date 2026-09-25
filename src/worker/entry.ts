import { failure } from '../server/integration/request-policy.js';
import { allowedOrigins, type StagingBindings } from './config.js';
import { createStagingDispatch } from './dispatch.js';
import { READ_API_MAX_REQUEST_BYTES, createReadApi } from './read-api.js';

/**
 * Worker entry point for the feasibility slice.
 *
 * It is intentionally thin: configuration is read and validated per request so a
 * misconfigured deployment fails closed with a bounded JSON envelope instead of
 * a platform error page, and the transport rules live in `read-api.ts` where
 * they can be tested without Cloudflare or Google.
 */
export default {
  async fetch(request: Request, env: StagingBindings = {}): Promise<Response> {
    try {
      const api = createReadApi({
        origins: allowedOrigins(env),
        dispatch: createStagingDispatch(env),
        maxRequestBytes: READ_API_MAX_REQUEST_BYTES
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
} satisfies ExportedHandler<StagingBindings>;
