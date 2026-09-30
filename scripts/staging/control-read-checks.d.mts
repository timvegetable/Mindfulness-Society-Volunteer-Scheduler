// Types for the read-matrix driver, so the Node suite can drive it with an
// injected fetch double and the shared ledgers instead of a network target.
import type { AttemptBudget, ReadBudget } from './measure-worker.mjs';

export type ReadCheckEntry = {
  operation: string;
  expectation: string;
  label?: string;
  reads?: number;
};

export type ReadCheckList = {
  workerUrl: string;
  credentialPath: string;
  reportPath: string;
  checks: ReadCheckEntry[];
};

export type NormalizedReadCheck = {
  index: number;
  label: string;
  operation: string;
  expectation: string;
  reads: number;
};

export type NormalizedCheckList = {
  workerUrl: string;
  credentialPath: string;
  reportPath: string;
  checks: NormalizedReadCheck[];
};

export type ReadCheckResult = {
  index: number;
  label: string;
  operation: string;
  expectation: string;
  issued: boolean;
  status: number;
  code: string | null;
  reason: string | null;
  reads: number | null;
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

export declare function validateCheckList(value: unknown, options?: { allowHost?: string; report?: string }): NormalizedCheckList;

export declare function planFor(checkList: NormalizedCheckList, budget: ReadBudget, attemptLedger: AttemptBudget): {
  workerUrl: string;
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
}): {
  generatedAt: string;
  startedAt: string;
  workerUrl: string;
  checks: ReadCheckResult[];
  summary: {
    checks: number;
    passed: number;
    failed: number;
    issued: number;
    deferred: number;
    reads: number;
    plannedReads: number;
    observedMaxInFlight: number;
  };
  passed: boolean;
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
}): Promise<{ results: ReadCheckResult[]; passed: boolean }>;
