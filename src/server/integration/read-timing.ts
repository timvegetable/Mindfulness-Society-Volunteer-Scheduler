/** Request-local, aggregate-only timing. Never records credentials or row values. */
export type ReadPhase = 'credentialVerification' | 'authorization' | 'workbookHydration' | 'derivation' | 'responseConstruction';

export class ReadTiming {
  succeeded = false;
  private readonly durations: Record<ReadPhase, number> = {
    credentialVerification: 0,
    authorization: 0,
    workbookHydration: 0,
    derivation: 0,
    responseConstruction: 0
  };
  private readonly sheetReads: Record<string, number> = {};
  private sheetCallMs = 0;
  private sheetCallCount = 0;

  measure<T>(phase: ReadPhase, action: () => T): T {
    const started = Date.now();
    try { return action(); }
    finally { this.durations[phase] += Date.now() - started; }
  }

  hydration<T>(tab: string, action: () => T): T {
    this.sheetReads[tab] = (this.sheetReads[tab] ?? 0) + 1;
    return this.measure('workbookHydration', action);
  }

  sheetCall<T>(action: () => T): T {
    const started = Date.now();
    this.sheetCallCount += 1;
    try { return action(); }
    finally { this.sheetCallMs += Date.now() - started; }
  }

  derive<T>(action: () => T): T {
    const started = Date.now();
    const hydrationBefore = this.durations.workbookHydration;
    try { return action(); }
    finally { this.durations.derivation += Math.max(0, Date.now() - started - (this.durations.workbookHydration - hydrationBefore)); }
  }

  report(operation: string, success: boolean, probeId?: string): void {
    console.log(`read-phases ${JSON.stringify({ operation, success, ...(probeId ? { probeId } : {}), phasesMs: this.durations, sheetCallMs: this.sheetCallMs, sheetCallCount: this.sheetCallCount, sheetReads: this.sheetReads })}`);
  }
}
