import { readFile } from 'node:fs/promises';

const PRIVATE_KEYS = new Set([
  'environment',
  'timeZone',
  'displayIncrementMinutes',
  'operatingHours',
  'administratorRecipients',
  'oauthAudience',
  'appsScriptUrl',
  'sheetId',
  'sheetOwnerEmail',
  'writeEnabled'
]);

const PUBLIC_KEYS = new Set(['appsScriptUrl', 'oauthClientId']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CLOCK_PATTERN = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u;
const PLACEHOLDER_PATTERN = /^(?:REPLACE|SET_|PUBLIC_|DEPLOYMENT_ID|YOUR_|CHANGE_ME|EXAMPLE)/iu;

export class ConfigError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export async function readJsonFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Unable to read configuration file: ${path}`, [String(error?.code ?? 'read-failed')]);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigError(`Configuration is not valid JSON: ${path}`, ['invalid-json']);
  }
}

function issue(issues, message) {
  issues.push(message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validEmail(value) {
  return typeof value === 'string' && EMAIL_PATTERN.test(value) && value.length <= 320;
}

function validHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname === 'script.google.com' &&
    /^\/macros\/s\/[^/]+\/exec$/u.test(url.pathname) && !url.search && !url.hash;
}

function validSheetId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,}$/u.test(value) && !PLACEHOLDER_PATTERN.test(value);
}

function validAudience(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 512 &&
    !/\s/u.test(value) && !PLACEHOLDER_PATTERN.test(value);
}

function minutes(value) {
  const [hours, mins] = value.split(':').map(Number);
  return hours * 60 + mins;
}

export function validateConfig(config) {
  const issues = [];
  if (!isRecord(config)) return { valid: false, issues: ['configuration must be a JSON object'] };

  for (const key of Object.keys(config)) {
    if (!PRIVATE_KEYS.has(key)) issue(issues, `unknown private configuration key: ${key}`);
  }
  const required = [...PRIVATE_KEYS];
  for (const key of required) {
    if (!(key in config)) issue(issues, `missing required configuration: ${key}`);
  }

  if (config.environment !== undefined && !['development', 'staging', 'production'].includes(config.environment)) {
    issue(issues, 'environment must be development, staging, or production');
  }

  if (config.timeZone !== undefined) {
    if (typeof config.timeZone !== 'string' || !config.timeZone.trim()) {
      issue(issues, 'timeZone must be a non-empty IANA time-zone identifier');
    } else {
      try {
        const resolved = new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone }).resolvedOptions().timeZone;
        if (!resolved) issue(issues, 'timeZone must be a recognized IANA time-zone identifier');
      } catch {
        issue(issues, 'timeZone must be a recognized IANA time-zone identifier');
      }
    }
  }

  if (config.displayIncrementMinutes !== undefined &&
      (!Number.isInteger(config.displayIncrementMinutes) || config.displayIncrementMinutes < 1 ||
        config.displayIncrementMinutes > 1440 || 1440 % config.displayIncrementMinutes !== 0)) {
    issue(issues, 'displayIncrementMinutes must be an integer that divides one day (1–1440)');
  }

  if (config.operatingHours !== undefined) {
    if (!isRecord(config.operatingHours) || !CLOCK_PATTERN.test(config.operatingHours.start ?? '') ||
        !CLOCK_PATTERN.test(config.operatingHours.end ?? '')) {
      issue(issues, 'operatingHours.start and operatingHours.end must use HH:mm');
    } else if (minutes(config.operatingHours.end) <= minutes(config.operatingHours.start)) {
      issue(issues, 'operatingHours.end must be later than operatingHours.start');
    }
    if (isRecord(config.operatingHours)) {
      for (const key of Object.keys(config.operatingHours)) {
        if (!['start', 'end'].includes(key)) issue(issues, `unknown operatingHours key: ${key}`);
      }
    }
  }

  if (config.administratorRecipients !== undefined &&
      (!Array.isArray(config.administratorRecipients) || config.administratorRecipients.length === 0 ||
        config.administratorRecipients.some((email) => !validEmail(email)))) {
    issue(issues, 'administratorRecipients must contain at least one valid email address');
  }

  if (config.oauthAudience !== undefined && !validAudience(config.oauthAudience)) {
    issue(issues, 'oauthAudience must be a non-placeholder audience/client identifier without whitespace');
  }
  if (config.appsScriptUrl !== undefined && !validHttpsUrl(config.appsScriptUrl)) {
    issue(issues, 'appsScriptUrl must be an HTTPS Apps Script /macros/s/<deployment>/exec URL');
  }
  if (config.sheetId !== undefined && !validSheetId(config.sheetId)) {
    issue(issues, 'sheetId must be a real-looking private Sheet ID, not a placeholder');
  }
  if (config.sheetOwnerEmail !== undefined && !validEmail(config.sheetOwnerEmail)) {
    issue(issues, 'sheetOwnerEmail must be a valid administrator-owned email address');
  }
  if (config.writeEnabled !== undefined && typeof config.writeEnabled !== 'boolean') {
    issue(issues, 'writeEnabled must be boolean and must be explicitly set');
  }

  return { valid: issues.length === 0, issues };
}

export function validatePublicConfig(publicConfig, privateConfig) {
  const issues = [];
  if (!isRecord(publicConfig)) return { valid: false, issues: ['public configuration must be a JSON object'] };
  for (const key of Object.keys(publicConfig)) {
    if (!PUBLIC_KEYS.has(key)) issue(issues, `private or unknown key found in public configuration: ${key}`);
  }
  if (typeof publicConfig.appsScriptUrl !== 'string' || !validHttpsUrl(publicConfig.appsScriptUrl)) {
    issue(issues, 'public appsScriptUrl must be an HTTPS Apps Script /exec URL');
  }
  if (typeof publicConfig.oauthClientId !== 'string' || !publicConfig.oauthClientId.trim() ||
      PLACEHOLDER_PATTERN.test(publicConfig.oauthClientId)) {
    issue(issues, 'public oauthClientId must be a configured non-placeholder client ID');
  }
  if (isRecord(privateConfig)) {
    if (publicConfig.appsScriptUrl !== privateConfig.appsScriptUrl) issue(issues, 'public appsScriptUrl does not match private configuration');
    if (publicConfig.oauthClientId !== privateConfig.oauthAudience) issue(issues, 'public oauthClientId does not match private oauthAudience');
  }
  return { valid: issues.length === 0, issues };
}

export function summarizeConfig(config) {
  return {
    environment: config.environment,
    configured: {
      timeZone: typeof config.timeZone === 'string',
      displayIncrementMinutes: Number.isInteger(config.displayIncrementMinutes),
      operatingHours: isRecord(config.operatingHours),
      administratorRecipients: Array.isArray(config.administratorRecipients),
      oauthAudience: typeof config.oauthAudience === 'string',
      appsScriptUrl: typeof config.appsScriptUrl === 'string',
      protectedSheetOwnership: typeof config.sheetId === 'string' && typeof config.sheetOwnerEmail === 'string'
    },
    administratorRecipientCount: Array.isArray(config.administratorRecipients) ? config.administratorRecipients.length : 0,
    writeEnabled: config.writeEnabled === true
  };
}

export function assertValidConfig(config, label = 'configuration') {
  const result = validateConfig(config);
  if (!result.valid) throw new ConfigError(`${label} failed validation`, result.issues);
  return config;
}

export function publicProjection(config) {
  assertValidConfig(config, 'private configuration');
  return { appsScriptUrl: config.appsScriptUrl, oauthClientId: config.oauthAudience };
}

export function isPrivateKey(key) {
  return PRIVATE_KEYS.has(key);
}

export { PRIVATE_KEYS, PUBLIC_KEYS };
