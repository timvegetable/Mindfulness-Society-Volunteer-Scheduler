import type { AttemptBudget, HostReadiness, ReadBudget } from './measure-worker.mjs';

export declare function conservativeReadsFor(operation: string): number;

export declare function createRehearsalCampaignBudgets(paths?: { read: string; attempt: string }): {
  readBudget: ReadBudget;
  attemptLedger: AttemptBudget;
};

export declare function prepareRehearsalGatewayRead(options: {
  workerUrl: string;
  operation: string;
  credential: string;
  idempotencyKey: string;
  attemptLogPath: string;
  expectedHostDeployedAt?: string;
  fetchImpl?: typeof fetch;
  readBudget?: Pick<ReadBudget, 'reserve'>;
  attemptLedger?: Pick<AttemptBudget, 'reserve'>;
}): Promise<{
  attemptLogPath: string;
  start(): Promise<{
    attempt: Record<string, unknown>;
    response?: {
      status: number;
      durationMs: number;
      ok: boolean;
      errorCode?: string;
      reason?: string;
      sheetsReads: number;
      readMs: string | null;
      hostDeployedAt: string | null;
      versionLag: boolean;
      hasCorrelationId: boolean;
    };
    attemptLogPath: string;
  }>;
}>;

export declare function reserveThenReadBaseline<Prepared, Baseline>(options: {
  prepare: () => Promise<Prepared>;
  readBaseline: () => Promise<Baseline>;
}): Promise<{ prepared: Prepared; baseline: Baseline }>;

export declare function prepareRehearsalStraddle<Prepared, Baseline>(options: {
  expectedHostDeployedAt: string;
  readinessOptions?: { now?: () => number; wait?: (durationMs: number) => Promise<void> };
  prepare: () => Promise<Prepared>;
  readBaseline: () => Promise<Baseline>;
}): Promise<{ hostReadiness: HostReadiness; prepared: Prepared; baseline: Baseline }>;

export declare function straddleExpectationPassed(
  expectation: string,
  response: { status: number; ok: boolean; errorCode?: string; reason?: string; versionLag?: boolean } | undefined,
  attempt?: { versionLag?: boolean }
): boolean;

export declare function runRehearsalStraddle(options: {
  prepare: () => Promise<{ start: () => Promise<unknown> }> | { start: () => Promise<unknown> };
  fireMs: number;
  transition: () => Promise<unknown> | unknown;
  wait?: (duration: number) => Promise<unknown>;
}): Promise<{
  gateway: { value: unknown } | { error: { name: string; message: string } };
  transitionError?: { name: string; message: string };
}>;
