import type {
  ApiError,
  Assignment,
  AvailabilityException,
  Backup,
  RecurringAvailability,
  Role,
  Session,
  Volunteer
} from '../../shared/domain.js';
import type { AuditEntry, RevisionedRepository, RevisionState } from '../workbook/repository.js';

export type ServiceSuccess<T> = { ok: true; data: T; revision?: number };
export type ServiceFailure = { ok: false; error: ApiError };
export type ServiceResult<T> = ServiceSuccess<T> | ServiceFailure;

export type Caller = {
  id: string;
  volunteerId?: string;
  roles?: readonly Role[];
  active?: boolean;
};

export type RecurringAvailabilityRecord = RecurringAvailability & {
  id: string;
  volunteerId: string;
  revision: number;
  source?: string;
  updatedAt?: string;
};

export type NotificationKind = 'recurring-availability' | 'availability-exception' | 'assignment-cancellation' | 'understaffed';
export type NotificationDeliveryStatus = 'pending' | 'sent' | 'failed';

export type NotificationStatusRecord = {
  id: string;
  kind: NotificationKind;
  entityId: string;
  recipients: string[];
  subject: string;
  body: string;
  status: NotificationDeliveryStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  actorId: string;
  lastError?: string;
};

export type NotificationMessage = {
  to: readonly string[];
  subject: string;
  body: string;
};

export type Mailer = {
  send(message: NotificationMessage): void;
};

export type Clock = { now(): string };
export type IdGenerator = { next(prefix: string): string };
export type TransactionRunner = <T>(action: () => T) => T;

export type ScheduleStaleReason = 'recurring-availability' | 'availability-exception';
export type ScheduleStaleState = {
  stale: boolean;
  markedAt: string;
  markedBy: string;
  reason: ScheduleStaleReason;
  volunteerId: string;
  sourceRevision: number;
};

export type ScheduleStalenessStore = {
  markStale(state: ScheduleStaleState): void;
  getStatus?(): ScheduleStaleState | undefined;
};

export type SelfServiceRepositories = {
  recurringAvailability?: RevisionedRepository<RecurringAvailabilityRecord>;
  volunteers?: RevisionedRepository<Volunteer>;
  exceptions?: RevisionedRepository<AvailabilityException>;
  sessions?: RevisionedRepository<Session>;
  assignments?: RevisionedRepository<Assignment>;
  backups?: RevisionedRepository<Backup>;
  notifications?: RevisionedRepository<NotificationStatusRecord>;
  audits?: { append(entry: AuditEntry): void };
};

export type AdministratorRecipients = readonly string[] | (() => readonly string[]);

export const systemClock: Clock = { now: () => new Date().toISOString() };

class DefaultIdGenerator implements IdGenerator {
  next(prefix: string): string {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi?.randomUUID) return `${prefix}-${cryptoApi.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export const defaultIdGenerator: IdGenerator = new DefaultIdGenerator();

export function failure(code: ApiError['code'], message: string, details?: Record<string, unknown>): ServiceFailure {
  const error: ApiError = details === undefined ? { code, message } : { code, message, details };
  return { ok: false, error };
}

export function success<T>(data: T, revision?: number): ServiceSuccess<T> {
  return revision === undefined ? { ok: true, data } : { ok: true, data, revision };
}

export function repositoryFailure(error: unknown, fallback = 'Unable to save the change'): ServiceFailure {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: ApiError['code'] }).code;
    if (code) return failure(code, error instanceof Error ? error.message : fallback);
  }
  return failure('INTERNAL_ERROR', error instanceof Error ? error.message : fallback);
}

export function resolveRecipients(recipients: AdministratorRecipients | undefined): string[] {
  const value = typeof recipients === 'function' ? recipients() : recipients;
  return [...new Set((value ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

export function isAdministrator(caller: Caller): boolean {
  return caller.active !== false && caller.roles?.includes('administrator') === true;
}

export function authorizeVolunteer(caller: Caller, volunteerId: string): ServiceFailure | undefined {
  if (caller.active === false) return failure('UNAUTHORIZED', 'Caller is not active');
  if (!caller.volunteerId || caller.volunteerId !== volunteerId) return failure('FORBIDDEN', 'Volunteer data belongs to the signed-in volunteer');
  if (caller.roles && !caller.roles.includes('volunteer')) return failure('FORBIDDEN', 'Volunteer role is required');
  return undefined;
}

export function repositoryRevision(repository: { revision(): RevisionState }): number {
  return repository.revision().number;
}

export function appendAudit(repositories: SelfServiceRepositories, entry: AuditEntry): void {
  repositories.audits?.append(entry);
}

export function serializeAuditValue(value: unknown): unknown {
  return value === undefined ? null : value;
}

export function isValidEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}
