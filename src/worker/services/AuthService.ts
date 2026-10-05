import { Context, Effect, Layer } from 'effect';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { AppError } from '../../shared/api/errors';
import { readBoundedText, type Fetch } from './http';

export interface VerifiedIdentity { email: string }
export class AuthService extends Context.Service<AuthService, {
  readonly verify: (credential: string) => Effect.Effect<VerifiedIdentity, AppError>;
}>()('AuthService') {}

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';

/** A per-runtime cache, respecting HTTP freshness and sharing in-flight fetches. */
export function makeGoogleAuth(config: { audience: string; fetch: Fetch; now: () => number }) {
  const fetcher = config.fetch;
  let cached: { keys: ReturnType<typeof createLocalJWKSet>; expiresAt: number } | undefined;
  let pending: Promise<ReturnType<typeof createLocalJWKSet>> | undefined;
  async function signingKeys() {
    if (cached && cached.expiresAt > config.now()) return cached.keys;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetcher(GOOGLE_JWKS, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Signing keys unavailable');
      const keys = createLocalJWKSet(JSON.parse(await readBoundedText(response, 256 * 1024)) as JSONWebKeySet);
      const control = response.headers.get('cache-control') ?? '';
      const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(control)?.[1];
      const age = Number(response.headers.get('age') ?? 0);
      const date = Date.parse(response.headers.get('date') ?? '');
      const expires = Date.parse(response.headers.get('expires') ?? '');
      const apparentAge = Number.isFinite(date) ? Math.max(0, (config.now() - date) / 1000) : 0;
      const lifetime = maxAge ? Number(maxAge) : Number.isFinite(expires) && Number.isFinite(date) ? (expires - date) / 1000 : 0;
      const remaining = /(?:^|,)\s*(?:no-store|no-cache)\b/i.test(control)
        ? 0 : Math.max(0, lifetime - Math.max(Number.isFinite(age) ? age : 0, apparentAge));
      cached = { keys, expiresAt: config.now() + remaining * 1000 };
      return keys;
    })();
    try { return await pending; } finally { pending = undefined; }
  }
  return AuthService.of({
    verify: credential => Effect.tryPromise({
      try: async () => {
        if (!credential || credential.length > 32_768 || !config.audience) throw new Error('Invalid credential');
        const { payload } = await jwtVerify(credential, await signingKeys(), {
          issuer: ['accounts.google.com', 'https://accounts.google.com'],
          audience: config.audience,
          algorithms: ['RS256'],
          requiredClaims: ['exp', 'email', 'email_verified'],
          currentDate: new Date(config.now()),
        });
        if (payload.email_verified !== true || typeof payload.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email.trim())) {
          throw new Error('Verified email required');
        }
        return { email: payload.email.trim().toLowerCase() };
      },
      catch: () => new AppError('UNAUTHORIZED', 'A valid Google sign-in credential is required.'),
    }),
  });
}

export const googleAuthLayer = (config: Parameters<typeof makeGoogleAuth>[0]) => Layer.succeed(AuthService, makeGoogleAuth(config));
