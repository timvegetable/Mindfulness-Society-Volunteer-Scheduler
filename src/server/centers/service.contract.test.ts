import { describe, expect, it } from 'vitest';
import type { Session, Volunteer } from '../../shared/domain.js';
import type { CenterCaller, CandidateSchedule } from './models.js';
import { CandidateCoverageService, CenterConfirmationService, CenterWorkflowError } from './service.js';
import { MemoryCandidateScheduleStore, MemorySessionStore } from './stores.js';

const timestamp = '2026-09-18T00:00:00.000Z';
const timeZone = 'America/New_York';
/** 2026-09-07 is a Monday, matching the candidate weekday below. */
const occurrenceDate = '2026-09-07';

const admin: CenterCaller = { id: 'admin@example.test', active: true, roles: ['administrator'] };

function volunteer(id: string): Volunteer {
  return {
    id,
    name: `Volunteer ${id}`,
    email: `${id}@example.test`,
    lifecycleStatus: 'active',
    interviewStatus: 'complete',
    readinessRank: 1,
    recurringAvailability: [{ weekday: 1, start: '09:00', end: '10:00', timeZone }],
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function candidate(): CandidateSchedule {
  return {
    id: 'candidate-1',
    centerId: 'center-1',
    weekday: 1,
    start: '09:00',
    end: '10:00',
    timeZone,
    requestedStaffCount: 1,
    status: 'candidate',
    createdBy: 'admin@example.test',
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    occurrenceDates: [occurrenceDate]
  };
}

function lockedSession(id: string, date: string): Session {
  return {
    id,
    kind: 'center',
    centerId: 'center-1',
    title: `Existing occurrence ${date}`,
    date,
    start: '09:00',
    end: '10:00',
    timeZone,
    requiredStaffCount: 1,
    status: 'locked',
    revision: 0,
    sourceCandidateId: 'candidate-existing'
  };
}

function confirmationService(candidates: MemoryCandidateScheduleStore, sessions: MemorySessionStore<Session>): CenterConfirmationService {
  const coverage = new CandidateCoverageService({ volunteers: [volunteer('vol-1'), volunteer('vol-2')] });
  return new CenterConfirmationService({ coverage, candidates, sessions });
}

describe('center confirmation duplicates', () => {
  it('rejects confirmation when the candidate occurrence is already a locked session', () => {
    const existing = lockedSession('session-existing-2026-09-07', occurrenceDate);
    const candidates = new MemoryCandidateScheduleStore([candidate()]);
    const sessions = new MemorySessionStore<Session>([existing]);
    const before = candidates.get('candidate-1');

    let caught: unknown;
    try {
      confirmationService(candidates, sessions).confirm(admin, 'candidate-1');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CenterWorkflowError);
    expect((caught as CenterWorkflowError).code).toBe('CONFLICT');
    expect((caught as CenterWorkflowError).details?.existingSessionId).toBe(existing.id);

    const storedSessions = sessions.list();
    expect(storedSessions.map((session) => session.id)).toEqual([existing.id]);

    const unchanged = candidates.get('candidate-1');
    expect(unchanged).toEqual(before);
    expect(unchanged?.status).toBe('candidate');
    expect(unchanged?.revision).toBe(1);
    expect(candidates.revision().number).toBe(1);
  });

  it('confirms a candidate whose occurrence does not match any locked session', () => {
    const candidates = new MemoryCandidateScheduleStore([candidate()]);
    const sessions = new MemorySessionStore<Session>([lockedSession('session-other-2026-08-31', '2026-08-31')]);

    const result = confirmationService(candidates, sessions).confirm(admin, 'candidate-1');

    expect(result.occurrences.map((session) => session.id)).toEqual(['session-candidate-1-2026-09-07']);
    expect(result.occurrences[0]?.status).toBe('locked');
    expect(result.candidate.status).toBe('confirmed');
    expect(sessions.list().map((session) => session.id)).toEqual([
      'session-other-2026-08-31',
      'session-candidate-1-2026-09-07'
    ]);
    expect(candidates.get('candidate-1')?.status).toBe('confirmed');
  });
});
