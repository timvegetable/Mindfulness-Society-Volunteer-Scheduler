import { Temporal } from '@js-temporal/polyfill';
import type { AvailabilityException, Interval, RecurringAvailability, Session, Weekday } from './domain.js';

function minutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function clock(value: number): string {
  const hour = Math.floor(value / 60).toString().padStart(2, '0');
  const minute = (value % 60).toString().padStart(2, '0');
  return `${hour}:${minute}`;
}

export function normalizeIntervals<T extends Interval>(intervals: readonly T[]): T[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => minutes(a.start) - minutes(b.start) || minutes(a.end) - minutes(b.end));
  const result: T[] = [];
  for (const interval of sorted) {
    if (interval.start >= interval.end) throw new Error(`Invalid interval ${interval.start}-${interval.end}`);
    const previous = result[result.length - 1];
    if (previous && previous.timeZone !== interval.timeZone) throw new Error('Intervals must use one time zone');
    if (previous && minutes(interval.start) <= minutes(previous.end)) {
      if (minutes(interval.end) > minutes(previous.end)) {
        result[result.length - 1] = { ...previous, end: interval.end };
      }
      continue;
    }
    result.push({ ...interval });
  }
  return result;
}

export function intervalsOverlap(left: Interval, right: Interval, date?: string): boolean {
  if (left.timeZone !== right.timeZone) throw new Error('Intervals must use the same time zone');
  if (!date) return minutes(left.start) < minutes(right.end) && minutes(right.start) < minutes(left.end);
  const leftRange = zonedRange(date, left);
  const rightRange = zonedRange(date, right);
  return Temporal.Instant.compare(leftRange.start, rightRange.end) < 0 && Temporal.Instant.compare(rightRange.start, leftRange.end) < 0;
}

export function intervalContains(container: Interval, candidate: Interval, date?: string): boolean {
  if (container.timeZone !== candidate.timeZone) return false;
  if (!date) return minutes(container.start) <= minutes(candidate.start) && minutes(container.end) >= minutes(candidate.end);
  const outer = zonedRange(date, container);
  const inner = zonedRange(date, candidate);
  return Temporal.Instant.compare(outer.start, inner.start) <= 0 && Temporal.Instant.compare(outer.end, inner.end) >= 0;
}

function zonedRange(date: string, interval: Interval): { start: Temporal.Instant; end: Temporal.Instant } {
  const plainDate = Temporal.PlainDate.from(date);
  const start = Temporal.ZonedDateTime.from({ timeZone: interval.timeZone, year: plainDate.year, month: plainDate.month, day: plainDate.day, hour: Number(interval.start.slice(0, 2)), minute: Number(interval.start.slice(3, 5)) });
  const end = Temporal.ZonedDateTime.from({ timeZone: interval.timeZone, year: plainDate.year, month: plainDate.month, day: plainDate.day, hour: Number(interval.end.slice(0, 2)), minute: Number(interval.end.slice(3, 5)) });
  return { start: start.toInstant(), end: end.toInstant() };
}

function weekdayForDate(date: string): Weekday {
  return Temporal.PlainDate.from(date).dayOfWeek as Weekday;
}

export function effectiveIntervalsForDate(date: string, timeZone: string, recurring: readonly RecurringAvailability[], exceptions: readonly AvailabilityException[]): Interval[] {
  const weekday = weekdayForDate(date);
  const base = recurring.filter((item) => item.weekday === weekday && item.timeZone === timeZone).map(({ start, end }) => ({ start, end, timeZone }));
  const dated = exceptions.filter((item) => item.date === date && item.interval.timeZone === timeZone);
  const points = new Set<number>([0, 24 * 60]);
  for (const item of [...base, ...dated.map((item) => item.interval)]) {
    points.add(minutes(item.start));
    points.add(minutes(item.end));
  }
  const sortedPoints = [...points].sort((a, b) => a - b);
  const result: Interval[] = [];
  for (let index = 0; index < sortedPoints.length - 1; index += 1) {
    const start = sortedPoints[index];
    const end = sortedPoints[index + 1];
    if (start === undefined || end === undefined || start >= end) continue;
    const midpoint = (start + end) / 2;
    let available = base.some((item) => minutes(item.start) <= midpoint && midpoint < minutes(item.end));
    for (const exception of dated) {
      const exceptionInterval = exception.interval;
      if (minutes(exceptionInterval.start) <= midpoint && midpoint < minutes(exceptionInterval.end)) available = exception.kind === 'available';
    }
    if (available) result.push({ start: clock(start), end: clock(end), timeZone });
  }
  return normalizeIntervals(result);
}

export function isAvailableForSession(session: Pick<Session, 'date' | 'start' | 'end' | 'timeZone'>, recurring: readonly RecurringAvailability[], exceptions: readonly AvailabilityException[]): boolean {
  const effective = effectiveIntervalsForDate(session.date, session.timeZone, recurring, exceptions);
  const target: Interval = { start: session.start, end: session.end, timeZone: session.timeZone };
  return effective.some((interval) => intervalContains(interval, target, session.date));
}

export function recurringWeekdayIntervals(recurring: readonly RecurringAvailability[], weekday: Weekday, timeZone: string): Interval[] {
  return normalizeIntervals(recurring.filter((item) => item.weekday === weekday && item.timeZone === timeZone).map(({ start, end }) => ({ start, end, timeZone })));
}
