import { Effect } from 'effect';
import { AppError } from '../../shared/api/errors';
import { AuthService } from './AuthService';
import { readSessionIdentity } from './ReadSessionIdentity';
/** Effect adapter for the same verified-principal interface used by small reads. */
export function makeReadSessionAuth(service: Pick<Fetcher, 'fetch'>) {
  return AuthService.of({ verify: credential => Effect.tryPromise({
    try: () => readSessionIdentity(service, credential),
    catch: error => error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'Read authentication is temporarily unavailable.'),
  }) });
}
