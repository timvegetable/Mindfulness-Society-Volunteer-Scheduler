import { AppError } from '../../shared/api/errors';
import type { InsightInput } from '../../shared/domain/insights';
import { accountColumns, storedAccount, storedRevision } from '../scheduleRead/accounts';

/** Read current authority and the calculation's fields in one transactional batch.
 * Historical runs remain inputs to the shared current-run selection rule; their
 * assignment/backup lists, shortfalls and diagnostics are not needed here.
 */
export async function readInsightsData(db: D1Database, identity: { accountId: string; email: string }) {
  const results = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT ${accountColumns} FROM users WHERE id=? AND lower(trim(email))=? AND active=1`).bind(identity.accountId, identity.email),
    db.prepare(`SELECT id,name,email,lifecycle_status AS lifecycleStatus,interview_status AS interviewStatus,
      readiness_rank AS readinessRank,source,created_at AS createdAt,updated_at AS updatedAt FROM volunteers ORDER BY id`),
    db.prepare(`SELECT volunteer_id AS volunteerId,weekday,start_time AS start,end_time AS end,time_zone AS timeZone
      FROM recurring_availability ORDER BY id`),
    db.prepare('SELECT id,status,output_revision AS outputRevision FROM scheduling_runs ORDER BY id'),
    db.prepare('SELECT volunteer_id AS volunteerId,schedule_revision AS scheduleRevision,status FROM assignments ORDER BY id'),
    db.prepare("SELECT key,value FROM meta WHERE key IN ('dataRevision','schedulingInputRevision')"),
  ]);
  if (results.length !== 6 || results.some(result => !result.success || !Array.isArray(result.results))) throw new AppError('INTERNAL_ERROR', 'Stored data is invalid.');
  const meta = new Map(results[5]!.results.map(row => [row.key, row.value]));
  return { users: results[0]!.results.map(storedAccount), input: {
    volunteers: results[1]!.results, recurringAvailability: results[2]!.results,
    schedulingRuns: results[3]!.results, assignments: results[4]!.results,
  } as unknown as InsightInput,
  dataRevision: storedRevision(meta.get('dataRevision') ?? 0), schedulingInputRevision: storedRevision(meta.get('schedulingInputRevision') ?? 0) };
}
