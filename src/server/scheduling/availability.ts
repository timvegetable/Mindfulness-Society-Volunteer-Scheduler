import type {
  AvailabilityException,
  Interval,
  RecurringAvailability,
  Session,
  Volunteer
} from '../../shared/domain.js';
import {
  effectiveIntervalsForDate,
  isAvailableForSession
} from '../../shared/time.js';

export function effectiveAvailabilityForDate(
  volunteer: Pick<Volunteer, 'id' | 'recurringAvailability'>,
  date: string,
  timeZone: string,
  exceptions?: readonly AvailabilityException[]
): Interval[];
export function effectiveAvailabilityForDate(
  date: string,
  timeZone: string,
  recurring: readonly RecurringAvailability[],
  exceptions?: readonly AvailabilityException[]
): Interval[];
export function effectiveAvailabilityForDate(
  volunteerOrDate: Pick<Volunteer, 'id' | 'recurringAvailability'> | string,
  dateOrTimeZone: string,
  timeZoneOrRecurring: string | readonly RecurringAvailability[],
  exceptions: readonly AvailabilityException[] = []
): Interval[] {
  if (typeof volunteerOrDate === 'string') {
    return effectiveIntervalsForDate(
      volunteerOrDate,
      dateOrTimeZone,
      timeZoneOrRecurring as readonly RecurringAvailability[],
      exceptions
    );
  }
  return effectiveIntervalsForDate(
    dateOrTimeZone,
    timeZoneOrRecurring as string,
    volunteerOrDate.recurringAvailability,
    exceptions.filter((exception) => exception.volunteerId === volunteerOrDate.id)
  );
}

/** A concise alias used by scheduling and consumers building projections. */
export const effectiveAvailability = effectiveAvailabilityForDate;

/**
 * Whether a volunteer covers the complete occurrence, rather than merely
 * overlapping part of it.
 */
export function volunteerIsAvailableForSession(
  volunteer: Pick<Volunteer, 'id' | 'recurringAvailability'>,
  session: Pick<Session, 'date' | 'start' | 'end' | 'timeZone'>,
  exceptions: readonly AvailabilityException[] = []
): boolean {
  return isAvailableForSession(
    session,
    volunteer.recurringAvailability,
    exceptions.filter((exception) => exception.volunteerId === volunteer.id)
  );
}

export const isVolunteerAvailableForSession = volunteerIsAvailableForSession;
