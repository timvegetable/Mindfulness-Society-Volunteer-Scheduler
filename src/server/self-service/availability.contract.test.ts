import { describe, expect, it } from 'vitest';
import type { Assignment, AvailabilityException, Session, Volunteer } from '../../shared/domain.js';
import { projectVolunteerDashboard } from '../integration/projections.js';
import { MemoryRepository } from '../workbook/repository.js';
import { MemoryScheduleStalenessStore, VolunteerAvailabilityService } from './availability.js';
import type { NotificationMessage, RecurringAvailabilityRecord } from './types.js';

const timestamp = '2026-09-01T00:00:00.000Z';
const timeZone = 'America/New_York';
const caller = { id: 'user-1', volunteerId: 'vol-1', roles: ['volunteer'] as const, active: true };

function volunteer(id: string): Volunteer {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    lifecycleStatus: 'active',
    interviewStatus: 'complete',
    readinessRank: 1,
    recurringAvailability: [],
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function seed<T extends { id: string }>(repository: MemoryRepository<T>, rows: readonly T[]): void {
  for (const row of rows) repository.upsert(row, repository.revision().number, 'seed', 'seed');
}

describe('volunteer availability acceptance contract', () => {
  it('replaces only the caller recurring availability, marks the schedule stale, and notifies after persistence', () => {
    const volunteers = new MemoryRepository<Volunteer>();
    seed(volunteers, [volunteer('vol-1'), volunteer('vol-2')]);
    const recurring = new MemoryRepository<RecurringAvailabilityRecord>();
    seed(recurring, [
      { id: 'own-old', volunteerId: 'vol-1', weekday: 1, start: '09:00', end: '10:00', timeZone, revision: 0 },
      { id: 'other', volunteerId: 'vol-2', weekday: 2, start: '12:00', end: '13:00', timeZone, revision: 0 }
    ]);
    const staleness = new MemoryScheduleStalenessStore();
    const messages: NotificationMessage[] = [];
    let nextId = 0;
    const service = new VolunteerAvailabilityService({
      volunteers,
      recurringAvailability: recurring,
      staleness,
      configuredTimeZone: timeZone,
      administratorRecipients: ['admin@example.test'],
      mailer: { send: (message) => messages.push({ ...message, to: [...message.to] }) },
      clock: { now: () => timestamp },
      idGenerator: { next: (prefix) => `${prefix}-${++nextId}` }
    });

    const result = service.replaceRecurringAvailability(caller, {
      intervals: [
        { weekday: 4, start: '10:00', end: '11:00', timeZone },
        { weekday: 4, start: '11:00', end: '12:00', timeZone }
      ],
      expectedRevision: recurring.revision().number,
      expectedVolunteerRevision: volunteers.revision().number
    });

    expect(result.ok).toBe(true);
    expect(recurring.list().filter((row) => row.volunteerId === 'vol-1').map((row) => [row.weekday, row.start, row.end])).toEqual([[4, '10:00', '12:00']]);
    expect(recurring.list().filter((row) => row.volunteerId === 'vol-2').map((row) => row.id)).toEqual(['other']);
    expect(staleness.getStatus()).toMatchObject({ stale: true, reason: 'recurring-availability', volunteerId: 'vol-1' });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toBe('Volunteer recurring availability changed');
  });

  it('records a Thursday absence without changing recurring Thursday coverage', () => {
    const volunteers = new MemoryRepository<Volunteer>();
    seed(volunteers, [volunteer('vol-1')]);
    const recurring = new MemoryRepository<RecurringAvailabilityRecord>();
    seed(recurring, [{ id: 'thursday', volunteerId: 'vol-1', weekday: 4, start: '09:00', end: '12:00', timeZone, revision: 0 }]);
    const exceptions = new MemoryRepository<AvailabilityException>();
    let nextId = 0;
    const service = new VolunteerAvailabilityService({
      volunteers,
      recurringAvailability: recurring,
      exceptions,
      configuredTimeZone: timeZone,
      clock: { now: () => timestamp },
      idGenerator: { next: (prefix) => `${prefix}-${++nextId}` }
    });

    const result = service.recordException(caller, {
      date: '2026-09-24',
      kind: 'unavailable',
      interval: { start: '10:00', end: '11:00', timeZone },
      expectedRevision: exceptions.revision().number
    });

    expect(result.ok).toBe(true);
    expect(recurring.list().map((row) => [row.weekday, row.start, row.end])).toEqual([[4, '09:00', '12:00']]);
    expect(service.effectiveAvailability('vol-1', '2026-09-24', timeZone).map((row) => [row.start, row.end])).toEqual([
      ['09:00', '10:00'],
      ['11:00', '12:00']
    ]);
    expect(service.effectiveAvailability('vol-1', '2026-10-01', timeZone).map((row) => [row.start, row.end])).toEqual([['09:00', '12:00']]);
  });

  it('projects only the signed-in volunteer records and assigned sessions', () => {
    const own = volunteer('vol-1');
    const sessions: Session[] = [
      { id: 'own-session', kind: 'center', centerId: 'center-1', date: '2026-09-24', start: '10:00', end: '11:00', timeZone, requiredStaffCount: 1, status: 'locked', revision: 0 },
      { id: 'other-session', kind: 'center', centerId: 'center-2', date: '2026-09-25', start: '10:00', end: '11:00', timeZone, requiredStaffCount: 1, status: 'locked', revision: 0 }
    ];
    const assignments: Assignment[] = [
      { id: 'own-assignment', sessionId: 'own-session', volunteerId: 'vol-1', scheduleRevision: 1, status: 'assigned', createdAt: timestamp },
      { id: 'other-assignment', sessionId: 'other-session', volunteerId: 'vol-2', scheduleRevision: 1, status: 'assigned', createdAt: timestamp }
    ];
    const exceptions: AvailabilityException[] = [
      { id: 'own-exception', volunteerId: 'vol-1', date: '2026-09-24', kind: 'unavailable', interval: { start: '10:00', end: '11:00', timeZone }, revision: 0 },
      { id: 'other-exception', volunteerId: 'vol-2', date: '2026-09-25', kind: 'unavailable', interval: { start: '10:00', end: '11:00', timeZone }, revision: 0 }
    ];

    const projection = projectVolunteerDashboard({ volunteer: own, assignments, exceptions, sessions });

    expect(projection.assignments.map((row) => row.id)).toEqual(['own-assignment']);
    expect(projection.exceptions.map((row) => row.id)).toEqual(['own-exception']);
    expect(projection.sessions.map((row) => row.id)).toEqual(['own-session']);
    expect(JSON.stringify(projection)).not.toContain('vol-2');
  });
});
