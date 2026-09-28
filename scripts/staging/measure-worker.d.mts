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

export declare function validateManifest(value: unknown, options?: { allowHost?: string }): {
  workerUrl: string;
  origins: string[];
  operations: string[];
  cold?: { requests: number };
  burst: { requests: number; concurrency: number };
  sustained: { requests: number; concurrency: number };
  reportPath: string;
  credentialPath: string;
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
  observed(): number;
}

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
