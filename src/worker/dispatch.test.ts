import { describe, expect, it } from 'vitest';
import { INTEGRATION_OPERATIONS } from '../server/integration/request-policy.js';
import { createStagingDispatch } from './dispatch.js';

/**
 * The staging composition applies the shared envelope and read-only policy and
 * then refuses the served operations, because identity verification and
 * workbook access do not exist yet. These assertions pin that boundary so a
 * later milestone cannot quietly start serving unauthenticated data.
 */
describe('staging dispatch seam', () => {
  const dispatch = createStagingDispatch();

  it('refuses the three served operations until authentication and workbook access are configured', async () => {
    for (const operation of [INTEGRATION_OPERATIONS.me, INTEGRATION_OPERATIONS.adminSchedule, INTEGRATION_OPERATIONS.adminInsights]) {
      const response = await dispatch({ operation, payload: {}, idempotencyKey: 'dispatch-probe-1' });
      expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    }
  });

  it('refuses a mutating operation with the shared read-only policy', async () => {
    const response = await dispatch({ operation: INTEGRATION_OPERATIONS.adminScheduleRerun, payload: {}, idempotencyKey: 'dispatch-probe-2' });
    expect(response).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('rejects an unsupported request field instead of ignoring it', async () => {
    const response = await dispatch({ operation: INTEGRATION_OPERATIONS.me, payload: {}, idempotencyKey: 'dispatch-probe-3', spreadsheetId: 'x' });
    expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('rejects payloads that name a Sheet range or query', async () => {
    const response = await dispatch({ operation: INTEGRATION_OPERATIONS.me, payload: { range: 'A1:B2' }, idempotencyKey: 'dispatch-probe-4' });
    expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('rejects a structurally invalid envelope and an oversized one', async () => {
    expect(await dispatch({ operation: INTEGRATION_OPERATIONS.me, payload: [], idempotencyKey: 'dispatch-probe-5' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await dispatch({ operation: INTEGRATION_OPERATIONS.me, payload: {}, idempotencyKey: 'short' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await dispatch({ operation: INTEGRATION_OPERATIONS.me, payload: { filler: 'x'.repeat(70 * 1024) }, idempotencyKey: 'dispatch-probe-6' }))
      .toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(await dispatch('not an object')).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('refuses an operation that is not registered at all', async () => {
    expect(await dispatch({ operation: 'admin.anything.else', payload: {}, idempotencyKey: 'dispatch-probe-7' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });
});
