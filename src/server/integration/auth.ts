import { z } from 'zod';
import type { Role, User } from '../../shared/domain.js';

export type Clock = () => number;

export type VerifiedIdentityClaims = Readonly<{
  iss: string;
  aud: string | readonly string[];
  sub: string;
  email: string;
  email_verified?: boolean;
  exp: number;
  iat?: number;
  name?: string;
}>;

export type TokenVerifier = {
  verify(token: string): VerifiedIdentityClaims | Promise<VerifiedIdentityClaims>;
};

export type UserDirectory = {
  findByEmail(email: string): User | undefined | Promise<User | undefined>;
};

export type AuthenticatedPrincipal = Readonly<{
  claims: VerifiedIdentityClaims;
  user: User;
  email: string;
}>;

export class AuthenticationError extends Error {
  readonly reason: 'missing' | 'invalid' | 'unknown-identity';

  constructor(reason: 'missing' | 'invalid' | 'unknown-identity', message = 'Authentication is required.') {
    super(message);
    this.name = 'AuthenticationError';
    this.reason = reason;
  }
}

const JwtPayloadSchema = z.object({
  iss: z.string().min(1),
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  exp: z.number().finite(),
  iat: z.number().finite().optional(),
  name: z.string().max(200).optional()
}).passthrough();

const JwtHeaderSchema = z.object({ alg: z.string().min(1), typ: z.string().optional() }).passthrough();

type JwtHeader = z.infer<typeof JwtHeaderSchema>;
type JwtPayload = z.infer<typeof JwtPayloadSchema>;

export type JwtClaimVerifierOptions = Readonly<{
  audience: string;
  issuer?: string | readonly string[];
  clock?: Clock;
  clockSkewSeconds?: number;
  requireEmailVerified?: boolean;
  verifySignature?: (token: string, header: JwtHeader, claims: VerifiedIdentityClaims) => boolean | Promise<boolean>;
}>;

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  if (typeof globalThis.atob === 'function') return globalThis.atob(normalized);
  const bufferApi = (globalThis as { Buffer?: { from(value: string, encoding: string): { toString(encoding: string): string } } }).Buffer;
  if (bufferApi) return bufferApi.from(normalized, 'base64').toString('utf8');
  throw new Error('Base64 decoding is unavailable.');
}

function parseJwtPart<T>(encoded: string, schema: z.ZodType<T>): T {
  try {
    const parsed: unknown = JSON.parse(decodeBase64Url(encoded));
    const result = schema.safeParse(parsed);
    if (!result.success) throw new Error('JWT claim shape is invalid.');
    return result.data;
  } catch {
    throw new Error('Credential is not a valid JWT.');
  }
}

function audienceMatches(actual: string | readonly string[], expected: string): boolean {
  return typeof actual === 'string' ? actual === expected : actual.includes(expected);
}

function issuerMatches(actual: string, expected: string | readonly string[] | undefined): boolean {
  if (!expected) return actual === 'https://accounts.google.com' || actual === 'accounts.google.com';
  return typeof expected === 'string' ? actual === expected : expected.includes(actual);
}

/**
 * Validates the claims in a Google-style JWT. Signature verification is deliberately
 * injectable because Apps Script deployments may use a Google verifier while tests
 * and other runtimes can provide their own verifier. No role claim is read here;
 * roles always come from the Users directory.
 */
export function createJwtClaimVerifier(options: JwtClaimVerifierOptions): TokenVerifier {
  if (!options.audience.trim()) throw new Error('A token audience is required.');
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  const skew = options.clockSkewSeconds ?? 60;
  if (!Number.isFinite(skew) || skew < 0 || skew > 900) throw new Error('JWT clock skew is invalid.');
  const requireEmailVerified = options.requireEmailVerified ?? true;

  return {
    async verify(token: string): Promise<VerifiedIdentityClaims> {
      const pieces = token.split('.');
      if (pieces.length !== 3) throw new Error('Credential is not a valid JWT.');
      const header = parseJwtPart(pieces[0]!, JwtHeaderSchema);
      if (header.alg.toLowerCase() === 'none') throw new Error('Unsigned credentials are not accepted.');
      const payload = parseJwtPart(pieces[1]!, JwtPayloadSchema);
      if (!issuerMatches(payload.iss, options.issuer)) throw new Error('Credential issuer is invalid.');
      if (!audienceMatches(payload.aud, options.audience)) throw new Error('Credential audience is invalid.');
      const now = clock();
      if (payload.exp <= now - skew) throw new Error('Credential has expired.');
      if (payload.iat !== undefined && payload.iat > now + skew) throw new Error('Credential was issued in the future.');
      if (requireEmailVerified && payload.email_verified !== true) throw new Error('Credential email is not verified.');
      const claims: VerifiedIdentityClaims = {
        iss: payload.iss,
        aud: payload.aud,
        sub: payload.sub,
        email: payload.email.trim().toLowerCase(),
        ...(payload.email_verified === undefined ? {} : { email_verified: payload.email_verified }),
        exp: payload.exp,
        ...(payload.iat === undefined ? {} : { iat: payload.iat }),
        ...(payload.name === undefined ? {} : { name: payload.name })
      };
      if (options.verifySignature && !(await options.verifySignature(token, header, claims))) {
        throw new Error('Credential signature is invalid.');
      }
      return claims;
    }
  };
}

export class MemoryTokenVerifier implements TokenVerifier {
  private readonly credentials = new Map<string, VerifiedIdentityClaims>();

  constructor(entries: Readonly<Record<string, VerifiedIdentityClaims>> = {}) {
    for (const [token, claims] of Object.entries(entries)) this.credentials.set(token, claims);
  }

  set(token: string, claims: VerifiedIdentityClaims): void {
    this.credentials.set(token, claims);
  }

  verify(token: string): VerifiedIdentityClaims {
    const claims = this.credentials.get(token);
    if (!claims) throw new AuthenticationError('invalid');
    return claims;
  }
}

export class MemoryUserDirectory implements UserDirectory {
  private readonly users = new Map<string, User>();

  constructor(users: readonly User[] = []) {
    for (const user of users) this.users.set(normalizeEmail(user.email), user);
  }

  set(user: User): void {
    this.users.set(normalizeEmail(user.email), user);
  }

  findByEmail(email: string): User | undefined {
    return this.users.get(normalizeEmail(email));
  }

  list(): User[] {
    return [...this.users.values()].map((user) => ({ ...user, roles: [...user.roles], ...(user.centerIds ? { centerIds: [...user.centerIds] } : {}) }));
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function authenticateCredential(
  credential: string | undefined,
  verifier: TokenVerifier,
  users: UserDirectory
): Promise<AuthenticatedPrincipal> {
  if (!credential?.trim()) throw new AuthenticationError('missing');
  let claims: VerifiedIdentityClaims;
  try {
    claims = await verifier.verify(credential);
  } catch {
    throw new AuthenticationError('invalid');
  }
  const email = normalizeEmail(claims.email);
  const user = await users.findByEmail(email);
  if (!user || !user.active) throw new AuthenticationError('unknown-identity');
  return { claims, user, email };
}

export function hasRole(principal: AuthenticatedPrincipal, role: Role): boolean {
  return principal.user.roles.includes(role);
}

export function hasAnyRole(principal: AuthenticatedPrincipal, roles: readonly Role[]): boolean {
  return roles.some((role) => hasRole(principal, role));
}

export function centerScope(principal: AuthenticatedPrincipal): readonly string[] {
  return principal.user.centerIds ?? [];
}
