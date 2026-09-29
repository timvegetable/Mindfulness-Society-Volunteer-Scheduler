import { describe, expect, it } from 'vitest';
import { MemoryTokenVerifier, MemoryUserDirectory, type VerifiedIdentityClaims } from './auth.js';
import { createIntegrationDispatcher, INTEGRATION_OPERATIONS, MemoryRevisionSource, MemoryWriteLock, OPERATION_POLICIES } from './dispatcher.js';

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

describe('write gate', () => {
  it('refuses a state-changing operation while writes are disabled', () => {
    const dispatcher = createIntegrationDispatcher({
      verifier: new MemoryTokenVerifier({ 'valid-credential': claims }),
      users: new MemoryUserDirectory([user as unknown as Parameters<typeof MemoryUserDirectory.prototype.set>[0]]),
      // No revision source and no write lock: exactly what the runtime installs
      // when the WRITE_ENABLED Script Property is not "true".
      handlers: { [INTEGRATION_OPERATIONS.adminScheduleRerun]: () => ({ sessions: [] }) }
    });

    const response = dispatcher.dispatch({ operation: INTEGRATION_OPERATIONS.adminScheduleRerun, payload: {}, idempotencyKey: 'gate-check-1', credential: 'valid-credential', expectedRevision: 0 });

    expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });
});

describe('reviewed scheduling publication', () => {
  it('publishes with the preview revision and rejects a superseded one', () => {
    const revision = new MemoryRevisionSource(7);
    let publications = 0;
    const dispatcher = createIntegrationDispatcher({
      verifier: new MemoryTokenVerifier({ 'valid-credential': claims }),
      users: new MemoryUserDirectory([user as unknown as Parameters<typeof MemoryUserDirectory.prototype.set>[0]]),
      handlers: {
        [INTEGRATION_OPERATIONS.adminSchedulePreview]: () => ({ preview: true, revision: revision.current() }),
        [INTEGRATION_OPERATIONS.adminScheduleRerun]: () => {
          publications += 1;
          return { preview: false, sessions: [] };
        }
      },
      revision,
      writeLock: new MemoryWriteLock()
    });

    const preview = dispatcher.dispatchReadOnly({ operation: INTEGRATION_OPERATIONS.adminSchedulePreview, payload: {}, idempotencyKey: 'preview-1', credential: 'valid-credential' });
    expect(preview).toEqual({ ok: true, data: { preview: true, revision: 7 } });

    const published = dispatcher.dispatch({ operation: INTEGRATION_OPERATIONS.adminScheduleRerun, payload: {}, idempotencyKey: 'publish-1', credential: 'valid-credential', expectedRevision: 7 });
    expect(published.ok).toBe(true);
    expect(publications).toBe(1);

    // Any intervening mutation moves the global revision, so the reviewed
    // preview can no longer be published.
    const superseded = dispatcher.dispatch({ operation: INTEGRATION_OPERATIONS.adminScheduleRerun, payload: {}, idempotencyKey: 'publish-2', credential: 'valid-credential', expectedRevision: 7 });
    expect(superseded).toMatchObject({ ok: false, error: { code: 'STALE_REVISION', details: { currentRevision: 8 } } });
    expect(publications).toBe(1);
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

describe('import preview staging is a mutation', () => {
  const previewRequest = {
    operation: INTEGRATION_OPERATIONS.adminImportPreview,
    payload: { resultsCode: 'results-code-1' },
    idempotencyKey: 'preview-check-1',
    credential: 'valid-credential'
  };

  function previewDispatcher(options: { revision?: MemoryRevisionSource; writeLock?: MemoryWriteLock } = {}) {
    const stagged: unknown[] = [];
    const dispatcher = createIntegrationDispatcher({
      verifier: new MemoryTokenVerifier({ 'valid-credential': claims }),
      users: new MemoryUserDirectory([user as unknown as Parameters<typeof MemoryUserDirectory.prototype.set>[0]]),
      handlers: { [INTEGRATION_OPERATIONS.adminImportPreview]: (_context, payload) => { stagged.push(payload); return { import: { resultsCode: 'results-code-1' } }; } },
      ...(options.revision ? { revision: options.revision } : {}),
      ...(options.writeLock ? { writeLock: options.writeLock } : {})
    });
    return { dispatcher, stagged };
  }

  it('is classified as mutating, revision-requiring and not read-only', () => {
    const policy = OPERATION_POLICIES[INTEGRATION_OPERATIONS.adminImportPreview];
    expect(policy).toMatchObject({ mutating: true, expectedRevision: true, readOnly: false });
  });

  it('refuses a request that omits the revision, staging nothing', () => {
    const revision = new MemoryRevisionSource(4);
    const { dispatcher, stagged } = previewDispatcher({ revision, writeLock: new MemoryWriteLock() });

    const response = dispatcher.dispatch({ ...previewRequest, idempotencyKey: 'preview-missing-1' });

    expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(stagged).toEqual([]);
    expect(revision.current()).toBe(4);
  });

  it('refuses a stale revision, staging nothing', () => {
    const revision = new MemoryRevisionSource(4);
    const { dispatcher, stagged } = previewDispatcher({ revision, writeLock: new MemoryWriteLock() });

    const response = dispatcher.dispatch({ ...previewRequest, idempotencyKey: 'preview-stale-1', expectedRevision: 3 });

    expect(response).toMatchObject({ ok: false, error: { code: 'STALE_REVISION', details: { currentRevision: 4 } } });
    expect(stagged).toEqual([]);
    expect(revision.current()).toBe(4);
  });

  it('refuses while the live write gate is closed, staging nothing', () => {
    // No revision source and no write lock: what the runtime installs when
    // WRITE_ENABLED is not exactly "true".
    const { dispatcher, stagged } = previewDispatcher();

    const response = dispatcher.dispatch({ ...previewRequest, idempotencyKey: 'preview-gate-1', expectedRevision: 4 });

    expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(stagged).toEqual([]);
  });

  it('refuses the read-only dispatch path, staging nothing', () => {
    const revision = new MemoryRevisionSource(4);
    const { dispatcher, stagged } = previewDispatcher({ revision, writeLock: new MemoryWriteLock() });

    const response = dispatcher.dispatchReadOnly({ ...previewRequest, idempotencyKey: 'preview-readonly-1', expectedRevision: 4 });

    expect(response).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(stagged).toEqual([]);
  });

  it('stages once with the current revision and advances the global revision', () => {
    const revision = new MemoryRevisionSource(4);
    const { dispatcher, stagged } = previewDispatcher({ revision, writeLock: new MemoryWriteLock() });

    const response = dispatcher.dispatch({ ...previewRequest, idempotencyKey: 'preview-ok-1', expectedRevision: 4 });

    expect(response).toMatchObject({ ok: true, revision: 5 });
    expect(stagged).toHaveLength(1);
    expect(revision.current()).toBe(5);
  });
});
