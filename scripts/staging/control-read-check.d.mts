export type ControlReadCheckResult = {
  status: number;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
  reason?: string;
  sheetsReads: number | null;
  readMs: number[] | null;
  hostDeployedAt: string | null;
  expectedHostDeployedAt: string | null;
  versionMatch: boolean | null;
  hasCorrelationId: boolean;
  hasHostMarker: boolean;
};

export declare function controlReadCheck(options: {
  workerUrl: string;
  operation: string;
  credential?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
  expectedHostDeployedAt?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}): Promise<ControlReadCheckResult>;

export declare function evaluateExpectation(result: ControlReadCheckResult, expectation: string, options?: { requireZeroReads?: boolean }): { passed: boolean; detail: string };
