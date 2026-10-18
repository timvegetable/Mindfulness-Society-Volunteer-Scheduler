import { AppError } from '../../shared/api/errors';
import type { RequestEnvelope } from '../../shared/api/schemas';
import { authorizedAccount } from '../api/authorization';
import { decodePayload, decodeResult } from '../api/validation';
import { readOperationSnapshot } from '../repositories/database';
import { latestJob } from '../repositories/synchronizationJobs';
import { readSessionIdentity } from '../services/ReadSessionIdentity';
import { synchronizationView } from '../synchronization';
/** Preserve the shared projection/view/schema without acquiring the mutation runtime. */
export async function readSyncStatus(envelope: RequestEnvelope, db: D1Database, reader: Pick<Fetcher, 'fetch'>): Promise<string> {
  console.info('Scheduling API operation:', 'admin.sync.read');
  const identity = await readSessionIdentity(reader, envelope.credential);
  const before = await readOperationSnapshot(db, 'admin.sync.read');
  authorizedAccount(before.users, identity, 'admin.sync.read');
  try { decodePayload('admin.sync.read', envelope.payload); }
  catch { throw new AppError('INVALID_REQUEST', 'Invalid operation payload.'); }
  const job = await latestJob(db);
  let data;
  try { data = decodeResult('admin.sync.read', { ...synchronizationView(before), job,
    dataRevision: before.dataRevision, schedulingInputRevision: before.schedulingInputRevision }); }
  catch { throw new AppError('INTERNAL_ERROR', 'The operation produced an invalid response.'); }
  return JSON.stringify({ ok: true, data });
}
