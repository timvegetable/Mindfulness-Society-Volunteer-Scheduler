import { makeSignedTokens } from './signedTokens';
import { AppError } from '../../shared/api/errors';
import type { User } from '../../shared/domain/models';

const lifetime = 15 * 60;
interface Protocol { version: string; issuer: string; purpose: string }
export interface ReadIdentity { accountId: string; email: string; expiresAt: number }
export interface ReadTicket { credential: string; expiresAt: number }
export interface TicketOptions { secret: string; audience: string; previousSecret?: string; previousFrom?: number; previousUntil?: number }
export interface ReadTickets {
  issue: (user: Pick<User, 'id' | 'email'>, googleExpiry: number, now: number) => Promise<ReadTicket>;
  verify: (credential: string, now: number) => Promise<ReadIdentity>;
}
const denied = () => new AppError('UNAUTHORIZED', 'Your schedule session expired or is invalid. Please sign in again.');
/** Caches cryptographic keys only. Identity and authorization are never cached. */
export const makeReadTickets = (options: TicketOptions): ReadTickets => makeTickets(options, { version: 'r1', issuer: 'umd-scheduler-read-v1', purpose: 'admin.schedule.read' });
export const makeReadSessionTickets = (options: TicketOptions): ReadTickets => makeTickets(options, { version: 'r2', issuer: 'umd-scheduler-read-v2', purpose: 'api.read' });
function makeTickets(options: TicketOptions, protocol: Protocol): ReadTickets {
  const tokens = makeSignedTokens(options, protocol.version);
  return {
    async issue(user, googleExpiry, now) {
      if (!Number.isSafeInteger(now) || now < 0) throw denied();
      const iat = Math.floor(now / 1000);
      if (!Number.isSafeInteger(googleExpiry) || googleExpiry <= iat || !user.id || !user.email.trim()) throw denied();
      const exp = Math.min(googleExpiry, iat + lifetime);
      const credential = await tokens.sign({ iss: protocol.issuer, aud: options.audience, purpose: protocol.purpose,
        sub: user.id, email: user.email.trim().toLowerCase(), iat, exp });
      return { credential, expiresAt: exp * 1000 };
    },
    async verify(credential, now) {
      try {
        const claims = await tokens.verify(credential, now);
        if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) throw denied();
        const c = claims as Record<string, unknown>;
        if (Object.keys(c).sort().join(',') !== 'aud,email,exp,iat,iss,purpose,sub'
          || c.iss !== protocol.issuer || c.aud !== options.audience || c.purpose !== protocol.purpose
          || typeof c.sub !== 'string' || !c.sub || typeof c.email !== 'string' || !c.email
          || c.email !== c.email.trim().toLowerCase() || !Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp)
          || (c.iat as number) > Math.floor(now / 1000) || (c.exp as number) <= now / 1000
          || (c.exp as number) <= (c.iat as number) || (c.exp as number) - (c.iat as number) > lifetime) throw denied();
        return { accountId: c.sub, email: c.email, expiresAt: (c.exp as number) * 1000 };
      } catch { throw denied(); }
    },
  };
}
