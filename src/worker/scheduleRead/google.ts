import { makeGoogleVerifier } from '../services/GoogleVerifier';
let cached: { audience: string; verify: ReturnType<typeof makeGoogleVerifier> } | undefined;
/** Shared provider-key freshness; no verified identities or account authority cached. */
export function verifyGoogle(credential: string, audience: string) {
  if (cached?.audience !== audience) cached = { audience, verify: makeGoogleVerifier({ audience, fetch, now: () => Date.now() }) };
  return cached.verify(credential);
}
