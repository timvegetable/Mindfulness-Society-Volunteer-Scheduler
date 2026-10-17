import { Effect } from 'effect';
import { applicationTimeZone } from '../shared/domain/models';
import { AppError } from '../shared/api/errors';
import { dispatchResponse, publicFailure } from './api/dispatch';
import { appConfig, liveServices, synchronizationJobs, type Bindings } from './runtime/live';
import { readBoundedText } from './services/http';

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const failure = (code: ConstructorParameters<typeof AppError>[0], message: string, status: number) => new Response(publicFailure(new AppError(code, message)), { status, headers });

export default {
  async scheduled(controller: ScheduledController, env: Bindings): Promise<void> {
    await env.SYNC_QUEUE.send({ jobId: `scheduled-${controller.scheduledTime}`, phase: 'start', version: 0 });
    await env.SYNC_QUEUE.send({ jobId: 'maintenance', phase: 'recover', version: 0 });
  },
  async queue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
    // Every stage needs its own invocation budget, including dead-letter handling.
    if (batch.messages.length !== 1) throw new Error('Synchronization requires Queue batch size one.');
    const message = batch.messages[0]!;
    const jobs = synchronizationJobs(env);
    if (batch.queue === env.SYNC_DEAD_LETTER_QUEUE) await jobs.deadLetter(message.body);
    else await jobs.consume(message.body);
    message.ack();
  },
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/client-config') {
      if (request.method !== 'GET') return failure('INVALID_REQUEST', 'Use GET.', 405);
      return Response.json({ oauthClientId: env.OAUTH_CLIENT_ID, timeZone: applicationTimeZone }, { headers });
    }
    if (url.pathname !== '/api') return env.ASSETS.fetch(request);
    if (request.method !== 'POST') return failure('INVALID_REQUEST', 'Use POST /api.', 405);
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return failure('INVALID_REQUEST', 'Use application/json.', 415);
    let body: unknown;
    try {
      body = JSON.parse(await readBoundedText(new Response(request.body, { headers: request.headers }), 64 * 1024));
    } catch { return failure('INVALID_REQUEST', 'Expected a JSON request no larger than 64 KiB.', 400); }
    try {
      const response = await Effect.runPromise(dispatchResponse(body, appConfig(env)).pipe(Effect.provide(liveServices(env))));
      return new Response(response, { headers });
    } catch {
      return failure('INTERNAL_ERROR', 'An unexpected error occurred.', 500);
    }
  },
};
