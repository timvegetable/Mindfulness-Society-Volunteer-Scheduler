import { describe, expect, it } from 'vitest';
import { StagingConfigurationError, allowedOrigins, googleIdentityConfiguration, optionalBinding, requiredBinding } from './config.js';
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
