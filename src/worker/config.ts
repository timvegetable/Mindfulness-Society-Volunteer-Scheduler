/**
 * Staging configuration for the Worker feasibility slice.
 *
 * Values arrive as Worker bindings (plain variables) or secrets. The slice keeps
 * no production state: revisions, time zone and the workbook id are immutable
 * staging configuration, per the change design. Everything here is validated
 * eagerly and fails closed, because a misconfigured staging endpoint must refuse
 * rather than serve data under the wrong zone, revision or origin allowlist.
 */

export type StagingBindings = Readonly<Record<string, unknown>>;

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

export function requiredBinding(bindings: StagingBindings, name: string): string {
  const value = optionalBinding(bindings, name);
  if (value === undefined) throw new StagingConfigurationError(name, `${name} is required for staging.`);
  return value;
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
