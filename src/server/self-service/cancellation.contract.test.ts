import { describe, expect, it } from 'vitest';
import { intervalsOverlap } from '../../shared/time.js';
import type { Assignment, AvailabilityException, Backup, RecurringAvailability, Session, Volunteer } from '../../shared/domain.js';
import { MemoryRepository } from '../workbook/repository.js';
import { AssignedOccurrenceCancellationService } from './cancellation.js';
import type { RecurringAvailabilityRecord } from './types.js';

const timestamp = '2026-09-01T00:00:00.000Z';
const timeZone = 'America/New_York';

function volunteer(id: string, rank: 1 | 2 | 3, name: string): Volunteer {
  return {
    id,
    name,
    email: `${id}@example.test`,
    lifecycleStatus: 'active',
    interviewStatus: 'complete',
    readinessRank: rank,
    // The roster row carries no intervals: recurring availability lives in its own tab.
    recurringAvailability: [],
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function session(): Session {
  return {
    id: 'session-1',
    kind: 'center',
    centerId: 'center-1',
    title: 'Center session',
    date: '2026-09-07',
    start: '09:00',
    end: '11:00',
    timeZone,
    requiredStaffCount: 1,
    status: 'locked',
    revision: 0
  };
}

function availability(id: string, volunteerId: string, weekday: 1, start: string, end: string): RecurringAvailabilityRecord {
  return { id, volunteerId, weekday, start, end, timeZone, revision: 0, source: 'whenisgood', updatedAt: timestamp };
}

function assignment(id: string, volunteerId: string): Assignment {
  return { id, sessionId: 'session-1', volunteerId, scheduleRevision: 1, status: 'assigned', createdAt: timestamp };
}

function secondSession(): Session {
  return { ...session(), id: 'session-2', title: 'Other center session', start: '13:00', end: '15:00' };
}

function backup(volunteerId: string, position: number, sessionId = 'session-1'): Backup {
  return { id: `backup-${sessionId}-${volunteerId}`, sessionId, volunteerId, scheduleRevision: 1, position, status: 'available' };
}

function serviceFor(options: {
  assignments: readonly Assignment[];
  backups: readonly Backup[];
  exceptions?: readonly AvailabilityException[];
  recurringAvailability: readonly RecurringAvailabilityRecord[];
  sessions?: readonly Session[];
}) {
  const assignments = new MemoryRepository<Assignment>();
  for (const row of options.assignments) assignments.upsert(row, assignments.revision().number, 'seed', 'seed');
  const backups = new MemoryRepository<Backup>();
  for (const row of options.backups) backups.upsert(row, backups.revision().number, 'seed', 'seed');
  const exceptions = new MemoryRepository<AvailabilityException>();
  for (const row of options.exceptions ?? []) exceptions.upsert(row, exceptions.revision().number, 'seed', 'seed');
  const sessions = new MemoryRepository<Session>();
  for (const row of options.sessions ?? [session()]) sessions.upsert(row, sessions.revision().number, 'seed', 'seed');
  const volunteers = new MemoryRepository<Volunteer>();
  for (const row of [volunteer('vol-1', 1, 'First Volunteer'), volunteer('vol-2', 2, 'Second Volunteer')]) volunteers.upsert(row, volunteers.revision().number, 'seed', 'seed');
  const recurring = new MemoryRepository<RecurringAvailabilityRecord>();
  for (const row of options.recurringAvailability) recurring.upsert(row, recurring.revision().number, 'seed', 'seed');

  const service = new AssignedOccurrenceCancellationService({
    assignments,
    backups,
    sessions,
    volunteers,
    recurringAvailability: recurring,
    exceptions,
    clock: { now: () => timestamp }
  });
  return { service, assignments, backups, exceptions };
}

const caller = { id: 'vol-1', volunteerId: 'vol-1', roles: ['volunteer'] as const, active: true };

describe('cancellation backup promotion', () => {
  it('promotes an available backup whose recurring availability covers the session', () => {
    const interval: RecurringAvailability = { weekday: 1, start: '08:00', end: '12:00', timeZone };
    expect(intervalsOverlap(interval, { start: '09:00', end: '11:00', timeZone })).toBe(true);
    const { service, assignments, backups, exceptions } = serviceFor({
      assignments: [assignment('assignment-1', 'vol-1')],
      backups: [backup('vol-2', 1)],
      recurringAvailability: [availability('availability-2', 'vol-2', 1, '08:00', '12:00')]
    });

    const result = service.cancel(caller, { assignmentId: 'assignment-1', expectedRevision: assignments.revision().number, expectedExceptionRevision: exceptions.revision().number });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.promotion.promotedVolunteerId).toBe('vol-2');
    expect(result.data.promotion.understaffed).toBe(false);
    expect(assignments.list().map((row) => [row.volunteerId, row.status])).toEqual([['vol-1', 'cancelled'], ['vol-2', 'assigned']]);
    expect(backups.list().map((row) => [row.volunteerId, row.status])).toEqual([['vol-2', 'promoted']]);
  });

  it('skips a backup whose recurring availability does not cover the session', () => {
    const { service, assignments, backups, exceptions } = serviceFor({
      assignments: [assignment('assignment-1', 'vol-1')],
      backups: [backup('vol-2', 1)],
      recurringAvailability: [availability('availability-2', 'vol-2', 1, '12:00', '15:00')]
    });

    const result = service.cancel(caller, { assignmentId: 'assignment-1', expectedRevision: assignments.revision().number, expectedExceptionRevision: exceptions.revision().number });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.promotion.promotedVolunteerId).toBeUndefined();
    expect(result.data.promotion.understaffed).toBe(true);
    expect(assignments.list().map((row) => [row.volunteerId, row.status])).toEqual([['vol-1', 'cancelled']]);
    expect(backups.list().map((row) => [row.volunteerId, row.status])).toEqual([['vol-2', 'skipped']]);
  });

  it('promotes a backup whose dated availability exception overrides the recurring row', () => {
    const { service, assignments, exceptions } = serviceFor({
      assignments: [assignment('assignment-1', 'vol-1')],
      backups: [backup('vol-2', 1)],
      recurringAvailability: [availability('availability-2', 'vol-2', 1, '12:00', '15:00')],
      exceptions: [{ id: 'exception-1', volunteerId: 'vol-2', date: '2026-09-07', kind: 'available', interval: { start: '09:00', end: '11:00', timeZone }, revision: 0 }]
    });

    const result = service.cancel(caller, { assignmentId: 'assignment-1', expectedRevision: assignments.revision().number, expectedExceptionRevision: exceptions.revision().number });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.promotion.promotedVolunteerId).toBe('vol-2');
  });

  it('leaves another session\u2019s backups intact when rebuilding one session', () => {
    const { service, assignments, backups, exceptions } = serviceFor({
      assignments: [assignment('assignment-1', 'vol-1')],
      backups: [backup('vol-2', 1), backup('vol-3', 1, 'session-2'), backup('vol-4', 2, 'session-2')],
      sessions: [session(), secondSession()],
      recurringAvailability: [availability('availability-2', 'vol-2', 1, '08:00', '12:00')]
    });

    const result = service.cancel(caller, { assignmentId: 'assignment-1', expectedRevision: assignments.revision().number, expectedExceptionRevision: exceptions.revision().number });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.promotion.promotedVolunteerId).toBe('vol-2');
    // The cancelled session's backup is promoted...
    expect(backups.list().filter((row) => row.sessionId === 'session-1').map((row) => [row.volunteerId, row.status])).toEqual([['vol-2', 'promoted']]);
    // ...while the untouched session keeps every backup it had, in order.
    expect(backups.list().filter((row) => row.sessionId === 'session-2').map((row) => [row.volunteerId, row.status, row.position])).toEqual([['vol-3', 'available', 1], ['vol-4', 'available', 2]]);
    expect(backups.list()).toHaveLength(3);
  });
});
