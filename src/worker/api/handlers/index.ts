import { SynchronizationJobs } from '../../synchronizationJobs';
import { freshness, synchronizationView } from '../../synchronization';
import { Effect, Option, Schema } from 'effect';
import { whenIsGoodSource } from '../../config';
import { payloadSchemas, type Operation } from '../../../shared/api/schemas';
import { computeInsights } from '../../../shared/domain/insights';
import { canUseCenter } from '../policies';
import { dashboard, updateRecurring, createException, cancelAssignment } from './volunteer';
import { previewSchedule, publishSchedule } from './schedule';
import { readCandidates, updateCandidate, confirmCandidate } from './candidates';
import { previewImport, promoteImport, upsertMapping } from './imports';
import { disableCalendarSubscription, enableCalendarSubscription, readCalendarSubscription, resetCalendarSubscription } from './calendar';
import { createVolunteer, removeVolunteer, updateVolunteerDetails } from './volunteers';
import { scheduleView, type HandlerContext } from './context';

export function handleOperation(operation: Operation, payload: unknown, ctx: HandlerContext) {
  // The dispatcher already validated this payload. Decode here to narrow each branch's type.
  const input = <O extends Operation>(name: O) => Schema.decodeUnknownSync(payloadSchemas[name])(payload);
  switch (operation) {
    case 'admin.sync.read': return Effect.gen(function* () {
      const jobs = yield* Effect.serviceOption(SynchronizationJobs);
      const job = Option.isSome(jobs) ? yield* Effect.promise(() => jobs.value.latest()) : undefined;
      return { ...synchronizationView(ctx.state), ...(job !== undefined ? { job } : {}) };
    });
    case 'admin.sync.now': throw new Error('Synchronization is dispatched through its shared workflow.');
    case 'session.me': return Effect.succeed({ user: ctx.user, centers: ctx.state.centers.filter((center) => canUseCenter(ctx.user, center.id)) });
    case 'volunteer.dashboard': return dashboard(ctx).pipe(Effect.map(data => ({ ...data, freshness: freshness(ctx.state) })));
    case 'volunteer.availability.recurring.update': return updateRecurring(ctx, input('volunteer.availability.recurring.update').intervals);
    case 'volunteer.availability.exception.create': return createException(ctx, input('volunteer.availability.exception.create'));
    case 'volunteer.assignment.cancel': return cancelAssignment(ctx, input('volunteer.assignment.cancel'));
    case 'volunteer.calendar.read': return readCalendarSubscription(ctx);
    case 'volunteer.calendar.enable': return enableCalendarSubscription(ctx);
    case 'volunteer.calendar.reset': return resetCalendarSubscription(ctx);
    case 'volunteer.calendar.disable': return disableCalendarSubscription(ctx);
    case 'admin.schedule.read': return Effect.succeed(scheduleView(ctx.state, ctx.now));
    case 'admin.schedule.preview': return Effect.succeed(previewSchedule(ctx));
    case 'admin.schedule.rerun': return publishSchedule(ctx);
    case 'center.candidate.read': return Effect.succeed(readCandidates(ctx));
    case 'center.candidate.update': return updateCandidate(ctx, input('center.candidate.update'));
    case 'admin.center.candidate.confirm': return confirmCandidate(ctx, input('admin.center.candidate.confirm').candidateId);
    case 'admin.import.whenIsGood.preview': return previewImport(ctx, whenIsGoodSource.resultId);
    case 'admin.import.whenIsGood.promote': return promoteImport(ctx, whenIsGoodSource.resultId);
    case 'admin.import.mapping.upsert': return upsertMapping(ctx, input('admin.import.mapping.upsert'));
    case 'admin.insights.read': return Effect.succeed(computeInsights(ctx.state, ctx.config));
    case 'admin.volunteer.read': return Effect.succeed({ volunteers: ctx.state.volunteers });
    case 'admin.volunteer.create': return createVolunteer(ctx, input('admin.volunteer.create'));
    case 'admin.volunteer.update': return updateVolunteerDetails(ctx, input('admin.volunteer.update'));
    case 'admin.volunteer.remove': return removeVolunteer(ctx, input('admin.volunteer.remove'));
  }
}
