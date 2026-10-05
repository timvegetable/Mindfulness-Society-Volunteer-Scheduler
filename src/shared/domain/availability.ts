import { Temporal } from '@js-temporal/polyfill';
import { coversInterval, normalizeIntervals, subtractIntervals } from './intervals';
import type { AvailabilityException, Interval, Session, Snapshot, Volunteer, Weekday } from './models';

export function eligibleVolunteer(volunteer: Volunteer): boolean {
  return volunteer.lifecycleStatus === 'active' && volunteer.interviewStatus === 'complete' && [1, 2, 3].includes(volunteer.readinessRank ?? 0);
}
export function weekdayOf(date: string): Weekday { return Temporal.PlainDate.from(date).dayOfWeek as Weekday; }
export function instantFor(date: string, time: string, timeZone: string): Temporal.Instant {
  return Temporal.PlainDate.from(date).toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from(time) }).toInstant();
}
export function overlayExceptions(recurring: readonly Interval[], exceptions: readonly Pick<AvailabilityException, 'kind' | 'start' | 'end'>[]): Interval[] {
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
  return coversInterval(availabilityOnDate(snapshot, volunteerId, session.date, session.timeZone), session);
}
export function sessionsOverlap(a: Session, b: Session): boolean {
  return Temporal.Instant.compare(instantFor(a.date, a.start, a.timeZone), instantFor(b.date, b.end, b.timeZone)) < 0
    && Temporal.Instant.compare(instantFor(b.date, b.start, b.timeZone), instantFor(a.date, a.end, a.timeZone)) < 0;
}
