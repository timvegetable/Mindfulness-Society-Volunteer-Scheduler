import { z } from 'zod';
import { ApiRequestSchema, type ApiResponse, type ErrorCode, type Role } from '../../shared/domain.js';
import { RepositoryError } from '../workbook/repository.js';
import {
  authenticateCredential,
  type AuthenticatedPrincipal,
  type TokenVerifier,
  type UserDirectory,
  AuthenticationError
} from './auth.js';

export const INTEGRATION_OPERATIONS = {
  me: 'session.me',
  volunteerDashboard: 'volunteer.dashboard',
  recurringAvailabilityUpdate: 'volunteer.availability.recurring.update',
  availabilityExceptionCreate: 'volunteer.availability.exception.create',
  assignmentCancel: 'volunteer.assignment.cancel',
  adminSchedule: 'admin.schedule.read',
  adminScheduleRerun: 'admin.schedule.rerun',
  adminImportPreview: 'admin.import.whenIsGood.preview',
  adminImportPromote: 'admin.import.whenIsGood.promote',
  adminInsights: 'admin.insights.read',
  adminInsightsRefresh: 'admin.insights.refresh',
  centerCandidate: 'center.candidate.read',
  centerCandidateUpdate: 'center.candidate.update',
  adminCenterCandidateConfirm: 'admin.center.candidate.confirm'
} as const;

export type IntegrationOperation = (typeof INTEGRATION_OPERATIONS)[keyof typeof INTEGRATION_OPERATIONS];
export const ALLOWED_INTEGRATION_OPERATIONS: ReadonlySet<string> = new Set(Object.values(INTEGRATION_OPERATIONS));

export type OperationPolicy = Readonly<{
  roles: readonly Role[];
  mutating: boolean;
  expectedRevision: boolean;
  readOnly: boolean;
  payload: z.ZodType<unknown>;
}>;

const emptyPayload = z.object({}).strict();
const id = z.string().min(1).max(200);
const text = z.string().max(500);
const importCode = z.string().min(1).max(200);
const interval = z.object({
  start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.string().min(1).max(100).regex(/^[A-Za-z0-9_+./-]+$/)
}).strict().superRefine((value, context) => {
  if (value.start >= value.end) context.addIssue({ code: 'custom', path: ['end'], message: 'end must be after start' });
});
const recurringInterval = interval.extend({ weekday: z.number().int().min(1).max(7) }).strict();
const exceptionPayload = z.object({
  id: id.optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(['unavailable', 'available']),
  interval,
  reason: text.optional()
}).strict();
const candidatePayload = z.object({
  candidateId: id.optional(),
  id: id.optional(),
  centerId: id.optional(),
  weekday: z.number().int().min(1).max(7).optional(),
  start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  timeZone: z.string().min(1).max(100).regex(/^[A-Za-z0-9_+./-]+$/).optional(),
  requestedStaffCount: z.number().int().min(0).max(2).optional(),
  status: z.enum(['draft', 'submitted', 'confirmed', 'rejected']).optional(),
  intervals: z.array(recurringInterval).max(100).optional()
}).strict().superRefine((value, context) => {
  if (value.start !== undefined && value.end !== undefined && value.start >= value.end) {
    context.addIssue({ code: 'custom', path: ['end'], message: 'end must be after start' });
  }
});

export const OPERATION_POLICIES: Readonly<Record<IntegrationOperation, OperationPolicy>> = {
  [INTEGRATION_OPERATIONS.me]: { roles: ['volunteer', 'administrator', 'center-contact'], mutating: false, expectedRevision: false, readOnly: true, payload: emptyPayload },
  [INTEGRATION_OPERATIONS.volunteerDashboard]: { roles: ['volunteer'], mutating: false, expectedRevision: false, readOnly: true, payload: emptyPayload },
  [INTEGRATION_OPERATIONS.recurringAvailabilityUpdate]: { roles: ['volunteer'], mutating: true, expectedRevision: true, readOnly: false, payload: z.object({ intervals: z.array(recurringInterval).max(100) }).strict() },
  [INTEGRATION_OPERATIONS.availabilityExceptionCreate]: { roles: ['volunteer'], mutating: true, expectedRevision: true, readOnly: false, payload: exceptionPayload },
  [INTEGRATION_OPERATIONS.assignmentCancel]: { roles: ['volunteer'], mutating: true, expectedRevision: true, readOnly: false, payload: z.object({ assignmentId: id, reason: text.optional() }).strict() },
  [INTEGRATION_OPERATIONS.adminSchedule]: { roles: ['administrator'], mutating: false, expectedRevision: false, readOnly: true, payload: emptyPayload },
  [INTEGRATION_OPERATIONS.adminScheduleRerun]: { roles: ['administrator'], mutating: true, expectedRevision: true, readOnly: false, payload: emptyPayload },
  [INTEGRATION_OPERATIONS.adminImportPreview]: { roles: ['administrator'], mutating: false, expectedRevision: false, readOnly: true, payload: z.object({ resultsCode: importCode }).strict() },
  [INTEGRATION_OPERATIONS.adminImportPromote]: { roles: ['administrator'], mutating: true, expectedRevision: true, readOnly: false, payload: z.object({ resultsCode: importCode }).strict() },
  [INTEGRATION_OPERATIONS.adminInsights]: { roles: ['administrator'], mutating: false, expectedRevision: false, readOnly: true, payload: emptyPayload },
  [INTEGRATION_OPERATIONS.adminInsightsRefresh]: { roles: ['administrator'], mutating: true, expectedRevision: true, readOnly: false, payload: emptyPayload },
  [INTEGRATION_OPERATIONS.centerCandidate]: { roles: ['administrator', 'center-contact'], mutating: false, expectedRevision: false, readOnly: true, payload: emptyPayload },
  [INTEGRATION_OPERATIONS.centerCandidateUpdate]: { roles: ['administrator', 'center-contact'], mutating: true, expectedRevision: true, readOnly: false, payload: candidatePayload },
  [INTEGRATION_OPERATIONS.adminCenterCandidateConfirm]: { roles: ['administrator'], mutating: true, expectedRevision: true, readOnly: false, payload: z.object({ candidateId: id }).strict() }
};

export type IntegrationErrorDetails = Record<string, unknown>;

export class IntegrationError extends Error {
  readonly code: ErrorCode;
  readonly details?: IntegrationErrorDetails;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, details?: IntegrationErrorDetails, retryable = false) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

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

export type OperationHandler = (context: HandlerContext, payload: unknown) => unknown | Promise<unknown>;
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
}>;

type StoredRequest = Readonly<{ fingerprint: string; storedAt: number; response?: ApiResponse<unknown> }>;

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 1000;
const DANGEROUS_KEYS = new Set(['sheet', 'sheetname', 'range', 'a1range', 'spreadsheetid', 'gid', 'formula', 'query', 'sql']);
const REQUEST_KEYS = new Set(['operation', 'payload', 'idempotencyKey', 'expectedRevision', 'credential']);

function failure(code: ErrorCode, message: string, details?: IntegrationErrorDetails): ApiResponse<never> {
  const error: { code: ErrorCode; message: string; details?: IntegrationErrorDetails } = { code, message };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}

function payloadBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return Number.POSITIVE_INFINITY;
  if (typeof globalThis.TextEncoder === 'function') return new TextEncoder().encode(encoded).byteLength;
  return encodeURIComponent(encoded).replace(/%[0-9A-F]{2}|./g, 'x').length;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function fingerprint(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectDangerousKeys(value: unknown, depth = 0): void {
  if (depth > 12) throw new IntegrationError('INVALID_REQUEST', 'Request payload is nested too deeply.');
  if (Array.isArray(value)) {
    for (const item of value) rejectDangerousKeys(item, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key.toLowerCase())) throw new IntegrationError('INVALID_REQUEST', `Payload field ${key} is not supported.`);
    rejectDangerousKeys(child, depth + 1);
  }
}

function mapUnknownError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  if (error instanceof RepositoryError) return new IntegrationError(error.code, error.message, undefined, error.code === 'CONFLICT');
  if (error instanceof AuthenticationError) return new IntegrationError('UNAUTHORIZED', 'Authentication is required.');
  if (error instanceof z.ZodError) return new IntegrationError('INVALID_REQUEST', 'Request validation failed.', { issues: error.issues });
  return new IntegrationError('INTERNAL_ERROR', 'The scheduling service could not complete the request.', undefined, true);
}

function isAllowedOperation(value: string): value is IntegrationOperation {
  return ALLOWED_INTEGRATION_OPERATIONS.has(value);
}

function assertRequestKeys(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (!REQUEST_KEYS.has(key)) throw new IntegrationError('INVALID_REQUEST', `Request field ${key} is not supported.`);
  }
}

function expectedRevisionFrom(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new IntegrationError('INVALID_REQUEST', 'expectedRevision must be a non-negative integer.');
  }
  return value;
}

function enforceCenterCandidateBoundary(operation: IntegrationOperation, actor: AuthenticatedPrincipal, payload: unknown): void {
  if (operation !== INTEGRATION_OPERATIONS.centerCandidateUpdate || actor.user.roles.includes('administrator')) return;
  if (!actor.user.roles.includes('center-contact')) throw new IntegrationError('FORBIDDEN', 'Center-contact access is required.');
  if (!isRecord(payload)) return;
  if (payload.status === 'confirmed') throw new IntegrationError('FORBIDDEN', 'Only administrators can confirm a candidate schedule.');
  if (typeof payload.centerId === 'string' && !actor.user.centerIds?.includes(payload.centerId)) {
    throw new IntegrationError('FORBIDDEN', 'The candidate must belong to your center.');
  }
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

  async dispatch(input: unknown, options: Readonly<{ readOnly?: boolean }> = {}): Promise<ApiResponse<unknown>> {
    this.pruneIdempotency(Date.now());
    let operation: IntegrationOperation | undefined;
    let lockAcquired = false;
    let requestKey: string | undefined;
    try {
      if (payloadBytes(input) > (this.options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES)) {
        return failure('PAYLOAD_TOO_LARGE', 'The request payload is too large.');
      }
      if (!isRecord(input)) return failure('INVALID_REQUEST', 'Request must be a JSON object.');
      assertRequestKeys(input);
      rejectDangerousKeys(input.payload);
      const parsedRequest = ApiRequestSchema.strict().parse(input);
      if (!isAllowedOperation(parsedRequest.operation)) return failure('INVALID_REQUEST', 'That operation is not available.');
      operation = parsedRequest.operation;
      const policy = OPERATION_POLICIES[operation];
      if (options.readOnly && !policy.readOnly) return failure('FORBIDDEN', 'This operation is not available through a read-only request.');
      if (parsedRequest.payload === null || typeof parsedRequest.payload !== 'object' || Array.isArray(parsedRequest.payload)) {
        return failure('INVALID_REQUEST', 'Request payload must be an object.');
      }
      const payloadResult = policy.payload.safeParse(parsedRequest.payload);
      if (!payloadResult.success) return failure('INVALID_REQUEST', 'Request payload is invalid.', { issues: payloadResult.error.issues });
      const actor = await authenticateCredential(parsedRequest.credential, this.options.verifier, this.options.users);
      if (!policy.roles.some((role) => actor.user.roles.includes(role))) return failure('FORBIDDEN', 'Your account is not authorized for this operation.');
      enforceCenterCandidateBoundary(operation, actor, payloadResult.data);
      const expectedRevision = expectedRevisionFrom(parsedRequest.expectedRevision);
      if (policy.mutating && (!this.options.revision || !this.options.writeLock)) return failure('UNAVAILABLE', 'State-changing operations are not configured.');
      requestKey = `${actor.user.id}:${operation}:${parsedRequest.idempotencyKey}`;
      const requestFingerprint = fingerprint({ operation, payload: payloadResult.data, expectedRevision });
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
        idempotencyKey: parsedRequest.idempotencyKey,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        now: this.options.clock?.() ?? new Date().toISOString()
      };
      const data = await handler(context, payloadResult.data);
      let revision: number | undefined;
      if (policy.mutating && this.options.revision?.advance) revision = this.options.revision.advance(actor.user.id, operation);
      const response: ApiResponse<unknown> = revision === undefined ? { ok: true, data } : { ok: true, data, revision };
      this.requests.set(requestKey, { fingerprint: requestFingerprint, storedAt: Date.now(), response });
      return response;
    } catch (error) {
      if (requestKey) this.requests.delete(requestKey);
      const mapped = mapUnknownError(error);
      return failure(mapped.code, mapped.message, mapped.details);
    } finally {
      if (lockAcquired) this.options.writeLock?.release();
    }
  }

  dispatchReadOnly(input: unknown): Promise<ApiResponse<unknown>> {
    return this.dispatch(input, { readOnly: true });
  }

  clearIdempotency(): void {
    this.requests.clear();
  }

  isOperationMutating(operation: string): boolean {
    return isAllowedOperation(operation) && OPERATION_POLICIES[operation].mutating;
  }
}

export function createIntegrationDispatcher(options: IntegrationDispatcherOptions): IntegrationDispatcher {
  return new IntegrationDispatcher(options);
}

export function operationPolicy(operation: string): OperationPolicy | undefined {
  return isAllowedOperation(operation) ? OPERATION_POLICIES[operation] : undefined;
}
