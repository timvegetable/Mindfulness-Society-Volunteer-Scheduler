import { AppError } from '../../shared/api/errors';
import type { TicketOptions } from './tickets';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const keyPattern = /^[a-f0-9]{64}$/;
const denied = () => new AppError('UNAUTHORIZED', 'Your sign-in session expired or is invalid. Please sign in again.');
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
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g)!, value => Number.parseInt(value, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
/** Cryptographic framing only; each protocol owns its exact claim validation. */
export function makeSignedTokens(options: TicketOptions, version: string) {
  if (!keyPattern.test(options.secret) || !options.audience.trim()
    || (options.previousSecret !== undefined && (!keyPattern.test(options.previousSecret)
      || !Number.isSafeInteger(options.previousFrom) || !Number.isSafeInteger(options.previousUntil)
      || options.previousUntil! <= options.previousFrom! || options.previousUntil! - options.previousFrom! > 900000))) throw new Error('Invalid schedule read key configuration');
  let current: Promise<CryptoKey> | undefined, previous: Promise<CryptoKey> | undefined;
  const currentKey = () => current ??= key(options.secret);
  return {
    async sign(claims: Record<string, unknown>): Promise<string> {
      const payload = base64(encoder.encode(JSON.stringify(claims)));
      const signature = await crypto.subtle.sign('HMAC', await currentKey(), encoder.encode(`${version}.${payload}`));
      return `${version}.${payload}.${base64(new Uint8Array(signature))}`;
    },
    async verify(credential: string, now: number): Promise<unknown> {
      try {
        if (!Number.isSafeInteger(now) || now < 0 || typeof credential !== 'string' || credential.length > 8192) throw denied();
        const [prefix, payload, signature, ...extra] = credential.split('.');
        if (prefix !== version || !payload || !signature || extra.length) throw denied();
        const bytes = unbase64(signature);
        if (bytes.length !== 32) throw denied();
        const signed = encoder.encode(`${version}.${payload}`);
        let valid = await crypto.subtle.verify('HMAC', await currentKey(), bytes, signed);
        if (!valid && options.previousSecret && options.previousFrom! <= now && options.previousUntil! > now) {
          previous ??= key(options.previousSecret);
          valid = await crypto.subtle.verify('HMAC', await previous, bytes, signed);
        }
        if (!valid) throw denied();
        return JSON.parse(decoder.decode(unbase64(payload)));
      } catch { throw denied(); }
    },
  };
}
