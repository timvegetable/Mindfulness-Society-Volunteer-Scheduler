export type ControlReadCheckResult = {
  status: number;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
  reason?: string;
  sheetsReads: number;
  hasCorrelationId: boolean;
  hasHostMarker: boolean;
};

export declare function controlReadCheck(options: {
  workerUrl: string;
  operation: string;
  credential: string;
  idempotencyKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ControlReadCheckResult>;

export declare function evaluateExpectation(result: ControlReadCheckResult, expectation: string): { passed: boolean; detail: string };
