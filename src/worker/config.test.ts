import { describe, expect, it } from 'vitest';
import { StagingConfigurationError, MAX_BRACKET_HOLD_MS, allowedOrigins, googleIdentityConfiguration, optionalBinding, requiredBinding, controlAuthority, stagingBracketHoldMs } from './config.js';
import { INTEGRATION_OPERATIONS } from '../server/integration/request-policy.js';
import { READ_API_OPERATIONS } from './read-api.js';

describe('staging configuration', () => {
  it('parses an exact origin allowlist and drops duplicates and blanks', () => {
    expect(allowedOrigins({ STAGING_ALLOWED_ORIGINS: 'https://a.example.test, https://b.example.test ,https://a.example.test,,' }))
      .toEqual(['https://a.example.test', 'https://b.example.test']);
  });

  it('treats an absent or blank allowlist as deny-every-browser-origin, not allow-all', () => {
    expect(allowedOrigins({})).toEqual([]);
    expect(allowedOrigins({ STAGING_ALLOWED_ORIGINS: '   ' })).toEqual([]);
  });

  it('refuses wildcards rather than interpreting them', () => {
    expect(() => allowedOrigins({ STAGING_ALLOWED_ORIGINS: '*' })).toThrow(StagingConfigurationError);
    expect(() => allowedOrigins({ STAGING_ALLOWED_ORIGINS: 'https://*.example.test' })).toThrow(StagingConfigurationError);
  });

  it('refuses entries that are not bare http(s) origins', () => {
    for (const value of ['not a url', 'https://a.example.test/', 'https://a.example.test/path', 'ftp://a.example.test', 'javascript:alert(1)']) {
      expect(() => allowedOrigins({ STAGING_ALLOWED_ORIGINS: value })).toThrow(StagingConfigurationError);
    }
  });

  it('reads bindings as trimmed text and reports a missing required one by name', () => {
    expect(optionalBinding({ A: '  value  ' }, 'A')).toBe('value');
    expect(optionalBinding({ A: '   ' }, 'A')).toBeUndefined();
    expect(optionalBinding({}, 'A')).toBeUndefined();
    expect(requiredBinding({ A: 'value' }, 'A')).toBe('value');
    expect(() => requiredBinding({}, 'STAGING_WORKBOOK_ID')).toThrow(/STAGING_WORKBOOK_ID/);
    expect(() => optionalBinding({ A: 42 }, 'A')).toThrow(StagingConfigurationError);
  });

  it('allowlists exactly the three feasibility operations', () => {
    expect([...READ_API_OPERATIONS].sort()).toEqual([
      INTEGRATION_OPERATIONS.adminInsights,
      INTEGRATION_OPERATIONS.adminSchedule,
      INTEGRATION_OPERATIONS.me
    ].sort());
  });
});

describe('staging identity configuration', () => {
  const PEM = '-----BEGIN PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END PRIVATE KEY-----\n';
  const complete = {
    STAGING_OAUTH_AUDIENCE: 'staging-client.apps.googleusercontent.com',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'reader@example.iam.gserviceaccount.com',
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: PEM
  };

  it('reads the audience, service-account address and private key', () => {
    // Bindings are trimmed, so the trailing newline of a PEM is not significant.
    expect(googleIdentityConfiguration(complete)).toEqual({
      audience: 'staging-client.apps.googleusercontent.com',
      clientEmail: 'reader@example.iam.gserviceaccount.com',
      privateKeyPem: PEM.trim()
    });
  });

  it('normalises a private key whose newlines arrived escaped', () => {
    const escaped = { ...complete, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') };
    expect(googleIdentityConfiguration(escaped).privateKeyPem).toBe(PEM.trim());
  });

  it('names the missing binding instead of failing later', () => {
    for (const variable of Object.keys(complete)) {
      const partial: Record<string, string> = { ...complete };
      delete partial[variable];
      expect(() => googleIdentityConfiguration(partial), variable).toThrow(new RegExp(variable));
    }
  });

  it('refuses a private key that is not a PKCS#8 PEM and never echoes it', () => {
    for (const value of ['not-a-key', '-----BEGIN RSA PRIVATE KEY-----\nSECRETBODY\n-----END RSA PRIVATE KEY-----']) {
      const error = (() => {
        try {
          googleIdentityConfiguration({ ...complete, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: value });
          return undefined;
        } catch (thrown) {
          return thrown as Error;
        }
      })();
      expect(error).toBeInstanceOf(StagingConfigurationError);
      expect(error?.message).not.toContain('SECRETBODY');
      expect(error?.message).not.toContain(value);
    }
  });
});

describe('staging control authority binding', () => {
  // The Worker mirrors the Apps Script CONTROL_AUTHORITY property: absent means
  // the legacy authority and no bracket; the literal selects the protocol; a typo
  // is a configuration fault rather than a silent downgrade to unguarded reads.
  it('treats an absent or blank binding as the legacy authority', () => {
    expect(controlAuthority({})).toBe('script-properties');
    expect(controlAuthority({ STAGING_CONTROL_AUTHORITY: '  ' })).toBe('script-properties');
    expect(controlAuthority({ STAGING_CONTROL_AUTHORITY: 'script-properties' })).toBe('script-properties');
  });

  it('selects the portable authority for the exact literal', () => {
    expect(controlAuthority({ STAGING_CONTROL_AUTHORITY: 'workbook-control' })).toBe('workbook-control');
  });

  it.each(['Workbook-Control', 'portable', 'true'])('refuses %s instead of serving unguarded', (value) => {
    expect(() => controlAuthority({ STAGING_CONTROL_AUTHORITY: value })).toThrowError(/STAGING_CONTROL_AUTHORITY/u);
  });

  it('refuses a non-string binding', () => {
    expect(() => controlAuthority({ STAGING_CONTROL_AUTHORITY: 1 })).toThrowError(/STAGING_CONTROL_AUTHORITY/u);
  });
});

describe('staging bracket-hold binding', () => {
  // A measurement instrument, not a gate: a value it cannot parse disables the
  // hold rather than failing the deployment, and an out-of-range value is not
  // silently clamped into a different experiment.
  it('is off unless the deployment sets an integer inside the range', () => {
    expect(stagingBracketHoldMs({})).toBe(0);
    expect(stagingBracketHoldMs({ STAGING_BRACKET_HOLD_MS: '' })).toBe(0);
    expect(stagingBracketHoldMs({ STAGING_BRACKET_HOLD_MS: '   ' })).toBe(0);
    expect(stagingBracketHoldMs({ STAGING_BRACKET_HOLD_MS: '0' })).toBe(0);
    expect(stagingBracketHoldMs({ STAGING_BRACKET_HOLD_MS: 'abc' })).toBe(0);
    expect(stagingBracketHoldMs({ STAGING_BRACKET_HOLD_MS: '-5' })).toBe(0);
    expect(stagingBracketHoldMs({ STAGING_BRACKET_HOLD_MS: '12.5' })).toBe(0);
    expect(stagingBracketHoldMs({ STAGING_BRACKET_HOLD_MS: '8000ms' })).toBe(0);
    expect(stagingBracketHoldMs({ STAGING_BRACKET_HOLD_MS: String(MAX_BRACKET_HOLD_MS + 1) })).toBe(0);
    expect(stagingBracketHoldMs({ STAGING_BRACKET_HOLD_MS: 8000 })).toBe(0);
  });

  it('accepts the milliseconds it will hold', () => {
    expect(stagingBracketHoldMs({ STAGING_BRACKET_HOLD_MS: '1' })).toBe(1);
    expect(stagingBracketHoldMs({ STAGING_BRACKET_HOLD_MS: ' 8000 ' })).toBe(8000);
    expect(stagingBracketHoldMs({ STAGING_BRACKET_HOLD_MS: String(MAX_BRACKET_HOLD_MS) })).toBe(MAX_BRACKET_HOLD_MS);
  });
});
