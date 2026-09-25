/**
 * Minimal JOSE primitives for the staging slice, built on WebCrypto only.
 *
 * The Worker runtime has no Node `crypto`, so nothing here may import one. The
 * functions are deliberately narrow: RS256 signing and verification, PKCS#8
 * private-key import, JWK public-key import, and base64url encoding. They carry
 * no policy — claim validation stays in the shared `createJwtClaimVerifier`.
 */

/** A `fetch(…)` compatible function, injected so tests never touch the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const RSA_PARAMETERS = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

export class JwtFormatError extends Error {
  constructor(message = 'Credential is not a valid JWT.') {
    super(message);
    this.name = 'JwtFormatError';
  }
}

function base64ToBytes(value: string): Uint8Array {
  const padded = value.padEnd(Math.ceil(value.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new JwtFormatError();
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64UrlToBytes(value: string): Uint8Array {
  return base64ToBytes(value.replace(/-/g, '+').replace(/_/g, '/'));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/** Splits a compact JWS and returns its signing input plus signature bytes. */
export function splitJws(token: string): { signingInput: string; signature: Uint8Array } {
  const pieces = token.split('.');
  if (pieces.length !== 3 || !pieces[0] || !pieces[2]) throw new JwtFormatError();
  return { signingInput: `${pieces[0]}.${pieces[1]}`, signature: base64UrlToBytes(pieces[2]) };
}

/** Decodes the JOSE header. The header is untrusted until the signature verifies. */
export function decodeJoseHeader(token: string): { alg: string; kid?: string } {
  const pieces = token.split('.');
  if (pieces.length !== 3 || !pieces[0] || !pieces[1]) throw new JwtFormatError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(pieces[0])));
  } catch {
    throw new JwtFormatError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new JwtFormatError();
  const header = parsed as { alg?: unknown; kid?: unknown };
  if (typeof header.alg !== 'string' || header.alg.length === 0) throw new JwtFormatError();
  if (header.kid !== undefined && (typeof header.kid !== 'string' || header.kid.length === 0)) throw new JwtFormatError();
  return { alg: header.alg, ...(header.kid === undefined ? {} : { kid: header.kid }) };
}

/** Verifies an RS256 JWS signature. Returns false rather than throwing on mismatch. */
export async function verifyRs256(token: string, key: CryptoKey): Promise<boolean> {
  let signingInput: string;
  let signature: Uint8Array;
  try {
    ({ signingInput, signature } = splitJws(token));
  } catch {
    return false;
  }
  try {
    return await crypto.subtle.verify(RSA_PARAMETERS, key, signature, new TextEncoder().encode(signingInput));
  } catch {
    return false;
  }
}

export async function signRs256(signingInput: string, key: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign(RSA_PARAMETERS, key, new TextEncoder().encode(signingInput));
  return base64UrlEncode(new Uint8Array(signature));
}

/** Imports a PKCS#8 PEM private key. The key material is never echoed in an error. */
export async function importPkcs8PrivateKey(pem: string): Promise<CryptoKey> {
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/.exec(pem);
  if (!match?.[1]) throw new Error('The service-account private key is not a PKCS#8 PEM key.');
  let der: Uint8Array;
  try {
    der = base64ToBytes(match[1].replace(/\s+/g, ''));
  } catch {
    throw new Error('The service-account private key is not valid base64.');
  }
  try {
    return await crypto.subtle.importKey('pkcs8', der, RSA_PARAMETERS, false, ['sign']);
  } catch {
    throw new Error('The service-account private key could not be imported.');
  }
}

/** Imports an RSA public key from a JWKS entry. */
export async function importJwkPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  if (jwk.kty !== 'RSA') throw new Error('The identity provider returned a non-RSA signing key.');
  return await crypto.subtle.importKey('jwk', jwk, RSA_PARAMETERS, false, ['verify']);
}
