import type { ApiResponse } from '../../shared/domain.js';
import { authenticateCredential, type AuthenticatedPrincipal, type TokenVerifier, type UserDirectory } from './auth.js';
import type { ReadTiming } from './read-timing.js';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  IntegrationError,
  enforceCenterCandidateBoundary,
  expectedRevisionFrom,
  failure,
  mapUnknownError,
  operationPolicy,
  validateRequestEnvelope,
  type IntegrationOperation
} from './request-policy.js';

export {
  ALLOWED_INTEGRATION_OPERATIONS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  INTEGRATION_OPERATIONS,
  IntegrationError,
  OPERATION_POLICIES,
  enforceCenterCandidateBoundary,
  expectedRevisionFrom,
  failure,
  fingerprint,
  isAllowedOperation,
  mapUnknownError,
  operationPolicy,
  payloadBytes,
  rejectDangerousKeys,
  stableValue,
  validateRequestEnvelope
} from './request-policy.js';
export type { EnvelopeValidation, IntegrationErrorDetails, OperationPolicy, ValidatedRequest } from './request-policy.js';

export type RevisionSource = {
  current(): number;
  advance?(actorId: string, operation: string): number;
};

export type WriteLock = {
  tryAcquire(): boolean;
  release(): void;
};

export class MemoryRevisionSource implements RevisionSource {
  private value: number;

  constructor(initialRevision = 0) {
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) throw new Error('Revision must be a non-negative integer.');
    this.value = initialRevision;
  }

  current(): number {
    return this.value;
  }

  advance(): number {
    this.value += 1;
    return this.value;
  }
}

export class MemoryWriteLock implements WriteLock {
  private held = false;

  tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }

  release(): void {
    this.held = false;
  }

  hold(): void {
    this.held = true;
  }

  isHeld(): boolean {
    return this.held;
  }
}

export type HandlerContext = Readonly<{
  actor: AuthenticatedPrincipal;
  operation: IntegrationOperation;
  idempotencyKey: string;
  expectedRevision?: number;
  now: string;
}>;

export type OperationHandler = (context: HandlerContext, payload: unknown) => unknown;
export type OperationHandlers = Partial<Record<IntegrationOperation, OperationHandler>>;

export type IntegrationDispatcherOptions = Readonly<{
  verifier: TokenVerifier;
  users: UserDirectory;
  handlers?: OperationHandlers;
  revision?: RevisionSource;
  writeLock?: WriteLock;
  maxPayloadBytes?: number;
  idempotencyTtlMs?: number;
  maxIdempotencyEntries?: number;
  clock?: () => string;
  timing?: ReadTiming;
}>;

type StoredRequest = Readonly<{ fingerprint: string; storedAt: number; response?: ApiResponse<unknown> }>;

const DEFAULT_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 1000;

/**
 * Apps Script web apps cannot return a Promise: a handler that yields one makes
 * the platform report "The script completed but the returned value is not a
 * supported return type". Fail loudly here instead, so the diagnostic names the
 * operation rather than the transport.
 */
function assertSynchronous(operation: IntegrationOperation, value: unknown): unknown {
  if (typeof (value as { then?: unknown } | null)?.then === 'function') {
    throw new IntegrationError('INTERNAL_ERROR', `Operation ${operation} returned a Promise; Apps Script handlers must complete synchronously.`);
  }
  return value;
}

export class IntegrationDispatcher {
  private readonly options: IntegrationDispatcherOptions;
  private readonly handlers: OperationHandlers;
  private readonly requests = new Map<string, StoredRequest>();
  private readonly idempotencyTtlMs: number;
  private readonly maxIdempotencyEntries: number;

  constructor(options: IntegrationDispatcherOptions) {
    if (!Number.isSafeInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES) || (options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES) < 1024) {
      throw new Error('maxPayloadBytes must be at least 1024 bytes.');
    }
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.maxIdempotencyEntries = options.maxIdempotencyEntries ?? DEFAULT_MAX_IDEMPOTENCY_ENTRIES;
    if (!Number.isSafeInteger(this.idempotencyTtlMs) || this.idempotencyTtlMs < 1000) throw new Error('idempotencyTtlMs must be at least one second.');
    if (!Number.isSafeInteger(this.maxIdempotencyEntries) || this.maxIdempotencyEntries < 1) throw new Error('maxIdempotencyEntries must be positive.');
    this.options = options;
    this.handlers = options.handlers ?? {};
  }

  private pruneIdempotency(now: number): void {
    for (const [key, request] of this.requests) {
      if (now - request.storedAt >= this.idempotencyTtlMs) this.requests.delete(key);
    }
    while (this.requests.size >= this.maxIdempotencyEntries) {
      const oldest = this.requests.keys().next().value;
      if (oldest === undefined) break;
      this.requests.delete(oldest);
    }
  }

  dispatch(input: unknown, options: Readonly<{ readOnly?: boolean }> = {}): ApiResponse<unknown> {
    this.pruneIdempotency(Date.now());
    let requestKey: string | undefined;
    let lockAcquired = false;
    try {
      const validation = validateRequestEnvelope(input, {
        ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
        maxPayloadBytes: this.options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES
      });
      if (!validation.ok) return validation.response;
      const { operation, policy, payload, idempotencyKey, credential, requestFingerprint } = validation.value;
      // The caller is authenticated after the envelope is validated, so an
      // unauthorized request cannot probe which payload shapes are accepted for
      // an operation it may not use.
      const actor = authenticateCredential(credential, this.options.verifier, this.options.users, this.options.timing);
      if (!policy.roles.some((role) => actor.user.roles.includes(role))) return failure('FORBIDDEN', 'Your account is not authorized for this operation.');
      enforceCenterCandidateBoundary(operation, actor, payload);
      const expectedRevision = expectedRevisionFrom(validation.value.expectedRevision);
      // The policy field is a requirement, not a hint: an operation that declares
      // expectedRevision is refused when the caller omits it, before any state is
      // touched. Compare against the refused set in architecture.md.
      if (policy.expectedRevision && expectedRevision === undefined) {
        return failure('INVALID_REQUEST', 'This operation requires the current revision; read it again before retrying.');
      }
      if (policy.mutating && (!this.options.revision || !this.options.writeLock)) return failure('UNAVAILABLE', 'State-changing operations are not configured.');
      requestKey = `${actor.user.id}:${operation}:${idempotencyKey}`;
      const existingRequest = this.requests.get(requestKey);
      if (existingRequest) {
        if (existingRequest.fingerprint !== requestFingerprint) return failure('CONFLICT', 'The idempotency key was already used for a different request.');
        return failure('DUPLICATE_REQUEST', 'This request has already been submitted.');
      }
      this.requests.set(requestKey, { fingerprint: requestFingerprint, storedAt: Date.now() });
      if (policy.mutating && this.options.writeLock && !this.options.writeLock.tryAcquire()) {
        this.requests.delete(requestKey);
        return failure('CONFLICT', 'Another write is in progress.');
      }
      lockAcquired = policy.mutating && this.options.writeLock !== undefined;
      if (expectedRevision !== undefined && this.options.revision && this.options.revision.current() !== expectedRevision) {
        this.requests.delete(requestKey);
        return failure('STALE_REVISION', 'The data changed before this request could be applied.', { currentRevision: this.options.revision.current() });
      }
      const handler = this.handlers[operation];
      if (!handler) {
        this.requests.delete(requestKey);
        return failure('UNAVAILABLE', 'This operation is not configured.', undefined);
      }
      const context: HandlerContext = {
        actor,
        operation,
        idempotencyKey,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        now: this.options.clock?.() ?? new Date().toISOString()
      };
      const invoke = () => assertSynchronous(operation, handler(context, payload));
      const data = this.options.timing ? this.options.timing.derive(invoke) : invoke();
      let revision: number | undefined;
      if (policy.mutating && this.options.revision?.advance) revision = this.options.revision.advance(actor.user.id, operation);
      const response: ApiResponse<unknown> = revision === undefined ? { ok: true, data } : { ok: true, data, revision };
      this.requests.set(requestKey, { fingerprint: requestFingerprint, storedAt: Date.now(), response });
      if (this.options.timing) this.options.timing.succeeded = true;
      return response;
    } catch (error) {
      if (requestKey) this.requests.delete(requestKey);
      const mapped = mapUnknownError(error);
      return failure(mapped.code, mapped.message, mapped.details);
    } finally {
      if (lockAcquired) this.options.writeLock?.release();
    }
  }

  dispatchReadOnly(input: unknown): ApiResponse<unknown> {
    return this.dispatch(input, { readOnly: true });
  }

  clearIdempotency(): void {
    this.requests.clear();
  }

  isOperationMutating(operation: string): boolean {
    return operationPolicy(operation)?.mutating ?? false;
  }
}

export function createIntegrationDispatcher(options: IntegrationDispatcherOptions): IntegrationDispatcher {
  return new IntegrationDispatcher(options);
}

export type { IntegrationOperation };
