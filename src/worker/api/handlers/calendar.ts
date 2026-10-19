import { Effect } from 'effect';
import { AppError } from '../../../shared/api/errors';
import type { CalendarSubscription } from '../../../shared/domain/models';
import { createCalendarToken, recoverCalendarToken } from '../../calendar/tokens';
import { fail, type HandlerContext } from './context';

function owner(ctx: HandlerContext) {
  if (!ctx.user.roles.includes('volunteer')) return fail('FORBIDDEN', 'Your account cannot manage a volunteer calendar.');
  const volunteer = ctx.state.volunteers.find((item) => item.id === ctx.user.volunteerId);
  return volunteer ? Effect.succeed(volunteer) : fail('NOT_FOUND', 'This account has no linked volunteer.');
}

function issue(ctx: HandlerContext, volunteerId: string, existing: CalendarSubscription | undefined) {
  return Effect.tryPromise({
    try: () => createCalendarToken(ctx.config.calendarTokenKey, volunteerId),
    catch: () => new AppError('INTERNAL_ERROR', 'Calendar links are not configured or are temporarily unavailable.'),
  }).pipe(Effect.map((credential) => {
    const subscription: CalendarSubscription = {
      id: volunteerId, volunteerId, tokenHash: credential.tokenHash,
      tokenCiphertext: credential.tokenCiphertext, tokenIv: credential.tokenIv, enabled: true,
      createdAt: existing?.createdAt ?? ctx.now.toISOString(), updatedAt: ctx.now.toISOString(),
    };
    if (existing) Object.assign(existing, subscription);
    else ctx.state.calendarSubscriptions.push(subscription);
    return { enabled: true };
  }));
}

export function readCalendarSubscription(ctx: HandlerContext) {
  return Effect.gen(function* () {
    const volunteer = yield* owner(ctx);
    const subscription = ctx.state.calendarSubscriptions.find((item) => item.volunteerId === volunteer.id && item.enabled);
    if (!subscription) return { enabled: false, token: null };
    const token = yield* Effect.tryPromise({
      try: () => recoverCalendarToken(ctx.config.calendarTokenKey, subscription),
      catch: () => new AppError('INTERNAL_ERROR', 'Your calendar link is temporarily unavailable. Please try again.'),
    });
    return { enabled: true, token };
  });
}

export function enableCalendarSubscription(ctx: HandlerContext) {
  return Effect.gen(function* () {
    const volunteer = yield* owner(ctx);
    const existing = ctx.state.calendarSubscriptions.find((item) => item.volunteerId === volunteer.id);
    if (existing?.enabled) return { enabled: true };
    return yield* issue(ctx, volunteer.id, existing);
  });
}

export function resetCalendarSubscription(ctx: HandlerContext) {
  return Effect.gen(function* () {
    const volunteer = yield* owner(ctx);
    const existing = ctx.state.calendarSubscriptions.find((item) => item.volunteerId === volunteer.id);
    if (!existing?.enabled) return yield* fail('CONFLICT', 'Turn on calendar sync before resetting your link.');
    return yield* issue(ctx, volunteer.id, existing);
  });
}

export function disableCalendarSubscription(ctx: HandlerContext) {
  return Effect.gen(function* () {
    const volunteer = yield* owner(ctx);
    const existing = ctx.state.calendarSubscriptions.find((item) => item.volunteerId === volunteer.id);
    if (existing) {
      existing.enabled = false;
      existing.tokenHash = null;
      existing.tokenCiphertext = null;
      existing.tokenIv = null;
      existing.updatedAt = ctx.now.toISOString();
    }
    return { enabled: false };
  });
}
