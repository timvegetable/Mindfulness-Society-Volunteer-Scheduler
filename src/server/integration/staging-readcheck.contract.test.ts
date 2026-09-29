import { describe, expect, it } from 'vitest';
import { controlReadCheck, evaluateExpectation, type ControlReadCheckResult } from '../../../scripts/staging/control-read-check.mjs';

/**
 * The control read check is a measurement tool, so its contract is: it reports
 * exactly what the service said, it never puts a credential or a row value into
 * its result, and the expectation comparison is strict about the failure reason.
 * These tests contact nothing.
 */

function fetchReturning(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => body
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const servedHeaders = { 'x-staging-sheets-reads': '4', 'x-staging-correlation-id': 'corr-1', 'x-staging-host-deployed-at': '2026-09-29T21:47:50.265Z' };

describe('control read check', () => {
  it('posts the operation envelope with the credential and reports the service answer', async () => {
    const { fetchImpl, calls } = fetchReturning(200, { ok: true, data: { revision: 43 } }, servedHeaders);

    const result = await controlReadCheck({ workerUrl: 'https://staging.example/exec', operation: 'admin.schedule.read', credential: 'credential-value', idempotencyKey: 'check-1', fetchImpl });

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ operation: 'admin.schedule.read', idempotencyKey: 'check-1', credential: 'credential-value' });
    expect(calls[0]?.init.method).toBe('POST');
    expect(result).toEqual({
      status: 200,
      durationMs: expect.any(Number) as unknown as number,
      ok: true,
      errorCode: undefined,
      reason: undefined,
      sheetsReads: 4,
      hasCorrelationId: true,
      hasHostMarker: true
    });
    // No credential or row value may appear anywhere in the result.
    expect(JSON.stringify(result)).not.toContain('credential-value');
  });

  it('reports a bounded refusal with its code and reason', async () => {
    const { fetchImpl } = fetchReturning(200, { ok: false, error: { code: 'UNAVAILABLE', message: 'not now', details: { reason: 'control-pending' } } }, { 'x-staging-sheets-reads': '1' });

    const result = await controlReadCheck({ workerUrl: 'https://staging.example/exec', operation: 'admin.schedule.read', credential: 'c', fetchImpl });

    expect(result).toMatchObject({ ok: false, errorCode: 'UNAVAILABLE', reason: 'control-pending', sheetsReads: 1, hasCorrelationId: false, hasHostMarker: false });
  });

  it('never throws on a response that is not JSON', async () => {
    const fetchImpl = (async () => ({ status: 503, headers: { get: () => null }, json: async () => { throw new Error('not json'); } }) as unknown as Response) as unknown as typeof fetch;

    const result = await controlReadCheck({ workerUrl: 'https://staging.example/exec', operation: 'admin.schedule.read', credential: 'c', fetchImpl });

    expect(result).toMatchObject({ status: 503, ok: false, errorCode: undefined, sheetsReads: 0 });
  });
});

describe('expectation comparison', () => {
  const served: ControlReadCheckResult = { status: 200, durationMs: 12, ok: true, sheetsReads: 4, hasCorrelationId: true, hasHostMarker: true };
  const refused = (code: string, reason: string): ControlReadCheckResult => ({ status: 200, durationMs: 9, ok: false, errorCode: code, reason, sheetsReads: 1, hasCorrelationId: true, hasHostMarker: true });

  it('accepts a served read against the served expectation', () => {
    expect(evaluateExpectation(served, 'ok')).toMatchObject({ passed: true });
  });

  it('requires both the code and the named reason for a refusal', () => {
    expect(evaluateExpectation(refused('UNAVAILABLE', 'control-pending'), 'failed:UNAVAILABLE:control-pending')).toMatchObject({ passed: true });
    expect(evaluateExpectation(refused('UNAVAILABLE', 'control-missing'), 'failed:UNAVAILABLE:control-pending').passed).toBe(false);
    expect(evaluateExpectation(refused('STALE_REVISION', 'control-generation_changed'), 'failed:UNAVAILABLE').passed).toBe(false);
    expect(evaluateExpectation(served, 'failed:UNAVAILABLE').passed).toBe(false);
  });

  it('reports a mismatch with what actually happened', () => {
    expect(evaluateExpectation(served, 'failed:UNAVAILABLE:control-pending').detail).toContain('got served');
    expect(evaluateExpectation(refused('UNAVAILABLE', 'control-pending'), 'ok').detail).toContain('control-pending');
  });

  it('refuses an unparseable expectation rather than passing it', () => {
    expect(evaluateExpectation(served, 'anything').passed).toBe(false);
    expect(evaluateExpectation(served, 'failed').passed).toBe(false);
  });
});
