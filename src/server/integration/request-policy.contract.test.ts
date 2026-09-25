import { describe, expect, it } from 'vitest';
import { ApiRequestSchema } from '../../shared/domain.js';
import {
  ALLOWED_INTEGRATION_OPERATIONS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  INTEGRATION_OPERATIONS,
  OPERATION_POLICIES,
  validateRequestEnvelope
} from './request-policy.js';
import { createIntegrationDispatcher, MemoryRevisionSource, MemoryWriteLock } from './dispatcher.js';
import { MemoryTokenVerifier, MemoryUserDirectory } from './auth.js';

/**
 * The extracted request-policy seam must accept and refuse exactly what the
 * dispatcher accepted and refused before the policy lived in its own module, and
 * the dispatcher must now be a consumer of it rather than a second copy.
 */
describe('request policy seam', () => {
  const valid = { operation: INTEGRATION_OPERATIONS.me, payload: {}, idempotencyKey: 'policy-probe-1' };

  it('registers exactly the sixteen operations and keeps the three read-only route operations', () => {
    expect(Object.values(INTEGRATION_OPERATIONS)).toHaveLength(16);
    expect(ALLOWED_INTEGRATION_OPERATIONS.size).toBe(16);
    const readOnly = Object.entries(OPERATION_POLICIES).filter(([, policy]) => policy.readOnly).map(([operation]) => operation);
    expect(readOnly).toContain(INTEGRATION_OPERATIONS.me);
    expect(readOnly).toContain(INTEGRATION_OPERATIONS.adminSchedule);
    expect(readOnly).toContain(INTEGRATION_OPERATIONS.adminInsights);
  });

  it('accepts a well-formed envelope and returns the schema-validated payload', () => {
    const result = validateRequestEnvelope(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.operation).toBe(INTEGRATION_OPERATIONS.me);
    expect(result.value.payload).toEqual({});
    // Key order is normalised, so two callers cannot produce different
    // fingerprints for the same request by reordering JSON fields.
    expect(result.value.requestFingerprint).toBe('{"operation":"session.me","payload":{}}');
    const reordered = validateRequestEnvelope({ idempotencyKey: 'policy-probe-1', payload: {}, operation: INTEGRATION_OPERATIONS.me });
    expect(reordered.ok && reordered.value.requestFingerprint).toBe(result.value.requestFingerprint);
  });

  it('refuses a mutating operation when the caller asked for read-only dispatch', () => {
    const result = validateRequestEnvelope({ operation: INTEGRATION_OPERATIONS.adminScheduleRerun, payload: {}, idempotencyKey: 'policy-probe-2' }, { readOnly: true });
    expect(result).toMatchObject({ ok: false, response: { ok: false, error: { code: 'FORBIDDEN' } } });
  });

  it('refuses unsupported request fields, dangerous payload keys and oversized envelopes', () => {
    const cases: Array<[unknown, string]> = [
      [{ ...valid, spreadsheetId: 'x' }, 'INVALID_REQUEST'],
      [{ ...valid, payload: { range: 'Users!A1:B2' } }, 'INVALID_REQUEST'],
      [{ ...valid, payload: { nested: { Query: 'select 1' } } }, 'INVALID_REQUEST'],
      [{ ...valid, payload: { filler: 'x'.repeat(DEFAULT_MAX_PAYLOAD_BYTES) } }, 'PAYLOAD_TOO_LARGE'],
      ['not an object', 'INVALID_REQUEST'],
      [{ ...valid, idempotencyKey: 'short' }, 'INVALID_REQUEST'],
      [{ ...valid, expectedRevision: -1 }, 'INVALID_REQUEST'],
      [{ ...valid, expectedRevision: 1.5 }, 'INVALID_REQUEST']
    ];
    for (const [input, code] of cases) {
      const result = validateRequestEnvelope(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.response).toMatchObject({ ok: false, error: { code } });
    }
  });

  it('honours a caller-supplied smaller payload limit', () => {
    const intervals = Array.from({ length: 60 }, () => ({ weekday: 1, start: '09:00', end: '10:00', timeZone: 'America/New_York' }));
    const input = { operation: INTEGRATION_OPERATIONS.recurringAvailabilityUpdate, payload: { intervals }, idempotencyKey: 'policy-probe-3' };
    expect(validateRequestEnvelope(input, { maxPayloadBytes: 1024 })).toMatchObject({ ok: false, response: { ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } } });
    expect(validateRequestEnvelope(input, { maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES }).ok).toBe(true);
  });

  it('keeps the dispatcher and the seam in agreement for the same request', () => {
    // A dispatcher that rejects before authentication proves the seam ran first:
    // with no credential the failure would otherwise be UNAUTHORIZED.
    const dispatcher = createIntegrationDispatcher({
      verifier: new MemoryTokenVerifier(),
      users: new MemoryUserDirectory(),
      revision: new MemoryRevisionSource(0),
      writeLock: new MemoryWriteLock()
    });
    const oversized = { operation: INTEGRATION_OPERATIONS.me, payload: { filler: 'x'.repeat(DEFAULT_MAX_PAYLOAD_BYTES) }, idempotencyKey: 'policy-probe-4' };
    const viaDispatcher = dispatcher.dispatch(oversized);
    const viaSeam = validateRequestEnvelope(oversized);
    expect(viaDispatcher).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(viaSeam.ok).toBe(false);
    if (!viaSeam.ok) expect(viaSeam.response).toEqual(viaDispatcher);

    const mutation = { operation: INTEGRATION_OPERATIONS.adminScheduleRerun, payload: {}, idempotencyKey: 'policy-probe-5' };
    expect(dispatcher.dispatchReadOnly(mutation)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const readOnlySeam = validateRequestEnvelope(mutation, { readOnly: true });
    expect(readOnlySeam.ok).toBe(false);
    if (!readOnlySeam.ok) expect(readOnlySeam.response).toEqual(dispatcher.dispatchReadOnly(mutation));
  });

  it('gives every registered operation a role set and a strict payload schema', () => {
    for (const operation of Object.values(INTEGRATION_OPERATIONS)) {
      const policy = OPERATION_POLICIES[operation];
      expect(policy.roles.length, operation).toBeGreaterThan(0);
      // Strict schemas reject an unknown field, so a payload cannot smuggle in a
      // Sheet or range reference that the handler would then ignore or misuse.
      expect(policy.payload.safeParse({ unexpectedField: true }).success, operation).toBe(false);
      expect(ApiRequestSchema.safeParse({ operation, payload: {}, idempotencyKey: 'policy-probe-6' }).success, operation).toBe(true);
      // A declared mutating operation is never read-only, and vice versa.
      expect(policy.mutating && policy.readOnly, operation).toBe(false);
    }
  });
});
