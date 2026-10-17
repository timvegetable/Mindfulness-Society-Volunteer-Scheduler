import { Effect } from 'effect';
import { AppError } from '../../shared/api/errors';
import { AuthService } from './AuthService';
/** The signing key stays in the private Worker; every caller reloads current D1 authority. */
export function makeReadSessionAuth(service: Pick<Fetcher, 'fetch'>) {
  return AuthService.of({ verify: credential => Effect.tryPromise({
    try: async () => {
      const response = await service.fetch(new Request('https://read.internal/internal/read-session', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) }));
      if (response.status === 401) throw new AppError('UNAUTHORIZED', 'Your read session expired or is invalid. Please sign in again.');
      if (!response.ok) throw new AppError('INTERNAL_ERROR', 'Read authentication is temporarily unavailable.');
      const value = await response.json() as { ok?: unknown; kind?: unknown; identity?: { accountId?: unknown; email?: unknown; expiresAt?: unknown } };
      const identity = value.identity;
      if (value.ok !== true || value.kind !== 'api.read' || !identity || typeof identity.accountId !== 'string' || !identity.accountId
        || typeof identity.email !== 'string' || !identity.email || identity.email !== identity.email.trim().toLowerCase()
        || typeof identity.expiresAt !== 'number' || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= Date.now() / 1000) {
        throw new AppError('INTERNAL_ERROR', 'Read authentication returned an invalid response.');
      }
      return { accountId: identity.accountId, email: identity.email, expiresAt: identity.expiresAt };
    },
    catch: error => error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'Read authentication is temporarily unavailable.'),
  }) });
}
