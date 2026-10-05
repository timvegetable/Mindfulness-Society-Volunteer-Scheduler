import { describe, expect, it } from 'vitest';
import { normalizeIntervals, normalizeWeeklyIntervals, subtractIntervals, timeMinutes, coversInterval } from '../../src/shared/domain/intervals';
import { availableForSession, eligibleVolunteer, overlayExceptions, sessionsOverlap } from '../../src/shared/domain/availability';
import { currentAssignments, currentRun, generateSchedule, selectBackup } from '../../src/shared/domain/scheduler';
import { candidateCoverage, candidateSession, confirmedDateCoverage, nextOccurrence } from '../../src/shared/domain/candidates';
import { computeInsights } from '../../src/shared/domain/insights';
import { emptySnapshot, type Candidate, type Session, type Snapshot, type Volunteer } from '../../src/shared/domain/models';

const zone = 'America/New_York';
const now = '2026-10-04T12:00:00Z';
const interval = (start: string, end: string) => ({ start, end });
const volunteer = (id: string, readinessRank = 1): Volunteer => ({ id, name: id, email: `${id}@example.test`, lifecycleStatus: 'active', interviewStatus: 'complete', readinessRank });
const session = (id = 's1', requiredStaffCount = 1, start = '10:00', end = '11:00'): Session => ({ id, kind: 'center', centerId: 'c1', title: 'Center', date: '2026-10-05', start, end, timeZone: zone, requiredStaffCount, status: 'locked' });
const candidate = (requestedStaffCount = 1): Candidate => ({ id: 'candidate1', centerId: 'c1', weekday: 1, start: '10:00', end: '11:00', timeZone: zone, requestedStaffCount, status: 'candidate' });
function snapshot(volunteers = [volunteer('a'), volunteer('b'), volunteer('c')], sessions = [session()]): Snapshot {
  return { ...emptySnapshot(), volunteers, sessions, recurringAvailability: volunteers.map((v) => ({ id: `availability-${v.id}`, volunteerId: v.id, weekday: 1, start: '09:00', end: '13:00', timeZone: zone })) };
}
function publish(input: Snapshot): Snapshot {
  return { ...input, schedulingRuns: [{ id: 'run', inputRevision: 0, outputRevision: 1, status: 'completed', assignmentIds: ['assignment-a'], backupIds: [], shortfalls: [] }], assignments: [{ id: 'assignment-a', sessionId: 's1', volunteerId: 'a', scheduleRevision: 1, status: 'assigned' }] };
}

describe('interval normalization', () => {
  it('sorts and merges overlapping and adjacent intervals but preserves gaps', () => {
    expect(normalizeIntervals([interval('14:00', '15:00'), interval('11:00', '12:00'), interval('09:00', '10:30'), interval('10:00', '11:00')])).toEqual([interval('09:00', '12:00'), interval('14:00', '15:00')]);
  });
  it('rejects malformed, overnight, and zero-length intervals', () => {
    for (const value of [interval('25:00', '26:00'), interval('10:00', '10:00'), interval('22:00', '01:00'), interval('9:00', '10:00')]) expect(() => normalizeIntervals([value])).toThrow(RangeError);
    expect(() => timeMinutes('09:60')).toThrow(RangeError);
  });
  it('groups weekly intervals by weekday and timezone without mutating input', () => {
    const input = [{ weekday: 2 as const, timeZone: zone, ...interval('11:00', '12:00') }, { weekday: 1 as const, timeZone: zone, ...interval('09:00', '10:00') }, { weekday: 1 as const, timeZone: zone, ...interval('10:00', '11:00') }];
    const original = structuredClone(input);
    expect(normalizeWeeklyIntervals(input)).toEqual([{ weekday: 1, timeZone: zone, ...interval('09:00', '11:00') }, { weekday: 2, timeZone: zone, ...interval('11:00', '12:00') }]);
    expect(input).toEqual(original);
  });
  it('uses complete coverage after merging adjacent intervals', () => {
    expect(coversInterval([interval('09:00', '10:00'), interval('10:00', '11:00')], interval('09:30', '10:30'))).toBe(true);
    expect(coversInterval([interval('09:00', '10:00'), interval('10:30', '11:00')], interval('09:30', '10:45'))).toBe(false);
  });
  it('subtracts exclusions spanning multiple base intervals', () => expect(subtractIntervals([interval('09:00', '11:00'), interval('12:00', '14:00')], [interval('10:00', '13:00')])).toEqual([interval('09:00', '10:00'), interval('13:00', '14:00')]));
});

describe('availability and dated exceptions', () => {
  it('unavailability removes part of recurring availability', () => expect(overlayExceptions([interval('09:00', '12:00')], [{ kind: 'unavailable', ...interval('10:00', '11:00') }])).toEqual([interval('09:00', '10:00'), interval('11:00', '12:00')]));
  it('available exceptions add and merge time', () => expect(overlayExceptions([interval('10:00', '11:00')], [{ kind: 'available', ...interval('09:00', '10:00') }, { kind: 'available', ...interval('10:30', '12:00') }])).toEqual([interval('09:00', '12:00')]));
  it('normalizes overlapping exceptions independently of order', () => {
    const exceptions = [{ kind: 'available' as const, ...interval('08:00', '11:00') }, { kind: 'unavailable' as const, ...interval('09:00', '10:00') }, { kind: 'unavailable' as const, ...interval('09:30', '10:30') }];
    expect(overlayExceptions([], exceptions)).toEqual([interval('08:00', '09:00'), interval('10:30', '11:00')]);
    expect(overlayExceptions([], [...exceptions].reverse())).toEqual(overlayExceptions([], exceptions));
  });
  it('applies exceptions only to their volunteer/date/timezone', () => {
    const input = snapshot();
    input.availabilityExceptions = [{ id: 'e1', volunteerId: 'a', date: '2026-10-05', kind: 'unavailable', ...interval('10:30', '11:00'), timeZone: zone }];
    expect(availableForSession(input, 'a', session())).toBe(false);
    expect(availableForSession(input, 'b', session())).toBe(true);
  });
  it('requires active, interviewed volunteers with a supported readiness rank', () => {
    expect([1, 2, 3].every((rank) => eligibleVolunteer(volunteer('a', rank)))).toBe(true);
    expect(eligibleVolunteer(volunteer('a', 4))).toBe(false);
    expect(eligibleVolunteer({ ...volunteer('a'), readinessRank: null })).toBe(false);
    expect(eligibleVolunteer({ ...volunteer('a'), lifecycleStatus: 'newly-joined' })).toBe(false);
    expect(eligibleVolunteer({ ...volunteer('a'), interviewStatus: 'incomplete' })).toBe(false);
  });
  it('compares dated instants and treats adjacent sessions as non-overlapping', () => {
    expect(sessionsOverlap(session(), session('s2', 1, '10:30', '11:30'))).toBe(true);
    expect(sessionsOverlap(session(), session('s2', 1, '11:00', '12:00'))).toBe(false);
    expect(sessionsOverlap(session(), { ...session('s2'), date: '2026-10-06' })).toBe(false);
    expect(sessionsOverlap(session(), { ...session('s2', 1, '14:30', '15:00'), timeZone: 'UTC' })).toBe(true);
  });
});

describe('deterministic scheduler', () => {
  it('produces identical logical output twice and leaves the snapshot untouched', () => {
    const input = snapshot(); const before = structuredClone(input);
    expect(generateSchedule(input, now)).toEqual(generateSchedule(structuredClone(input), now));
    expect(input).toEqual(before);
  });
  it('prioritizes lower readiness rank and sorts ties by volunteer ID', () => {
    const output = generateSchedule(snapshot([volunteer('z', 1), volunteer('a', 2), volunteer('b', 1)]), now);
    expect(output.assignments).toEqual([{ sessionId: 's1', volunteerId: 'b' }]);
    expect(output.backups).toEqual([{ sessionId: 's1', volunteerId: 'z', position: 1 }, { sessionId: 's1', volunteerId: 'a', position: 2 }]);
  });
  it('preserves continuity within the same rank, but rank has priority', () => {
    const input = publish(snapshot([volunteer('a'), volunteer('b')]));
    input.assignments[0]!.volunteerId = 'b';
    expect(generateSchedule(input, now).assignments[0]!.volunteerId).toBe('b');
    input.volunteers[1]!.readinessRank = 2;
    expect(generateSchedule(input, now).assignments[0]!.volunteerId).toBe('a');
  });
  it.each([0, 1, 2])('fills requested staff count %i', (count) => expect(generateSchedule(snapshot(undefined, [session('s1', count)]), now).assignments).toHaveLength(count));
  it('never double-books overlapping sessions and orders sessions deterministically', () => {
    const input = snapshot([volunteer('a')], [session('s2', 1, '10:30', '11:30'), session()]);
    expect(generateSchedule(input, now)).toEqual({ assignments: [{ sessionId: 's1', volunteerId: 'a' }], backups: [], shortfalls: [{ sessionId: 's2', required: 1, assigned: 0, missing: 1 }] });
  });
  it('allows adjacent sessions and emits explicit shortfalls', () => {
    const output = generateSchedule(snapshot([volunteer('a')], [session('s1', 2), session('s2', 1, '11:00', '12:00')]), now);
    expect(output.assignments).toHaveLength(2);
    expect(output.shortfalls).toEqual([{ sessionId: 's1', required: 2, assigned: 1, missing: 1 }]);
  });
  it('only schedules future locked center and confirmed class sessions', () => {
    const input = snapshot(undefined, [{ ...session('cancelled'), status: 'cancelled' }, { ...session('proposed'), status: 'proposed' }, { ...session('past'), date: '2026-10-03' }, { ...session('class'), kind: 'univ100', status: 'confirmed' }]);
    expect(generateSchedule(input, now).assignments.map((a) => a.sessionId)).toEqual(['class']);
    expect(generateSchedule(snapshot(), '2026-10-05T14:00:00Z').assignments).toEqual([]);
  });
  it('chooses only the greatest completed run and its assignment revision', () => {
    const input = publish(snapshot());
    input.schedulingRuns.push({ ...input.schedulingRuns[0]!, id: 'new', outputRevision: 3, status: 'staged' }, { ...input.schedulingRuns[0]!, id: 'completed', outputRevision: 2 });
    input.assignments.push({ ...input.assignments[0]!, id: 'new-assignment', scheduleRevision: 2, volunteerId: 'b' });
    expect(currentRun(input)?.id).toBe('completed');
    expect(currentAssignments(input).map((a) => a.id)).toEqual(['new-assignment']);
  });
});

describe('backup re-evaluation', () => {
  it('skips now-ineligible backups, promotes the first eligible, and reorders remaining', () => {
    const input = publish(snapshot([volunteer('a'), volunteer('b'), volunteer('c'), volunteer('d')]));
    input.volunteers[1]!.lifecycleStatus = 'inactive';
    input.assignments[0]!.status = 'cancelled';
    input.backups = ['b', 'c', 'd'].map((id, index) => ({ id: `backup-${id}`, sessionId: 's1', volunteerId: id, scheduleRevision: 1, position: index + 1, status: 'available' }));
    const result = selectBackup(input, session());
    expect(result.selected?.volunteerId).toBe('c');
    expect(result.skipped.map((b) => b.volunteerId)).toEqual(['b']);
    expect(result.remaining.map((b) => [b.volunteerId, b.position])).toEqual([['d', 1]]);
  });
  it('returns no backup when current exceptions or assignments remove eligibility', () => {
    const input = publish(snapshot());
    input.sessions.push(session('s2', 1, '10:30', '11:30'));
    input.assignments.push({ id: 'assignment-c', sessionId: 's2', volunteerId: 'c', scheduleRevision: 1, status: 'assigned' });
    input.availabilityExceptions.push({ id: 'exception-b', volunteerId: 'b', date: '2026-10-05', kind: 'unavailable', ...interval('10:00', '11:00'), timeZone: zone });
    input.backups = ['b', 'c'].map((id, index) => ({ id: `backup-${id}`, sessionId: 's1', volunteerId: id, scheduleRevision: 1, position: index + 1, status: 'available' }));
    expect(selectBackup(input, session()).selected).toBeNull();
    expect(selectBackup(input, session()).skipped).toHaveLength(2);
  });
});

describe('candidate coverage and confirmation date', () => {
  it('returns adequate advisory coverage ordered by rank then ID', () => {
    const coverage = candidateCoverage(snapshot([volunteer('z', 2), volunteer('b', 1), volunteer('a', 1)]), candidate(2));
    expect(coverage.volunteers.map((v) => v.id)).toEqual(['a', 'b', 'z']);
    expect(coverage.shortfall).toBe(0); expect(coverage.requestedCount).toBe(2);
  });
  it('reports advisory shortfall and rejects partial interval coverage', () => {
    const input = snapshot([volunteer('a')]); input.recurringAvailability[0]!.end = '10:30';
    expect(candidateCoverage(input, candidate(2))).toEqual({ volunteers: [], requestedCount: 2, shortfall: 2 });
  });
  it('uses the same weekday before or at start, then the following week after start', () => {
    expect(nextOccurrence(candidate(), '2026-10-05T13:59:00Z')).toBe('2026-10-05');
    expect(nextOccurrence(candidate(), '2026-10-05T14:00:00Z')).toBe('2026-10-05');
    expect(nextOccurrence(candidate(), '2026-10-05T14:00:01Z')).toBe('2026-10-12');
    expect(nextOccurrence(candidate(), '2026-10-06T12:00:00Z')).toBe('2026-10-12');
  });
  it('handles timezone offsets through daylight-saving changes', () => {
    expect(nextOccurrence(candidate(), '2026-11-02T14:30:00Z')).toBe('2026-11-02');
    expect(nextOccurrence(candidate(), '2026-11-02T15:30:00Z')).toBe('2026-11-09');
  });
  it('creates exactly one dated locked session with deterministic ID', () => {
    expect(candidateSession(candidate(), 'Center One', now)).toMatchObject({ id: 'session-candidate1-2026-10-05', date: '2026-10-05', sourceCandidateId: 'candidate1', title: 'Center One', status: 'locked' });
  });
  it('confirmed-date coverage accounts for exceptions and existing assignments', () => {
    const input = publish(snapshot());
    input.availabilityExceptions.push({ id: 'e1', volunteerId: 'b', date: '2026-10-05', kind: 'unavailable', ...interval('10:00', '11:00'), timeZone: zone });
    expect(candidateCoverage(input, candidate(2)).volunteers).toHaveLength(3);
    expect(confirmedDateCoverage(input, candidateSession(candidate(2), 'Center', now)).volunteers.map((v) => v.id)).toEqual(['c']);
    expect(confirmedDateCoverage(input, candidateSession(candidate(2), 'Center', now)).shortfall).toBe(1);
  });
});

describe('current insights', () => {
  it('merges adjacent increments with identical volunteer sets and retains empty cells', () => {
    const input = snapshot([volunteer('a')]); input.recurringAvailability[0]!.end = '10:00';
    const insights = computeInsights(input, { timeZone: zone, displayIncrementMinutes: 30, operatingHoursStart: '09:00', operatingHoursEnd: '11:00' });
    expect(insights.grid.filter((g) => g.weekday === 1).map((g) => [g.start, g.end, g.count])).toEqual([['09:00', '10:00', 1], ['10:00', '11:00', 0]]);
    expect(insights.grid).toHaveLength(6);
  });
  it('leftovers include cancelled assignments but exclude active current assignments', () => {
    const input = publish(snapshot());
    expect(computeInsights(input, { timeZone: zone, displayIncrementMinutes: 30, operatingHoursStart: '09:00', operatingHoursEnd: '10:00' }).leftoverVolunteers.map((v) => v.id)).toEqual(['b', 'c']);
    input.assignments[0]!.status = 'cancelled';
    expect(computeInsights(input, { timeZone: zone, displayIncrementMinutes: 30, operatingHoursStart: '09:00', operatingHoursEnd: '10:00' }).leftoverVolunteers).toHaveLength(3);
  });
});
