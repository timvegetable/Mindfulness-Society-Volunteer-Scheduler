import type { RecurringAvailability, Volunteer } from '../../shared/domain.js';

export type AvailabilityHydrationSource = {
  volunteers: { list(): Volunteer[] };
  recurringAvailability?: { list(): ReadonlyArray<RecurringAvailability & { volunteerId: string }> } | undefined;
};

/**
 * Recurring availability lives in its own tab, so a volunteer only becomes
 * schedulable once those intervals are grouped onto the roster row. Group the
 * request's rows once instead of scanning the full list per volunteer, and keep
 * scheduling, insights, center coverage, and backup promotion reading the same
 * availability.
 */
export function hydratedVolunteers(source: AvailabilityHydrationSource): Volunteer[] {
  const intervalsByVolunteer = new Map<string, RecurringAvailability[]>();
  for (const row of source.recurringAvailability?.list() ?? []) {
    const interval: RecurringAvailability = { weekday: row.weekday, start: row.start, end: row.end, timeZone: row.timeZone };
    const existing = intervalsByVolunteer.get(row.volunteerId);
    if (existing) existing.push(interval);
    else intervalsByVolunteer.set(row.volunteerId, [interval]);
  }
  return source.volunteers.list().map((volunteer) => ({ ...volunteer, recurringAvailability: intervalsByVolunteer.get(volunteer.id) ?? [] }));
}
