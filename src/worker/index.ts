import { Effect } from 'effect';
import { AppError } from '../shared/api/errors';
import { dispatchResponse, publicFailure } from './api/dispatch';
import { appConfig, liveLayer, type Bindings } from './runtime/live';
import { readBoundedText } from './services/http';

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const failure = (code: ConstructorParameters<typeof AppError>[0], message: string, status: number) => new Response(publicFailure(new AppError(code, message)), { status, headers });

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/client-config') {
      if (request.method !== 'GET') return failure('INVALID_REQUEST', 'Use GET.', 405);
      return Response.json({ oauthClientId: env.OAUTH_CLIENT_ID, timeZone: env.TIME_ZONE }, { headers });
    }
    if (url.pathname !== '/api') return env.ASSETS.fetch(request);
    if (request.method !== 'POST') return failure('INVALID_REQUEST', 'Use POST /api.', 405);
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return failure('INVALID_REQUEST', 'Use application/json.', 415);
    let body: unknown;
    try {
      body = JSON.parse(await readBoundedText(new Response(request.body, { headers: request.headers }), 64 * 1024));
    } catch { return failure('INVALID_REQUEST', 'Expected a JSON request no larger than 64 KiB.', 400); }
    try {
      const response = await Effect.runPromise(dispatchResponse(body, appConfig(env)).pipe(Effect.provide(liveLayer(env))));
      return new Response(response, { headers });
    } catch {
      return failure('INTERNAL_ERROR', 'An unexpected error occurred.', 500);
    }
  },
};
