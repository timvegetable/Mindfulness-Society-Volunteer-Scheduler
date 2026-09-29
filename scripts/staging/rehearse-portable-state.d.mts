// The rehearsal runner is executed with vite-node; this declaration lets its
// contract test import the pure argument and confirmation helpers.
export type RehearsalRole = 'representative' | 'larger';

export type RehearsalArgs = {
  command: string;
  role: RehearsalRole;
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

export declare function parseArgs(argv: readonly string[]): RehearsalArgs;
export declare function requiresStagingConfirmation(command: string): boolean;
export declare const READ_ONLY_COMMANDS: ReadonlySet<string>;
