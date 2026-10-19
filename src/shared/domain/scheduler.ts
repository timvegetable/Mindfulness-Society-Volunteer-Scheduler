import { Temporal } from '@js-temporal/polyfill';
import { availabilityForSessions, availableForSession, eligibleVolunteer, instantMilliseconds, sessionsOverlap } from './availability';
import type { Assignment, Backup, ScheduleOutput, SchedulingRun, Session, Snapshot, Volunteer } from './models';

export function currentRun<Run extends Pick<SchedulingRun, 'id' | 'status' | 'outputRevision'>>(snapshot: { schedulingRuns: readonly Run[] }): Run | null {
  return snapshot.schedulingRuns.filter((run) => run.status === 'completed').sort((a, b) => b.outputRevision - a.outputRevision || a.id.localeCompare(b.id))[0] ?? null;
}
export function currentAssignments<Row extends Pick<Assignment, 'scheduleRevision'>>(snapshot: {
  schedulingRuns: readonly Pick<SchedulingRun, 'id' | 'status' | 'outputRevision'>[]; assignments: readonly Row[];
}): Row[] {
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
export function rankVolunteers(volunteers: readonly Volunteer[], session: Session, snapshot: Snapshot, assignmentCounts?: ReadonlyMap<string, number>): Volunteer[] {
  const assignments = currentAssignments(snapshot);
  const continuity = new Set(volunteers.filter(volunteer => assignments.some((assignment) => assignment.status === 'assigned' && assignment.volunteerId === volunteer.id && assignment.sessionId === session.id)
    && !assignmentConflicts(snapshot, assignments, volunteer.id, session)).map(volunteer => volunteer.id));
  return [...volunteers].sort((a, b) => (a.readinessRank ?? 99) - (b.readinessRank ?? 99)
    || (assignmentCounts?.get(a.id) ?? 0) - (assignmentCounts?.get(b.id) ?? 0)
    || Number(continuity.has(b.id)) - Number(continuity.has(a.id)) || a.id.localeCompare(b.id));
}
export function schedulableSessions(snapshot: Pick<Snapshot, 'sessions'>, now: string): Session[] {
  const instant = Temporal.Instant.from(now).epochMilliseconds;
  return snapshot.sessions.filter((session) => ((session.kind === 'center' && session.status === 'locked') || (session.kind === 'univ100' && session.status === 'confirmed'))
    && instantMilliseconds(session.date, session.start, session.timeZone) > instant)
    .sort((a, b) => instantMilliseconds(a.date, a.start, a.timeZone) - instantMilliseconds(b.date, b.start, b.timeZone) || a.id.localeCompare(b.id));
}
export function generateSchedule(snapshot: Snapshot, now: string): ScheduleOutput {
  const output: ScheduleOutput = { assignments: [], backups: [], shortfalls: [] };
  const sessions = schedulableSessions(snapshot, now);
  const canAttend = availabilityForSessions(snapshot);
  const availableBySession = new Map<string, Volunteer[]>();
  const proposed: Pick<Assignment, 'sessionId' | 'volunteerId' | 'status'>[] = [];
  const assignmentCounts = new Map<string, number>();
  for (const session of sessions) {
    const available = snapshot.volunteers.filter((volunteer) => eligibleVolunteer(volunteer) && canAttend(volunteer.id, session));
    availableBySession.set(session.id, available);
    const chosen = new Set<string>();
    while (chosen.size < session.requiredStaffCount) {
      const compatible = rankVolunteers(available.filter((volunteer) => !chosen.has(volunteer.id)
        && !assignmentConflicts(snapshot, proposed, volunteer.id, session)), session, snapshot, assignmentCounts);
      const next = compatible[0];
      if (!next) break;
      chosen.add(next.id);
      proposed.push({ sessionId: session.id, volunteerId: next.id, status: 'assigned' });
      output.assignments.push({ sessionId: session.id, volunteerId: next.id });
      assignmentCounts.set(next.id, (assignmentCounts.get(next.id) ?? 0) + 1);
    }
    if (chosen.size < session.requiredStaffCount) output.shortfalls.push({ sessionId: session.id, required: session.requiredStaffCount, assigned: chosen.size, missing: session.requiredStaffCount - chosen.size });
  }
  for (const session of sessions) {
    const assigned = new Set(output.assignments.filter((assignment) => assignment.sessionId === session.id).map((assignment) => assignment.volunteerId));
    const backups = rankVolunteers((availableBySession.get(session.id) ?? []).filter((volunteer) => !assigned.has(volunteer.id)
      && !assignmentConflicts(snapshot, proposed, volunteer.id, session)), session, snapshot, assignmentCounts);
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
