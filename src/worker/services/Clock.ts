import { Context, Effect, Layer } from 'effect';

export class Clock extends Context.Service<Clock, {
  readonly now: Effect.Effect<Date>;
}>()('Clock') {}

export const ClockLive = Layer.succeed(Clock, { now: Effect.sync(() => new Date()) });
export const fixedClock = (instant: string | Date) => Layer.succeed(Clock, {
  now: Effect.sync(() => new Date(instant)),
});
