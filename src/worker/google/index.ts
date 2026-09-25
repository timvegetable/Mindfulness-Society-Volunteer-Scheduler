import type { GoogleIdentityConfiguration } from '../config.js';
import { createGoogleIdTokenVerifier, type AsyncTokenVerifier } from './id-token.js';
import { createGoogleKeyStore } from './jwks.js';
import { createServiceAccountTokenProvider, type AccessTokenProvider } from './service-account.js';
import type { FetchLike } from './jwt.js';

export {
  GOOGLE_JWKS_URL,
  SigningKeyError,
  createGoogleKeyStore,
  type GoogleKeyStore,
  type GoogleKeyStoreStats
} from './jwks.js';
export { ASSERTION_LIFETIME_SECONDS, GOOGLE_TOKEN_ENDPOINT, SHEETS_READONLY_SCOPE, ServiceAccountTokenError, createServiceAccountTokenProvider, type AccessTokenProvider } from './service-account.js';
export { JwtFormatError, base64UrlEncode, base64UrlEncodeJson, decodeJoseHeader, importJwkPublicKey, importPkcs8PrivateKey, signRs256, splitJws, verifyRs256, type FetchLike } from './jwt.js';
export { createGoogleIdTokenVerifier, type AsyncTokenVerifier } from './id-token.js';

/**
 * The two Google credentials the slice needs, assembled over one injected
 * `fetch` so tests can drive both flows without a network.
 *
 * They are deliberately separate: verifying a browser's ID token uses Google's
 * public keys, while reading the workbook uses a service-account access token.
 * Sharing a cache between them would be a way to confuse the two identities.
 */
export type GoogleDependencies = Readonly<{
  verifier: AsyncTokenVerifier;
  sheetsTokens: AccessTokenProvider;
}>;

export function createGoogleDependencies(
  configuration: GoogleIdentityConfiguration,
  options: Readonly<{ fetch: FetchLike; nowMs?: () => number }>
): GoogleDependencies {
  const shared = {
    fetch: options.fetch,
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs })
  };
  return {
    verifier: createGoogleIdTokenVerifier({
      audience: configuration.audience,
      keys: createGoogleKeyStore(shared),
      // The key store and the token provider take milliseconds, the claim
      // validator takes seconds; the verifier converts, so both flows share one
      // clock and cannot disagree about the time.
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs })
    }),
    sheetsTokens: createServiceAccountTokenProvider({
      clientEmail: configuration.clientEmail,
      privateKeyPem: configuration.privateKeyPem,
      ...shared
    })
  };
}
