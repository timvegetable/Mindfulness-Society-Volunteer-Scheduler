import { AppError } from '../../shared/api/errors';
import { readBoundedText } from '../services/http';
import { identityProofsFor, type ScheduleReadBindings } from './configuration';
import { verifyGoogle } from './google';
/** First external sign-in stage: Google verification and a short-lived proof; no D1. */
export async function proveGoogleIdentity(request: Request, env: ScheduleReadBindings): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  try {
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new AppError('INVALID_REQUEST', 'Use a JSON POST request.');
    let body: unknown;
    try { body = JSON.parse(await readBoundedText(new Response(request.body, { headers: request.headers }), 65536)); }
    catch { throw new AppError('INVALID_REQUEST', 'Expected a bounded JSON request.'); }
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length !== 1
      || !('credential' in body) || typeof body.credential !== 'string') throw new AppError('INVALID_REQUEST', 'Invalid sign-in request.');
    const proofs = identityProofsFor(env);
    if (!proofs) throw new AppError('NOT_FOUND', 'This endpoint is unavailable.');
    console.info('Scheduling API operation:', 'session.google.verify');
    const identity = await verifyGoogle(body.credential, env.OAUTH_CLIENT_ID);
    return Response.json({ ok: true, data: await proofs.issue(identity, Date.now()) }, { headers });
  } catch (error) {
    const failure = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'Sign-in is temporarily unavailable.');
    return Response.json({ ok: false, error: { code: failure.code, message: failure.message } }, { headers,
      status: failure.code === 'UNAUTHORIZED' ? 401 : failure.code === 'NOT_FOUND' ? 404 : failure.code === 'INVALID_REQUEST' ? 400 : 500 });
  }
}
