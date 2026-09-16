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

/**
 * Return the intervals a volunteer can actually work on a date.  Recurring
 * intervals are overlaid with only that volunteer's dated exceptions; the
 * shared time helper applies exception precedence and normalizes the result.
 */
export function effectiveAvailabilityForDate(
  volunteer: Pick<Volunteer, 'id' | 'recurringAvailability'>,
  date: string,
  timeZone: string,
  exceptions: readonly AvailabilityException[] = []
): Interval[] {
  return effectiveIntervalsForDate(
    date,
    timeZone,
    volunteer.recurringAvailability,
    exceptions.filter((exception) => exception.volunteerId === volunteer.id)
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
