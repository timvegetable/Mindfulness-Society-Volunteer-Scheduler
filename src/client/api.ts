export const API_OPERATIONS = {
  me: 'session.me',
  volunteerDashboard: 'volunteer.dashboard',
  recurringAvailabilityUpdate: 'volunteer.availability.recurring.update',
  availabilityExceptionCreate: 'volunteer.availability.exception.create',
  assignmentCancel: 'volunteer.assignment.cancel',
  adminSchedule: 'admin.schedule.read',
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

export type OperationName = (typeof API_OPERATIONS)[keyof typeof API_OPERATIONS];

export const ALLOWED_OPERATIONS: Readonly<Record<OperationName, true>> = Object.fromEntries(
  Object.values(API_OPERATIONS).map((operation) => [operation, true])
) as Readonly<Record<OperationName, true>>;

export interface ApiClientConfig {
  appsScriptUrl?: string;
  maxPayloadBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface RequestEnvelope {
  operation: OperationName;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  expectedRevision?: number;
  credential?: string;
}

export interface RequestOptions {
  credential?: string;
  idempotencyKey?: string;
  expectedRevision?: number | string;
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  revision?: number | string;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
  };
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    options: { status?: number; retryable?: boolean; details?: unknown } = {}
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const FORBIDDEN_PAYLOAD_KEYS: Readonly<Record<string, true>> = {
  sheet: true,
  sheetname: true,
  range: true,
  a1range: true,
  spreadsheetid: true,
  gid: true,
  formula: true,
  query: true,
  sql: true
};

function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi?.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `client-${Date.now().toString(36)}-${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeExpectedRevision(value: number | string): number {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new ApiClientError('invalid_revision', 'Expected revision must be a non-negative integer.');
  }
  return normalized;
}

function validatePayloadShape(value: unknown, depth = 0): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ApiClientError('invalid_payload', 'Request payload must be an object.');
  }
  if (depth > 8) {
    throw new ApiClientError('invalid_payload', 'Request payload is nested too deeply.');
  }
  for (const [key, child] of Object.entries(value)) {
    if (Object.hasOwn(FORBIDDEN_PAYLOAD_KEYS, key.toLowerCase())) {
      throw new ApiClientError('invalid_payload', `Payload field ${key} is not supported.`);
    }
    if (isRecord(child)) validatePayloadShape(child, depth + 1);
    if (Array.isArray(child)) {
      for (const item of child) if (isRecord(item)) validatePayloadShape(item, depth + 1);
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorFromBody(body: unknown, status?: number): ApiClientError {
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === 'string' ? body.error.code : 'request_failed';
    const message = typeof body.error.message === 'string' ? body.error.message : 'The request failed.';
    return new ApiClientError(code, message, {
      status,
      retryable: body.error.retryable === true,
      details: body.error.details
    });
  }
  if (isRecord(body) && typeof body.message === 'string') {
    return new ApiClientError('request_failed', body.message, { status });
  }
  // A 401/403 carrying anything other than our JSON envelope comes from Google's
  // own web-app gate, not from the scheduling service: the deployment is not
  // published with access set to "Anyone".
  if (status === 401 || status === 403) {
    return new ApiClientError(
      'deployment_not_public',
      'The Apps Script web app rejected the request before it reached the scheduler. Publish the deployment with access set to "Anyone".',
      { status }
    );
  }
  return new ApiClientError(
    status && status >= 500 ? 'server_unavailable' : 'invalid_response',
    status && status >= 500 ? 'The scheduling service is temporarily unavailable.' : 'The scheduling service returned an invalid response.',
    { status, retryable: status === undefined || status >= 500 }
  );
}

function responseData<T>(body: unknown, status: number): T {
  if (!isRecord(body)) throw errorFromBody(body, status);
  if (body.ok === false || 'error' in body) throw errorFromBody(body, status);
  if (body.ok === true && 'data' in body) return body.data as T;
  if ('data' in body) return body.data as T;
  throw errorFromBody(body, status);
}

function parseIdentityData(value: unknown): IdentityData {
  if (!isRecord(value) || typeof value.email !== 'string' || !value.email.trim()) {
    throw new ApiClientError('invalid_response', 'The identity service returned an invalid profile.');
  }
  if (value.role !== 'volunteer' && value.role !== 'administrator' && value.role !== 'center-contact') {
    throw new ApiClientError('unauthorized', 'This account is not authorized for scheduling.');
  }
  const profile: IdentityData = { email: value.email, role: value.role };
  if (typeof value.name === 'string') profile.name = value.name;
  if (typeof value.volunteerId === 'string') profile.volunteerId = value.volunteerId;
  if (typeof value.centerId === 'string') profile.centerId = value.centerId;
  return profile;
}

function ensureUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new ApiClientError('invalid_configuration', 'The Apps Script URL must use HTTPS.');

    }
    return url.toString();
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    throw new ApiClientError('invalid_configuration', 'The Apps Script URL is invalid.');
  }
}
function exceptionRequest(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ApiClientError('invalid_payload', 'Exception payload must be an object.');
  const date = value.date;
  const kind = value.kind;
  const interval = isRecord(value.interval) ? value.interval : {
    start: value.start,
    end: value.end,
    timeZone: value.timeZone
  };
  if (typeof date !== 'string' || (kind !== 'available' && kind !== 'unavailable') || typeof interval.start !== 'string' || typeof interval.end !== 'string' || typeof interval.timeZone !== 'string') {
    throw new ApiClientError('invalid_payload', 'Exception payload is incomplete.');
  }
  const payload: Record<string, unknown> = { date, kind, interval };
  if (typeof value.id === 'string') payload.id = value.id;
  if (typeof value.reason === 'string' && value.reason.trim()) payload.reason = value.reason.trim();
  return payload;
}

/**
 * The only browser-side boundary for Apps Script calls. Operation names and
 * payloads are intentionally narrow; Sheet names, ranges, and formulas never
 * cross this boundary.
 */
export class ApiClient {
  readonly appsScriptUrl: string;
  readonly maxPayloadBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ApiClientConfig | string = {}) {
    const normalized = typeof config === 'string' ? { appsScriptUrl: config } : config;
    this.appsScriptUrl = ensureUrl(normalized.appsScriptUrl);
    this.maxPayloadBytes = normalized.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    if (!Number.isSafeInteger(this.maxPayloadBytes) || this.maxPayloadBytes < 1) {
      throw new ApiClientError('invalid_configuration', 'The payload limit must be a positive number.');
    }
    this.fetchImpl = normalized.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async request<T>(operation: OperationName, payload: unknown = {}, options: RequestOptions = {}): Promise<T> {
    if (!Object.hasOwn(ALLOWED_OPERATIONS, operation)) {
      throw new ApiClientError('invalid_operation', 'That operation is not available.');
    }
    if (!this.appsScriptUrl) {
      throw new ApiClientError('service_unavailable', 'The scheduling service is not configured.', { retryable: true });
    }
    validatePayloadShape(payload);
    if (options.credential !== undefined && !options.credential.trim()) {
      throw new ApiClientError('invalid_credential', 'A credential is required for this request.');
    }
    const envelope: RequestEnvelope = {
      operation,
      payload,
      idempotencyKey: options.idempotencyKey ?? newIdempotencyKey()
    };
    if (options.expectedRevision !== undefined) envelope.expectedRevision = normalizeExpectedRevision(options.expectedRevision);
    if (options.credential !== undefined) envelope.credential = options.credential;
    const body = JSON.stringify(envelope);
    const bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > this.maxPayloadBytes) {
      throw new ApiClientError('payload_too_large', 'This request is too large to submit.');
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.appsScriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8', Accept: 'application/json' },
        body,
        credentials: 'omit'
      });
    } catch {
      throw new ApiClientError(
        'network_error',
        'Unable to reach the scheduling service. If this persists, confirm the Apps Script deployment is published with "Who has access: Anyone" (an account-restricted deployment answers the browser with a sign-in page it cannot read).',
        { retryable: true }
      );
    }
    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok) throw errorFromBody(parsed, response.status);
    return responseData<T>(parsed, response.status);
  }

  me(credential: string): Promise<IdentityData> {
    return this.request<unknown>(API_OPERATIONS.me, {}, { credential }).then(parseIdentityData);
  }

  volunteerDashboard(credential: string): Promise<unknown> {
    return this.request(API_OPERATIONS.volunteerDashboard, {}, { credential });
  }

  updateRecurringAvailability(
    intervals: readonly unknown[],
    expectedRevision: number | string,
    credential: string
  ): Promise<unknown> {
    return this.request(API_OPERATIONS.recurringAvailabilityUpdate, { intervals }, { expectedRevision, credential });
  }

  createAvailabilityException(
    exception: unknown,
    expectedRevision: number | string,
    credential: string
  ): Promise<unknown> {
    return this.request(API_OPERATIONS.availabilityExceptionCreate, exceptionRequest(exception), { expectedRevision, credential });
  }

  cancelAssignment(
    assignmentId: string,
    reason: string,
    expectedRevision: number | string,
    credential: string
  ): Promise<unknown> {
    return this.request(API_OPERATIONS.assignmentCancel, { assignmentId, reason }, { expectedRevision, credential });
  }

  schedule(credential: string): Promise<unknown> {
    return this.request(API_OPERATIONS.adminSchedule, {}, { credential });
  }

  rerunSchedule(expectedRevision: number | string, credential: string): Promise<unknown> {
    return this.request(API_OPERATIONS.adminScheduleRerun, {}, { expectedRevision, credential });
  }

  importPreview(resultsCode: string, credential: string): Promise<unknown> {
    return this.request(API_OPERATIONS.adminImportPreview, { resultsCode }, { credential });
  }

  importPromote(resultsCode: string, expectedRevision: number | string, credential: string): Promise<unknown> {
    return this.request(API_OPERATIONS.adminImportPromote, { resultsCode }, { expectedRevision, credential });
  }

  importMappingUpsert(
    source: Readonly<{ sourceParticipantId?: string; sourceEmail?: string; sourceName?: string; volunteerId: string }>,
    expectedRevision: number | string,
    credential: string
  ): Promise<unknown> {
    return this.request(API_OPERATIONS.adminImportMappingUpsert, { ...source }, { expectedRevision, credential });
  }

  insights(credential: string): Promise<unknown> {
    return this.request(API_OPERATIONS.adminInsights, {}, { credential });
  }

  refreshInsights(expectedRevision: number | string, credential: string): Promise<unknown> {
    return this.request(API_OPERATIONS.adminInsightsRefresh, {}, { expectedRevision, credential });
  }

  centerCandidate(credential: string): Promise<unknown> {
    return this.request(API_OPERATIONS.centerCandidate, {}, { credential });
  }

  updateCenterCandidate(
    candidate: unknown,
    expectedRevision: number | string,
    credential: string
  ): Promise<unknown> {
    return this.request(API_OPERATIONS.centerCandidateUpdate, candidate, { expectedRevision, credential });
  }

  confirmCenterCandidate(
    candidateId: string,
    expectedRevision: number | string,
    credential: string
  ): Promise<unknown> {
    return this.request(API_OPERATIONS.adminCenterCandidateConfirm, { candidateId }, { expectedRevision, credential });
  }
}

export interface IdentityData {
  email: string;
  name?: string;
  role: 'volunteer' | 'administrator' | 'center-contact';
  volunteerId?: string;
  centerId?: string;
}
