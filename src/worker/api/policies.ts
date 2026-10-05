import type { Role, User } from '../../shared/domain/models';
import { isMutation, operationRoles, operations, type Operation } from '../../shared/api/operations';

export const policies = Object.fromEntries(operations.map((operation) => [operation, { roles: operationRoles[operation], write: isMutation(operation) }])) as Record<Operation, { roles: readonly Role[]; write: boolean }>;
export type { Operation };
export function canUseOperation(user: User, operation: Operation): boolean {
  // Full administrative access still derives volunteer identity from the caller's link.
  return user.roles.includes('administrator') || user.roles.some((role) => (policies[operation].roles as readonly Role[]).includes(role));
}
export function canUseCenter(user: User, centerId: string): boolean {
  return user.roles.includes('administrator') || user.centerIds.includes(centerId);
}
