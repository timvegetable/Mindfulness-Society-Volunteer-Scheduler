// Types for the read-matrix driver, so the Node suite can drive it with an
// injected fetch double and the shared ledgers instead of a network target.
import type { AttemptBudget, HostReadiness, ReadBudget } from './measure-worker.mjs';

export type ReadCheckEntry = {
  operation: string;
  expectation: string;
  label?: string;
  reads?: number;
  credentialMode?: 'none' | 'configured';
};

export type ReadCheckList = {
  workerUrl: string;
  credentialPath: string;
  reportPath: string;
  hostDeployedAt?: string;
  checks: ReadCheckEntry[];
};

export type NormalizedReadCheck = {
  index: number;
  label: string;
  operation: string;
  expectation: string;
  reads: number;
  policyRefusal: boolean;
  credentialMode: 'none' | 'configured';
};

export type NormalizedCheckList = {
  workerUrl: string;
  credentialPath: string;
  reportPath: string;
  hostDeployedAt?: string;
  checks: NormalizedReadCheck[];
};

export type ReadCheckResult = {
  index: number;
  label: string;
  operation: string;
  expectation: string;
  issued: boolean;
  deferred?: boolean;
  deferredReason?: string;
  status: number;
  code: string | null;
  reason: string | null;
  reads: number | null;
  readMs: number[] | null;
  hostDeployedAt: string | null;
  expectedHostDeployedAt: string | null;
  versionMatch: boolean | null;
  policyRefusal: boolean;
  credentialMode: 'none' | 'configured';
  plannedReads: number;
  durationMs: number | null;
  observedInFlight: number;
  passed: boolean;
  detail: string;
  failure?: string;
};

export declare function parseArguments(argv: string[]): {
  checks?: string;
  report?: string;
  allowHost?: string;
  confirmStaging: boolean;
  plan: boolean;
  help?: boolean;
};

export declare function validateCheckList(value: unknown, options?: { allowHost?: string; report?: string; requireHostDeployedAt?: boolean }): NormalizedCheckList;

export declare function planFor(checkList: NormalizedCheckList, budget: ReadBudget, attemptLedger: AttemptBudget, now?: number): {
  workerUrl: string;
  hostDeployedAt: string | null;
  hostReadiness: {
    required: boolean;
    minimumDelayMs: number;
    readyAt: string | null;
    waitRemainingMs: number | null;
  };
  checks: NormalizedReadCheck[];
  expectedReads: number;
  readBudgetPerWindow: number;
  windowSeconds: number;
  attemptBudgetPerCampaign: number;
  retries: 0;
  reportPath: string;
  attemptLogPath: string;
};

export declare function reportFor(checkList: NormalizedCheckList, results: ReadCheckResult[], options: {
  startedAt: string;
  budget: ReadBudget;
  attemptLedger: AttemptBudget;
  attemptsBeforeRun: number;
  attemptLogPath: string;
  hostReadiness: HostReadiness;
}): {
  generatedAt: string;
  startedAt: string;
  workerUrl: string;
  hostDeployedAt: string | null;
  hostReadiness: HostReadiness;
  checks: ReadCheckResult[];
  summary: {
    checks: number;
    passed: number;
    failed: number;
    issued: number;
    deferred: number;
    reads: number;
    readCountObservations: number;
    unreportedReadChecks: number;
    versionMatchedObservations: number | null;
    versionLaggedObservations: number | null;
    readTimingObservations: number;
    plannedReads: number;
    observedMaxInFlight: number;
  };
  passed: boolean;
  stoppedOn429: boolean;
  budget: {
    limit: number;
    windowSeconds: number;
    observedReadsInLastWindow: number;
    attempts: { limit: number; spentBeforeRun: number; spentAfterRun: number };
  };
  attemptLogPath: string;
  retries: 0;
  sanitized: true;
};

export declare function exitCodeFor(passed: boolean): 0 | 1;

export declare function runReadChecks(checkList: NormalizedCheckList, options: {
  credential: string;
  budget: ReadBudget;
  attemptLedger: AttemptBudget;
  attemptLog: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  wait?: (durationMs: number) => Promise<void>;
}): Promise<{ results: ReadCheckResult[]; passed: boolean; stoppedOn429: boolean; hostReadiness: HostReadiness }>;
