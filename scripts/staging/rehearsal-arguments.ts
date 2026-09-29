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
};

export function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (!command) throw new Error('Usage: rehearse-portable-state <baseline|initialize|verify|capture|transition|rollback> --role representative|larger [--baseline PATH] --confirm-staging');
  let role: Role | undefined;
  let confirm = false;
  let baseline: string | undefined;
  let event: Args['event'];
  let decision: Args['decision'];
  let authority: Args['authority'];
  let dataRevision: number | undefined;
  let inputRevision: number | undefined;
  let tabRevisions: Record<string, number> | undefined;
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
    ...(tabRevisions ? { tabRevisions } : {})
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

export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set(['baseline', 'verify']);
