export declare const CPU_UNIT: {
  reportedUnit: string;
  basis: string;
  sources: string[];
};

export declare function parseArguments(argv: string[]): {
  tokenFile: string;
  scripts: string[];
  role: string;
  namespace?: string;
  since?: string;
  until?: string;
  expectedRequests?: number;
  attempts?: string;
  report?: string;
  plan: boolean;
  help: boolean;
};

export declare function resolveWindow(options: { since?: string; until?: string }, nowMs?: number): { since: Date; until: Date };

export declare function splitWindows(since: Date, until: Date, sliceMs?: number): Array<{ since: Date; until: Date }>;

export declare function invocationsQuery(accountId: string, scriptNames: readonly string[], since: Date, until: Date, limit?: number): string;

export declare function doInvocationsQuery(accountId: string, namespaceId: string | undefined, since: Date, until: Date, limit?: number): string;

export declare function doPeriodicQuery(accountId: string, namespaceId: string | undefined, since: Date, until: Date, limit?: number): string;

export declare function mergeRows(rows: unknown[]): unknown[];

export declare function summarizeInvocations(rows: unknown[]): {
  intervals: number;
  requests: number;
  errors: number;
  statuses: Record<string, number>;
  scriptNames: string[];
  attribution: { requestedExplicitly: boolean; ambiguous: boolean; reason: string };
  cpu: {
    unit: typeof CPU_UNIT;
    exactSamples: number;
    exactSampleShare: number | null;
    campaignQuantiles:
      | { derivable: true; population: number; p50Us: number; p90Us: number; p99Us: number; maxUs: number }
      | { derivable: false; reason: string };
    worstBucket: { datetime?: string; status?: string; requests: number; p50Us?: number; p90Us?: number; p99Us?: number } | null;
    bucketAggregates: Array<{ datetime?: string; status?: string; requests: number; p50Us?: number; p90Us?: number; p99Us?: number }>;
  };
  sanitized: boolean;
};

export declare function campaignPercentiles(values: number[]): { population: number; p50Us: number; p90Us: number; p99Us: number; maxUs: number } | null;

export declare function summarizeDurableObjects(invocationRows: unknown[], periodicRows: unknown[]): {
  requests: number;
  namespaces: string[];
  cpuTime: { unit: typeof CPU_UNIT; totalUs: number | null };
  memory: {
    source: string;
    unit: string;
    isolateP99Bytes: number | null;
    isolateP99MiB: number | null;
    samples: number;
    note?: undefined;
  };
  billableDuration: { status: string; reason: string };
  sanitized: boolean;
};

export declare function coverageCheck(expected: number | undefined, observed: number, options?: { tolerance?: number; maxExcess?: number }): {
  checked: boolean;
  expected?: number;
  observed: number;
  sufficient?: boolean;
  note?: string;
  reason?: string;
};
