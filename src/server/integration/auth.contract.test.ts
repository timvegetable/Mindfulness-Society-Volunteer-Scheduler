import { describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  authenticateCredential,
  MemoryTokenVerifier,
  MemoryUserDirectory,
  createGoogleTokenInfoVerifier,
  normalizeEmail,
  type VerifiedIdentityClaims
} from './auth.js';

const claims: VerifiedIdentityClaims = {
  iss: 'https://accounts.google.com', aud: 'expected-client-id', sub: 'sub-1',
  email: 'tcai5958@terpmail.umd.edu', email_verified: true, exp: 4102444800
};
const admin = { id: 'tcai5958@terpmail.umd.edu', email: 'tcai5958@terpmail.umd.edu', roles: ['administrator'] as const, active: true, revision: 0 };
const directory = () => new MemoryUserDirectory([admin as unknown as Parameters<MemoryUserDirectory['set']>[0]]);

describe('sign-in rejection diagnostics', () => {
  it('names the verifier failure, so a wrong audience is distinguishable from a missing user', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const verifier = createGoogleTokenInfoVerifier({
        audience: 'expected-client-id',
        fetcher: () => ({ aud: 'some-other-client-id', sub: 'sub-1', email: claims.email, exp: claims.exp })
      });
      const error = (() => {
        try {
          authenticateCredential('token', verifier, directory());
        } catch (thrown) {
          return thrown as AuthenticationError;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error?.reason).toBe('invalid');
      expect(error?.detail).toContain('audience');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sign-in rejected (invalid)') as unknown as string);
    } finally {
      warn.mockRestore();
    }
  });

  it('reports how many directory rows were searched when the email is absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const verifier = new MemoryTokenVerifier({ token: { ...claims, email: 'someone.else@umd.edu' } });
      const error = (() => {
        try {
          authenticateCredential('token', verifier, directory());
        } catch (thrown) {
          return thrown as AuthenticationError;
        }
        return undefined;
      })();
      expect(error?.reason).toBe('unknown-identity');
      expect(error?.detail).toContain('no Users row for someone.else@umd.edu');
      expect(error?.detail).toContain('1 row(s)');
    } finally {
      warn.mockRestore();
    }
  });

  it('accepts an authorized token and never logs a credential', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const verifier = new MemoryTokenVerifier({ token: claims });
      const principal = authenticateCredential('token', verifier, directory());
      expect(principal.email).toBe(normalizeEmail(claims.email));
      expect(principal.user.roles).toEqual(['administrator']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects an inactive account distinctly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const verifier = new MemoryTokenVerifier({ token: claims });
      const users = new MemoryUserDirectory([{ ...admin, active: false } as unknown as Parameters<MemoryUserDirectory['set']>[0]]);
      let error: AuthenticationError | undefined;
      try {
        authenticateCredential('token', verifier, users);
      } catch (thrown) {
        error = thrown as AuthenticationError;
      }
      expect(error?.reason).toBe('unknown-identity');
      expect(error?.detail).toContain('inactive');
    } finally {
      warn.mockRestore();
    }
  });
});
