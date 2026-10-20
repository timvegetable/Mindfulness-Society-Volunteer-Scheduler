import { decodePayload, decodeRequest, decodeResult } from '../../src/worker/api/validation';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { operations } from '../../src/shared/api/operations';
import { ErrorEnvelopeSchema, payloadSchemas, RequestEnvelopeSchema, resultSchemas } from '../../src/shared/api/schemas';

const weekly = { weekday: 1, start: '09:00', end: '12:00', timeZone: 'America/New_York' };
const volunteer = { id: 'v1', name: 'Volunteer', email: 'v@example.test', lifecycleStatus: 'active', interviewStatus: 'complete', readinessRank: 1 };
const center = { id: 'c1', name: 'Center', active: true };
const sessionCenter = { id: center.id, name: center.name };
const user = { id: 'u1', email: 'v@example.test', roles: ['volunteer'], volunteerId: 'v1', centerIds: [], active: true };
const candidate = { id: 'c1', centerId: 'center1', ...weekly, requestedStaffCount: 1, status: 'candidate' };
const session = { id: 's1', kind: 'center', centerId: 'c1', title: 'Center', date: '2026-10-05', start: '10:00', end: '11:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked' };
const assignment = { id: 'a1', sessionId: 's1', volunteerId: 'v1', scheduleRevision: 1, status: 'assigned' };
const exception = { id: 'e1', volunteerId: 'v1', date: '2026-10-05', kind: 'unavailable', start: '10:00', end: '11:00', timeZone: 'America/New_York' };
const recurring = { id: 'r1', volunteerId: 'v1', ...weekly };
const coverage = { volunteers: [volunteer], requestedCount: 1, shortfall: 0 };
const importRun = { id: 'i1', source: 'whenIsGood', contentHash: 'hash', status: 'staged', unmatched: [], stagedAvailability: [{ id: 'participant1', name: 'Volunteer', email: 'v@example.test', volunteerId: 'v1', intervals: [weekly] }] };
const schedule = { run: null, assignments: [assignment], backups: [], shortfalls: [], sessions: [session], volunteers: [volunteer], centers: [sessionCenter], stale: true };
const payloads: Record<string, unknown> = {
  'admin.sync.read': {}, 'admin.sync.now': {},
  'session.me': {}, 'volunteer.dashboard': {}, 'volunteer.availability.recurring.update': { intervals: [weekly] },
  'volunteer.availability.exception.create': { date: '2026-10-05', kind: 'available', start: '10:00', end: '11:00', timeZone: 'America/New_York' },
  'volunteer.assignment.cancel': { assignmentId: 'a1' }, 'volunteer.calendar.read': {}, 'volunteer.calendar.enable': {},
  'volunteer.calendar.reset': {}, 'volunteer.calendar.disable': {},
  'admin.schedule.read': {}, 'admin.schedule.preview': {}, 'admin.schedule.rerun': {},
  'admin.import.whenIsGood.preview': {}, 'admin.import.whenIsGood.promote': {},
  'admin.import.mapping.upsert': { sourceEmail: 'v@example.test', volunteerId: 'v1' },
  'admin.insights.read': {}, 'center.candidate.read': {}, 'center.candidate.update': { centerId: 'c1', ...weekly },
  'admin.center.candidate.confirm': { candidateId: 'c1' },
  'admin.volunteer.read': {}, 'admin.volunteer.create': { name: 'Volunteer', email: 'v@example.test' }, 'admin.volunteer.update': { volunteerId: 'v1', name: 'Volunteer', email: 'v@example.test' },
};
const syncView = { status: { lastAttemptAt: null, lastSuccessAt: null, effectiveChangeAt: null, outcome: 'never', diagnostic: null, participantCount: 0, matchedCount: 0, pendingCount: 0 }, pending: [], imports: [], volunteers: [{ id: volunteer.id, name: volunteer.name, email: volunteer.email }] };
const results: Record<string, object> = {
  'admin.sync.read': syncView, 'admin.sync.now': { status: syncView.status },
  'session.me': { user, centers: [center] },
  'volunteer.dashboard': { volunteer, calendarEnabled: false, assignments: [assignment], recurringAvailability: [recurring], availabilityExceptions: [exception], sessions: [session], centers: [sessionCenter] },
  'volunteer.availability.recurring.update': { intervals: [recurring] }, 'volunteer.availability.exception.create': { exception },
  'volunteer.assignment.cancel': { assignment, exception, promotedAssignment: null, shortfall: { sessionId: 's1', required: 1, assigned: 0, missing: 1 } },
  'admin.schedule.read': schedule, 'admin.schedule.rerun': schedule, 'admin.schedule.preview': { sessions: [session], output: { assignments: [{ sessionId: 's1', volunteerId: 'v1' }], backups: [], shortfalls: [] } },
  'volunteer.calendar.read': { enabled: false, token: null }, 'volunteer.calendar.enable': { enabled: true },
  'volunteer.calendar.reset': { enabled: true }, 'volunteer.calendar.disable': { enabled: false },
  'admin.import.whenIsGood.preview': { import: importRun }, 'admin.import.whenIsGood.promote': { import: { ...importRun, status: 'completed' } },
  'admin.import.mapping.upsert': { mapping: { id: 'm1', source: 'whenIsGood', sourceEmail: 'v@example.test', volunteerId: 'v1' } },
  'admin.insights.read': { leftoverVolunteers: [volunteer], grid: [{ weekday: 1, start: '09:00', end: '10:00', volunteers: [volunteer], count: 1 }] },
  'center.candidate.read': { candidates: [{ candidate, coverage }], centers: [center] },
  'center.candidate.update': { candidate, coverage }, 'admin.center.candidate.confirm': { candidate: { ...candidate, status: 'confirmed' }, session },
  'admin.volunteer.read': { volunteers: [volunteer] }, 'admin.volunteer.create': { volunteer }, 'admin.volunteer.update': { volunteer },
};

describe('shared API schemas', () => {
  it.each(operations)('%s has a strict payload and a validated revision-bearing result', (operation) => {
    expect(Schema.decodeUnknownSync(payloadSchemas[operation])(payloads[operation])).toEqual(payloads[operation]);
    expect(decodePayload(operation, payloads[operation])).toEqual(payloads[operation]);
    expect(() => decodePayload(operation, { ...(payloads[operation] as object), unknownField: true })).toThrow();
    expect(() => Schema.decodeUnknownSync(payloadSchemas[operation])({ ...(payloads[operation] as object), unknownField: 'substituted' })).toThrow();
    const result = { ...results[operation], dataRevision: 2, schedulingInputRevision: 1 };
    expect(Schema.decodeUnknownSync(resultSchemas[operation])(result)).toEqual(result);
    expect(decodeResult(operation, result)).toEqual(result);
    expect(() => decodeResult(operation, { ...result, dataRevision: -1 })).toThrow();
    expect(() => decodeResult(operation, { ...result, unknownField: 'private' })).toThrow();
    expect(() => Schema.decodeUnknownSync(resultSchemas[operation])(results[operation])).toThrow();
  });
  it.each(operations)('%s preserves boundary validation when nested values are corrupted', operation => {
    const compare = (fixture: unknown, fast: (value: unknown) => unknown, original: (value: unknown) => unknown) => {
      const paths: (string | number)[][] = [];
      function visit(value: unknown, path: (string | number)[]) {
        paths.push(path);
        if (value !== null && typeof value === 'object') {
          for (const [key, child] of Object.entries(value)) visit(child, [...path, Array.isArray(value) ? Number(key) : key]);
        }
      }
      visit(fixture, []);
      const accepted = (decode: (value: unknown) => unknown, value: unknown) => { try { decode(value); return true; } catch { return false; } };
      for (const path of paths) for (const replacement of [null, undefined, false, -1, 1.5, NaN, Infinity, 'invalid', '2026-02-30', {}, [], [undefined], Array(1), { privateField: true }]) {
        let value: unknown = replacement;
        if (path.length) {
          value = structuredClone(fixture);
          let parent = value as Record<string | number, unknown>;
          for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
          parent[path.at(-1)!] = replacement;
        }
        expect(accepted(fast, value), `${operation} ${path.join('.')}`).toBe(accepted(original, value));
      }
    };
    compare({ ...results[operation], dataRevision: 2, schedulingInputRevision: 1 },
      value => decodeResult(operation, value), Schema.decodeUnknownSync(resultSchemas[operation]));
    compare(payloads[operation], value => decodePayload(operation, value), Schema.decodeUnknownSync(payloadSchemas[operation]));
    compare({ operation, credential: 'synthetic', payload: payloads[operation], expectedRevision: 1, idempotencyKey: 'synthetic' },
      decodeRequest, Schema.decodeUnknownSync(RequestEnvelopeSchema));
  });
  it('rejects unknown envelope fields and unknown operations', () => {
    const request = { operation: 'session.me', payload: {}, credential: 'token' };
    expect(Schema.decodeUnknownSync(RequestEnvelopeSchema)(request)).toEqual(request);
    expect(decodeRequest(request)).toEqual(request);
    for (const key of Object.keys(request)) {
      const missing = { ...request } as Record<string, unknown>; delete missing[key];
      const accepts = (fn: (value: unknown) => unknown) => { try { fn(missing); return true; } catch { return false; } };
      expect(accepts(decodeRequest)).toBe(accepts(Schema.decodeUnknownSync(RequestEnvelopeSchema)));
    }
    expect(() => Schema.decodeUnknownSync(RequestEnvelopeSchema)({ ...request, operation: 'admin.insights.refresh' })).toThrow();
    expect(() => Schema.decodeUnknownSync(RequestEnvelopeSchema)({ ...request, volunteerId: 'other' })).toThrow();
    expect(() => Schema.decodeUnknownSync(RequestEnvelopeSchema)({ ...request, expectedRevision: -1 })).toThrow();
  });
  it('rejects excess fields inside recurring intervals and more than 100 intervals', () => {
    const decode = Schema.decodeUnknownSync(payloadSchemas['volunteer.availability.recurring.update']);
    expect(() => decode({ intervals: [{ ...weekly, volunteerId: 'substituted' }] })).toThrow();
    expect(() => decode({ intervals: Array.from({ length: 101 }, () => weekly) })).toThrow();
    expect(() => decodePayload('volunteer.availability.recurring.update', { intervals: Array.from({ length: 101 }, () => weekly) })).toThrow();
    expect(decode({ intervals: Array.from({ length: 100 }, () => weekly) }).intervals).toHaveLength(100);
  });
  it('rejects invalid dates, times, interval ordering, weekdays and timezone names', () => {
    const decode = Schema.decodeUnknownSync(payloadSchemas['volunteer.availability.exception.create']);
    const valid = payloads['volunteer.availability.exception.create'] as object;
    for (const change of [{ date: '2026-02-30' }, { date: '2026-1-01' }, { start: '24:00' }, { start: '12:00', end: '11:00' }, { start: '11:00', end: '11:00' }, { timeZone: 'Invalid/Zone' }]) expect(() => decode({ ...valid, ...change })).toThrow();
    expect(() => Schema.decodeUnknownSync(payloadSchemas['center.candidate.update'])({ centerId: 'c1', ...weekly, weekday: 6 })).toThrow();
  });
  it.each([
    ['2000-02-29', true], ['1900-02-29', false], ['2024-02-29', true], ['2026-02-29', false],
    ['0000-02-29', true], ['0099-01-01', true], ['2026-04-31', false], ['9999-12-31', true],
  ])('validates the Gregorian date %s across leap years and year boundaries', (date, valid) => {
    const decode = () => Schema.decodeUnknownSync(payloadSchemas['volunteer.availability.exception.create'])({
      date, kind: 'available', start: '10:00', end: '11:00', timeZone: 'America/New_York',
    });
    if (valid) expect(decode().date).toBe(date);
    else expect(decode).toThrow();
  });
  it('requires all candidate creation fields, allows partial edits, and only permits cancellation status', () => {
    const decode = Schema.decodeUnknownSync(payloadSchemas['center.candidate.update']);
    expect(() => decode({ centerId: 'c1' })).toThrow();
    expect(decode({ candidateId: 'c1', requestedStaffCount: 0 })).toEqual({ candidateId: 'c1', requestedStaffCount: 0 });
    expect(decode({ candidateId: 'c1', status: 'cancelled' })).toEqual({ candidateId: 'c1', status: 'cancelled' });
    expect(() => decode({ candidateId: 'c1', status: 'confirmed' })).toThrow();
    expect(() => decode({ centerId: 'c1', ...weekly, status: 'cancelled' })).toThrow();
    expect(() => decode({ candidateId: 'c1', requestedStaffCount: 3 })).toThrow();
  });
  it('requires at least one source mapping identity', () => {
    const decode = Schema.decodeUnknownSync(payloadSchemas['admin.import.mapping.upsert']);
    expect(() => decode({ volunteerId: 'v1' })).toThrow();
    expect(() => decode({ volunteerId: 'v1', sourceName: '' })).toThrow();
    expect(decode({ volunteerId: 'v1', sourceParticipantId: 'p1' })).toEqual({ volunteerId: 'v1', sourceParticipantId: 'p1' });
  });
  it('validates failed fetch runs without content to hash', () => {
    expect(Schema.decodeUnknownSync(resultSchemas['admin.import.whenIsGood.preview'])({ dataRevision: 1, schedulingInputRevision: 0, import: { ...importRun, contentHash: '', status: 'failed', stagedAvailability: [], diagnostic: 'Fetch failed' } })).toMatchObject({ import: { status: 'failed', contentHash: '' } });
  });
  it('validates public errors while allowing application-specific details', () => {
    expect(Schema.decodeUnknownSync(ErrorEnvelopeSchema)({ ok: false, error: { code: 'STALE_REVISION', message: 'Data changed', details: { currentRevision: 2 } } })).toMatchObject({ ok: false });
    expect(() => Schema.decodeUnknownSync(ErrorEnvelopeSchema)({ ok: false, error: { code: 'SQL_ERROR', message: 'internal' } })).toThrow();
  });
});
