export type CapturedCredentialSummary = {
  audience: string;
  expiresAt: string;
  minutesRemaining: number;
  hasEmail: boolean;
  emailVerified: boolean;
  out: string;
};

export declare function assertPrivatePath(path: string): string;
export declare function inspectIdToken(token: string, expectedAudience: string, nowMs?: number): Omit<CapturedCredentialSummary, 'out'>;
export declare function signInPage(expectedAudience: string, origin: string): string;
export declare function startCredentialCapture(options: {
  audience: string;
  out?: string;
  port?: number;
  nowMs?: () => number;
  onCaptured?: (summary: CapturedCredentialSummary) => void;
}): Promise<{ origin: string; out: string; close(): Promise<void> }>;
