import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { operations } from '../../src/shared/api/operations';
import { ErrorEnvelopeSchema, payloadSchemas, RequestEnvelopeSchema, resultSchemas } from '../../src/shared/api/schemas';

const weekly = { weekday: 1, start: '09:00', end: '12:00', timeZone: 'America/New_York' };
const volunteer = { id: 'v1', name: 'Volunteer', email: 'v@example.test', lifecycleStatus: 'active', interviewStatus: 'complete', readinessRank: 1 };
const center = { id: 'c1', name: 'Center', active: true };
const user = { id: 'u1', email: 'v@example.test', roles: ['volunteer'], volunteerId: 'v1', centerIds: [], active: true };
const candidate = { id: 'c1', centerId: 'center1', ...weekly, requestedStaffCount: 1, status: 'candidate' };
const session = { id: 's1', kind: 'center', centerId: 'c1', title: 'Center', date: '2026-10-05', start: '10:00', end: '11:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked' };
const assignment = { id: 'a1', sessionId: 's1', volunteerId: 'v1', scheduleRevision: 1, status: 'assigned' };
const exception = { id: 'e1', volunteerId: 'v1', date: '2026-10-05', kind: 'unavailable', start: '10:00', end: '11:00', timeZone: 'America/New_York' };
const recurring = { id: 'r1', volunteerId: 'v1', ...weekly };
const coverage = { volunteers: [volunteer], requestedCount: 1, shortfall: 0 };
const importRun = { id: 'i1', source: 'whenIsGood', contentHash: 'hash', status: 'staged', unmatched: [], stagedAvailability: [{ id: 'participant1', name: 'Volunteer', email: 'v@example.test', volunteerId: 'v1', intervals: [weekly] }] };
const schedule = { run: null, assignments: [assignment], backups: [], shortfalls: [], sessions: [session], volunteers: [volunteer], stale: true };
const payloads: Record<string, unknown> = {
  'session.me': {}, 'volunteer.dashboard': {}, 'volunteer.availability.recurring.update': { intervals: [weekly] },
  'volunteer.availability.exception.create': { date: '2026-10-05', kind: 'available', start: '10:00', end: '11:00', timeZone: 'America/New_York' },
  'volunteer.assignment.cancel': { assignmentId: 'a1' }, 'admin.schedule.read': {}, 'admin.schedule.preview': {}, 'admin.schedule.rerun': {},
  'admin.import.whenIsGood.preview': { resultsCode: 'abc' }, 'admin.import.whenIsGood.promote': { resultsCode: 'abc' },
  'admin.import.mapping.upsert': { sourceEmail: 'v@example.test', volunteerId: 'v1' },
  'admin.insights.read': {}, 'center.candidate.read': {}, 'center.candidate.update': { centerId: 'c1', ...weekly },
  'admin.center.candidate.confirm': { candidateId: 'c1' },
};
const results: Record<string, object> = {
  'session.me': { user, centers: [center] },
  'volunteer.dashboard': { volunteer, assignments: [assignment], recurringAvailability: [recurring], availabilityExceptions: [exception], sessions: [session] },
  'volunteer.availability.recurring.update': { intervals: [recurring] }, 'volunteer.availability.exception.create': { exception },
  'volunteer.assignment.cancel': { assignment, exception, promotedAssignment: null, shortfall: { sessionId: 's1', required: 1, assigned: 0, missing: 1 } },
  'admin.schedule.read': schedule, 'admin.schedule.rerun': schedule, 'admin.schedule.preview': { output: { assignments: [{ sessionId: 's1', volunteerId: 'v1' }], backups: [], shortfalls: [] } },
  'admin.import.whenIsGood.preview': { import: importRun }, 'admin.import.whenIsGood.promote': { import: { ...importRun, status: 'completed' } },
  'admin.import.mapping.upsert': { mapping: { id: 'm1', source: 'whenIsGood', sourceEmail: 'v@example.test', volunteerId: 'v1' } },
  'admin.insights.read': { leftoverVolunteers: [volunteer], grid: [{ weekday: 1, start: '09:00', end: '10:00', volunteers: [volunteer], count: 1 }] },
  'center.candidate.read': { candidates: [{ candidate, coverage }], centers: [center] },
  'center.candidate.update': { candidate, coverage }, 'admin.center.candidate.confirm': { candidate: { ...candidate, status: 'confirmed' }, session },
};

describe('shared API schemas', () => {
  it.each(operations)('%s has a strict payload and a validated revision-bearing result', (operation) => {
    expect(Schema.decodeUnknownSync(payloadSchemas[operation])(payloads[operation])).toEqual(payloads[operation]);
    expect(() => Schema.decodeUnknownSync(payloadSchemas[operation])({ ...(payloads[operation] as object), unknownField: 'substituted' })).toThrow();
    const result = { ...results[operation], dataRevision: 2, schedulingInputRevision: 1 };
    expect(Schema.decodeUnknownSync(resultSchemas[operation])(result)).toEqual(result);
    expect(() => Schema.decodeUnknownSync(resultSchemas[operation])(results[operation])).toThrow();
  });
  it('rejects unknown envelope fields and unknown operations', () => {
    const request = { operation: 'session.me', payload: {}, credential: 'token' };
    expect(Schema.decodeUnknownSync(RequestEnvelopeSchema)(request)).toEqual(request);
    expect(() => Schema.decodeUnknownSync(RequestEnvelopeSchema)({ ...request, operation: 'admin.insights.refresh' })).toThrow();
    expect(() => Schema.decodeUnknownSync(RequestEnvelopeSchema)({ ...request, volunteerId: 'other' })).toThrow();
    expect(() => Schema.decodeUnknownSync(RequestEnvelopeSchema)({ ...request, expectedRevision: -1 })).toThrow();
  });
  it('rejects excess fields inside recurring intervals and more than 100 intervals', () => {
    const decode = Schema.decodeUnknownSync(payloadSchemas['volunteer.availability.recurring.update']);
    expect(() => decode({ intervals: [{ ...weekly, volunteerId: 'substituted' }] })).toThrow();
    expect(() => decode({ intervals: Array.from({ length: 101 }, () => weekly) })).toThrow();
    expect(decode({ intervals: Array.from({ length: 100 }, () => weekly) }).intervals).toHaveLength(100);
  });
  it('rejects invalid dates, times, interval ordering, weekdays and timezone names', () => {
    const decode = Schema.decodeUnknownSync(payloadSchemas['volunteer.availability.exception.create']);
    const valid = payloads['volunteer.availability.exception.create'] as object;
    for (const change of [{ date: '2026-02-30' }, { date: '2026-1-01' }, { start: '24:00' }, { start: '12:00', end: '11:00' }, { start: '11:00', end: '11:00' }, { timeZone: 'Invalid/Zone' }]) expect(() => decode({ ...valid, ...change })).toThrow();
    expect(() => Schema.decodeUnknownSync(payloadSchemas['center.candidate.update'])({ centerId: 'c1', ...weekly, weekday: 6 })).toThrow();
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
