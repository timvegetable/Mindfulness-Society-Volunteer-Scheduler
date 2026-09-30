/**
 * Staging configuration for the Worker feasibility slice.
 *
 * Values arrive as Worker bindings (plain variables) or secrets. The slice keeps
 * no production state: revisions, time zone and the workbook id are immutable
 * staging configuration, per the change design. Everything here is validated
 * eagerly and fails closed, because a misconfigured staging endpoint must refuse
 * rather than serve data under the wrong zone, revision or origin allowlist.
 */

import { WORKBOOK_TABS } from '../server/workbook/schema.js';
import type { ControlAuthority } from '../server/workbook/control.js';

export type StagingBindings = Readonly<Record<string, unknown>>;

const WORKBOOK_TAB_NAMES: ReadonlySet<string> = new Set(WORKBOOK_TABS.map((tab) => tab.name));

export class StagingConfigurationError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(message);
    this.name = 'StagingConfigurationError';
    this.variable = variable;
  }
}

/** Reads a binding as trimmed text; an absent or blank binding is `undefined`. */
export function optionalBinding(bindings: StagingBindings, name: string): string | undefined {
  const value = bindings[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new StagingConfigurationError(name, `${name} must be a string binding.`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Which revision authority this Worker may use, mirroring the Apps Script
 * `CONTROL_AUTHORITY` property. Absent means the legacy Script Properties
 * authority and no completed-snapshot bracket; `workbook-control` turns the
 * bracket on; anything else is a configuration fault rather than a silent
 * downgrade.
 */
export function controlAuthority(bindings: StagingBindings): ControlAuthority {
  const value = optionalBinding(bindings, 'STAGING_CONTROL_AUTHORITY');
  if (value === undefined || value === 'script-properties') return 'script-properties';
  if (value === 'workbook-control') return 'workbook-control';
  throw new StagingConfigurationError('STAGING_CONTROL_AUTHORITY', 'STAGING_CONTROL_AUTHORITY must be absent, "script-properties" or "workbook-control".');
}

export function requiredBinding(bindings: StagingBindings, name: string): string {
  const value = optionalBinding(bindings, name);
  if (value === undefined) throw new StagingConfigurationError(name, `${name} is required for staging.`);
  return value;
}

/** The longest hold the staging bracket instrument accepts, in milliseconds. */
export const MAX_BRACKET_HOLD_MS = 10_000;

/**
 * Staging-only instrument: hold the portable reader's bracket open for a fixed
 * number of milliseconds before it hydrates, so a concurrent control transition
 * lands inside the window unconditionally. A rehearsal needs that interleaving
 * to be deterministic; three earlier attempts failed because each transition
 * ran in its own process and never made the window.
 *
 * Absent, blank, zero, non-integer or out-of-range disables the instrument, and
 * a value it cannot parse is off rather than an error: this is a measurement
 * aid, and a deployment must never fail to serve because of it.
 */
export function stagingBracketHoldMs(bindings: StagingBindings): number {
  const raw = bindings.STAGING_BRACKET_HOLD_MS;
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BRACKET_HOLD_MS) return 0;
  return parsed;
}

function parseOrigin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StagingConfigurationError(name, `${name} contains an entry that is not a URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new StagingConfigurationError(name, `${name} entries must use http or https: ${value}`);
  }
  if (url.origin !== value) {
    throw new StagingConfigurationError(name, `${name} entries must be bare origins without a path, query or trailing slash: ${value}`);
  }
  return url.origin;
}

/**
 * Exact origin allowlist. Wildcards are refused rather than interpreted: the
 * design requires exact allowlisting, and a browser origin is never identity.
 * An empty or absent binding yields an empty list, which denies every request
 * that carries an `Origin` header — the safe default before the staging
 * manifest names a real origin.
 */
export function allowedOrigins(bindings: StagingBindings): readonly string[] {
  const raw = optionalBinding(bindings, 'STAGING_ALLOWED_ORIGINS');
  if (raw === undefined) return [];
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const origins: string[] = [];
  for (const entry of entries) {
    if (entry.includes('*')) throw new StagingConfigurationError('STAGING_ALLOWED_ORIGINS', 'Wildcard origins are not allowed; list exact origins.');
    const origin = parseOrigin('STAGING_ALLOWED_ORIGINS', entry);
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

export type GoogleIdentityConfiguration = Readonly<{
  /** OAuth client id the ID tokens must be issued for. */
  audience: string;
  /** Service-account address used as the JWT assertion issuer. */
  clientEmail: string;
  /** PKCS#8 private key for the service account, as a PEM block. */
  privateKeyPem: string;
}>;

const PRIVATE_KEY_VARIABLE = 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY';

/**
 * A secret pasted through a dashboard or CLI often arrives with escaped
 * newlines. Normalising here keeps every consumer working with a real PEM, and
 * no error ever echoes the key material.
 */
function normalizePrivateKey(value: string): string {
  const unescaped = value.includes('\\n') && !value.includes('\n') ? value.replace(/\\n/g, '\n') : value;
  // Trimmed *after* unescaping so the same key supplied either way normalises to
  // the same bytes.
  const pem = unescaped.trim();
  if (!pem.includes('-----BEGIN PRIVATE KEY-----') || !pem.includes('-----END PRIVATE KEY-----')) {
    throw new StagingConfigurationError(PRIVATE_KEY_VARIABLE, `${PRIVATE_KEY_VARIABLE} is not a PKCS#8 PEM private key.`);
  }
  return pem;
}

/**
 * Identity configuration for the staging slice. The audience is the OAuth web
 * client id the browser signs in with; the service account is a *different*
 * credential used only for server-to-server Sheets reads.
 */
export function googleIdentityConfiguration(bindings: StagingBindings): GoogleIdentityConfiguration {
  return {
    audience: requiredBinding(bindings, 'STAGING_OAUTH_AUDIENCE'),
    clientEmail: requiredBinding(bindings, 'GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    privateKeyPem: normalizePrivateKey(requiredBinding(bindings, PRIVATE_KEY_VARIABLE))
  };
}

export type WorkbookConfiguration = Readonly<{
  spreadsheetId: string;
  /** Zone the workbook's date and time cells are anchored to; never the display zone. */
  workbookTimeZone: string;
  /** Frozen staging configuration, presented to the runtime as Script Properties. */
  properties: ScriptProperties;
}>;

/** Properties the runtime reads. Only these are exposed; everything else is absent. */
export type ScriptProperties = Readonly<{
  getProperty(name: string): string | null;
  setProperty(name: string, value: string): void;
}>;

const REQUIRED_WORKBOOK_VARIABLES = ['STAGING_WORKBOOK_ID', 'STAGING_WORKBOOK_TIME_ZONE', 'STAGING_DATA_REVISION', 'STAGING_SCHEDULING_INPUT_REVISION', 'STAGING_TAB_REVISIONS'] as const;

function nonNegativeInteger(variable: string, value: string): number {
  if (!/^\d+$/.test(value.trim())) throw new StagingConfigurationError(variable, `${variable} must be a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new StagingConfigurationError(variable, `${variable} must be a safe non-negative integer.`);
  return parsed;
}

function tabRevisions(value: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new StagingConfigurationError('STAGING_TAB_REVISIONS', 'STAGING_TAB_REVISIONS must be a JSON object of tab name to revision.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StagingConfigurationError('STAGING_TAB_REVISIONS', 'STAGING_TAB_REVISIONS must be a JSON object of tab name to revision.');
  }
  const revisions: Record<string, number> = {};
  for (const [tab, revision] of Object.entries(parsed as Record<string, unknown>)) {
    if (!WORKBOOK_TAB_NAMES.has(tab)) throw new StagingConfigurationError('STAGING_TAB_REVISIONS', `STAGING_TAB_REVISIONS names an unknown tab: ${tab}`);
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      throw new StagingConfigurationError('STAGING_TAB_REVISIONS', `STAGING_TAB_REVISIONS must give ${tab} a non-negative integer revision.`);
    }
    revisions[tab] = revision;
  }
  return revisions;
}

/**
 * Immutable staging workbook configuration.
 *
 * The feasibility slice keeps no portable state: the workbook id, its time zone
 * and every revision counter are deployment configuration fixed before
 * measurement, and the runtime sees them through a read-only Script Properties
 * facade. A write attempt throws rather than pretending to persist.
 */
export function workbookConfiguration(bindings: StagingBindings): WorkbookConfiguration {
  for (const variable of REQUIRED_WORKBOOK_VARIABLES) requiredBinding(bindings, variable);
  const revisions = tabRevisions(requiredBinding(bindings, 'STAGING_TAB_REVISIONS'));
  const values = new Map<string, string>([
    ['TIME_ZONE', optionalBinding(bindings, 'STAGING_TIME_ZONE') ?? 'America/New_York'],
    ['DISPLAY_INCREMENT_MINUTES', optionalBinding(bindings, 'STAGING_DISPLAY_INCREMENT_MINUTES') ?? '30'],
    ['OPERATING_HOURS_START', optionalBinding(bindings, 'STAGING_OPERATING_HOURS_START') ?? '09:00'],
    ['OPERATING_HOURS_END', optionalBinding(bindings, 'STAGING_OPERATING_HOURS_END') ?? '21:00'],
    ['DATA_REVISION', String(nonNegativeInteger('STAGING_DATA_REVISION', requiredBinding(bindings, 'STAGING_DATA_REVISION')))],
    ['SCHEDULING_INPUT_REVISION', String(nonNegativeInteger('STAGING_SCHEDULING_INPUT_REVISION', requiredBinding(bindings, 'STAGING_SCHEDULING_INPUT_REVISION')))],
    // The slice serves reads only; the flag is pinned so nothing downstream can
    // conclude that writes are enabled.
    ['WRITE_ENABLED', 'false']
  ]);
  for (const [tab, revision] of Object.entries(revisions)) values.set(`TAB_REVISION_${tab}`, String(revision));

  return {
    spreadsheetId: requiredBinding(bindings, 'STAGING_WORKBOOK_ID'),
    workbookTimeZone: requiredBinding(bindings, 'STAGING_WORKBOOK_TIME_ZONE'),
    properties: {
      getProperty: (name) => values.get(name) ?? null,
      setProperty: () => { throw new StagingConfigurationError('STAGING_TAB_REVISIONS', 'Staging configuration is immutable; the slice serves reads only.'); }
    }
  };
}
