import { describe, expect, it } from 'vitest';
import { StagingConfigurationError, allowedOrigins, optionalBinding, requiredBinding } from './config.js';
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
