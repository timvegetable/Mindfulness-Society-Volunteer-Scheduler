import { describe, expect, it } from 'vitest';
import type { Assignment, AvailabilityException, Session, Volunteer } from '../../shared/domain.js';
import { effectiveAvailabilityForDate } from './availability.js';
import { confirmUniv100Session, evaluateSessionCoverage } from './coverage.js';
import { SchedulingInputError } from './inputs.js';
import { runScheduling, SchedulingStore } from './publication.js';
import { scheduleSessions } from './scheduler.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function volunteer(id: string, rank: 1 | 2 | 3, availability = [{ weekday: 1 as const, start: '09:00', end: '12:00', timeZone: 'UTC' }]): Volunteer {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    lifecycleStatus: 'active',
    interviewStatus: 'complete',
    readinessRank: rank,
    recurringAvailability: availability,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function session(id: string, status: 'locked' | 'confirmed' | 'proposed' = 'locked'): Session {
  return {
    id,
    kind: status === 'locked' ? 'center' : 'univ100',
    centerId: status === 'locked' ? 'center-a' : undefined,
    date: '2026-01-05',
    start: '10:00',
    end: '11:00',
    timeZone: 'UTC',
    requiredStaffCount: 2,
    status,
    revision: 1
  } as Session;
}

describe('ranked scheduler contract', () => {
  it('uses rank, continuity, then stable ID and produces unique backups', () => {
    const first = volunteer('vol-b', 1);
    const second = volunteer('vol-a', 1);
    const lower = volunteer('vol-c', 2);
    const current: Assignment[] = [{
      id: 'old-assignment', sessionId: 'fixed', volunteerId: 'vol-b', scheduleRevision: 4,
      status: 'assigned', createdAt: timestamp
    }];
    const result = scheduleSessions({ volunteers: [first, second, lower], sessions: [session('fixed')], assignments: current, scheduleRevision: 5, createdAt: timestamp });
    expect(result.assignments.map((row) => row.volunteerId)).toEqual(['vol-b', 'vol-a']);
    expect(result.backups.map((row) => row.volunteerId)).toEqual(['vol-c']);
    expect(new Set(result.backups.map((row) => row.volunteerId)).size).toBe(result.backups.length);
  });

  it('prevents overlap and reports a shortfall without scheduling proposals', () => {
    const only = volunteer('only', 1);
    const overlapping: Session[] = [session('a'), { ...session('b'), start: '10:30', end: '11:30' }];
    const result = scheduleSessions({ volunteers: [only], sessions: [...overlapping, session('proposal', 'proposed')] });
    expect(result.assignments).toHaveLength(1);
    expect(result.shortfalls).toEqual([
      { sessionId: 'a', required: 2, assigned: 1, unfilled: 1 },
      { sessionId: 'b', required: 2, assigned: 0, unfilled: 2 }
    ]);
    expect(result.excludedSessionIds).toContain('proposal');
  });

  it('overlays a dated absence without changing recurring availability', () => {
    const person = volunteer('person', 1);
    const absence: AvailabilityException = {
      id: 'absence', volunteerId: person.id, date: '2026-01-05', kind: 'unavailable',
      interval: { start: '10:00', end: '11:00', timeZone: 'UTC' }, revision: 1
    };
    expect(effectiveAvailabilityForDate(person, '2026-01-05', 'UTC', [absence])).toEqual([
      { start: '09:00', end: '10:00', timeZone: 'UTC' },
      { start: '11:00', end: '12:00', timeZone: 'UTC' }
    ]);
    expect(effectiveAvailabilityForDate(person, '2026-01-12', 'UTC', [absence])).toEqual([
      { start: '09:00', end: '12:00', timeZone: 'UTC' }
    ]);
  });

  it('blocks an under-covered proposed UNIV100 session', () => {
    const proposed = session('class', 'proposed');
    const report = evaluateSessionCoverage(proposed, [volunteer('one', 1)]);
    expect(report.sufficient).toBe(false);
    expect(() => confirmUniv100Session(proposed, { volunteers: [volunteer('one', 1)] })).toThrow(SchedulingInputError);
  });
});

describe('staged publication contract', () => {
  it('leaves the last current revision unchanged when a run fails', () => {
    const store = new SchedulingStore({ inputRevision: 1, clock: { now: () => timestamp } });
    const args = { inputRevision: 1, volunteers: [volunteer('one', 1), volunteer('two', 1)], sessions: [session('fixed')], runId: 'first', startedAt: timestamp };
    const first = runScheduling(store, args);
    expect(store.currentRevision()).toBe(first.schedule.revision);
    expect(() => runScheduling(store, { ...args, runId: 'failed', sessions: [{ ...session('bad'), requiredStaffCount: 3 } as Session] })).toThrow();
    expect(store.current()).toEqual(first.schedule);
    expect(store.run('failed')?.status).toBe('failed');
  });
});
