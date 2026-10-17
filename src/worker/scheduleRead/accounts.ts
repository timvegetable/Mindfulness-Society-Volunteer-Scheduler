import { AppError } from '../../shared/api/errors';
import type { User } from '../../shared/domain/models';
import { roles } from '../../shared/domain/roles';
export const accountColumns = "id,email,COALESCE(roles,'[]') AS roles,volunteer_id,COALESCE(center_ids,'[]') AS center_ids,active";
export function storedRevision(value: unknown): number {
  if ((typeof value !== 'string' || !value.trim()) && typeof value !== 'number') throw new AppError('INTERNAL_ERROR', 'Stored data is invalid.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AppError('INTERNAL_ERROR', 'Stored data is invalid.');
  return parsed;
}
export function storedAccount(row: Record<string, unknown>): User {
  if (typeof row.id !== 'string' || !row.id || typeof row.email !== 'string' || !row.email
    || typeof row.roles !== 'string' || typeof row.center_ids !== 'string'
    || (row.volunteer_id !== null && (typeof row.volunteer_id !== 'string' || !row.volunteer_id))) throw new AppError('INTERNAL_ERROR', 'Stored data is invalid.');
  const assigned: unknown = JSON.parse(row.roles), centers: unknown = JSON.parse(row.center_ids);
  if (!Array.isArray(assigned) || assigned.some(role => !roles.includes(role))
    || !Array.isArray(centers) || centers.some(id => typeof id !== 'string' || !id)) throw new AppError('INTERNAL_ERROR', 'Stored data is invalid.');
  return { id: row.id, email: row.email, roles: assigned, centerIds: centers, volunteerId: row.volunteer_id, active: row.active === 1 };
}
