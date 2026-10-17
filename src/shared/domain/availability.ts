import { Temporal } from '@js-temporal/polyfill';
import { isISODate } from './dates';
import { applicationTimeZone } from './models';
import { coversNormalizedInterval, validateInterval, normalizeIntervals, subtractIntervals } from './intervals';
import type { AvailabilityException, Interval, Session, Snapshot, Volunteer, Weekday } from './models';

export function eligibleVolunteer(volunteer: Volunteer): boolean {
  return volunteer.lifecycleStatus === 'active' && volunteer.interviewStatus === 'complete' && [1, 2, 3].includes(volunteer.readinessRank ?? 0);
}
const weekdays = new Map<string, Weekday>();
export function weekdayOf(date: string): Weekday {
  const cached = weekdays.get(date);
  if (cached) return cached;
  const weekday = Temporal.PlainDate.from(date).dayOfWeek as Weekday;
  if (weekdays.size >= 256) weekdays.delete(weekdays.keys().next().value!);
  weekdays.set(date, weekday);
  return weekday;
}
// Date conversion is pure; a bounded cache also shares work within a single
// scheduling run, where the same session endpoints are compared many times.
const instants = new Map<string, { instant: Temporal.Instant; milliseconds: number }>();
function localInstant(date: string, time: string, timeZone: string) {
  const key = `${date}\0${time}\0${timeZone}`;
  const cached = instants.get(key);
  if (cached) return cached;
  const instant = Temporal.PlainDate.from(date).toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from(time) }).toInstant();
  if (instants.size >= 256) instants.delete(instants.keys().next().value!);
  const result = { instant, milliseconds: instant.epochMilliseconds };
  instants.set(key, result);
  return result;
}
export function instantFor(date: string, time: string, timeZone: string): Temporal.Instant {
  return localInstant(date, time, timeZone).instant;
}
export function instantMilliseconds(date: string, time: string, timeZone: string): number {
  return localInstant(date, time, timeZone).milliseconds;
}

/** New York is always less than a day from UTC. Only nearby dates need an
 * exact conversion; keep Temporal's gap/repeated-hour semantics at that boundary.
 */
export function futureStartCheck(now: number): (date: string, time: string, timeZone: string) => boolean {
  const previousDay = new Date(now - 86400000).toISOString().slice(0, 10);
  const nextDay = new Date(now + 86400000).toISOString().slice(0, 10);
  return (date, time, timeZone) => {
    if (timeZone === applicationTimeZone && isISODate(date) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      if (date < previousDay) return false;
      if (date > nextDay) return true;
    }
    return instantMilliseconds(date, time, timeZone) > now;
  };
}

export function overlayExceptions(recurring: readonly Interval[], exceptions: readonly Pick<AvailabilityException, 'kind' | 'start' | 'end'>[]): Interval[] {
  if (!exceptions.length) return normalizeIntervals(recurring);
  // Unavailability wins when dated exceptions conflict, independently of storage order.
  const added = normalizeIntervals([...recurring, ...exceptions.filter((exception) => exception.kind === 'available')]);
  return subtractIntervals(added, exceptions.filter((exception) => exception.kind === 'unavailable'));
}
export function availabilityOnDate(snapshot: Pick<Snapshot, 'recurringAvailability' | 'availabilityExceptions'>, volunteerId: string, date: string, timeZone: string): Interval[] {
  const weekday = weekdayOf(date);
  return overlayExceptions(
    snapshot.recurringAvailability.filter((interval) => interval.volunteerId === volunteerId && interval.weekday === weekday && interval.timeZone === timeZone),
    snapshot.availabilityExceptions.filter((exception) => exception.volunteerId === volunteerId && exception.date === date && exception.timeZone === timeZone),
  );
}
export function availableForSession(snapshot: Pick<Snapshot, 'recurringAvailability' | 'availabilityExceptions'>, volunteerId: string, session: Session): boolean {
  const intervals = availabilityOnDate(snapshot, volunteerId, session.date, session.timeZone);
  return coversNormalizedInterval(intervals, validateInterval(session));
}
/** Reuse dated availability while calculating against a fixed snapshot. */
export function availabilityForSessions(snapshot: Pick<Snapshot, 'recurringAvailability' | 'availabilityExceptions'>) {
  const volunteers = new Map<string, typeof snapshot>();
  const dates = new Map<string, Interval[]>();
  const validated = new Set<Session>();
  return (volunteerId: string, session: Session): boolean => {
    let own = volunteers.get(volunteerId);
    if (!own) {
      own = { recurringAvailability: snapshot.recurringAvailability.filter(row => row.volunteerId === volunteerId),
        availabilityExceptions: snapshot.availabilityExceptions.filter(row => row.volunteerId === volunteerId) };
      volunteers.set(volunteerId, own);
    }
    // Without dated exceptions, every occurrence of a weekday has the same availability.
    const day = own.availabilityExceptions.length ? session.date : weekdayOf(session.date);
    const key = JSON.stringify([volunteerId, day, session.timeZone]);
    let intervals = dates.get(key);
    if (!intervals) {
      intervals = availabilityOnDate(own, volunteerId, session.date, session.timeZone);
      dates.set(key, intervals);
    }
    if (!validated.has(session)) { validateInterval(session); validated.add(session); }
    return coversNormalizedInterval(intervals, session);
  };
}

export function sessionsOverlap(a: Session, b: Session): boolean {
  return instantMilliseconds(a.date, a.start, a.timeZone) < instantMilliseconds(b.date, b.end, b.timeZone)
    && instantMilliseconds(b.date, b.start, b.timeZone) < instantMilliseconds(a.date, a.end, a.timeZone);
}
