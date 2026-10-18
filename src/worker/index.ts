import { readSyncStatus } from './reads/syncStatus';
import { isMutation } from '../shared/api/operations';
import { makeReadSessionAuth } from './services/ReadSessionAuth';
import { scheduleReadMode } from './scheduleRead/configuration';
import { Effect, Schema } from 'effect';
import { decodeRequest, decodePayload, decodeResult } from './api/validation';
import { ErrorEnvelopeSchema } from '../shared/api/schemas';
import { applicationTimeZone } from '../shared/domain/models';
import { AppError } from '../shared/api/errors';
import { dispatchResponse, publicFailure } from './api/dispatch';
import { appConfig, liveServices, synchronizationJobs, type Bindings } from './runtime/live';
import { readBoundedText } from './services/http';

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const failure = (code: ConstructorParameters<typeof AppError>[0], message: string, status: number, details?: unknown) => new Response(publicFailure(new AppError(code, message, details)), { status, headers });

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
    if (url.pathname === '/api/schedule') {
      if (scheduleReadMode(env) !== 'enabled') return failure('NOT_FOUND', 'This endpoint is unavailable.', 404);
      if (!env.SCHEDULE_READER) return failure('INTERNAL_ERROR', 'The schedule is temporarily unavailable. Please try again.', 500);
      try { return await env.SCHEDULE_READER.fetch(request); }
      catch { return failure('INTERNAL_ERROR', 'The schedule is temporarily unavailable. Please try again.', 500); }
    }
    if (url.pathname === '/api/identity') {
      if (scheduleReadMode(env) !== 'enabled') return failure('NOT_FOUND', 'This endpoint is unavailable.', 404);
      if (!env.SCHEDULE_READER) return failure('INTERNAL_ERROR', 'Sign-in is temporarily unavailable.', 500);
      const target = new URL(request.url); target.pathname = '/internal/identity';
      try { return await env.SCHEDULE_READER.fetch(new Request(target, request)); }
      catch { return failure('INTERNAL_ERROR', 'Sign-in is temporarily unavailable.', 500); }
    }
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
      if (scheduleReadMode(env) === 'enabled' && typeof body === 'object' && body !== null
          && 'operation' in body && body.operation === 'admin.schedule.read') {
        return failure('INVALID_REQUEST', 'Refresh this application to read the schedule.', 400, { scheduleReadProtocol: 1 });
      }
      if (scheduleReadMode(env) === 'enabled' && typeof body === 'object' && body !== null
        && 'operation' in body && body.operation === 'session.me') {
        if (!env.SCHEDULE_READER) return failure('INTERNAL_ERROR', 'Sign-in is temporarily unavailable.', 500);
        let envelope;
        try { envelope = decodeRequest(body); decodePayload('session.me', envelope.payload); }
        catch { return failure('INVALID_REQUEST', 'Invalid sign-in request.', 400); }
        if (!envelope.credential.startsWith('g1.')) return failure('INVALID_REQUEST', 'Use the split sign-in exchange.', 400, { signInProtocol: 3 });
        const target = new URL(request.url); target.pathname = '/internal/session';
        const exchanged = await env.SCHEDULE_READER.fetch(new Request(target, { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Read-Session-Protocol': '3' }, body: JSON.stringify(envelope) }));
        const result = await exchanged.json() as { ok?: unknown; data?: unknown };
        if (result.ok === false) return Response.json(Schema.decodeUnknownSync(ErrorEnvelopeSchema)(result), { headers, status: exchanged.status });
        if (result.ok !== true) return failure('INTERNAL_ERROR', 'Sign-in is temporarily unavailable.', 500);
        return Response.json({ ok: true, data: decodeResult('session.me', result.data) }, { headers });
      }
      let authentication;
      if (scheduleReadMode(env) === 'enabled') {
        let envelope;
        try { envelope = decodeRequest(body); }
        catch { return failure('INVALID_REQUEST', 'Invalid request envelope or operation.', 400); }
        if (!isMutation(envelope.operation) && envelope.operation !== 'session.me') {
          if (!envelope.credential.startsWith('r2.')) return failure('INVALID_REQUEST', 'Reload this application to use a read session.', 400, { readSessionProtocol: 2 });
          if (!env.SCHEDULE_READER) return failure('INTERNAL_ERROR', 'Read authentication is temporarily unavailable.', 500);
          if (envelope.operation === 'admin.sync.read') {
            if (request.headers.get('X-Sync-Read-Protocol') !== '2') return failure('INVALID_REQUEST', 'Reload this application to read synchronization status.', 400, { syncReadProtocol: 2 });
            const response = await readSyncStatus(envelope, env.DB, env.SCHEDULE_READER).catch(error =>
              publicFailure(error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'An unexpected error occurred.')));
            return new Response(response, { headers });
          }
          authentication = makeReadSessionAuth(env.SCHEDULE_READER);
        } else if (envelope.credential.startsWith('r2.') || envelope.credential.startsWith('g1.')) return failure('UNAUTHORIZED', 'Google sign-in is required for this operation.', 401);
      }
      const response = await Effect.runPromise(dispatchResponse(body, appConfig(env)).pipe(Effect.provide(liveServices(env, authentication))));
      return new Response(response, { headers });
    } catch {
      return failure('INTERNAL_ERROR', 'An unexpected error occurred.', 500);
    }
  },
};
