import { describe, expect, it } from 'vitest';
import type { Session, Volunteer } from '../../shared/domain.js';
import type { CenterCaller, CandidateSchedule } from './models.js';
import { CandidateCoverageService, CenterConfirmationService, CenterScheduleService, CenterWorkflowError } from './service.js';
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

function lockedSession(id: string, date: string, centerId = 'center-1'): Session {
  return {
    id,
    kind: 'center',
    centerId,
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

describe('center candidate entry against locked occurrences', () => {
  const contact: CenterCaller = { id: 'contact@example.test', active: true, roles: ['center-contact'], centerIds: ['center-1'] };

  it('refuses to create an interval that overlaps a locked occurrence', () => {
    const existing = lockedSession('session-existing-2026-09-07', occurrenceDate);
    const candidates = new MemoryCandidateScheduleStore([]);
    const sessions = new MemorySessionStore<Session>([existing]);

    let caught: unknown;
    try {
      new CenterScheduleService({ candidates, sessions }).create(contact, { centerId: 'center-1', weekday: 1, start: '09:00', end: '10:00', timeZone, requestedStaffCount: 1 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CenterWorkflowError);
    expect((caught as CenterWorkflowError).code).toBe('CONFLICT');
    expect((caught as CenterWorkflowError).message).toContain('an administrator must manage the existing session');
    expect((caught as CenterWorkflowError).details?.lockedSessionId).toBe(existing.id);
    // Nothing is stored and the locked occurrence is untouched.
    expect(candidates.list()).toEqual([]);
    expect(sessions.list().map((session) => [session.id, session.status, session.start, session.end])).toEqual([['session-existing-2026-09-07', 'locked', '09:00', '10:00']]);
  });

  it('still creates the same time slot for a different center', () => {
    const candidates = new MemoryCandidateScheduleStore([]);
    const sessions = new MemorySessionStore<Session>([lockedSession('session-existing-2026-09-07', occurrenceDate)]);
    const other: CenterCaller = { id: 'other@example.test', active: true, roles: ['center-contact'], centerIds: ['center-2'] };

    const created = new CenterScheduleService({ candidates, sessions }).create(other, { centerId: 'center-2', weekday: 1, start: '09:00', end: '10:00', timeZone, requestedStaffCount: 1 });

    expect(created.centerId).toBe('center-2');
    expect(candidates.list().map((row) => row.centerId)).toEqual(['center-2']);
  });
});

describe('centre tenant isolation', () => {
  const opalContact: CenterCaller = { id: 'opal@example.test', active: true, roles: ['center-contact'], centerIds: ['center-1'] };
  const otherContact: CenterCaller = { id: 'other@example.test', active: true, roles: ['center-contact'], centerIds: ['center-2'] };

  function scheduleService(): CenterScheduleService {
    // candidate() and the seeded candidate belong to center-1.
    return new CenterScheduleService({ candidates: new MemoryCandidateScheduleStore([candidate()]), sessions: new MemorySessionStore<Session>([]) });
  }

  it('hides another centre s candidate from a centre contact list', () => {
    const service = scheduleService();

    expect(service.list(opalContact).map((row) => row.id)).toEqual(['candidate-1']);
    expect(service.list(otherContact)).toEqual([]);
    expect(service.list(admin).map((row) => row.id)).toEqual(['candidate-1']);
  });

  it('refuses a centre contact reading another centre s candidate', () => {
    let caught: unknown;
    try {
      scheduleService().get(otherContact, 'candidate-1');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CenterWorkflowError);
    expect((caught as CenterWorkflowError).code).toBe('FORBIDDEN');
    expect((caught as CenterWorkflowError).message).toContain('not authorized for this center');
  });

  it('refuses a centre contact editing another centre s candidate', () => {
    let caught: unknown;
    try {
      scheduleService().update(otherContact, 'candidate-1', { start: '10:00', end: '11:00' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CenterWorkflowError);
    expect((caught as CenterWorkflowError).message).toContain('not authorized for this center');
  });
});
