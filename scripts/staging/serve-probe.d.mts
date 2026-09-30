// Types for the staging probe host.
export declare function createProbeServer(options?: {
  port?: number;
  stagingDirectory?: string;
  /**
   * The shared Sheets read ledger `/__reserve` spends from. Defaults to a
   * `ReadBudget` whose ledger file lives inside `stagingDirectory`, so the
   * browser's reads and the paced harness's attempts hold one rolling window.
   */
  budget?: { reserve(reads: number): Promise<void>; observed(): number };
}): { server: import("node:http").Server; port: number; stagingDirectory: string };
