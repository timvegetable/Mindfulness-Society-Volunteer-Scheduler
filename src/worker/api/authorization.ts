import { AppError } from '../../shared/api/errors';
import type { Operation } from '../../shared/api/operations';
import type { User } from '../../shared/domain/models';
import type { VerifiedIdentity } from '../services/AuthService';
import { canUseOperation } from './policies';
import { decodeUser } from './validation';
/** Resolve current D1 authority; signed principals never carry cached permissions. */
export function authorizedAccount(users: readonly User[], identity: VerifiedIdentity, operation: Operation): User {
  const user = users.find(row => row.active && (identity.accountId === undefined || row.id === identity.accountId)
    && row.email.trim().toLowerCase() === identity.email.toLowerCase());
  if (!user) throw new AppError('UNAUTHORIZED', 'This account is not active.');
  try { decodeUser(user); }
  catch { throw new AppError('INTERNAL_ERROR', 'Stored account data is invalid.'); }
  if (!canUseOperation(user, operation)) throw new AppError('FORBIDDEN', 'Your account cannot perform this operation.');
  return user;
}
