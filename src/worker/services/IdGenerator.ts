import { Context, Effect, Layer } from 'effect';

export class IdGenerator extends Context.Service<IdGenerator, {
  readonly next: Effect.Effect<string>;
}>()('IdGenerator') {}

export const IdGeneratorLive = Layer.succeed(IdGenerator, {
  next: Effect.sync(() => crypto.randomUUID()),
});

export function sequentialIds(prefix = 'test') {
  let sequence = 0;
  return Layer.succeed(IdGenerator, { next: Effect.sync(() => `${prefix}-${++sequence}`) });
}
