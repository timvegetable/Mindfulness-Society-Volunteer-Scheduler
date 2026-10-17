import { AppError } from '../../shared/api/errors';
import type { User } from '../../shared/domain/models';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const lifetime = 15 * 60;
const issuer = 'umd-scheduler-read-v1';
const purpose = 'admin.schedule.read';
const keyPattern = /^[a-f0-9]{64}$/;
export interface ReadIdentity { accountId: string; email: string; expiresAt: number }
export interface ReadTicket { credential: string; expiresAt: number }
export interface TicketOptions { secret: string; audience: string; previousSecret?: string; previousFrom?: number; previousUntil?: number }
export interface ReadTickets {
  issue: (user: Pick<User, 'id' | 'email'>, googleExpiry: number, now: number) => Promise<ReadTicket>;
  verify: (credential: string, now: number) => Promise<ReadIdentity>;
}
const denied = () => new AppError('UNAUTHORIZED', 'Your schedule session expired or is invalid. Please sign in again.');
function base64(bytes: Uint8Array): string {
  let value = ''; for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw denied();
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  if (base64(bytes) !== value) throw denied();
  return bytes;
}
function key(secret: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(secret.match(/../g)!, value => Number.parseInt(value, 16));
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
/** Caches cryptographic keys only. Identity and authorization are never cached. */
export function makeReadTickets(options: TicketOptions): ReadTickets {
  if (!keyPattern.test(options.secret) || !options.audience.trim()
    || (options.previousSecret !== undefined && (!keyPattern.test(options.previousSecret)
      || !Number.isSafeInteger(options.previousFrom) || !Number.isSafeInteger(options.previousUntil)
      || options.previousUntil! <= options.previousFrom! || options.previousUntil! - options.previousFrom! > lifetime * 1000))) throw new Error('Invalid schedule read key configuration');
  let current: Promise<CryptoKey> | undefined, previous: Promise<CryptoKey> | undefined;
  const currentKey = () => current ??= key(options.secret);
  return {
    async issue(user, googleExpiry, now) {
      if (!Number.isSafeInteger(now) || now < 0) throw denied();
      const iat = Math.floor(now / 1000);
      if (!Number.isSafeInteger(googleExpiry) || googleExpiry <= iat || !user.id || !user.email.trim()) throw denied();
      const exp = Math.min(googleExpiry, iat + lifetime);
      const payload = base64(encoder.encode(JSON.stringify({ iss: issuer, aud: options.audience, purpose,
        sub: user.id, email: user.email.trim().toLowerCase(), iat, exp })));
      const signature = await crypto.subtle.sign('HMAC', await currentKey(), encoder.encode(`r1.${payload}`));
      return { credential: `r1.${payload}.${base64(new Uint8Array(signature))}`, expiresAt: exp * 1000 };
    },
    async verify(credential, now) {
      try {
        if (!Number.isSafeInteger(now) || now < 0) throw denied();
        if (typeof credential !== 'string' || credential.length > 8192) throw denied();
        const [version, payload, signature, ...extra] = credential.split('.');
        if (version !== 'r1' || !payload || !signature || extra.length) throw denied();
        const bytes = unbase64(signature);
        if (bytes.length !== 32) throw denied();
        const signed = encoder.encode(`r1.${payload}`);
        let valid = await crypto.subtle.verify('HMAC', await currentKey(), bytes, signed);
        if (!valid && options.previousSecret && options.previousFrom! <= now && options.previousUntil! > now) {
          previous ??= key(options.previousSecret);
          valid = await crypto.subtle.verify('HMAC', await previous, bytes, signed);
        }
        if (!valid) throw denied();
        const claims: unknown = JSON.parse(decoder.decode(unbase64(payload)));
        if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) throw denied();
        const c = claims as Record<string, unknown>;
        if (Object.keys(c).sort().join(',') !== 'aud,email,exp,iat,iss,purpose,sub'
          || c.iss !== issuer || c.aud !== options.audience || c.purpose !== purpose
          || typeof c.sub !== 'string' || !c.sub || typeof c.email !== 'string' || !c.email
          || c.email !== c.email.trim().toLowerCase() || !Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp)
          || (c.iat as number) > Math.floor(now / 1000) || (c.exp as number) <= now / 1000
          || (c.exp as number) <= (c.iat as number) || (c.exp as number) - (c.iat as number) > lifetime) throw denied();
        return { accountId: c.sub, email: c.email, expiresAt: (c.exp as number) * 1000 };
      } catch { throw denied(); }
    },
  };
}
