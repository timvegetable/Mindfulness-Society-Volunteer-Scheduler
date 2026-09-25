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
