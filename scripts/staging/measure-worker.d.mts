export type StagingOperation =
  | 'session.me'
  | 'admin.schedule.read'
  | 'admin.insights.read'
  | 'admin.schedule.preview';

export interface StagingWorkload {
  requests: number;
  concurrency: number;
}

export interface StagingManifest {
  workerUrl: string;
  origins: string[];
  operations: StagingOperation[];
  cold?: { requests: number };
  burst: StagingWorkload;
  sustained: StagingWorkload;
  reportPath: string;
  credentialPath: string;
  /** Sheets requests one request of an operation is expected to spend. */
  readsPerRequest?: Partial<Record<StagingOperation, number>>;
  fixtureDigest?: string;
  hostDeployedAt?: string;
}

export interface WallTimeSummary {
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface PopulationSummary {
  attempts: number;
  successes: number;
  failures: Record<string, number>;
  /** Null when the manifest did not provide an expected deployed marker. */
  versionLag: number | null;
  latencyObservations: number;
  latencyObservationsAtLeast3InFlight: number;
  wallTimeMs: WallTimeSummary;
  wallTimeMsAtLeast3InFlight: WallTimeSummary;
  achieved: {
    observedMaxInFlight: number;
    attemptsAtLeast3InFlight: number;
    successfulObservationsAtLeast3InFlight: number;
    versionLagAtLeast3InFlight: number | null;
  };
}

export interface OperationSummary extends PopulationSummary {
  achieved: PopulationSummary['achieved'] & {
    requestsPerMinute: number | null;
    sheetsReadsPerMinute: number | null;
    sheetsReadsReportedByWorker: number;
  };
}

export interface PhaseSummary extends PopulationSummary {
  achieved: PopulationSummary['achieved'] & {
    requestsPerMinute: number | null;
    sheetsReadsPerMinute: number | null;
    sheetsReadsReportedByWorker: number;
  };
  statuses: Record<string, number>;
  snapshotDigests: string[];
  byOperation: Record<string, OperationSummary>;
}

export interface HostReadiness {
  required: boolean;
  readyAt: string | null;
  waitedMs: number;
}

export interface StagingAttempt extends Record<string, unknown> {
  phase: string;
  index: number;
  operation: StagingOperation;
  startedAt: string;
  durationMs: number;
  status: number;
  inFlight: number;
  observedMaxInFlightDuringRequest: number;
  failure?: string;
  sheetsReads?: number;
  readMs?: number[] | null;
  digest?: string;
  hostDeployedAt?: string;
  correlationId?: string;
  envelopeOk?: boolean;
  errorCode?: string;
}

export interface DeferredStagingAttempt extends Record<string, unknown> {
  phase: string;
  index: number;
  operation: StagingOperation;
  issued: false;
  deferred: true;
  deferredReason: 'http-429' | 'attempt-budget-exhausted';
  attemptReserved: boolean;
  readsReserved: boolean;
}

export interface StopOn429State {
  stoppedBy429: boolean;
  phase?: string | null;
}

export declare const OPERATION_READS: Record<StagingOperation, number>;
export declare const HOST_VERSION_PROPAGATION_MS: number;
export declare const ATTEMPT_BUDGET_PER_CAMPAIGN: number;
export declare function validateHostDeployedAt(value: unknown): string;

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

export declare function readsFor(manifest: { operations?: string[]; readsPerRequest?: Partial<Record<StagingOperation, number>> }, operation: string): number;

export declare function validateManifest(value: unknown, options?: { allowHost?: string; requireHostDeployedAt?: boolean }): StagingManifest;

export declare class ReadBudget {
  readonly limit: number;
  readonly windowMs: number;
  spent: number[];
  constructor(limit?: number, windowMs?: number, now?: () => number, ledgerPath?: string);
  loadLedger(): Promise<void>;
  saveLedger(): Promise<void>;
  reserve(reads: number): Promise<void>;
  flush(): Promise<void>;
  observed(): number;
}

export declare function campaignLedgerPaths(): { read: string; attempt: string };

export declare function planFor(manifest: Pick<StagingManifest, 'workerUrl' | 'operations' | 'burst' | 'sustained' | 'reportPath'> & Partial<Pick<StagingManifest, 'cold' | 'readsPerRequest' | 'fixtureDigest' | 'hostDeployedAt'>>, now?: number): {
  workerUrl: string;
  operations: StagingOperation[];
  cold: { requests: number } | null;
  burst: StagingWorkload;
  sustained: StagingWorkload;
  expectedReadsPerRequest: Record<string, number>;
  readBudgetPerWindow: number;
  windowSeconds: number;
  attemptBudgetPerCampaign: number;
  hostDeployedAt: string | null;
  hostReadiness: {
    required: boolean;
    minimumDelayMs: number;
    readyAt: string | null;
    waitRemainingMs: number | null;
  };
  retries: 0;
  reportPath: string;
  attemptLogPath: string;
};

export declare function waitForHostVersion(manifest: Pick<StagingManifest, 'hostDeployedAt'>, options?: {
  now?: () => number;
  wait?: (durationMs: number) => Promise<void>;
}): Promise<HostReadiness>;

export declare function readTimingsFrom(headerValue: string | null, expectedReadCount?: number): number[] | null;

export declare function summarize(
  attempts: Array<Partial<StagingAttempt> & Record<string, unknown>>,
  elapsedMs: number,
  expectedHostDeployedAt?: string,
  operations?: string[]
): PhaseSummary;

export declare class AttemptBudget {
  readonly limit: number;
  spent: number;
  constructor(limit?: number, ledgerPath?: string);
  loadLedger(): Promise<void>;
  saveLedger(): Promise<void>;
  reserve(): Promise<boolean>;
  flush(): Promise<void>;
  observed(): number;
}

export declare function classifyColdObservation(attempt: { failure?: string; hostDeployedAt?: string }, expectedHostDeployedAt?: string): string;

export declare function runPhase(
  manifest: Pick<StagingManifest, 'workerUrl' | 'operations'> & Partial<Pick<StagingManifest, 'readsPerRequest' | 'hostDeployedAt'>>,
  phase: string,
  workload: StagingWorkload,
  credential: string,
  budget: ReadBudget,
  attemptLedger: AttemptBudget,
  fetchImpl: (url: string, init: unknown) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>,
  attemptLog: string,
  readinessOptions?: {
    now?: () => number;
    wait?: (durationMs: number) => Promise<void>;
    stopState?: StopOn429State;
  }
): Promise<{
  attempts: StagingAttempt[];
  elapsedMs: number;
  deferred: number;
  deferredAttempts: DeferredStagingAttempt[];
  stoppedBy429: boolean;
  stopPhase: string | null;
  hostReadiness: HostReadiness;
}>;
