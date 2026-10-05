import { Context, Effect, Layer } from 'effect';
import { AppError } from '../../shared/api/errors';
import type { Snapshot } from '../../shared/domain/models';
import { commit, findIdempotency, readSnapshot, storageError, type CommitInput, type IdempotencyKey, type IdempotencyRecord } from '../repositories/database';

export { schedulingInputsChanged } from '../repositories/database';
export type { CommitInput, IdempotencyKey, IdempotencyRecord } from '../repositories/database';

export interface DatabaseService {
  readonly read: Effect.Effect<Snapshot, AppError>;
  readonly findIdempotency: (key: IdempotencyKey, now: string) => Effect.Effect<IdempotencyRecord | null, AppError>;
  readonly commit: (input: CommitInput) => Effect.Effect<void, AppError>;
}

export class Database extends Context.Service<Database, DatabaseService>()('Database') {}

function operation<A>(run: () => Promise<A>): Effect.Effect<A, AppError> {
  return Effect.tryPromise({ try: run, catch: error => error instanceof AppError ? error : storageError() });
}

/** Binding access is isolated here; application workflows depend on the service. */
export function makeDatabase(db: D1Database): DatabaseService {
  return {
    read: operation(() => readSnapshot(db)),
    findIdempotency: (key, now) => operation(() => findIdempotency(db, key, now)),
    commit: input => operation(() => commit(db, input)),
  };
}

export const databaseLayer = (db: D1Database): Layer.Layer<Database> => Layer.succeed(Database, makeDatabase(db));
