export declare const OPERATION_READS: Record<string, number>;

export declare function classifyFailure(status: number, body: unknown, error?: unknown): string;

export declare function parseArguments(argv: string[]): {
  manifest?: string;
  confirmStaging: boolean;
  plan: boolean;
  allowHost?: string;
  cold: boolean;
  help?: boolean;
};

export declare function isStagingHost(hostname: string): boolean;

export declare function readsFor(manifest: { readsPerRequest?: Record<string, number>; operations: string[] }, operation: string): number;

export declare function validateManifest(value: unknown, options?: { allowHost?: string }): {
  workerUrl: string;
  origins: string[];
  operations: string[];
  cold?: { requests: number };
  burst: { requests: number; concurrency: number };
  sustained: { requests: number; concurrency: number };
  reportPath: string;
  credentialPath: string;
  /** Sheets requests one request of an operation is expected to spend. */
  readsPerRequest?: Record<string, number>;
  fixtureDigest?: string;
};

export declare class ReadBudget {
  readonly limit: number;
  readonly windowMs: number;
  constructor(limit?: number, windowMs?: number, now?: () => number, ledgerPath?: string);
  spent: number[];
  loadLedger(): Promise<void>;
  saveLedger(): Promise<void>;
  reserve(reads: number): Promise<void>;
  flush(): Promise<void>;
  observed(): number;
}

export declare function campaignLedgerPaths(): { read: string; attempt: string };

export declare function planFor(manifest: { workerUrl: string; operations: string[]; cold?: { requests: number } | null; burst: { requests: number; concurrency: number }; sustained: { requests: number; concurrency: number }; reportPath: string }): {
  workerUrl: string;
  operations: string[];
  cold: { requests: number } | null;
  burst: { requests: number; concurrency: number };
  sustained: { requests: number; concurrency: number };
  expectedReadsPerRequest: Record<string, number>;
  readBudgetPerWindow: number;
  windowSeconds: number;
  retries: 0;
  reportPath: string;
  attemptLogPath: string;
};

export declare function summarize(attempts: Array<Record<string, unknown>>, elapsedMs: number): Record<string, unknown>;

export declare const ATTEMPT_BUDGET_PER_CAMPAIGN: number;

export declare class AttemptBudget {
  readonly limit: number;
  constructor(limit?: number, ledgerPath?: string);
  spent: number;
  loadLedger(): Promise<void>;
  saveLedger(): Promise<void>;
  reserve(): Promise<boolean>;
  flush(): Promise<void>;
  observed(): number;
}

export declare function classifyColdObservation(attempt: { failure?: string; hostDeployedAt?: string }, expectedHostDeployedAt?: string): string;

export declare function runPhase(manifest: { workerUrl: string; operations: string[] }, phase: string, workload: { requests: number; concurrency: number }, credential: string, budget: ReadBudget, attemptLedger: AttemptBudget, fetchImpl: (url: string, init: unknown) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>, attemptLog: string): Promise<{ attempts: Array<Record<string, unknown>>; elapsedMs: number; deferred: number }>;
