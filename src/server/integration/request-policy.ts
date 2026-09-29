import { z } from 'zod';
import { ApiRequestSchema, type ApiResponse, type ErrorCode, type Role } from '../../shared/domain.js';
import { RepositoryError } from '../workbook/repository.js';
import { utf8ByteLength } from '../../shared/utf8.js';
import { AuthenticationError } from './auth.js';

/**
 * Transport-independent request policy: the operation registry, the payload
 * schemas, the envelope rejection rules and the shared failure envelopes.
 *
 * It is deliberately free of any runtime global so both the synchronous Apps
 * Script dispatcher and the asynchronous Worker composition validate a request
 * the same way. `dispatcher.ts` re-exports everything here that it exported
 * before this module existed, so existing importers are unchanged.
 */

export const INTEGRATION_OPERATIONS = {
  me: 'session.me',
  volunteerDashboard: 'volunteer.dashboard',
  recurringAvailabilityUpdate: 'volunteer.availability.recurring.update',
  availabilityExceptionCreate: 'volunteer.availability.exception.create',
  assignmentCancel: 'volunteer.assignment.cancel',
  adminSchedule: 'admin.schedule.read',
  adminSchedulePreview: 'admin.schedule.preview',
  adminScheduleRerun: 'admin.schedule.rerun',
  adminImportPreview: 'admin.import.whenIsGood.preview',
  adminImportPromote: 'admin.import.whenIsGood.promote',
  adminImportMappingUpsert: 'admin.import.mapping.upsert',
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

const sourceMappingPayload = z.object({
  sourceParticipantId: z.string().min(1).max(200).optional(),
  sourceEmail: z.string().email().max(200).optional(),
  sourceName: z.string().min(1).max(200).optional(),
  volunteerId: id
}).strict().superRefine((value, context) => {
  if (!value.sourceParticipantId && !value.sourceEmail && !value.sourceName) {
    context.addIssue({ code: 'custom', path: ['sourceParticipantId'], message: 'At least one source identity field is required' });
  }
});

export const OPERATION_POLICIES: Readonly<Record<IntegrationOperation, OperationPolicy>> = {
  [INTEGRATION_OPERATIONS.me]: { roles: ['volunteer', 'administrator', 'center-contact'], mutating: false, expectedRevision: false, readOnly: true, payload: emptyPayload },
  [INTEGRATION_OPERATIONS.volunteerDashboard]: { roles: ['volunteer'], mutating: false, expectedRevision: false, readOnly: true, payload: emptyPayload },
  [INTEGRATION_OPERATIONS.recurringAvailabilityUpdate]: { roles: ['volunteer'], mutating: true, expectedRevision: true, readOnly: false, payload: z.object({ intervals: z.array(recurringInterval).max(100) }).strict() },
  [INTEGRATION_OPERATIONS.availabilityExceptionCreate]: { roles: ['volunteer'], mutating: true, expectedRevision: true, readOnly: false, payload: exceptionPayload },
  [INTEGRATION_OPERATIONS.assignmentCancel]: { roles: ['volunteer'], mutating: true, expectedRevision: true, readOnly: false, payload: z.object({ assignmentId: id, reason: text.optional() }).strict() },
  [INTEGRATION_OPERATIONS.adminSchedule]: { roles: ['administrator'], mutating: false, expectedRevision: false, readOnly: true, payload: emptyPayload },
  [INTEGRATION_OPERATIONS.adminSchedulePreview]: { roles: ['administrator'], mutating: false, expectedRevision: false, readOnly: true, payload: emptyPayload },
  [INTEGRATION_OPERATIONS.adminScheduleRerun]: { roles: ['administrator'], mutating: true, expectedRevision: true, readOnly: false, payload: emptyPayload },
  [INTEGRATION_OPERATIONS.adminImportPreview]: { roles: ['administrator'], mutating: true, expectedRevision: true, readOnly: false, payload: z.object({ resultsCode: importCode }).strict() },
  [INTEGRATION_OPERATIONS.adminImportPromote]: { roles: ['administrator'], mutating: true, expectedRevision: true, readOnly: false, payload: z.object({ resultsCode: importCode }).strict() },
  [INTEGRATION_OPERATIONS.adminImportMappingUpsert]: { roles: ['administrator'], mutating: true, expectedRevision: true, readOnly: false, payload: sourceMappingPayload },
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

export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DANGEROUS_KEYS = new Set(['sheet', 'sheetname', 'range', 'a1range', 'spreadsheetid', 'gid', 'formula', 'query', 'sql']);
const REQUEST_KEYS = new Set(['operation', 'payload', 'idempotencyKey', 'expectedRevision', 'credential']);

export function failure(code: ErrorCode, message: string, details?: IntegrationErrorDetails): ApiResponse<never> {
  const error: { code: ErrorCode; message: string; details?: IntegrationErrorDetails } = { code, message };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}

export function payloadBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return Number.POSITIVE_INFINITY;
  return utf8ByteLength(encoded);
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rejectDangerousKeys(value: unknown, depth = 0): void {
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

export function assertRequestKeys(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (!REQUEST_KEYS.has(key)) throw new IntegrationError('INVALID_REQUEST', `Request field ${key} is not supported.`);
  }
}

export function expectedRevisionFrom(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new IntegrationError('INVALID_REQUEST', 'expectedRevision must be a non-negative integer.');
  }
  return value;
}

export function mapUnknownError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  if (error instanceof RepositoryError) return new IntegrationError(error.code, error.message, undefined, error.code === 'CONFLICT');
  if (error instanceof AuthenticationError) {
    // The caller is the account being rejected, so naming the reason is what lets
    // an operator diagnose a misconfigured deployment without server log access.
    const details: IntegrationErrorDetails = { reason: error.reason };
    if (error.detail !== undefined) details.detail = error.detail;
    return new IntegrationError('UNAUTHORIZED', 'Authentication is required.', details);
  }
  if (error instanceof z.ZodError) return new IntegrationError('INVALID_REQUEST', 'Request validation failed.', { issues: error.issues });
  return new IntegrationError('INTERNAL_ERROR', 'The scheduling service could not complete the request.', undefined, true);
}

export function isAllowedOperation(value: string): value is IntegrationOperation {
  return ALLOWED_INTEGRATION_OPERATIONS.has(value);
}

export function operationPolicy(operation: string): OperationPolicy | undefined {
  return isAllowedOperation(operation) ? OPERATION_POLICIES[operation] : undefined;
}

export function enforceCenterCandidateBoundary(operation: IntegrationOperation, actor: { user: { roles: readonly Role[]; centerIds?: readonly string[] } }, payload: unknown): void {
  if (operation !== INTEGRATION_OPERATIONS.centerCandidateUpdate || actor.user.roles.includes('administrator')) return;
  if (!actor.user.roles.includes('center-contact')) throw new IntegrationError('FORBIDDEN', 'Center-contact access is required.');
  if (!isRecord(payload)) return;
  if (payload.status === 'confirmed') throw new IntegrationError('FORBIDDEN', 'Only administrators can confirm a candidate schedule.');
  if (typeof payload.centerId === 'string' && !actor.user.centerIds?.includes(payload.centerId)) {
    throw new IntegrationError('FORBIDDEN', 'The candidate must belong to your center.');
  }
}

export type ValidatedRequest = Readonly<{
  operation: IntegrationOperation;
  policy: OperationPolicy;
  /** Schema-validated payload, safe to hand to a handler. */
  payload: unknown;
  /** Raw expectedRevision; validated by `expectedRevisionFrom` at the call site. */
  expectedRevision: unknown;
  idempotencyKey: string;
  /** Absent when the caller sent no credential; authentication rejects that. */
  credential: string | undefined;
  requestFingerprint: string;
}>;

export type EnvelopeValidation =
  | { ok: true; value: ValidatedRequest }
  | { ok: false; response: ApiResponse<never> };

/**
 * The transport-independent half of `IntegrationDispatcher.dispatch`: size,
 * envelope keys, arbitrary-access rejection, operation allowlist, read-only
 * policy and payload schema — in the same order and with the same failure
 * envelopes, so a runtime that must authorize or fetch before dispatch can run
 * this gate first without changing what a caller observes.
 *
 * Authentication, role policy, idempotency, revision comparison and handler
 * invocation remain in the dispatcher.
 */
export function validateRequestEnvelope(
  input: unknown,
  options: Readonly<{ readOnly?: boolean; maxPayloadBytes?: number }> = {}
): EnvelopeValidation {
  try {
    const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    if (payloadBytes(input) > maxPayloadBytes) {
      return { ok: false, response: failure('PAYLOAD_TOO_LARGE', 'The request payload is too large.') };
    }
    if (!isRecord(input)) return { ok: false, response: failure('INVALID_REQUEST', 'Request must be a JSON object.') };
    assertRequestKeys(input);
    rejectDangerousKeys(input.payload);
    const parsedRequest = ApiRequestSchema.strict().parse(input);
    if (!isAllowedOperation(parsedRequest.operation)) {
      return { ok: false, response: failure('INVALID_REQUEST', 'That operation is not available.') };
    }
    const operation = parsedRequest.operation;
    const policy = OPERATION_POLICIES[operation];
    if (options.readOnly && !policy.readOnly) {
      return { ok: false, response: failure('FORBIDDEN', 'This operation is not available through a read-only request.') };
    }
    if (parsedRequest.payload === null || typeof parsedRequest.payload !== 'object' || Array.isArray(parsedRequest.payload)) {
      return { ok: false, response: failure('INVALID_REQUEST', 'Request payload must be an object.') };
    }
    const payloadResult = policy.payload.safeParse(parsedRequest.payload);
    if (!payloadResult.success) {
      return { ok: false, response: failure('INVALID_REQUEST', 'Request payload is invalid.', { issues: payloadResult.error.issues }) };
    }
    return {
      ok: true,
      value: {
        operation,
        policy,
        payload: payloadResult.data,
        expectedRevision: parsedRequest.expectedRevision,
        idempotencyKey: parsedRequest.idempotencyKey,
        credential: parsedRequest.credential,
        requestFingerprint: fingerprint({ operation, payload: payloadResult.data, expectedRevision: parsedRequest.expectedRevision })
      }
    };
  } catch (error) {
    const mapped = mapUnknownError(error);
    return { ok: false, response: failure(mapped.code, mapped.message, mapped.details) };
  }
}
