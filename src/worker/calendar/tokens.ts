import type { CalendarSubscription } from '../../shared/domain/models';
import { encodeBase64Url } from '../../shared/base64url';

const textEncoder = new TextEncoder();
const tokenLength = 32;

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid calendar credential encoding.');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeKey(value: string | undefined): Uint8Array {
  if (!value) throw new Error('Calendar links are not configured.');
  const bytes = decodeBase64Url(value);
  if (bytes.length !== tokenLength || encodeBase64Url(bytes) !== value) throw new Error('Calendar links are not configured.');
  return bytes;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function encryptionKey(value: string | undefined): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', ownedBuffer(decodeKey(value)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function hashCalendarToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(token));
  return encodeBase64Url(new Uint8Array(digest));
}

export async function createCalendarToken(secret: string | undefined, volunteerId: string): Promise<{
  token: string; tokenHash: string; tokenCiphertext: string; tokenIv: string;
}> {
  const key = await encryptionKey(secret);
  const random = crypto.getRandomValues(new Uint8Array(tokenLength));
  const token = encodeBase64Url(random);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: textEncoder.encode(`calendar-subscription:${volunteerId}`),
  }, key, textEncoder.encode(token));
  return { token, tokenHash: await hashCalendarToken(token), tokenCiphertext: encodeBase64Url(new Uint8Array(encrypted)), tokenIv: encodeBase64Url(iv) };
}

export async function recoverCalendarToken(secret: string | undefined, subscription: CalendarSubscription): Promise<string> {
  if (!subscription.enabled || !subscription.tokenHash || !subscription.tokenCiphertext || !subscription.tokenIv) {
    throw new Error('The calendar link is unavailable.');
  }
  const key = await encryptionKey(secret);
  const decrypted = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: ownedBuffer(decodeBase64Url(subscription.tokenIv)),
    additionalData: textEncoder.encode(`calendar-subscription:${subscription.volunteerId}`),
  }, key, ownedBuffer(decodeBase64Url(subscription.tokenCiphertext)));
  const token = new TextDecoder().decode(decrypted);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || await hashCalendarToken(token) !== subscription.tokenHash) {
    throw new Error('The calendar link is unavailable.');
  }
  return token;
}
