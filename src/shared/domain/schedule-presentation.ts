import { Temporal } from '@js-temporal/polyfill';
import { isISODate } from './dates';
import type { Session, Weekday } from './models';

export interface ScheduleOccurrence {
  session: Session;
  assignedVolunteerIds: readonly string[];
  orderedBackupVolunteerIds: readonly string[];
  unfilledCount: number;
}

export type GroupedScheduleRow =
  | { occurrences: ScheduleOccurrence[]; weekly: true; weekday: Weekday }
  | { occurrences: ScheduleOccurrence[]; weekly: false };

interface IndexedOccurrence {
  index: number;
  occurrence: ScheduleOccurrence;
}

interface IndexedGroup {
  index: number;
  row: GroupedScheduleRow;
}

function oneWeekAfter(previous: string, next: string): boolean {
  try { return Temporal.PlainDate.from(previous).add({ days: 7 }).equals(Temporal.PlainDate.from(next)); }
  catch { return false; }
}

function signature(row: ScheduleOccurrence): string {
  const { session } = row;
  return JSON.stringify([
    session.centerId,
    session.start,
    session.end,
    session.timeZone,
    session.status,
    session.requiredStaffCount,
    [...row.assignedVolunteerIds].sort(),
    row.orderedBackupVolunteerIds,
    row.unfilledCount,
  ]);
}

function single(row: IndexedOccurrence): IndexedGroup {
  return { index: row.index, row: { occurrences: [row.occurrence], weekly: false } };
}

/** Collapses only three or more actual, uninterrupted weekly center occurrences with identical visible staffing. */
export function groupWeeklyScheduleRows(rows: readonly ScheduleOccurrence[]): GroupedScheduleRow[] {
  const buckets = new Map<string, IndexedOccurrence[]>();
  const result: IndexedGroup[] = [];

  rows.forEach((occurrence, index) => {
    const { session } = occurrence;
    if (session.kind !== 'center' || !session.centerId || !isISODate(session.date)) {
      result.push(single({ index, occurrence }));
      return;
    }
    const key = signature(occurrence);
    const bucket = buckets.get(key) ?? [];
    bucket.push({ index, occurrence });
    buckets.set(key, bucket);
  });

  for (const bucket of buckets.values()) {
    const dateCounts = new Map<string, number>();
    for (const item of bucket) dateCounts.set(item.occurrence.session.date, (dateCounts.get(item.occurrence.session.date) ?? 0) + 1);
    const ordered = [...bucket].sort((left, right) => left.occurrence.session.date.localeCompare(right.occurrence.session.date) || left.index - right.index);
    let run: IndexedOccurrence[] = [];
    const flush = () => {
      if (run.length >= 3) {
        const first = run[0]!.occurrence.session.date;
        const weekday = Temporal.PlainDate.from(first).dayOfWeek as Weekday;
        result.push({ index: run[0]!.index, row: { occurrences: run.map(item => item.occurrence), weekly: true, weekday } });
      } else run.forEach(item => result.push(single(item)));
      run = [];
    };
    for (const item of ordered) {
      const { date } = item.occurrence.session;
      if (dateCounts.get(date) !== 1) {
        flush();
        result.push(single(item));
      } else if (!run.length || oneWeekAfter(run[run.length - 1]!.occurrence.session.date, date)) run.push(item);
      else { flush(); run.push(item); }
    }
    flush();
  }

  return result.sort((left, right) => left.index - right.index).map(({ row }) => row);
}
