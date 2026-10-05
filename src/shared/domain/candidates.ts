import { Temporal } from '@js-temporal/polyfill';
import { availableForSession, eligibleVolunteer } from './availability';
import { coversInterval } from './intervals';
import { assignmentConflicts, currentAssignments } from './scheduler';
import type { Candidate, Coverage, Session, Snapshot, Volunteer } from './models';

const ordered = (volunteers: Volunteer[]): Volunteer[] => volunteers.sort((a, b) => (a.readinessRank ?? 99) - (b.readinessRank ?? 99) || a.id.localeCompare(b.id));
export function candidateCoverage(snapshot: Snapshot, candidate: Candidate): Coverage {
  const volunteers = ordered(snapshot.volunteers.filter((volunteer) => eligibleVolunteer(volunteer)
    && coversInterval(snapshot.recurringAvailability.filter((interval) => interval.volunteerId === volunteer.id && interval.weekday === candidate.weekday && interval.timeZone === candidate.timeZone), candidate)));
  return { volunteers, requestedCount: candidate.requestedStaffCount, shortfall: Math.max(0, candidate.requestedStaffCount - volunteers.length) };
}
export function nextOccurrence(candidate: Pick<Candidate, 'weekday' | 'start' | 'timeZone'>, now: string): string {
  const local = Temporal.Instant.from(now).toZonedDateTimeISO(candidate.timeZone);
  let days = (candidate.weekday - local.dayOfWeek + 7) % 7;
  if (days === 0 && Temporal.PlainTime.compare(local.toPlainTime(), Temporal.PlainTime.from(candidate.start)) > 0) days = 7;
  return local.toPlainDate().add({ days }).toString();
}
export function candidateSession(candidate: Candidate, centerName: string, now: string): Session {
  const date = nextOccurrence(candidate, now);
  return { id: `session-${candidate.id}-${date}`, kind: 'center', centerId: candidate.centerId, title: centerName, date, start: candidate.start, end: candidate.end, timeZone: candidate.timeZone, requiredStaffCount: candidate.requestedStaffCount, status: 'locked', sourceCandidateId: candidate.id, createdAt: now, updatedAt: now };
}
export function confirmedDateCoverage(snapshot: Snapshot, session: Session): Coverage {
  const assignments = currentAssignments(snapshot);
  const volunteers = ordered(snapshot.volunteers.filter((volunteer) => eligibleVolunteer(volunteer) && availableForSession(snapshot, volunteer.id, session)
    && !assignmentConflicts(snapshot, assignments, volunteer.id, session)));
  return { volunteers, requestedCount: session.requiredStaffCount, shortfall: Math.max(0, session.requiredStaffCount - volunteers.length) };
}
