import { restoreLegacyParticipants } from './tables';
import { AppError } from '../../shared/api/errors';
import { emptySyncStatus } from '../../shared/domain/models';
import { importHistorySummary, type ImportSummaryInput } from '../../shared/domain/synchronizationView';
import { accountColumns, storedAccount, storedRevision } from '../scheduleRead/accounts';
import { latestJobStatement, jobSummary, type SyncJob } from './synchronizationJobs';

/** A single transactional read of current authority and only the fields this view exposes. */
export async function readSyncStatusData(db: D1Database, identity: { accountId: string; email: string }) {
  const results = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT ${accountColumns} FROM users WHERE id=? AND lower(trim(email))=? AND active=1`).bind(identity.accountId, identity.email),
    db.prepare(`SELECT last_attempt_at AS lastAttemptAt,last_success_at AS lastSuccessAt,effective_change_at AS effectiveChangeAt,
      outcome,diagnostic,participant_count AS participantCount,matched_count AS matchedCount,pending_count AS pendingCount,pending
      FROM synchronizations WHERE id='whenIsGood'`),
    db.prepare(`SELECT id,status,started_at AS startedAt,actor_id AS actorId,participant_count AS participantCount,matched_count AS matchedCount,
      CASE WHEN participant_count IS NULL THEN COALESCE(staged_availability,'[]') ELSE NULL END AS legacyStagedAvailability
      FROM imports ORDER BY rowid`),
    db.prepare('SELECT id,name,email FROM volunteers ORDER BY id'),
    db.prepare("SELECT key,value FROM meta WHERE key IN ('dataRevision','schedulingInputRevision')"),
    latestJobStatement(db),
  ]);
  if (results.length !== 6 || results.some(result => !result.success || !Array.isArray(result.results))) throw new AppError('INTERNAL_ERROR', 'Stored data is invalid.');
  const statusRow = results[1]!.results[0];
  let status: unknown = emptySyncStatus(), pending: unknown = [];
  if (statusRow) {
    const { pending: storedPending, ...fields } = statusRow;
    if (typeof storedPending !== 'string') throw new AppError('INTERNAL_ERROR', 'Stored data is invalid.');
    pending = JSON.parse(storedPending); status = fields;
  }
  const meta = new Map(results[4]!.results.map(row => [row.key, row.value]));
  const job = results[5]!.results[0] as unknown as SyncJob | undefined;
  return { users: results[0]!.results.map(storedAccount), data: {
    status, pending, imports: results[2]!.results.map(row => {
      let stagedCount: number | null = null;
      if (row.participantCount === null) {
        if (typeof row.legacyStagedAvailability !== 'string') throw new AppError('INTERNAL_ERROR', 'Stored data is invalid.');
        const staged: unknown = JSON.parse(row.legacyStagedAvailability);
        if (!Array.isArray(staged)) throw new AppError('INTERNAL_ERROR', 'Stored data is invalid.');
        stagedCount = restoreLegacyParticipants(staged).length;
      }
      return importHistorySummary({ ...row, stagedCount } as unknown as ImportSummaryInput);
    }),
    volunteers: results[3]!.results, job: job ? jobSummary(job) : null,
    dataRevision: storedRevision(meta.get('dataRevision') ?? 0), schedulingInputRevision: storedRevision(meta.get('schedulingInputRevision') ?? 0),
  } };
}
