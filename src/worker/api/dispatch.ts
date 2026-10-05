import { Effect, Schema } from 'effect';
import { AppError } from '../../shared/api/errors';
import { RequestEnvelopeSchema, payloadSchemas, resultSchemas, type Operation } from '../../shared/api/schemas';
import { normalizeWeeklyIntervals } from '../../shared/domain/intervals';
import type { Snapshot, User } from '../../shared/domain/models';
import { AuthService } from '../services/AuthService';
import { Database, schedulingInputsChanged } from '../services/Database';
import { Clock } from '../services/Clock';
import { EmailService } from '../services/EmailService';
import { canUseCenter, canUseOperation, policies } from './policies';
import { handleOperation } from './handlers';
import type { AppConfig } from '../config';

function normalize(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizePayload(operation: Operation, raw: unknown) {
  const schema = payloadSchemas[operation];
  let payload = normalize(Schema.decodeUnknownSync(schema)(raw));
  if (operation === 'volunteer.availability.recurring.update') {
    const input = Schema.decodeUnknownSync(payloadSchemas[operation])(payload);
    payload = { intervals: normalizeWeeklyIntervals(input.intervals) };
  }
  if (operation === 'admin.import.mapping.upsert') {
    const input = Schema.decodeUnknownSync(payloadSchemas[operation])(payload);
    payload = { ...input, ...(input.sourceEmail ? { sourceEmail: input.sourceEmail.toLowerCase() } : {}) };
  }
  return Schema.decodeUnknownSync(schema)(payload);
}

function authorizeScope(operation: Operation, payload: unknown, user: User, state: Snapshot) {
  if (operation === 'center.candidate.update') {
    const input = Schema.decodeUnknownSync(payloadSchemas[operation])(payload);
    const candidate = state.candidateSchedules.find((row) => row.id === input.candidateId);
    if ((candidate && !canUseCenter(user, candidate.centerId)) || (input.centerId && !canUseCenter(user, input.centerId))) return false;
  }
  if (operation === 'volunteer.assignment.cancel') {
    const input = Schema.decodeUnknownSync(payloadSchemas[operation])(payload);
    const assignment = state.assignments.find((row) => row.id === input.assignmentId);
    if (assignment && assignment.volunteerId !== user.volunteerId) return false;
  }
  return true;
}

/** Returns the exact serialized successful response; durable replays preserve those bytes. */
export function dispatch(raw: unknown, config: AppConfig) {
  return Effect.gen(function* () {
    const envelope = yield* Effect.try({ try: () => Schema.decodeUnknownSync(RequestEnvelopeSchema)(raw), catch: () => new AppError('INVALID_REQUEST', 'Invalid request envelope or operation.') });
    const auth = yield* AuthService;
    const identity = yield* auth.verify(envelope.credential);
    const database = yield* Database;
    const before = yield* database.read;
    const user = before.users.find((row) => row.active && row.email.trim().toLowerCase() === identity.email.toLowerCase());
    if (!user) return yield* Effect.fail(new AppError('UNAUTHORIZED', 'This account is not active.'));
    const operation = envelope.operation;
    if (!canUseOperation(user, operation)) return yield* Effect.fail(new AppError('FORBIDDEN', 'Your account cannot perform this operation.'));
    const payload = yield* Effect.try({ try: () => normalizePayload(operation, envelope.payload), catch: () => new AppError('INVALID_REQUEST', 'Invalid operation payload.') });
    if (!authorizeScope(operation, payload, user, before)) return yield* Effect.fail(new AppError('FORBIDDEN', 'This resource is outside your account.'));
    const clock = yield* Clock;
    const now = yield* clock.now;
    const write = policies[operation].write;
    if (write && (envelope.expectedRevision === undefined || !envelope.idempotencyKey?.trim())) return yield* Effect.fail(new AppError('INVALID_REQUEST', 'Mutations require expectedRevision and idempotencyKey.'));
    const key = { actorId: user.id, operation, idempotencyKey: envelope.idempotencyKey ?? '' };
    const fingerprint = canonical(payload);
    if (write) {
      const replay = yield* database.findIdempotency(key, now.toISOString());
      if (replay) {
        if (replay.fingerprint !== fingerprint) return yield* Effect.fail(new AppError('INVALID_REQUEST', 'This idempotency key was used with different input.'));
        return replay.response;
      }
      if (envelope.expectedRevision !== before.dataRevision) return yield* Effect.fail(new AppError('STALE_REVISION', 'Data changed. Reload before saving.'));
    }
    const state = structuredClone(before);
    const result = yield* handleOperation(operation, payload, { state, user, config, now });
    const dataRevision = before.dataRevision + (write ? 1 : 0);
    const schedulingInputRevision = before.schedulingInputRevision + (write && schedulingInputsChanged(before, state) ? 1 : 0);
    const data = yield* Effect.try({ try: () => Schema.decodeUnknownSync(resultSchemas[operation])({ ...result, dataRevision, schedulingInputRevision }), catch: () => new AppError('INTERNAL_ERROR', 'The operation produced an invalid response.') });
    const response = JSON.stringify({ ok: true, data });
    if (!write) return response;
    const committed = yield* database.commit({ before, after: state, key, fingerprint, response, createdAt: now.toISOString() }).pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error }));
    if (committed) {
      const replay = yield* database.findIdempotency(key, now.toISOString());
      if (replay) {
        if (replay.fingerprint !== fingerprint) return yield* Effect.fail(new AppError('INVALID_REQUEST', 'This idempotency key was used with different input.'));
        return replay.response;
      }
      return yield* Effect.fail(committed);
    }
    if (operation === 'volunteer.availability.recurring.update' || operation === 'volunteer.availability.exception.create' || operation === 'volunteer.assignment.cancel') {
      const email = yield* EmailService;
      yield* email.send({ to: config.adminEmails, subject: 'Volunteer schedule update', text: `${user.email} completed ${operation} at ${now.toISOString()}. Data revision ${dataRevision}.` })
        .pipe(Effect.catchCause(() => Effect.logError('Administrative notification failed after the mutation committed.')));
    }
    return response;
  });
}

export function publicFailure(error: AppError) {
  return JSON.stringify({ ok: false, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
}

export function dispatchResponse(raw: unknown, config: AppConfig) {
  return dispatch(raw, config).pipe(
    Effect.catch((error) => Effect.succeed(publicFailure(error))),
    Effect.catchDefect(() => Effect.succeed(publicFailure(new AppError('INTERNAL_ERROR', 'An unexpected error occurred.')))),
  );
}
