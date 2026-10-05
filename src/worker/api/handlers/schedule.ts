import { Effect } from 'effect';
import { generateSchedule } from '../../../shared/domain/scheduler';
import { IdGenerator } from '../../services/IdGenerator';
import { scheduleView, type HandlerContext } from './context';

export function previewSchedule(ctx: HandlerContext) {
  return { output: generateSchedule(ctx.state, ctx.now.toISOString()) };
}

export function publishSchedule(ctx: HandlerContext) {
  return Effect.gen(function* () {
    const output = generateSchedule(ctx.state, ctx.now.toISOString());
    const ids = yield* IdGenerator;
    const revision = Math.max(0, ...ctx.state.schedulingRuns.map((run) => run.outputRevision)) + 1;
    const assignments = [];
    const backups = [];
    for (const row of output.assignments) assignments.push({ ...row, id: yield* ids.next, scheduleRevision: revision, status: 'assigned' as const, createdAt: ctx.now.toISOString() });
    for (const row of output.backups) backups.push({ ...row, id: yield* ids.next, scheduleRevision: revision, status: 'available' as const });
    ctx.state.assignments.push(...assignments);
    ctx.state.backups.push(...backups);
    ctx.state.schedulingRuns.push({ id: yield* ids.next, inputRevision: ctx.state.schedulingInputRevision, outputRevision: revision,
      status: 'completed', startedAt: ctx.now.toISOString(), completedAt: ctx.now.toISOString(),
      assignmentIds: assignments.map((row) => row.id), backupIds: backups.map((row) => row.id), shortfalls: output.shortfalls });
    return scheduleView(ctx.state);
  });
}
