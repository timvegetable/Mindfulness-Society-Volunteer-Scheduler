import { describe, expect, it } from 'vitest';
import { createGoogleTokenInfoVerifier, type GoogleTokenInfoFetcher } from './auth.js';

const AUDIENCE = '716719981089-example.apps.googleusercontent.com';
const base = {
  aud: AUDIENCE,
  sub: 'sub-1',
  email: 'Tcai5958@Terpmail.UMD.edu',
  exp: 4102444800
};

const verifier = (payload: unknown) => createGoogleTokenInfoVerifier({ audience: AUDIENCE, fetcher: (() => payload) as GoogleTokenInfoFetcher });

describe('Google tokeninfo verification', () => {
  it('accepts the email_verified claim tokeninfo actually returns', () => {
    const claims = verifier({ ...base, email_verified: 'true' }).verify('token');
    expect(claims.email).toBe('tcai5958@terpmail.umd.edu');
    expect(claims.aud).toBe(AUDIENCE);
    expect(claims.email_verified).toBe(true);
  });

  it('accepts the boolean form and the verified_email alias', () => {
    expect(verifier({ ...base, email_verified: true }).verify('token').sub).toBe('sub-1');
    expect(verifier({ ...base, verified_email: 'true' }).verify('token').sub).toBe('sub-1');
  });

  it('rejects an unverified or absent email claim', () => {
    expect(() => verifier({ ...base, email_verified: 'false' }).verify('token')).toThrow(/not verified/);
    expect(() => verifier({ ...base }).verify('token')).toThrow(/not verified/);
  });

  it('rejects a token minted for a different audience', () => {
    expect(() => verifier({ ...base, aud: 'someone-elses-client-id', email_verified: 'true' }).verify('token')).toThrow(/audience/);
  });

  it('rejects a malformed or expired payload', () => {
    expect(() => verifier({ aud: AUDIENCE, email_verified: 'true' }).verify('token')).toThrow(/audience/);
    expect(() => verifier({ ...base, email_verified: "true", exp: 1000 }).verify('token')).toThrow(/expired/);
  });
});
