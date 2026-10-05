import { Effect, Schema } from 'effect';
import { payloadSchemas, type Operation } from '../../../shared/api/schemas';
import { computeInsights } from '../../../shared/domain/insights';
import { canUseCenter } from '../policies';
import { dashboard, updateRecurring, createException, cancelAssignment } from './volunteer';
import { previewSchedule, publishSchedule } from './schedule';
import { readCandidates, updateCandidate, confirmCandidate } from './candidates';
import { previewImport, promoteImport, upsertMapping } from './imports';
import { scheduleView, type HandlerContext } from './context';

export function handleOperation(operation: Operation, payload: unknown, ctx: HandlerContext) {
  // The dispatcher already validated this payload. Decode here to narrow each branch's type.
  const input = <O extends Operation>(name: O) => Schema.decodeUnknownSync(payloadSchemas[name])(payload);
  switch (operation) {
    case 'session.me': return Effect.succeed({ user: ctx.user, centers: ctx.state.centers.filter((center) => canUseCenter(ctx.user, center.id)) });
    case 'volunteer.dashboard': return dashboard(ctx);
    case 'volunteer.availability.recurring.update': return updateRecurring(ctx, input('volunteer.availability.recurring.update').intervals);
    case 'volunteer.availability.exception.create': return createException(ctx, input('volunteer.availability.exception.create'));
    case 'volunteer.assignment.cancel': return cancelAssignment(ctx, input('volunteer.assignment.cancel'));
    case 'admin.schedule.read': return Effect.succeed(scheduleView(ctx.state));
    case 'admin.schedule.preview': return Effect.succeed(previewSchedule(ctx));
    case 'admin.schedule.rerun': return publishSchedule(ctx);
    case 'center.candidate.read': return Effect.succeed(readCandidates(ctx));
    case 'center.candidate.update': return updateCandidate(ctx, input('center.candidate.update'));
    case 'admin.center.candidate.confirm': return confirmCandidate(ctx, input('admin.center.candidate.confirm').candidateId);
    case 'admin.import.whenIsGood.preview': return previewImport(ctx, input('admin.import.whenIsGood.preview').resultsCode);
    case 'admin.import.whenIsGood.promote': return promoteImport(ctx, input('admin.import.whenIsGood.promote').resultsCode);
    case 'admin.import.mapping.upsert': return upsertMapping(ctx, input('admin.import.mapping.upsert'));
    case 'admin.insights.read': return Effect.succeed(computeInsights(ctx.state, ctx.config));
  }
}
