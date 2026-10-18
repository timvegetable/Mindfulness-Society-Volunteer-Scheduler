import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/shared/domain/models';
import { groupWeeklyScheduleRows, type ScheduleOccurrence } from '../../src/shared/domain/schedule-presentation';

const baseSession: Session = {
  id: 'session-1', kind: 'center', centerId: 'opal', title: 'Opal Senior Center',
  date: '2026-10-02', start: '09:00', end: '10:00', timeZone: 'America/New_York',
  requiredStaffCount: 1, status: 'locked',
};
type OccurrenceChanges = Omit<Partial<ScheduleOccurrence>, 'session'> & { session?: Partial<Session> };
const occurrence = (date: string, id: string, changes: OccurrenceChanges = {}): ScheduleOccurrence => {
  const { session: sessionChanges, ...rowChanges } = changes;
  return {
    session: { ...baseSession, id, date, ...sessionChanges },
    assignedVolunteerIds: ['volunteer-a'], orderedBackupVolunteerIds: ['volunteer-b'], unfilledCount: 0,
    ...rowChanges,
  };
};

describe('weekly schedule presentation', () => {
  it('groups matching consecutive center sessions and leaves two observations dated', () => {
    const three = ['2026-10-02', '2026-10-09', '2026-10-16'].map((date, index) => occurrence(date, `weekly-${index}`));
    const two = ['2026-10-23', '2026-10-30'].map((date, index) => occurrence(date, `two-${index}`));

    expect(groupWeeklyScheduleRows(three)).toEqual([{ occurrences: three, weekly: true, weekday: 5 }]);
    expect(groupWeeklyScheduleRows(two)).toEqual(two.map(row => ({ occurrences: [row], weekly: false })));
  });
  it.each<[string, OccurrenceChanges]>([
    ['center identity', { session: { centerId: 'different-center' } }],
    ['time', { session: { start: '10:00', end: '11:00' } }],
    ['timezone', { session: { timeZone: 'UTC' } }],
    ['status', { session: { status: 'confirmed' } }],
    ['required staffing', { session: { requiredStaffCount: 2 } }],
    ['assigned volunteer identity', { assignedVolunteerIds: ['volunteer-c'] }],
    ['backup order', { orderedBackupVolunteerIds: ['volunteer-c', 'volunteer-b'] }],
    ['unfilled count', { unfilledCount: 1 }],
  ])('keeps a dated exception when %s changes', (_label, change) => {
    const dates = ['2026-10-02', '2026-10-09', '2026-10-16'];
    const rows = dates.map((date, index) => occurrence(date, `exception-${index}`));
    rows[1] = occurrence(dates[1]!, 'changed', change);

    expect(groupWeeklyScheduleRows(rows)).toEqual(rows.map(row => ({ occurrences: [row], weekly: false })));
  });

  it('uses center identity rather than title text and ignores title edits for a known center', () => {
    const dates = ['2026-10-02', '2026-10-09', '2026-10-16'];
    const knownCenter = dates.map((date, index) => occurrence(date, `known-${index}`, { session: { title: `label-${index}` } }));
    const distinctCenter = dates.map((date, index) => occurrence(date, `distinct-${index}`, {
      session: { centerId: index === 1 ? 'another-center' : 'opal', title: 'Same title' },
    }));

    expect(groupWeeklyScheduleRows(knownCenter)).toHaveLength(1);
    expect(groupWeeklyScheduleRows(distinctCenter)).toEqual(distinctCenter.map(row => ({ occurrences: [row], weekly: false })));
  });

  it('breaks a series at a missing week and can group only a later complete run', () => {
    const dates = ['2026-10-02', '2026-10-09', '2026-10-23', '2026-10-30', '2026-11-06'];
    const rows = dates.map((date, index) => occurrence(date, `gap-${index}`));

    expect(groupWeeklyScheduleRows(rows)).toEqual([
      { occurrences: [rows[0]!], weekly: false },
      { occurrences: [rows[1]!], weekly: false },
      { occurrences: rows.slice(2), weekly: true, weekday: 5 },
    ]);
  });

  it('keeps nonweekly, UNIV100, and one candidate-created session dated', () => {
    const nonweekly = ['2026-10-02', '2026-10-10', '2026-10-16'].map((date, index) => occurrence(date, `irregular-${index}`));
    const univ100 = ['2026-10-02', '2026-10-09', '2026-10-16'].map((date, index) => occurrence(date, `class-${index}`, {
      session: { kind: 'univ100', centerId: null, title: 'UNIV100', sourceCandidateId: `candidate-${index}` },
    }));
    const candidateCreated = occurrence('2026-10-02', 'candidate-session', { session: { sourceCandidateId: 'candidate-1' } });

    expect(groupWeeklyScheduleRows(nonweekly)).toEqual(nonweekly.map(row => ({ occurrences: [row], weekly: false })));
    expect(groupWeeklyScheduleRows(univ100)).toEqual(univ100.map(row => ({ occurrences: [row], weekly: false })));
    expect(groupWeeklyScheduleRows([candidateCreated])).toEqual([{ occurrences: [candidateCreated], weekly: false }]);
  });
});
