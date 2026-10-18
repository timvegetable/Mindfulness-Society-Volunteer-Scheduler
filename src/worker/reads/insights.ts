import { AppError } from '../../shared/api/errors';
import type { RequestEnvelope } from '../../shared/api/schemas';
import { computeInsights, type InsightOptions } from '../../shared/domain/insights';
import { authorizedAccount } from '../api/authorization';
import { decodePayload, decodeResult } from '../api/validation';
import { readInsightsData } from '../repositories/insightsRead';
import { readSessionIdentity } from '../services/ReadSessionIdentity';

/** Same authority, calculation, output contract and validation as generic dispatch. */
export async function readInsights(envelope: RequestEnvelope, db: D1Database, reader: Pick<Fetcher, 'fetch'>, options: InsightOptions): Promise<string> {
  console.info('Scheduling API operation:', 'admin.insights.read');
  const identity = await readSessionIdentity(reader, envelope.credential);
  const before = await readInsightsData(db, identity);
  authorizedAccount(before.users, identity, 'admin.insights.read');
  try { decodePayload('admin.insights.read', envelope.payload); }
  catch { throw new AppError('INVALID_REQUEST', 'Invalid operation payload.'); }
  const result = computeInsights(before.input, options);
  let data;
  try { data = decodeResult('admin.insights.read', { ...result, dataRevision: before.dataRevision,
    schedulingInputRevision: before.schedulingInputRevision }); }
  catch { throw new AppError('INTERNAL_ERROR', 'The operation produced an invalid response.'); }
  return JSON.stringify({ ok: true, data });
}
