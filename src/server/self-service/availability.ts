import { Temporal } from '@js-temporal/polyfill';
import { AvailabilityExceptionSchema, DateSchema, RecurringAvailabilitySchema, TimeZoneSchema, type AvailabilityException, type RecurringAvailability, type Volunteer } from '../../shared/domain.js';
import { effectiveIntervalsForDate, normalizeIntervals } from '../../shared/time.js';
import type { AuditEntry, RevisionState, RevisionedRepository } from '../workbook/repository.js';
import {
  appendAudit,
  authorizeVolunteer,
  defaultIdGenerator,
  failure,
  type AdministratorRecipients,
  type Caller,
  type Clock,
  type IdGenerator,
  repositoryFailure,
  repositoryRevision,
  serializeAuditValue,
  success,
  systemClock,
  type RecurringAvailabilityRecord,
  type ScheduleStaleReason,
  type ScheduleStaleState,
  type ScheduleStalenessStore,
  type SelfServiceRepositories,
  type ServiceResult,
  type TransactionRunner
} from './types.js';
import { NotificationService, type NotificationServiceDependencies } from './notifications.js';
import type { NotificationStatusRecord } from './types.js';

export type RecurringAvailabilityInput = Pick<RecurringAvailability, 'weekday' | 'start' | 'end' | 'timeZone'>;

export type ReplaceRecurringAvailabilityRequest = {
  volunteerId?: string;
  availability?: readonly RecurringAvailabilityInput[];
  intervals?: readonly RecurringAvailabilityInput[];
  expectedRevision?: number;
  expectedVolunteerRevision?: number;
};

export type AvailabilityUpdateData = {
  volunteerId: string;
  availability: RecurringAvailabilityRecord[];
  changedAt: string;
  staleMarked: boolean;
  notification?: NotificationStatusRecord;
};

export type AvailabilityExceptionInput = {
  volunteerId?: string;
  date: string;
  kind: AvailabilityException['kind'];
  interval: AvailabilityException['interval'];
  reason?: string;
  expectedRevision?: number;
};

export type AvailabilityExceptionData = {
  exception: AvailabilityException;
  changedAt: string;
  staleMarked: boolean;
  notification?: NotificationStatusRecord;
};

export type AvailabilityServiceDependencies = {
  recurringAvailability?: RevisionedRepository<RecurringAvailabilityRecord>;
  volunteers?: RevisionedRepository<Volunteer>;
  exceptions?: RevisionedRepository<AvailabilityException>;
  repositories?: SelfServiceRepositories;
  staleness?: ScheduleStalenessStore;
  notificationService?: NotificationService;
  mailer?: NotificationServiceDependencies['mailer'];
  administratorRecipients?: AdministratorRecipients;
  clock?: Clock;
  idGenerator?: IdGenerator;
  transaction?: TransactionRunner;
  configuredTimeZone?: string;
};

function validTimeZone(timeZone: string): boolean {
  if (!TimeZoneSchema.safeParse(timeZone).success) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function validDate(date: string): boolean {
  if (!DateSchema.safeParse(date).success) return false;
  try {
    Temporal.PlainDate.from(date);
    return true;
  } catch {
    return false;
  }
}


function recordMatchesInput(record: RecurringAvailabilityRecord, volunteerId: string, input: RecurringAvailabilityInput): boolean {
  return record.volunteerId === volunteerId && record.weekday === input.weekday && record.start === input.start && record.end === input.end && record.timeZone === input.timeZone;
}

function makeAudit(id: string, actorId: string, action: string, source: string, timestamp: string, before: unknown, after: unknown): AuditEntry {
  return { id, entity: 'recurring-availability', entityId: id, action, source, actorId, timestamp, before: serializeAuditValue(before), after: serializeAuditValue(after) };
}

function notificationBody(volunteerId: string, availability: readonly RecurringAvailabilityRecord[], action: string): string {
  const summary = availability.map((item) => `day ${item.weekday} ${item.start}-${item.end} (${item.timeZone})`).join(', ') || 'no weekly intervals';
  return `${action} for volunteer ${volunteerId}. New recurring availability: ${summary}. An administrator scheduling rerun is required.`;
}

/** Volunteer-owned recurring availability and dated exception mutations. */
export class VolunteerAvailabilityService {
  private readonly recurringAvailability: RevisionedRepository<RecurringAvailabilityRecord> | undefined;
  private readonly volunteers: RevisionedRepository<Volunteer> | undefined;
  private readonly exceptions: RevisionedRepository<AvailabilityException> | undefined;
  private readonly repositories: SelfServiceRepositories;
  private readonly staleness: ScheduleStalenessStore;
  private readonly notifications: NotificationService | undefined;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly transaction: TransactionRunner;
  private readonly configuredTimeZone: string | undefined;

  constructor(dependencies: AvailabilityServiceDependencies) {
    this.recurringAvailability = dependencies.recurringAvailability ?? dependencies.repositories?.recurringAvailability;
    this.volunteers = dependencies.volunteers ?? dependencies.repositories?.volunteers;
    this.exceptions = dependencies.exceptions ?? dependencies.repositories?.exceptions;
    this.repositories = dependencies.repositories ?? {
      recurringAvailability: this.recurringAvailability,
      volunteers: this.volunteers,
      exceptions: this.exceptions
    };
    this.staleness = dependencies.staleness ?? new MemoryScheduleStalenessStore();
    this.clock = dependencies.clock ?? systemClock;
    this.idGenerator = dependencies.idGenerator ?? defaultIdGenerator;
    this.transaction = dependencies.transaction ?? ((action) => action());
    this.configuredTimeZone = dependencies.configuredTimeZone;

    if (dependencies.notificationService) {
      this.notifications = dependencies.notificationService;
    } else if (dependencies.mailer || dependencies.administratorRecipients || dependencies.repositories?.notifications) {
      const notificationDependencies: NotificationServiceDependencies = {
        mailer: dependencies.mailer,
        administratorRecipients: dependencies.administratorRecipients,
        clock: this.clock,
        idGenerator: this.idGenerator,
        repository: dependencies.repositories?.notifications
      };
      this.notifications = new NotificationService(notificationDependencies);
    }
  }

  currentRecurringAvailability(caller: Caller): ServiceResult<RecurringAvailabilityRecord[]> {
    const volunteerId = caller.volunteerId;
    if (!volunteerId) return failure('FORBIDDEN', 'A linked volunteer identity is required');
    const denied = authorizeVolunteer(caller, volunteerId);
    if (denied) return denied;
    try {
      if (!this.isActiveVolunteer(volunteerId)) return failure('FORBIDDEN', 'Volunteer is not active');
      const records = this.readRecurring(volunteerId);
      return success(records.map((record) => ({ ...record })));
    } catch (error) {
      return repositoryFailure(error, 'Unable to read recurring availability');
    }
  }

  replaceRecurringAvailability(caller: Caller, request: ReplaceRecurringAvailabilityRequest): ServiceResult<AvailabilityUpdateData> {
    const volunteerId = caller.volunteerId;
    if (!volunteerId) return failure('FORBIDDEN', 'A linked volunteer identity is required');
    const denied = authorizeVolunteer(caller, volunteerId);
    if (denied) return denied;
    if (request.volunteerId !== undefined && request.volunteerId !== volunteerId) return failure('FORBIDDEN', 'Volunteer data belongs to the signed-in volunteer');
    if (request.expectedRevision === undefined) return failure('INVALID_REQUEST', 'expectedRevision is required');
    const expectedRevision = request.expectedRevision;
    const input = request.availability ?? request.intervals;
    if (!input) return failure('INVALID_REQUEST', 'availability is required');

    const validation = this.validateRecurring(input);
    if (!validation.ok) return validation;
    const availability = validation.data;
    try {
      if (!this.isActiveVolunteer(volunteerId)) return failure('FORBIDDEN', 'Volunteer is not active');
      const revisionRepository = this.recurringAvailability ?? this.volunteers;
      if (!revisionRepository) return failure('UNAVAILABLE', 'Recurring availability repository is not configured');
      if (revisionRepository.revision().number !== expectedRevision) return failure('STALE_REVISION', 'Availability changed; refresh before saving');
      const oldRecords = this.readRecurring(volunteerId);
      const allRecords = this.recurringAvailability?.list() ?? [];
      const replacement = availability.map((item) => {
        const existing = oldRecords.find((record) => recordMatchesInput(record, volunteerId, item));
        const base: RecurringAvailabilityRecord = {
          id: existing?.id ?? this.idGenerator.next('recurring-availability'),
          volunteerId,
          ...item,
          revision: expectedRevision + 1,
          source: 'self-service',
          updatedAt: this.clock.now()
        };
        return base;
      });
      const retained = allRecords.filter((record) => record.volunteerId !== volunteerId);
      const nextRows = [...retained, ...replacement];
      const timestamp = this.clock.now();
      const commit = this.transaction(() => this.persistRecurring(replacement, nextRows, volunteerId, expectedRevision, request.expectedVolunteerRevision));
      const staleMarked = this.markStale(volunteerId, commit.revision.number, 'recurring-availability', caller.id, timestamp);
      const notification = this.notifyAvailability(volunteerId, replacement, caller.id, timestamp, 'recurring-availability');
      const data: AvailabilityUpdateData = { volunteerId, availability: replacement.map((record) => ({ ...record })), changedAt: timestamp, staleMarked };
      if (notification) data.notification = notification;
      return success(data, commit.revision.number);
    } catch (error) {
      return repositoryFailure(error, 'Unable to save recurring availability');
    }
  }

  /** Short alias used by API adapters. */
  replaceAvailability(caller: Caller, request: ReplaceRecurringAvailabilityRequest): ServiceResult<AvailabilityUpdateData> {
    return this.replaceRecurringAvailability(caller, request);
  }

  recordException(caller: Caller, request: AvailabilityExceptionInput): ServiceResult<AvailabilityExceptionData> {
    const volunteerId = caller.volunteerId;
    if (!volunteerId) return failure('FORBIDDEN', 'A linked volunteer identity is required');
    const denied = authorizeVolunteer(caller, volunteerId);
    if (denied) return denied;
    if (request.volunteerId !== undefined && request.volunteerId !== volunteerId) return failure('FORBIDDEN', 'Volunteer data belongs to the signed-in volunteer');
    if (request.expectedRevision === undefined) return failure('INVALID_REQUEST', 'expectedRevision is required');
    if (!validDate(request.date)) return failure('INVALID_REQUEST', 'date must be a valid calendar date');
    const parsed = AvailabilityExceptionSchema.safeParse({
      id: 'pending', volunteerId, date: request.date, kind: request.kind, interval: request.interval,
      ...(request.reason === undefined ? {} : { reason: request.reason }), revision: request.expectedRevision
    });
    if (!parsed.success) return failure('INVALID_REQUEST', 'Exception interval is invalid', { issues: parsed.error.issues });
    if (!validTimeZone(parsed.data.interval.timeZone)) return failure('INVALID_REQUEST', 'Unknown time zone');
    if (this.configuredTimeZone && parsed.data.interval.timeZone !== this.configuredTimeZone) return failure('INVALID_REQUEST', 'Availability must use the configured time zone');

    try {
      if (!this.isActiveVolunteer(volunteerId)) return failure('FORBIDDEN', 'Volunteer is not active');
      const id = this.idGenerator.next('availability-exception');
      const exception: AvailabilityException = { ...parsed.data, id };
      const timestamp = this.clock.now();
      const commit = this.transaction(() => this.persistException(exception, request.expectedRevision as number, caller.id));
      const staleMarked = this.markStale(volunteerId, commit.number, 'availability-exception', caller.id, timestamp);
      const notification = this.notifyException(exception, caller.id, timestamp);
      const data: AvailabilityExceptionData = { exception: { ...exception }, changedAt: timestamp, staleMarked };
      if (notification) data.notification = notification;
      return success(data, commit.number);
    } catch (error) {
      return repositoryFailure(error, 'Unable to save availability exception');
    }
  }

  addAvailabilityException(caller: Caller, request: AvailabilityExceptionInput): ServiceResult<AvailabilityExceptionData> {
    return this.recordException(caller, request);
  }

  /** Returns effective intervals with dated exceptions overlaid on recurring intervals. */
  effectiveAvailability(volunteerId: string, date: string, timeZone: string): RecurringAvailability[] {
    const recurring = this.readRecurring(volunteerId);
    const exceptions = this.exceptions?.list().filter((exception) => exception.volunteerId === volunteerId) ?? [];
    return effectiveIntervalsForDate(date, timeZone, recurring, exceptions).map((interval) => ({ ...interval, weekday: Temporal.PlainDate.from(date).dayOfWeek as RecurringAvailability['weekday'] }));
  }

  scheduleStaleness(): ScheduleStalenessStore {
    return this.staleness;
  }

  private validateRecurring(input: readonly RecurringAvailabilityInput[]): ServiceResult<RecurringAvailabilityInput[]> {
    const allTimeZones = new Set<string>();
    const byWeekday = new Map<number, RecurringAvailabilityInput[]>();
    for (const candidate of input) {
      const parsed = RecurringAvailabilitySchema.safeParse(candidate);
      if (!parsed.success) return failure('INVALID_REQUEST', 'Recurring availability contains an invalid interval', { issues: parsed.error.issues });
      if (!validTimeZone(parsed.data.timeZone)) return failure('INVALID_REQUEST', 'Unknown time zone');
      if (this.configuredTimeZone && parsed.data.timeZone !== this.configuredTimeZone) return failure('INVALID_REQUEST', 'Availability must use the configured time zone');
      allTimeZones.add(parsed.data.timeZone);
      const day = byWeekday.get(parsed.data.weekday) ?? [];
      day.push(parsed.data);
      byWeekday.set(parsed.data.weekday, day);
    }
    if (allTimeZones.size > 1) return failure('INVALID_REQUEST', 'All recurring intervals must use one time zone');
    const normalized: RecurringAvailabilityInput[] = [];
    for (const [weekday, dayIntervals] of byWeekday.entries()) {
      const day = normalizeIntervals(dayIntervals);
      for (const interval of day) {
        const { start, end, timeZone } = interval;
        normalized.push({ weekday: weekday as RecurringAvailability['weekday'], start, end, timeZone });
      }
    }
    return success(normalized);
  }

  private readRecurring(volunteerId: string): RecurringAvailabilityRecord[] {
    if (this.recurringAvailability) return this.recurringAvailability.list().filter((record) => record.volunteerId === volunteerId);
    const volunteer = this.volunteers?.get(volunteerId);
    return volunteer?.recurringAvailability.map((item, index) => ({ ...item, id: `${volunteerId}-embedded-${index}`, volunteerId, revision: volunteer.revision })) ?? [];
  }

  private isActiveVolunteer(volunteerId: string): boolean {
    if (!this.volunteers) return true;
    const volunteer = this.volunteers.get(volunteerId);
    return volunteer?.lifecycleStatus === 'active';
  }

  private persistRecurring(
    replacement: readonly RecurringAvailabilityRecord[],
    nextRows: readonly RecurringAvailabilityRecord[],
    volunteerId: string,
    expectedRevision: number,
    expectedVolunteerRevision: number | undefined
  ): { revision: RevisionState; volunteerRevision?: number } {
    let revision: RevisionState = { number: expectedRevision, changedAt: this.clock.now(), changedBy: volunteerId, source: 'self-service-recurring-availability' };
    if (this.recurringAvailability) {
      const before = this.readRecurring(volunteerId);
      revision = this.recurringAvailability.replace(nextRows, expectedRevision, volunteerId, 'self-service-recurring-availability');
      const audit = makeAudit(this.idGenerator.next('audit'), volunteerId, 'replace', 'self-service-recurring-availability', this.clock.now(), before, replacement);
      this.recurringAvailability.appendAudit(audit);
      appendAudit(this.repositories, audit);
    }
    if (this.volunteers) {
      const volunteer = this.volunteers.get(volunteerId);
      if (!volunteer) throw new Error('Volunteer is not active');
      const volunteerRevision = expectedVolunteerRevision ?? (this.recurringAvailability ? repositoryRevision(this.volunteers) : expectedRevision);
      const updated: Volunteer = { ...volunteer, recurringAvailability: replacement.map(({ weekday, start, end, timeZone }) => ({ weekday, start, end, timeZone })), revision: volunteerRevision + 1, updatedAt: this.clock.now() };
      const nextVolunteerRevision = this.volunteers.upsert(updated, volunteerRevision, volunteerId, 'self-service-recurring-availability');
      if (!this.recurringAvailability) revision = nextVolunteerRevision;
      return { revision, volunteerRevision: nextVolunteerRevision.number };
    }
    return { revision };
  }


  private persistException(exception: AvailabilityException, expectedRevision: number, actorId: string): RevisionState {
    if (!this.exceptions) throw new Error('Exception repository is unavailable');
    const revision = this.exceptions.upsert(exception, expectedRevision, actorId, 'self-service-availability-exception');
    const audit: AuditEntry = makeAudit(this.idGenerator.next('audit'), actorId, 'create', 'self-service-availability-exception', this.clock.now(), undefined, exception);
    this.exceptions.appendAudit(audit);
    appendAudit(this.repositories, audit);
    return revision;
  }

  private markStale(volunteerId: string, sourceRevision: number, reason: ScheduleStaleReason, actorId: string, timestamp: string): boolean {
    try {
      this.staleness.markStale({ stale: true, markedAt: timestamp, markedBy: actorId, reason, volunteerId, sourceRevision });
      return true;
    } catch {
      return false;
    }
  }

  private notifyAvailability(volunteerId: string, availability: readonly RecurringAvailabilityRecord[], actorId: string, _timestamp: string, kind: 'recurring-availability'): NotificationStatusRecord | undefined {
    if (!this.notifications) return undefined;
    const result = this.notifications.notifyAdministrators({ kind, entityId: volunteerId, actorId, subject: 'Volunteer recurring availability changed', body: notificationBody(volunteerId, availability, 'Recurring availability update') });
    return result.ok ? result.data : undefined;
  }

  private notifyException(exception: AvailabilityException, actorId: string, _timestamp: string): NotificationStatusRecord | undefined {
    if (!this.notifications) return undefined;
    const result = this.notifications.notifyAdministrators({ kind: 'availability-exception', entityId: exception.id, actorId, subject: 'Volunteer dated availability exception recorded', body: `Volunteer ${exception.volunteerId} recorded a dated ${exception.kind} interval on ${exception.date} (${exception.interval.start}-${exception.interval.end}, ${exception.interval.timeZone}).` });
    return result.ok ? result.data : undefined;
  }
}

export class MemoryScheduleStalenessStore implements ScheduleStalenessStore {
  private state: ScheduleStaleState | undefined;

  markStale(state: ScheduleStaleState): void {
    this.state = { ...state };
  }

  getStatus(): ScheduleStaleState | undefined {
    return this.state ? { ...this.state } : undefined;
  }
}

export type { ScheduleStaleState } from './types.js';
export { VolunteerAvailabilityService as RecurringAvailabilityService };
export { VolunteerAvailabilityService as AvailabilityExceptionService };
