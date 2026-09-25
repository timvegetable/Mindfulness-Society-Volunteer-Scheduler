import { createJwtClaimVerifier, type VerifiedIdentityClaims } from '../../server/integration/auth.js';
import { decodeJoseHeader, verifyRs256 } from './jwt.js';
import type { GoogleKeyStore } from './jwks.js';

/**
 * Google ID-token verification for the Worker runtime.
 *
 * The Apps Script path asks Google's `tokeninfo` endpoint to validate the
 * signature. The Worker verifies the RS256 signature itself against Google's
 * published key set and then applies the *same* shared claim validator the Apps
 * Script path uses, so issuer, audience, expiry, `email_verified` and subject
 * rules cannot drift between the two runtimes.
 */

export type AsyncTokenVerifier = {
  verify(token: string): Promise<VerifiedIdentityClaims>;
};

export type GoogleIdTokenVerifierOptions = Readonly<{
  audience: string;
  keys: GoogleKeyStore;
  /** Milliseconds since the epoch; converted to the seconds the claim validator uses. */
  nowMs?: () => number;
  clockSkewSeconds?: number;
  requireEmailVerified?: boolean;
}>;

export function createGoogleIdTokenVerifier(options: GoogleIdTokenVerifierOptions): AsyncTokenVerifier {
  if (!options.audience.trim()) throw new Error('A token audience is required.');

  return {
    async verify(token: string): Promise<VerifiedIdentityClaims> {
      const header = decodeJoseHeader(token);
      // Pin the algorithm: accepting whatever the token advertises is how an
      // `alg: none` or HMAC token gets treated as a signed one.
      if (header.alg !== 'RS256') throw new Error('Credential algorithm is not accepted.');
      const candidates = await options.keys.verificationKeys(header.kid);
      let signatureVerified = false;
      for (const key of candidates) {
        if (await verifyRs256(token, key)) {
          signatureVerified = true;
          break;
        }
      }
      if (!signatureVerified) throw new Error('Credential signature is invalid.');

      // The claim validator is handed a signature check that can only be
      // satisfied by the verification performed immediately above, so removing
      // or reordering that check fails closed instead of silently trusting the
      // token's claims.
      const claimVerifier = createJwtClaimVerifier({
        audience: options.audience,
        clock: () => Math.floor((options.nowMs ?? (() => Date.now()))() / 1000),
        verifySignature: () => signatureVerified,
        ...(options.clockSkewSeconds === undefined ? {} : { clockSkewSeconds: options.clockSkewSeconds }),
        ...(options.requireEmailVerified === undefined ? {} : { requireEmailVerified: options.requireEmailVerified })
      });
      return claimVerifier.verify(token);
    }
  };
}
