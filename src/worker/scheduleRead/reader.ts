import { accountColumns, storedAccount, storedRevision as revision } from './accounts';
import { AppError } from '../../shared/api/errors';
import { canUseOperation } from '../api/policies';
import { readBoundedText } from '../services/http';
import { readTicketsFor, scheduleReadMode, type ScheduleReadBindings } from './configuration';
import { partCharacters, representationDigest, representationVersion } from './storage';

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const unavailable = () => new AppError('INTERNAL_ERROR', 'The schedule is temporarily unavailable. Please try again.');
/** Only native crypto, fresh authority and a prepared representation execute here.
 * Selection/normalization/schema validation happen in the transactional writer.
 */
export async function readSchedule(request: Request, env: ScheduleReadBindings & { DB: D1Database }): Promise<Response> {
  try {
    if (new URL(request.url).pathname !== '/api/schedule') throw new AppError('NOT_FOUND', 'This endpoint is unavailable.');
    if (scheduleReadMode(env) !== 'enabled') throw new AppError('NOT_FOUND', 'This endpoint is unavailable.');
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new AppError('INVALID_REQUEST', 'Use a JSON POST request.');
    }
    let raw: unknown;
    try { raw = JSON.parse(await readBoundedText(new Response(request.body, { headers: request.headers }), 65536)); }
    catch { throw new AppError('INVALID_REQUEST', 'Expected a JSON request no larger than 64 KiB.'); }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new AppError('INVALID_REQUEST', 'Invalid schedule request.');
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some(key => !['credential','operation','payload','expectedRevision','idempotencyKey'].includes(key))
      || !['credential','operation','payload'].every(key => Object.hasOwn(body, key)) || body.operation !== 'admin.schedule.read'
      || typeof body.credential !== 'string' || !body.credential || !body.payload || typeof body.payload !== 'object'
      || Array.isArray(body.payload) || Object.keys(body.payload).length
      || (Object.hasOwn(body, 'expectedRevision') && (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0))
      || (Object.hasOwn(body, 'idempotencyKey') && (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey))) throw new AppError('INVALID_REQUEST', 'Invalid schedule request.');
    console.info('Scheduling API operation:', 'admin.schedule.read');
    const identity = await readTicketsFor(env, body.credential.startsWith('r2.') ? 'session' : 'schedule')!.verify(body.credential, Date.now());
    const [users, manifests, parts] = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare(`SELECT ${accountColumns} FROM users WHERE id=? AND lower(trim(email))=?`)
        .bind(identity.accountId, identity.email),
      env.DB.prepare(`SELECT m.*, COALESCE((SELECT value FROM meta WHERE key='dataRevision'),'0') AS data_revision,
        COALESCE((SELECT value FROM meta WHERE key='schedulingInputRevision'),'0') AS scheduling_revision,
        (SELECT value FROM meta WHERE key='scheduleViewRevision') AS current_version FROM schedule_read_manifest m WHERE id='schedule'`),
      env.DB.prepare('SELECT part,body FROM schedule_read_parts ORDER BY part'),
    ]);
    const stored = users?.results[0];
    if (!stored) throw new AppError('UNAUTHORIZED', 'This account is not active.');
    const user = storedAccount(stored);
    if (!user.active) throw new AppError('UNAUTHORIZED', 'This account is not active.');
    if (!canUseOperation(user, 'admin.schedule.read')) throw new AppError('FORBIDDEN', 'Your account cannot read this schedule.');
    const manifest = manifests?.results[0], rows = parts?.results;
    if (!manifest || manifest.schema_version !== representationVersion || !rows || !rows.length
      || revision(manifest.part_count) !== rows.length || revision(manifest.source_version) !== revision(manifest.current_version)
      || typeof manifest.digest !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.digest)) throw unavailable();
    const input = manifest.input_revision === null ? null : revision(manifest.input_revision);
    const dataRevision = revision(manifest.data_revision), schedulingInputRevision = revision(manifest.scheduling_revision);
    const fragments = rows.map((row, index) => {
      if (row.part !== index || typeof row.body !== 'string' || row.body.length > partCharacters) throw unavailable();
      return row.body;
    });
    const core = fragments.join('');
    if (!core.startsWith('{') || !core.endsWith('}') || await representationDigest(core, input) !== manifest.digest) throw unavailable();
    const stale = input === null || input < schedulingInputRevision;
    return new Response(`{"ok":true,"data":${core.slice(0, -1)},"stale":${stale},"dataRevision":${dataRevision},"schedulingInputRevision":${schedulingInputRevision}}}`, { headers });
  } catch (error) {
    const failure = error instanceof AppError ? error : unavailable();
    const status = failure.code === 'UNAUTHORIZED' ? 401 : failure.code === 'FORBIDDEN' ? 403
      : failure.code === 'INVALID_REQUEST' ? 400 : failure.code === 'NOT_FOUND' ? 404 : 500;
    return new Response(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }), { status, headers });
  }
}
