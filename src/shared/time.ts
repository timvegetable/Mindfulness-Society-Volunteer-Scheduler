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

export function intervalsOverlap(left: Interval, right: Interval, date?: string, memo?: IntervalMemo): boolean {
  if (left.timeZone !== right.timeZone) throw new Error('Intervals must use the same time zone');
  if (!date) return minutes(left.start) < minutes(right.end) && minutes(right.start) < minutes(left.end);
  const leftRange = memo ? memoizedRange(memo, date, left) : zonedRange(date, left);
  const rightRange = memo ? memoizedRange(memo, date, right) : zonedRange(date, right);
  return Temporal.Instant.compare(leftRange.start, rightRange.end) < 0 && Temporal.Instant.compare(rightRange.start, leftRange.end) < 0;
}

export function intervalContains(container: Interval, candidate: Interval, date?: string, memo?: IntervalMemo): boolean {
  if (container.timeZone !== candidate.timeZone) return false;
  if (!date) return minutes(container.start) <= minutes(candidate.start) && minutes(container.end) >= minutes(candidate.end);
  const outer = memo ? memoizedRange(memo, date, container) : zonedRange(date, container);
  const inner = memo ? memoizedRange(memo, date, candidate) : zonedRange(date, candidate);
  return Temporal.Instant.compare(outer.start, inner.start) <= 0 && Temporal.Instant.compare(outer.end, inner.end) >= 0;
}

/**
 * One memoized half-open instant range per (date, zone, clock) triple.
 * Memoizing per interval instead of per clock lets two intervals that share an
 * endpoint reuse the same instant without recomputing it.
 */
function memoizedRange(memo: IntervalMemo, date: string, interval: Interval): { start: Temporal.Instant; end: Temporal.Instant } {
  return {
    start: memo.zonedRange(date, interval.timeZone, interval.start),
    end: memo.zonedRange(date, interval.timeZone, interval.end)
  };
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

/**
 * A recurring availability's base intervals for one weekday and zone, exactly
 * as `effectiveIntervalsForDate` derives them: un-normalized, in source order.
 */
export function baseIntervals(recurring: readonly RecurringAvailability[], weekday: Weekday, timeZone: string): Interval[] {
  return recurring.filter((item) => item.weekday === weekday && item.timeZone === timeZone).map(({ start, end }) => ({ start, end, timeZone }));
}

/**
 * The date's effective availability, given a pre-derived base. This is the
 * point-merge half of `effectiveIntervalsForDate`; `dated` must already hold
 * the date's exceptions in the zone.
 */
export function effectiveIntervalsFromBase(date: string, timeZone: string, base: readonly Interval[], dated: readonly AvailabilityException[]): Interval[] {
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

export function effectiveIntervalsForDate(date: string, timeZone: string, recurring: readonly RecurringAvailability[], exceptions: readonly AvailabilityException[], memo?: IntervalMemo): Interval[] {
  const weekday = memo ? memo.weekday(date) : weekdayForDate(date);
  const base = memo ? memo.baseIntervals(recurring, weekday, timeZone) : baseIntervals(recurring, weekday, timeZone);
  const dated = exceptions.filter((item) => item.date === date && item.interval.timeZone === timeZone);
  return effectiveIntervalsFromBase(date, timeZone, base, dated);
}

export function isAvailableForSession(session: Pick<Session, 'date' | 'start' | 'end' | 'timeZone'>, recurring: readonly RecurringAvailability[], exceptions: readonly AvailabilityException[], memo?: IntervalMemo): boolean {
  const effective = memo
    ? memo.effectiveIntervals(session.date, session.timeZone, recurring, exceptions)
    : effectiveIntervalsForDate(session.date, session.timeZone, recurring, exceptions);
  const target: Interval = { start: session.start, end: session.end, timeZone: session.timeZone };
  return effective.some((interval) => intervalContains(interval, target, session.date, memo));
}

export function recurringWeekdayIntervals(recurring: readonly RecurringAvailability[], weekday: Weekday, timeZone: string): Interval[] {
  return normalizeIntervals(recurring.filter((item) => item.weekday === weekday && item.timeZone === timeZone).map(({ start, end }) => ({ start, end, timeZone })));
}

/**
 * Request-local memoization for the interval helpers.
 *
 * The preview computation evaluates the same (date, zone, clock) combinations
 * thousands of times per request, and every `Temporal.ZonedDateTime.from` is
 * expensive. Each helper's result is a pure function of its inputs, so the
 * memo caches results keyed by their exact inputs and changes no outcome —
 * including DST resolution, which happens inside the memoized construction.
 * A caller that passes no memo runs the unmemoized path, byte-identical to
 * this file's earlier behavior.
 *
 * The scheduler owns one memo per request. The reuse that pays is per date and
 * per availability list (weekday, base, normalized base, boundary instants);
 * the composed per-(availability, date) result is computed directly, because a
 * request's sessions rarely share a date and caching it would only spend
 * memory. The date's exceptions are therefore derived fresh on every call.
 */
export type IntervalMemo = {
  /** The weekday of a `YYYY-MM-DD` date, computed once per date. */
  weekday(date: string): Weekday;
  /** The base intervals of one recurring-availability list for (weekday, zone). */
  baseIntervals(recurring: readonly RecurringAvailability[], weekday: Weekday, timeZone: string): Interval[];
  /** The full effective intervals of one (date, zone, availability, exceptions) input. */
  effectiveIntervals(date: string, timeZone: string, recurring: readonly RecurringAvailability[], exceptions: readonly AvailabilityException[]): Interval[];
  /** The instant of one (date, zone, clock) triple, e.g. a session or interval boundary. */
  zonedRange(date: string, timeZone: string, clock: string): Temporal.Instant;
};

export function createIntervalMemo(): IntervalMemo {
  const weekdays = new Map<string, Weekday>();
  const instantMemo = new Map<string, Temporal.Instant>();
  const baseMemo = new WeakMap<readonly RecurringAvailability[], Map<string, Interval[]>>();
  const normalizedBaseMemo = new WeakMap<readonly RecurringAvailability[], Map<string, Interval[]>>();

  const instantOf = (date: string, timeZone: string, clockText: string): Temporal.Instant => {
    const key = `${date}\u0000${timeZone}\u0000${clockText}`;
    let instant = instantMemo.get(key);
    if (instant === undefined) {
      const [year, month, day] = date.split('-');
      const [hour, minute] = clockText.split(':');
      instant = Temporal.ZonedDateTime.from({ timeZone, year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) }).toInstant();
      instantMemo.set(key, instant);
    }
    return instant;
  };

  const normalizedBaseOf = (recurring: readonly RecurringAvailability[], weekday: Weekday, timeZone: string): Interval[] => {
    let byKey = normalizedBaseMemo.get(recurring);
    if (!byKey) {
      byKey = new Map();
      normalizedBaseMemo.set(recurring, byKey);
    }
    const key = `${weekday}\u0000${timeZone}`;
    const cached = byKey.get(key);
    if (cached) return cached;
    const intervals = normalizeIntervals(baseIntervals(recurring, weekday, timeZone));
    byKey.set(key, intervals);
    return intervals;
  };

  return {
    weekday(date) {
      const cached = weekdays.get(date);
      if (cached !== undefined) return cached;
      const weekday = weekdayForDate(date);
      weekdays.set(date, weekday);
      return weekday;
    },
    baseIntervals(recurring, weekday, timeZone) {
      let byKey = baseMemo.get(recurring);
      if (!byKey) {
        byKey = new Map();
        baseMemo.set(recurring, byKey);
      }
      const key = `${weekday}\u0000${timeZone}`;
      const cached = byKey.get(key);
      if (cached) return cached;
      const intervals = baseIntervals(recurring, weekday, timeZone);
      byKey.set(key, intervals);
      return intervals;
    },
    effectiveIntervals(date, timeZone, recurring, exceptions) {
      // Without the date's exceptions the effective intervals are exactly the
      // normalized base: the point merge can only return the base's own union.
      let dated: AvailabilityException[] | undefined;
      for (const exception of exceptions) {
        if (exception.date === date && exception.interval.timeZone === timeZone) (dated ??= []).push(exception);
      }
      const weekday = this.weekday(date);
      if (dated === undefined) return normalizedBaseOf(recurring, weekday, timeZone);
      return effectiveIntervalsFromBase(date, timeZone, this.baseIntervals(recurring, weekday, timeZone), dated);
    },
    zonedRange(date, timeZone, clockText) {
      return instantOf(date, timeZone, clockText);
    }
  };
}
