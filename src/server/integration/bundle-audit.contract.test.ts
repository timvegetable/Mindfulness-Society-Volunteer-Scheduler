import { describe, expect, it } from 'vitest';

// The executable audit module is imported directly so fixture tests exercise
// the same TypeScript-parser implementation used by build:server.
// @ts-expect-error The executable is intentionally a JavaScript build script.
const { auditServerBundle } = await import('../../../scripts/audit-server-bundle.mjs') as { auditServerBundle(source: string, fileName?: string): Array<{ name: string; location: string }> };

function runAudit(source: string): void {
  const issues = auditServerBundle(source, '<fixture>');
  if (issues.length > 0) throw new Error(issues.map((issue) => `${issue.name} at ${issue.location}`).join(', '));
}

describe('Apps Script bundle compatibility audit', () => {
  it('allows strings, property names, and guarded globalThis compatibility access', () => {
    expect(() => runAudit(`
      const labels = { TextDecoder: 'Buffer', process: 'structuredClone', crypto: 'text' };
      const description = 'TextDecoder Buffer process structuredClone crypto';
      if (typeof globalThis.TextEncoder === 'function') new globalThis.TextEncoder();
      const cryptoApi = typeof globalThis.crypto === 'object' ? globalThis.crypto : undefined;
      cryptoApi?.getRandomValues?.(new Uint8Array(1));
      function local(process: unknown, Buffer: unknown) { return process ?? Buffer; }
      local('process', 'Buffer');
      void labels;
    `)).not.toThrow();
  });

  it('rejects unsupported globals and unguarded compatibility references', () => {
    for (const source of [
      'new TextDecoder();',
      'Buffer.from("value");',
      'process.env.NODE_ENV;',
      'structuredClone({});',
      'crypto.randomUUID();',
      'new globalThis.TextEncoder();',
      'globalThis.crypto.randomUUID();',
      'globalThis.TextDecoder;',
      'if (typeof globalThis.TextEncoder === "undefined") new globalThis.TextEncoder();',
      'if (typeof globalThis.crypto !== "object") globalThis.crypto.randomUUID();'
    ]) {
      expect(() => runAudit(source), source).toThrow();
    }
  });
});
