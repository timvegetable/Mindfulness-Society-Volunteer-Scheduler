import { resolve, sep } from 'node:path';
import { validateHostDeployedAt } from './measure-worker.mjs';

// Command-line contract for the staging rehearsal runner.
//
// Pure and separately importable: the runner executes under vite-node, which
// strips the script path from `argv`, so an entry-point check cannot tell whether
// the module was imported or run. The contract test therefore imports this module
// and never the entry point, where a stray import would run a subcommand against
// a workbook.

export type Role = 'representative' | 'larger';

export type Args = {
  command: string;
  role: Role;
  confirm: boolean;
  baseline?: string;
  event?: 'begin' | 'complete' | 'abort' | 'recover';
  decision?: 'completed' | 'not-started' | 'restored';
  tabs: readonly string[];
  reason: string;
  actor: string;
  authority?: 'script-properties' | 'workbook-control';
  dataRevision?: number;
  inputRevision?: number;
  tabRevisions?: Record<string, number>;
  /** Straddle: milliseconds to wait before firing the transition pair. */
  fireMs?: number;
  /** Straddle: the read operation to race. */
  operation?: string;
  /** Straddle: the refusal the raced read must return, `CODE[:reason]`. */
  expect?: string;
  /** Straddle: the deployed gateway URL the read is sent to. */
  workerUrl?: string;
  /** Straddle: the expected `X-Staging-Host-Deployed-At` marker. */
  expectedHostDeployedAt?: string;
  /** Straddle: the private credential file holding a Google ID token. */
  credentialPath?: string;
  /** Injection: which deliberately broken control state to write. */
  kind?: InjectionKind;
  /** Restore: the snapshot an injection step wrote. */
  from?: string;
};

/** The control states the read matrix has to see refused. */
export const INJECTION_KINDS = ['pending', 'malformed', 'duplicate', 'unsupported', 'authority', 'missing'] as const;
export type InjectionKind = (typeof INJECTION_KINDS)[number];

/** The read a straddle races unless another operation is named. */
export const DEFAULT_STRADDLE_OPERATION = 'admin.schedule.read';
/** The refusal a straddled read must produce: the tuple moved under it. */
export const DEFAULT_STRADDLE_EXPECTATION = 'STALE_REVISION:control-generation_changed';
/** Milliseconds a straddle waits before firing its transition pair. */
export const DEFAULT_FIRE_MS = 1_500;

/**
 * A gateway URL is a deployment target, so it is validated the way the sibling
 * staging tools validate theirs: https only, and the host has to look like a
 * staging deployment. The runner addresses workbooks by role, never by raw id;
 * the same rule applies to the endpoint it races.
 */
export function stagingWorkerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--worker-url must be a URL.');
  }
  if (url.protocol !== 'https:') throw new Error('--worker-url must use https.');
  if (!url.hostname.includes('staging')) throw new Error('--worker-url must name a staging deployment host.');
  return url.toString();
}

/**
 * A private file has to stay inside the private staging directory. An absolute
 * path that resolves there is accepted: the runner prints absolute snapshot
 * paths, and refusing them turned a restore into a silent no-op.
 */
export function privateCredentialPath(value: string, flag = '--credential'): string {
  const resolved = resolve(value.replaceAll('\\', '/'));
  const privateRoot = resolve('staging-local');
  if (resolved !== privateRoot && !resolved.startsWith(`${privateRoot}${sep}`)) {
    throw new Error(`${flag} must resolve inside staging-local/.`);
  }
  return value;
}

function canonicalHostDeployedAt(value: string): string {
  try {
    return validateHostDeployedAt(value);
  } catch {
    throw new Error('--host-deployed-at must be a canonical UTC deployment timestamp such as 2026-09-30T12:00:00.000Z.');
  }
}

export function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (!command) throw new Error('Usage: rehearse-portable-state <baseline|initialize|verify|capture|transition|rollback|fixture|cleanup|inject|restore|legacy-admission|straddle> --role representative|larger [--baseline PATH] [--host-deployed-at UTC_TIMESTAMP] --confirm-staging');
  let role: Role | undefined;
  let confirm = false;
  let baseline: string | undefined;
  let event: Args['event'];
  let decision: Args['decision'];
  let authority: Args['authority'];
  let dataRevision: number | undefined;
  let inputRevision: number | undefined;
  let tabRevisions: Record<string, number> | undefined;
  let fireMs: number | undefined;
  let operation: string | undefined;
  let expect: string | undefined;
  let workerUrl: string | undefined;
  let expectedHostDeployedAt: string | undefined;
  let credentialPath: string | undefined;
  let kind: Args['kind'];
  let from: string | undefined;
  const tabs: string[] = [];
  let reason = '';
  let actor = 'rehearsal@example.test';
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    const next = (): string => {
      const candidate = rest[index + 1];
      if (candidate === undefined) throw new Error(`${value} needs a value.`);
      index += 1;
      return candidate;
    };
    if (value === '--role') {
      const candidate = next();
      if (candidate !== 'representative' && candidate !== 'larger') throw new Error('--role must be representative or larger.');
      role = candidate;
    } else if (value === '--baseline') {
      baseline = next();
    } else if (value === '--event') {
      const candidate = next();
      if (candidate !== 'begin' && candidate !== 'complete' && candidate !== 'abort' && candidate !== 'recover') throw new Error('--event must be begin, complete, abort or recover.');
      event = candidate;
    } else if (value === '--decision') {
      const candidate = next();
      if (candidate !== 'completed' && candidate !== 'not-started' && candidate !== 'restored') throw new Error('--decision must be completed, not-started or restored.');
      decision = candidate;
    } else if (value === '--data-revision') {
      const candidate = Number(next());
      if (!Number.isSafeInteger(candidate) || candidate < 0) throw new Error('--data-revision must be a non-negative integer.');
      dataRevision = candidate;
    } else if (value === '--input-revision') {
      const candidate = Number(next());
      if (!Number.isSafeInteger(candidate) || candidate < 0) throw new Error('--input-revision must be a non-negative integer.');
      inputRevision = candidate;
    } else if (value === '--tab-revisions') {
      const candidate = next();
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        throw new Error('--tab-revisions must be a JSON object of tab names to non-negative integers.');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('--tab-revisions must be a JSON object.');
      for (const entry of Object.values(parsed)) {
        if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) throw new Error('--tab-revisions values must be non-negative integers.');
      }
      tabRevisions = parsed as Record<string, number>;
    } else if (value === '--fire-ms') {
      const candidate = Number(next());
      if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > 60_000) throw new Error('--fire-ms must be an integer between 0 and 60000.');
      fireMs = candidate;
    } else if (value === '--operation') {
      const candidate = next();
      if (candidate.trim().length === 0) throw new Error('--operation must name an operation.');
      operation = candidate.trim();
    } else if (value === '--expect') {
      const candidate = next();
      if (candidate !== 'ok' && !/^(?:failed:)?[A-Z_]+(:[a-z0-9_-]+)?$/u.test(candidate)) throw new Error('--expect must be ok, CODE[:reason] or failed:CODE[:reason].');
      expect = candidate;
    } else if (value === '--worker-url') {
      workerUrl = stagingWorkerUrl(next());
    } else if (value === '--host-deployed-at') {
      expectedHostDeployedAt = canonicalHostDeployedAt(next().trim());
    } else if (value === '--credential') {
      credentialPath = privateCredentialPath(next());
    } else if (value === '--kind') {
      const candidate = next();
      if (!(INJECTION_KINDS as readonly string[]).includes(candidate)) throw new Error(`--kind must be one of ${INJECTION_KINDS.join(', ')}.`);
      kind = candidate as Args['kind'];
    } else if (value === '--from') {
      from = privateCredentialPath(next(), '--from');
    } else if (value === '--authority') {
      const candidate = next();
      if (candidate !== 'script-properties' && candidate !== 'workbook-control') throw new Error('--authority must be script-properties or workbook-control.');
      authority = candidate;
    } else if (value === '--tabs') {
      tabs.push(...next().split(',').map((tab) => tab.trim()).filter(Boolean));
    } else if (value === '--reason') {
      reason = next();
    } else if (value === '--actor') {
      actor = next();
    } else if (value === '--confirm-staging') {
      confirm = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!role) throw new Error('--role is required; the runner addresses workbooks by role, never by raw id.');
  if (command === 'straddle' && expectedHostDeployedAt === undefined) {
    throw new Error('straddle needs --host-deployed-at (the expected X-Staging-Host-Deployed-At marker).');
  }
  return {
    command,
    role,
    confirm,
    tabs,
    reason,
    actor,
    ...(baseline ? { baseline } : {}),
    ...(event ? { event } : {}),
    ...(decision ? { decision } : {}),
    ...(authority ? { authority } : {}),
    ...(dataRevision === undefined ? {} : { dataRevision }),
    ...(inputRevision === undefined ? {} : { inputRevision }),
    ...(tabRevisions ? { tabRevisions } : {}),
    ...(fireMs === undefined ? {} : { fireMs }),
    ...(operation ? { operation } : {}),
    ...(expect ? { expect } : {}),
    ...(workerUrl ? { workerUrl } : {}),
    ...(expectedHostDeployedAt ? { expectedHostDeployedAt } : {}),
    ...(credentialPath ? { credentialPath } : {}),
    ...(kind ? { kind } : {}),
    ...(from ? { from } : {})
  };
}

/**
 * Which subcommands mutate the synthetic workbooks and therefore require the
 * explicit confirmation flag. Pure, so the guard can be tested without running
 * anything against a workbook.
 */
export function requiresStagingConfirmation(command: string): boolean {
  return !READ_ONLY_COMMANDS.has(command);
}

export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set(['baseline', 'verify', 'legacy-admission']);
