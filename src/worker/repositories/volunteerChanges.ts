import { volunteerChangeFields, volunteerChangeKinds, type VolunteerChange, type VolunteerChangeCursor } from '../../shared/domain/models';
import { storageError, type CommitStatement } from './database';

export const VOLUNTEER_CHANGE_PAGE_SIZE = 50;

/** The history is append-only and outside the snapshot diff, so each entry is its own INSERT in the commit batch. */
export function volunteerChangeStatement(change: VolunteerChange): CommitStatement {
  return {
    sql: `INSERT INTO volunteer_changes (id, occurred_at, actor_id, actor_email, volunteer_id, volunteer_name, kind, changed_fields)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    values: [change.id, change.occurredAt, change.actorId, change.actorEmail, change.volunteerId, change.volunteerName, change.kind, JSON.stringify(change.changedFields)],
  };
}

interface StoredChange { id: string; occurred_at: string; actor_id: string; actor_email: string; volunteer_id: string; volunteer_name: string; kind: string; changed_fields: string }

/** One bounded page, newest first. Ties on the timestamp fall back to descending id, matching the index. */
export async function readVolunteerChangePage(db: D1Database, before: VolunteerChangeCursor | null): Promise<{ changes: VolunteerChange[]; older: VolunteerChangeCursor | null }> {
  const where = before ? 'WHERE occurred_at < ?1 OR (occurred_at = ?1 AND id < ?2)' : '';
  const statement = db.prepare(`SELECT id, occurred_at, actor_id, actor_email, volunteer_id, volunteer_name, kind, changed_fields
    FROM volunteer_changes ${where} ORDER BY occurred_at DESC, id DESC LIMIT ${VOLUNTEER_CHANGE_PAGE_SIZE + 1}`);
  const { results } = await (before ? statement.bind(before.occurredAt, before.id) : statement).all<StoredChange>();
  const page = results.slice(0, VOLUNTEER_CHANGE_PAGE_SIZE).map((row): VolunteerChange => {
    if (!(volunteerChangeKinds as readonly string[]).includes(row.kind)) throw storageError();
    const changedFields: unknown = JSON.parse(row.changed_fields);
    if (!Array.isArray(changedFields) || changedFields.some(item => !(volunteerChangeFields as readonly string[]).includes(item?.field))) throw storageError();
    return { id: row.id, occurredAt: row.occurred_at, actorId: row.actor_id, actorEmail: row.actor_email, volunteerId: row.volunteer_id, volunteerName: row.volunteer_name, kind: row.kind as VolunteerChange['kind'], changedFields: changedFields as VolunteerChange['changedFields'] };
  });
  const last = page.at(-1);
  return { changes: page, older: results.length > page.length && last ? { occurredAt: last.occurredAt, id: last.id } : null };
}
