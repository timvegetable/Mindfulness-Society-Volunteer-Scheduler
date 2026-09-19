import { describe, expect, it } from 'vitest';
import { MemoryTokenVerifier, MemoryUserDirectory, type VerifiedIdentityClaims } from './auth.js';
import { createIntegrationDispatcher, INTEGRATION_OPERATIONS } from './dispatcher.js';

const claims: VerifiedIdentityClaims = {
  iss: 'https://accounts.google.com', aud: 'client', sub: 'sub-1', email: 'admin@example.test', email_verified: true, exp: 4102444800
};
const user = { id: 'admin@example.test', email: 'admin@example.test', roles: ['administrator'] as const, active: true, revision: 0 };

function dispatcherWith(handler: (context: unknown, payload: unknown) => unknown) {
  return createIntegrationDispatcher({
    verifier: new MemoryTokenVerifier({ 'valid-credential': claims }),
    users: new MemoryUserDirectory([user as unknown as Parameters<typeof MemoryUserDirectory.prototype.set>[0]]),
    handlers: { [INTEGRATION_OPERATIONS.adminSchedule]: handler as never },
    revision: { current: () => 0 },
    writeLock: { tryAcquire: () => true, release: () => undefined }
  });
}

const request = { operation: INTEGRATION_OPERATIONS.adminSchedule, payload: {}, idempotencyKey: 'contract-check-1', credential: 'valid-credential' };

describe('rejection reporting', () => {
  it('tells the caller why the account was rejected', () => {
    const dispatcher = createIntegrationDispatcher({
      verifier: new MemoryTokenVerifier({ 'valid-credential': claims }),
      users: new MemoryUserDirectory([]),
      handlers: { [INTEGRATION_OPERATIONS.adminSchedule]: () => ({ sessions: [] }) },
      revision: { current: () => 0 },
      writeLock: { tryAcquire: () => true, release: () => undefined }
    });
    const response = dispatcher.dispatch(request);
    expect(response.ok).toBe(false);
    expect(response).toMatchObject({
      error: { code: 'UNAUTHORIZED', details: { reason: 'unknown-identity', detail: expect.stringContaining('no Users row') as unknown as string } }
    });
  });
});

describe('Apps Script synchronous operation contract', () => {
  it('answers with the handler value', () => {
    const response = dispatcherWith(() => ({ sessions: [] })).dispatch(request);
    expect(response).toEqual({ ok: true, data: { sessions: [] } });
  });

  it('rejects a handler that returns a Promise instead of failing at the platform', () => {
    const response = dispatcherWith(async () => ({ sessions: [] })).dispatch(request);
    expect(response.ok).toBe(false);
    expect(response).toMatchObject({ error: { code: 'INTERNAL_ERROR', message: expect.stringContaining('must complete synchronously') as unknown as string } });
  });
});
