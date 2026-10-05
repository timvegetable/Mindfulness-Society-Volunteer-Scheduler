import { Effect } from 'effect';
import type { AvailabilityException, WeeklyInterval, Assignment, Shortfall } from '../../../shared/domain/models';
import { normalizeWeeklyIntervals } from '../../../shared/domain/intervals';
import { instantFor } from '../../../shared/domain/availability';
import { selectBackup } from '../../../shared/domain/scheduler';
import { IdGenerator } from '../../services/IdGenerator';
import { attempt, currentAssignments, currentRun, fail, type HandlerContext } from './context';

export function ownVolunteer(ctx: HandlerContext) {
  const volunteer = ctx.state.volunteers.find((item) => item.id === ctx.user.volunteerId);
  return volunteer ? Effect.succeed(volunteer) : fail('NOT_FOUND', 'This account has no linked volunteer.');
}

export function dashboard(ctx: HandlerContext) {
  return Effect.gen(function* () {
    const volunteer = yield* ownVolunteer(ctx);
    return {
      volunteer,
      assignments: currentAssignments(ctx.state).filter((row) => row.volunteerId === volunteer.id),
      recurringAvailability: ctx.state.recurringAvailability.filter((row) => row.volunteerId === volunteer.id),
      availabilityExceptions: ctx.state.availabilityExceptions.filter((row) => row.volunteerId === volunteer.id),
      sessions: ctx.state.sessions.filter((session) => session.status !== 'cancelled' && instantFor(session.date, session.start, session.timeZone).epochMilliseconds > ctx.now.getTime()),
    };
  });
}

export function updateRecurring(ctx: HandlerContext, intervals: readonly WeeklyInterval[]) {
  return Effect.gen(function* () {
    const volunteer = yield* ownVolunteer(ctx);
    if (intervals.some((row) => row.timeZone !== ctx.config.timeZone)) return yield* fail('INVALID_REQUEST', 'Use the application time zone.');
    const normalized = yield* attempt(() => normalizeWeeklyIntervals(intervals));
    const ids = yield* IdGenerator;
    const saved = [];
    for (const interval of normalized) saved.push({ ...interval, id: yield* ids.next, volunteerId: volunteer.id, source: 'self-service', updatedAt: ctx.now.toISOString() });
    ctx.state.recurringAvailability = [...ctx.state.recurringAvailability.filter((row) => row.volunteerId !== volunteer.id), ...saved];
    return { intervals: saved };
  });
}

type ExceptionInput = Pick<AvailabilityException, 'date' | 'kind' | 'start' | 'end' | 'timeZone'> & { reason?: string };
export function createException(ctx: HandlerContext, input: ExceptionInput) {
  return Effect.gen(function* () {
    const volunteer = yield* ownVolunteer(ctx);
    if (input.timeZone !== ctx.config.timeZone) return yield* fail('INVALID_REQUEST', 'Use the application time zone.');
    yield* attempt(() => instantFor(input.date, input.start, input.timeZone));
    const ids = yield* IdGenerator;
    const exception: AvailabilityException = { ...input, id: yield* ids.next, volunteerId: volunteer.id, updatedAt: ctx.now.toISOString() };
    ctx.state.availabilityExceptions.push(exception);
    return { exception };
  });
}

export function cancelAssignment(ctx: HandlerContext, input: { assignmentId: string; reason?: string }) {
  return Effect.gen(function* () {
    const volunteer = yield* ownVolunteer(ctx);
    const assignment = currentAssignments(ctx.state).find((row) => row.id === input.assignmentId);
    if (!assignment || assignment.volunteerId !== volunteer.id) return yield* fail('NOT_FOUND', 'Assignment not found.');
    if (assignment.status !== 'assigned') return yield* fail('CONFLICT', 'This assignment is already cancelled.');
    const session = ctx.state.sessions.find((row) => row.id === assignment.sessionId);
    if (!session) return yield* fail('NOT_FOUND', 'Session not found.');
    const ids = yield* IdGenerator;
    assignment.status = 'cancelled';
    assignment.cancelledAt = ctx.now.toISOString();
    assignment.cancellationReason = input.reason ?? null;
    const exception: AvailabilityException = { id: yield* ids.next, volunteerId: volunteer.id, date: session.date,
      kind: 'unavailable', start: session.start, end: session.end, timeZone: ctx.config.timeZone,
      reason: input.reason ?? null, updatedAt: ctx.now.toISOString() };
    ctx.state.availabilityExceptions.push(exception);
    const choice = selectBackup(ctx.state, session);
    for (const skipped of choice.skipped) {
      const row = ctx.state.backups.find((item) => item.id === skipped.id);
      if (row) row.status = 'skipped';
    }
    let promotedAssignment: Assignment | null = null;
    if (choice.selected) {
      const backup = ctx.state.backups.find((row) => row.id === choice.selected?.id);
      if (backup) backup.status = 'promoted';
      promotedAssignment = { id: yield* ids.next, sessionId: session.id, volunteerId: choice.selected.volunteerId,
        scheduleRevision: assignment.scheduleRevision, status: 'assigned', createdAt: ctx.now.toISOString() };
      ctx.state.assignments.push(promotedAssignment);
    }
    for (const remaining of choice.remaining) {
      const row = ctx.state.backups.find((item) => item.id === remaining.id);
      if (row) row.position = remaining.position;
    }
    const assigned = currentAssignments(ctx.state).filter((row) => row.sessionId === session.id && row.status === 'assigned').length;
    const shortfall: Shortfall | null = assigned < session.requiredStaffCount ? {
      sessionId: session.id, required: session.requiredStaffCount, assigned, missing: session.requiredStaffCount - assigned,
    } : null;
    const run = currentRun(ctx.state);
    if (run) {
      run.shortfalls = [...run.shortfalls.filter((row) => row.sessionId !== session.id), ...(shortfall ? [shortfall] : [])];
      if (promotedAssignment) run.assignmentIds.push(promotedAssignment.id);
    }
    return { assignment, exception, promotedAssignment, shortfall };
  });
}
