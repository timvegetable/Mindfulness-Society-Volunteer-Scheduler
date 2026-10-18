import { AppError } from '../../shared/api/errors';
import { canUseCenter, canUseOperation } from '../api/policies';
import { readBoundedText } from '../services/http';
import { accountColumns, storedAccount, storedRevision } from './accounts';
import { identityProofsFor, readTicketsFor, type ScheduleReadBindings } from './configuration';

/** The public main Worker validates this result against the shared session schema. */
export async function exchangeSession(request: Request, env: ScheduleReadBindings & { DB: D1Database }): Promise<Response> {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  try {
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new AppError('INVALID_REQUEST', 'Use a JSON POST request.');
    }
    let raw: unknown;
    try { raw = JSON.parse(await readBoundedText(new Response(request.body, { headers: request.headers }), 65536)); }
    catch { throw new AppError('INVALID_REQUEST', 'Expected a bounded JSON request.'); }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new AppError('INVALID_REQUEST', 'Invalid sign-in request.');
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some(key => !['credential', 'operation', 'payload', 'expectedRevision', 'idempotencyKey'].includes(key))
      || !['credential', 'operation', 'payload'].every(key => Object.hasOwn(body, key))
      || (Object.hasOwn(body, 'expectedRevision') && (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0))
      || (Object.hasOwn(body, 'idempotencyKey') && (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey))
      || body.operation !== 'session.me' || typeof body.credential !== 'string' || !body.credential
      || !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload) || Object.keys(body.payload).length) {
      throw new AppError('INVALID_REQUEST', 'Invalid sign-in request.');
    }
    console.info('Scheduling API operation:', 'session.me');
    const protocol = request.headers.get('X-Read-Session-Protocol');
    const useSession = protocol === '2' || protocol === '3';
    const tickets = readTicketsFor(env, useSession ? 'session' : 'schedule');
    if (!tickets) throw new AppError('NOT_FOUND', 'This endpoint is unavailable.');
    const proofs = protocol === '3' ? identityProofsFor(env) : undefined;
    if (protocol === '3' && !proofs) throw new AppError('NOT_FOUND', 'This endpoint is unavailable.');
    const identity = proofs ? await proofs.verify(body.credential, Date.now()) : await (await import('./google')).verifyGoogle(body.credential, env.OAUTH_CLIENT_ID);
    const [accounts, centers, metadata] = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare(`SELECT ${accountColumns} FROM users WHERE lower(trim(email))=? ORDER BY id`).bind(identity.email),
      env.DB.prepare('SELECT id,name,active,created_at,updated_at FROM centers ORDER BY id'),
      env.DB.prepare("SELECT key,value FROM meta WHERE key IN ('dataRevision','schedulingInputRevision')"),
    ]);
    const users = accounts!.results.map(storedAccount);
    const user = users.find(row => row.active);
    if (!user) throw new AppError('UNAUTHORIZED', 'This account is not active.');
    if (!canUseOperation(user, 'session.me')) throw new AppError('FORBIDDEN', 'Your account cannot perform this operation.');
    const meta = new Map(metadata!.results.map(row => [row.key, row.value]));
    const data = { user, centers: centers!.results.filter(row => {
      if (typeof row.id !== 'string' || !row.id) throw new AppError('INTERNAL_ERROR', 'Stored data is invalid.');
      return canUseCenter(user, row.id);
    }).map(row => ({
      id: row.id, name: row.name, active: row.active === 1, createdAt: row.created_at, updatedAt: row.updated_at,
    })), dataRevision: storedRevision(meta.get('dataRevision') ?? 0), schedulingInputRevision: storedRevision(meta.get('schedulingInputRevision') ?? 0),
    ...(useSession ? { readSession: await tickets.issue(user, identity.expiresAt, Date.now()) }
      : canUseOperation(user, 'admin.schedule.read') ? { scheduleRead: await tickets.issue(user, identity.expiresAt, Date.now()) } : {}) };
    return new Response(JSON.stringify({ ok: true, data }), { headers });
  } catch (error) {
    const failure = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'Sign-in is temporarily unavailable. Please try again.');
    return new Response(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }), { headers, status: failure.code === 'UNAUTHORIZED' ? 401 : failure.code === 'FORBIDDEN' ? 403 : failure.code === 'INVALID_REQUEST' ? 400 : 500 });
  }
}
