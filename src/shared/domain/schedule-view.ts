import type { Assignment, Backup, SchedulingRun, Session, Shortfall } from './models';
import { sessionsStartingAfter } from './availability';

export interface ScheduleRows {
  run: SchedulingRun | null;
  assignments: Assignment[];
  backups: Backup[];
  shortfalls: Shortfall[];
  sessions: Session[];
}

/** Project saved schedule records onto the sessions visible at the read instant. */
export function futureScheduleRows<View extends ScheduleRows>(view: View, now: number): View {
  const sessions = sessionsStartingAfter(view.sessions, now);
  const sessionIds = new Set(sessions.map(session => session.id));
  const assignments = view.assignments.filter(assignment => sessionIds.has(assignment.sessionId));
  const backups = view.backups.filter(backup => sessionIds.has(backup.sessionId));
  const shortfalls = view.shortfalls.filter(shortfall => sessionIds.has(shortfall.sessionId));
  const assignmentIds = new Set(assignments.map(assignment => assignment.id));
  const backupIds = new Set(backups.map(backup => backup.id));
  const run = view.run && {
    ...view.run,
    assignmentIds: view.run.assignmentIds.filter(id => assignmentIds.has(id)),
    backupIds: view.run.backupIds.filter(id => backupIds.has(id)),
    shortfalls: view.run.shortfalls.filter(shortfall => sessionIds.has(shortfall.sessionId)),
  };
  return { ...view, run, assignments, backups, shortfalls, sessions } as View;
}
