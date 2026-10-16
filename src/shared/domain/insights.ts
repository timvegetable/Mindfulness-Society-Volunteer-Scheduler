import { eligibleVolunteer } from './availability';
import { coversNormalizedInterval, normalizeIntervals, minuteTime, timeMinutes } from './intervals';
import { currentAssignments } from './scheduler';
import type { GridCell, Insights, Snapshot, Weekday } from './models';

export interface InsightOptions { timeZone: string; displayIncrementMinutes: number; operatingHoursStart: string; operatingHoursEnd: string }
export function computeInsights(snapshot: Snapshot, options: InsightOptions): Insights {
  const start = timeMinutes(options.operatingHoursStart);
  const end = timeMinutes(options.operatingHoursEnd);
  if (start >= end || !Number.isInteger(options.displayIncrementMinutes) || options.displayIncrementMinutes < 1) throw new RangeError('Invalid insights grid configuration');
  const eligible = snapshot.volunteers.filter(eligibleVolunteer).sort((a, b) => a.id.localeCompare(b.id));
  const assigned = new Set(currentAssignments(snapshot).filter((assignment) => assignment.status === 'assigned').map((assignment) => assignment.volunteerId));
  // Normalize each volunteer/day once, rather than once per display cell.
  const eligibleIds = new Set(eligible.map(volunteer => volunteer.id));
  const availability = new Map<string, ReturnType<typeof normalizeIntervals>>();
  for (const row of snapshot.recurringAvailability) if (eligibleIds.has(row.volunteerId) && row.weekday >= 1 && row.weekday <= 5 && row.timeZone === options.timeZone) {
    const key = `${row.volunteerId}:${row.weekday}`;
    const group = availability.get(key) ?? [];
    group.push(row); availability.set(key, group);
  }
  for (const [key, intervals] of availability) availability.set(key, normalizeIntervals(intervals));
  const grid: GridCell[] = [];
  for (let weekday = 1; weekday <= 5; weekday += 1) {
    for (let minute = start; minute + options.displayIncrementMinutes <= end; minute += options.displayIncrementMinutes) {
      const interval = { start: minuteTime(minute), end: minuteTime(minute + options.displayIncrementMinutes) };
      const volunteers = eligible.filter((volunteer) => coversNormalizedInterval(availability.get(`${volunteer.id}:${weekday}`) ?? [], interval));
      const previous = grid.at(-1);
      if (previous && previous.weekday === weekday && previous.end === interval.start && previous.volunteers.map((v) => v.id).join('\0') === volunteers.map((v) => v.id).join('\0')) previous.end = interval.end;
      else grid.push({ weekday: weekday as Weekday, ...interval, volunteers, count: volunteers.length });
    }
  }
  return { leftoverVolunteers: eligible.filter((volunteer) => !assigned.has(volunteer.id)), grid };
}
