import { AppError } from '../../shared/api/errors';
import { makeSignedTokens } from './signedTokens';
import type { TicketOptions, ReadTicket } from './tickets';
import type { VerifiedIdentity } from '../services/GoogleVerifier';
const issuer = 'umd-scheduler-google-proof-v1';
const purpose = 'session.exchange';
const denied = () => new AppError('UNAUTHORIZED', 'Your sign-in proof expired or is invalid. Please sign in again.');
export interface IdentityProofs {
  issue(identity: VerifiedIdentity, now: number): Promise<ReadTicket>;
  verify(credential: string, now: number): Promise<VerifiedIdentity>;
}
/** Proves Google verification only; carries no application account or permissions. */
export function makeIdentityProofs(options: TicketOptions): IdentityProofs {
  const tokens = makeSignedTokens(options, 'g1');
  return {
    async issue(identity, now) {
      const iat = Math.floor(now / 1000);
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= iat
        || !identity.email || identity.email !== identity.email.trim().toLowerCase()) throw denied();
      const exp = Math.min(identity.expiresAt, iat + 60);
      const credential = await tokens.sign({ iss: issuer, aud: options.audience, purpose, email: identity.email,
        iat, exp, googleExp: identity.expiresAt });
      return { credential, expiresAt: exp * 1000 };
    },
    async verify(credential, now) {
      const claims = await tokens.verify(credential, now);
      if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) throw denied();
      const c = claims as Record<string, unknown>;
      if (Object.keys(c).sort().join(',') !== 'aud,email,exp,googleExp,iat,iss,purpose'
        || c.iss !== issuer || c.aud !== options.audience || c.purpose !== purpose
        || typeof c.email !== 'string' || !c.email || c.email !== c.email.trim().toLowerCase()
        || !Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp) || !Number.isSafeInteger(c.googleExp)
        || (c.iat as number) < 0 || (c.iat as number) > Math.floor(now / 1000) || (c.exp as number) <= now / 1000
        || (c.exp as number) <= (c.iat as number) || (c.exp as number) - (c.iat as number) > 60
        || (c.googleExp as number) < (c.exp as number)) throw denied();
      return { email: c.email, expiresAt: c.googleExp as number };
    },
  };
}
