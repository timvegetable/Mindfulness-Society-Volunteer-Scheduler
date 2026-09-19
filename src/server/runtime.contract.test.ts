import { describe, expect, it } from 'vitest';
import { INTEGRATION_OPERATIONS, type HandlerContext, type IntegrationOperation } from './integration/dispatcher.js';
import { createProductionRuntime } from './runtime.js';
import { InMemoryProperties, InMemorySpreadsheet } from './workbook/in-memory-sheet.js';

const actor = {
  claims: { iss: 'https://accounts.google.com', aud: 'client', sub: 'sub-1', email: 'admin@example.test', email_verified: true, exp: 0 },
  email: 'admin@example.test',
  user: { id: 'admin@example.test', email: 'admin@example.test', roles: ['administrator'] as const, active: true, revision: 0 }
};

describe('production Apps Script runtime', () => {
  it('composes a handler for every allowlisted operation', () => {
    const runtime = createProductionRuntime(new InMemorySpreadsheet(), new InMemoryProperties());
    for (const operation of Object.values(INTEGRATION_OPERATIONS)) expect(runtime.handlers[operation]).toBeTypeOf('function');
  });

  // Apps Script rejects a web app whose entry point returns a Promise with
  // "The script completed but the returned value is not a supported return type".
  it('never returns a Promise from a handler', () => {
    const runtime = createProductionRuntime(new InMemorySpreadsheet(), new InMemoryProperties());
    for (const operation of Object.values(INTEGRATION_OPERATIONS) as IntegrationOperation[]) {
      const handler = runtime.handlers[operation];
      if (!handler) continue;
      const context: HandlerContext = { actor: actor as unknown as HandlerContext['actor'], operation, idempotencyKey: 'contract-check', now: '2026-09-19T00:00:00.000Z' };
      let value: unknown;
      try {
        value = handler(context, {});
      } catch {
        continue; // a missing prerequisite is fine here; the return type is what matters
      }
      expect(typeof (value as { then?: unknown } | null)?.then, `${operation} returned a Promise`).not.toBe('function');
    }
  });
});
