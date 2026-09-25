// Types for the staging measurement harness, so the Node test suite can assert
// its fail-closed behaviour without pulling an untyped `.mjs` into the program.

export type HarnessArguments = {
  manifest?: string;
  confirmStaging: boolean;
  plan: boolean;
  allowHost?: string;
  cold: boolean;
  help?: boolean;
};

export type HarnessAttempt = {
  phase: string;
  index: number;
  operation: string;
  startedAt: string;
  durationMs: number;
  status: number;
  inFlight?: number;
  sheetsReads?: number;
  digest?: string;
  failure?: string;
};

export declare function classifyFailure(status: number, body: unknown, error?: Error): string;
export declare function parseArguments(argv: string[]): HarnessArguments;
export declare function isStagingHost(hostname: string): boolean;
export declare function validateManifest(value: unknown, options?: { allowHost?: string }): Record<string, unknown>;
export declare function planFor(manifest: Record<string, unknown>): Record<string, unknown>;
export declare function summarize(attempts: HarnessAttempt[], elapsedMs: number): Record<string, unknown>;

export declare class ReadBudget {
  constructor(limit?: number, windowMs?: number, now?: () => number);
  reserve(reads: number): Promise<void>;
  observed(): number;
}
