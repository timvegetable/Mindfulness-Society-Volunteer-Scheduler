import type { Interval, WeeklyInterval } from './models';

export function timeMinutes(value: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new RangeError(`Invalid local time: ${value}`);
  const [hours, minutes] = value.split(':').map(Number);
  return hours! * 60 + minutes!;
}
export function minuteTime(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value >= 1440) throw new RangeError('Minutes must be within a local day');
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
}
export function validateInterval<T extends Interval>(interval: T): T {
  if (timeMinutes(interval.start) >= timeMinutes(interval.end)) throw new RangeError('Interval start must precede end on the same day');
  return interval;
}
export function normalizeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.map((interval) => ({ ...validateInterval(interval) })).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = previous.end > interval.end ? previous.end : interval.end;
    else merged.push({ start: interval.start, end: interval.end });
  }
  return merged;
}
export function normalizeWeeklyIntervals(intervals: readonly WeeklyInterval[]): WeeklyInterval[] {
  const groups = new Map<string, WeeklyInterval[]>();
  for (const interval of intervals) {
    validateInterval(interval);
    if (!Number.isInteger(interval.weekday) || interval.weekday < 1 || interval.weekday > 7 || !interval.timeZone) throw new RangeError('Invalid recurring interval');
    const key = `${interval.weekday}:${interval.timeZone}`;
    groups.set(key, [...(groups.get(key) ?? []), interval]);
  }
  return [...groups.values()].flatMap((group) => normalizeIntervals(group).map((interval) => ({ ...interval, weekday: group[0]!.weekday, timeZone: group[0]!.timeZone })))
    .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start) || a.timeZone.localeCompare(b.timeZone));
}
export function coversInterval(intervals: readonly Interval[], target: Interval): boolean {
  validateInterval(target);
  return normalizeIntervals(intervals).some((interval) => interval.start <= target.start && interval.end >= target.end);
}
export function intervalsOverlap(a: Interval, b: Interval): boolean { return a.start < b.end && b.start < a.end; }
export function subtractIntervals(base: readonly Interval[], exclusions: readonly Interval[]): Interval[] {
  let remaining = normalizeIntervals(base);
  for (const exclusion of normalizeIntervals(exclusions)) {
    remaining = remaining.flatMap((interval) => {
      if (!intervalsOverlap(interval, exclusion)) return [interval];
      const parts: Interval[] = [];
      if (interval.start < exclusion.start) parts.push({ start: interval.start, end: exclusion.start });
      if (interval.end > exclusion.end) parts.push({ start: exclusion.end, end: interval.end });
      return parts;
    });
  }
  return normalizeIntervals(remaining);
}
