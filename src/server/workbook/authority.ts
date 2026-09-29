import type { ControlAuthority } from './control.js';

/**
 * Which revision authority this process was activated for. The control record
 * states which authority is authoritative; this configuration states which one
 * the process may use, and the two must agree or every request fails closed.
 * Absent means the legacy Script Properties authority, which is the state a
 * deployment is in until the approved activation procedure runs.
 */
export type ActivatedAuthority = ControlAuthority;

/** Deployment configuration, not workbook state: see the task 1.3 classification. */
export const CONTROL_AUTHORITY_KEY = 'CONTROL_AUTHORITY';

export type ScriptPropertyReader = { getProperty(name: string): string | null };

export function activatedAuthority(properties: ScriptPropertyReader): ActivatedAuthority {
  const raw = properties.getProperty(CONTROL_AUTHORITY_KEY)?.trim();
  if (!raw) return 'script-properties';
  if (raw === 'workbook-control') return 'workbook-control';
  if (raw === 'script-properties') return 'script-properties';
  // An unrecognized value is a configuration fault, not a silent downgrade: a
  // typo must not leave the process writing legacy counters against a workbook
  // whose authority has already moved.
  throw new Error(`${CONTROL_AUTHORITY_KEY} must be absent, "script-properties" or "workbook-control"; found ${JSON.stringify(raw)}`);
}
