import { AppError } from '../../shared/api/errors';
import { readBoundedText } from '../services/http';
import { readTicketsFor, type ScheduleReadBindings } from './configuration';
/** Verifies only the signed principal. The caller transactionally reads current authority. */
export async function verifyReadSession(request: Request, env: ScheduleReadBindings): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  try {
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new AppError('INVALID_REQUEST', 'Use a JSON POST request.');
    const body: unknown = JSON.parse(await readBoundedText(new Response(request.body, { headers: request.headers }), 16384));
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length !== 1
      || !('credential' in body) || typeof body.credential !== 'string') throw new AppError('INVALID_REQUEST', 'Invalid read session.');
    const tickets = readTicketsFor(env, 'session');
    if (!tickets) throw new AppError('NOT_FOUND', 'This endpoint is unavailable.');
    console.info('Scheduling API operation:', 'read.session.verify');
    const identity = await tickets.verify(body.credential, Date.now());
    return Response.json({ ok: true, kind: 'api.read', identity: { ...identity, expiresAt: identity.expiresAt / 1000 } }, { headers });
  } catch (error) {
    const failure = error instanceof AppError ? error : new AppError('INVALID_REQUEST', 'Invalid read session.');
    return Response.json({ ok: false, error: { code: failure.code, message: failure.message } }, { headers,
      status: failure.code === 'UNAUTHORIZED' ? 401 : failure.code === 'NOT_FOUND' ? 404 : 400 });
  }
}
