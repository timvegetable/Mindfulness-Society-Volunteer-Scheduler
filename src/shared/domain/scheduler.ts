import { Temporal } from '@js-temporal/polyfill';
import { availableForSession, eligibleVolunteer, instantFor, sessionsOverlap } from './availability';
import type { Assignment, Backup, ScheduleOutput, SchedulingRun, Session, Snapshot, Volunteer } from './models';

export function currentRun(snapshot: Pick<Snapshot, 'schedulingRuns'>): SchedulingRun | null {
  return snapshot.schedulingRuns.filter((run) => run.status === 'completed').sort((a, b) => b.outputRevision - a.outputRevision || a.id.localeCompare(b.id))[0] ?? null;
}
export function currentAssignments(snapshot: Pick<Snapshot, 'schedulingRuns' | 'assignments'>): Assignment[] {
  const run = currentRun(snapshot);
  return run ? snapshot.assignments.filter((assignment) => assignment.scheduleRevision === run.outputRevision) : [];
}
export function currentBackups(snapshot: Pick<Snapshot, 'schedulingRuns' | 'backups'>): Backup[] {
  const run = currentRun(snapshot);
  return run ? snapshot.backups.filter((backup) => backup.scheduleRevision === run.outputRevision) : [];
}
export function assignmentConflicts(snapshot: Pick<Snapshot, 'sessions'>, assignments: readonly Pick<Assignment, 'sessionId' | 'volunteerId' | 'status'>[], volunteerId: string, session: Session): boolean {
  return assignments.some((assignment) => assignment.status === 'assigned' && assignment.volunteerId === volunteerId && assignment.sessionId !== session.id
    && snapshot.sessions.some((other) => other.id === assignment.sessionId && other.status !== 'cancelled' && sessionsOverlap(session, other)));
}
export function rankVolunteers(volunteers: readonly Volunteer[], session: Session, snapshot: Snapshot): Volunteer[] {
  const assignments = currentAssignments(snapshot);
  const hasContinuity = (volunteer: Volunteer) => assignments.some((assignment) => assignment.status === 'assigned' && assignment.volunteerId === volunteer.id && assignment.sessionId === session.id)
    && !assignmentConflicts(snapshot, assignments, volunteer.id, session);
  return [...volunteers].sort((a, b) => (a.readinessRank ?? 99) - (b.readinessRank ?? 99) || Number(hasContinuity(b)) - Number(hasContinuity(a)) || a.id.localeCompare(b.id));
}
export function schedulableSessions(snapshot: Pick<Snapshot, 'sessions'>, now: string): Session[] {
  const instant = Temporal.Instant.from(now);
  return snapshot.sessions.filter((session) => ((session.kind === 'center' && session.status === 'locked') || (session.kind === 'univ100' && session.status === 'confirmed'))
    && Temporal.Instant.compare(instantFor(session.date, session.start, session.timeZone), instant) > 0)
    .sort((a, b) => Temporal.Instant.compare(instantFor(a.date, a.start, a.timeZone), instantFor(b.date, b.start, b.timeZone)) || a.id.localeCompare(b.id));
}
export function generateSchedule(snapshot: Snapshot, now: string): ScheduleOutput {
  const output: ScheduleOutput = { assignments: [], backups: [], shortfalls: [] };
  const sessions = schedulableSessions(snapshot, now);
  const ranked = new Map<string, Volunteer[]>();
  for (const session of sessions) {
    const available = rankVolunteers(snapshot.volunteers.filter((volunteer) => eligibleVolunteer(volunteer) && availableForSession(snapshot, volunteer.id, session)), session, snapshot);
    ranked.set(session.id, available);
    const compatible = available.filter((volunteer) => !assignmentConflicts(snapshot, output.assignments.map((assignment) => ({ ...assignment, status: 'assigned' as const })), volunteer.id, session));
    const chosen = compatible.slice(0, session.requiredStaffCount);
    output.assignments.push(...chosen.map((volunteer) => ({ sessionId: session.id, volunteerId: volunteer.id })));
    if (chosen.length < session.requiredStaffCount) output.shortfalls.push({ sessionId: session.id, required: session.requiredStaffCount, assigned: chosen.length, missing: session.requiredStaffCount - chosen.length });
  }
  for (const session of sessions) {
    const assigned = output.assignments.filter((assignment) => assignment.sessionId === session.id).map((assignment) => assignment.volunteerId);
    const backups = (ranked.get(session.id) ?? []).filter((volunteer) => !assigned.includes(volunteer.id)
      && !assignmentConflicts(snapshot, output.assignments.map((assignment) => ({ ...assignment, status: 'assigned' as const })), volunteer.id, session));
    output.backups.push(...backups.map((volunteer, index) => ({ sessionId: session.id, volunteerId: volunteer.id, position: index + 1 })));
  }
  return output;
}
export function eligibleBackup(snapshot: Snapshot, session: Session, volunteerId: string): boolean {
  const volunteer = snapshot.volunteers.find((entry) => entry.id === volunteerId);
  const assignments = currentAssignments(snapshot);
  return !!volunteer && eligibleVolunteer(volunteer) && availableForSession(snapshot, volunteer.id, session)
    && !assignments.some((assignment) => assignment.status === 'assigned' && assignment.sessionId === session.id && assignment.volunteerId === volunteer.id)
    && !assignmentConflicts(snapshot, assignments, volunteer.id, session);
}
export function selectBackup(snapshot: Snapshot, session: Session): { selected: Backup | null; skipped: Backup[]; remaining: Backup[] } {
  const backups = currentBackups(snapshot).filter((backup) => backup.sessionId === session.id && backup.status === 'available').sort((a, b) => a.position - b.position || a.volunteerId.localeCompare(b.volunteerId));
  const skipped: Backup[] = [];
  let selected: Backup | null = null;
  for (const backup of backups) {
    if (eligibleBackup(snapshot, session, backup.volunteerId)) { selected = backup; break; }
    skipped.push(backup);
  }
  return { selected, skipped, remaining: backups.filter((backup) => backup !== selected && !skipped.includes(backup)).map((backup, index) => ({ ...backup, position: index + 1 })) };
}
