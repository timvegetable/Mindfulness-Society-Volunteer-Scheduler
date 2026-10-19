import { describe, expect, it } from 'vitest';
import { compareSchedule } from '../../src/shared/domain/schedule-diff';
import type { ScheduleOccurrence } from '../../src/shared/domain/schedule-presentation';

function occurrence(index: number, assigned = ['a'], backups = ['b', 'c']): ScheduleOccurrence {
  return {
    session: { id: `s${index}`, kind: 'center', centerId: 'opal', title: 'Opal', date: `2026-10-${String(2 + index * 7).padStart(2, '0')}`, start: '09:00', end: '10:00', timeZone: 'America/New_York', status: 'locked', requiredStaffCount: 2 },
    assignedVolunteerIds: assigned, orderedBackupVolunteerIds: backups, unfilledCount: Math.max(0, 2 - assigned.length),
  };
}

describe('schedule comparison', () => {
  it('compares individual dates independently of weekly row boundaries and counts affected dates', () => {
    const published = [0, 1, 2, 3].map(i => occurrence(i));
    const preview = published.map((row, i) => i ? occurrence(i, []) : row);
    const diff = compareSchedule(published, preview);
    expect(diff.groups).toHaveLength(1);
    expect(diff.groups[0]?.group.occurrences).toHaveLength(3);
    expect(diff.groups[0]?.change.labels).toEqual(['Unassigned', 'Newly unfilled']);
    expect(diff.changedDates).toBe(3);
    expect(diff.newlyUnfilled).toBe(3);
    expect(diff.newlyFilled).toBe(0);
    expect(diff.unchanged).toEqual([published[0]]);
  });
  it('does not merge different published staffing into an identical preview group', () => {
    const published = [0, 1, 2].map(i => occurrence(i, [i === 1 ? 'b' : 'a']));
    const diff = compareSchedule(published, [0, 1, 2].map(i => occurrence(i, [])));
    expect(diff.groups).toHaveLength(3);
    expect(diff.groups.map(({ change }) => change.published.assignedVolunteerIds)).toEqual([['a'], ['b'], ['a']]);
  });
  it('ignores assignment ordering but detects backup ordering and newly filled places', () => {
    const published = [occurrence(0, ['a', 'b']), occurrence(1, []), occurrence(2)];
    const preview = [occurrence(0, ['b', 'a']), occurrence(1, ['a']), occurrence(2, ['a'], ['c', 'b'])];
    const diff = compareSchedule(published, preview);
    expect(diff.unchanged).toEqual([preview[0]]);
    expect(diff.groups.map(({ change }) => change.labels)).toEqual([['Assigned', 'Newly filled'], ['Backups changed']]);
    expect(diff.newlyFilled).toBe(1);
    expect(diff.newlyUnfilled).toBe(0);
  });
});
