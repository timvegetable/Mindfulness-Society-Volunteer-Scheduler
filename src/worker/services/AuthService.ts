import { Context, Effect, Layer } from 'effect';
import { AppError } from '../../shared/api/errors';
import { makeGoogleVerifier, type VerifiedIdentity } from './GoogleVerifier';
export type { VerifiedIdentity } from './GoogleVerifier';
export class AuthService extends Context.Service<AuthService, {
  readonly verify: (credential: string) => Effect.Effect<VerifiedIdentity, AppError>;
}>()('AuthService') {}
export function makeGoogleAuth(config: Parameters<typeof makeGoogleVerifier>[0]) {
  const verify = makeGoogleVerifier(config);
  return AuthService.of({ verify: credential => Effect.tryPromise({ try: () => verify(credential),
    catch: () => new AppError('UNAUTHORIZED', 'A valid Google sign-in credential is required.') }) });
}
export const googleAuthLayer = (config: Parameters<typeof makeGoogleAuth>[0]) => Layer.succeed(AuthService, makeGoogleAuth(config));
