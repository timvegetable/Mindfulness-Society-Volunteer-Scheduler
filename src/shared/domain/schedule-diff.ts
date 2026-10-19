import { groupWeeklyScheduleRows, type GroupedScheduleRow, type ScheduleOccurrence } from './schedule-presentation';

export interface ScheduleChange {
  published: ScheduleOccurrence;
  preview: ScheduleOccurrence;
  labels: string[];
}

const same = (left: readonly string[], right: readonly string[]) => JSON.stringify(left) === JSON.stringify(right);

/** Compare dated occurrences before grouping; row boundaries in either schedule are irrelevant. */
export function compareSchedule(published: readonly ScheduleOccurrence[], preview: readonly ScheduleOccurrence[]) {
  const before = new Map(published.map(row => [row.session.id, row]));
  const changes: ScheduleChange[] = [];
  const unchanged: ScheduleOccurrence[] = [];
  for (const row of preview) {
    const previous = before.get(row.session.id);
    if (!previous) continue;
    const labels: string[] = [];
    if (!same([...previous.assignedVolunteerIds].sort(), [...row.assignedVolunteerIds].sort())) {
      labels.push(!row.assignedVolunteerIds.length ? 'Unassigned' : !previous.assignedVolunteerIds.length ? 'Assigned' : 'Assignment changed');
    }
    if (!same(previous.orderedBackupVolunteerIds, row.orderedBackupVolunteerIds)) labels.push('Backups changed');
    if (row.unfilledCount > previous.unfilledCount) labels.push('Newly unfilled');
    if (row.unfilledCount < previous.unfilledCount) labels.push('Newly filled');
    if (labels.length) changes.push({ published: previous, preview: row, labels });
    else unchanged.push(row);
  }
  // A displayed group must have the same staffing on BOTH sides of the comparison.
  const buckets = new Map<string, ScheduleChange[]>();
  for (const change of changes) {
    const key = JSON.stringify([[...change.published.assignedVolunteerIds].sort(), change.published.orderedBackupVolunteerIds, change.published.unfilledCount]);
    const bucket = buckets.get(key) ?? []; bucket.push(change); buckets.set(key, bucket);
  }
  const groups: { group: GroupedScheduleRow; change: ScheduleChange }[] = [];
  const byId = new Map(changes.map(change => [change.preview.session.id, change]));
  for (const bucket of buckets.values()) {
    for (const group of groupWeeklyScheduleRows(bucket.map(change => change.preview))) groups.push({ group, change: byId.get(group.occurrences[0]!.session.id)! });
  }
  const order = new Map(preview.map((row, index) => [row.session.id, index]));
  groups.sort((a, b) => order.get(a.change.preview.session.id)! - order.get(b.change.preview.session.id)!);
  return {
    groups, unchanged, changedDates: changes.length,
    newlyUnfilled: changes.filter(change => change.preview.unfilledCount > change.published.unfilledCount).length,
    newlyFilled: changes.filter(change => change.preview.unfilledCount < change.published.unfilledCount).length,
  };
}
