import { Effect } from 'effect';
import { AppError } from '../../../shared/api/errors';
import type { Snapshot, User } from '../../../shared/domain/models';
import { sessionCenters } from '../../../shared/domain/session-label';
import type { AppConfig } from '../../config';
import { currentAssignments, currentBackups, currentRun } from '../../../shared/domain/scheduler';
import { futureScheduleRows } from '../../../shared/domain/schedule-view';
export { currentAssignments, currentBackups, currentRun } from '../../../shared/domain/scheduler';

export interface HandlerContext { state: Snapshot; user: User; config: AppConfig; now: Date }
export const fail = (code: ConstructorParameters<typeof AppError>[0], message: string) => Effect.fail(new AppError(code, message));
export function attempt<A>(fn: () => A) {
  return Effect.try({ try: fn, catch: () => new AppError('INVALID_REQUEST', 'Invalid date, time, or interval.') });
}
export function scheduleView(state: Snapshot, now?: Date) {
  const run = currentRun(state);
  const rows = { run, assignments: currentAssignments(state), backups: currentBackups(state),
    shortfalls: run?.shortfalls ?? [], sessions: state.sessions };
  const visible = now ? futureScheduleRows(rows, now.getTime()) : rows;
  return { ...visible, volunteers: state.volunteers,
    centers: sessionCenters(visible.sessions, state.centers),
    stale: !run || run.inputRevision < state.schedulingInputRevision };
}
