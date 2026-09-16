import type { RevisionedRepository } from '../workbook/repository.js';
import { MemoryRepository } from '../workbook/repository.js';
import {
  type AdministratorRecipients,
  authorizeVolunteer,
  defaultIdGenerator,
  failure,
  type Caller,
  type Clock,
  type IdGenerator,
  type Mailer,
  type NotificationKind,
  type NotificationMessage,
  type NotificationStatusRecord,
  repositoryFailure,
  resolveRecipients,
  success,
  systemClock,
  type ServiceResult
} from './types.js';
import type { SelfServiceRepositories } from './types.js';
import { isAdministrator } from './types.js';

export type NotificationRequest = {
  kind: NotificationKind;
  entityId: string;
  actorId: string;
  subject: string;
  body: string;
  recipients?: AdministratorRecipients;
};

export type NotificationServiceDependencies = {
  repository?: RevisionedRepository<NotificationStatusRecord>;
  mailer?: Mailer;
  administratorRecipients?: AdministratorRecipients;
  clock?: Clock;
  idGenerator?: IdGenerator;
};

export type NotificationRetryResult = {
  notification: NotificationStatusRecord;
  delivered: boolean;
};

/** Stores a notification attempt independently from the business mutation. */
export class NotificationService {
  private readonly repository: RevisionedRepository<NotificationStatusRecord>;
  private readonly mailer: Mailer | undefined;
  private readonly administratorRecipients: AdministratorRecipients | undefined;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;

  constructor(dependencies: NotificationServiceDependencies = {}) {
    this.repository = dependencies.repository ?? new MemoryRepository<NotificationStatusRecord>();
    this.mailer = dependencies.mailer;
    this.administratorRecipients = dependencies.administratorRecipients;
    this.clock = dependencies.clock ?? systemClock;
    this.idGenerator = dependencies.idGenerator ?? defaultIdGenerator;
  }

  statuses(): NotificationStatusRecord[] {
    return this.repository.list().map((record) => ({ ...record, recipients: [...record.recipients] }));
  }

  getStatus(id: string): NotificationStatusRecord | undefined {
    const record = this.repository.get(id);
    return record ? { ...record, recipients: [...record.recipients] } : undefined;
  }

  notifyAdministrators(request: NotificationRequest): ServiceResult<NotificationStatusRecord> {
    const recipients = resolveRecipients(request.recipients ?? this.administratorRecipients);
    const timestamp = this.clock.now();
    const record: NotificationStatusRecord = {
      id: this.idGenerator.next('notification'),
      kind: request.kind,
      entityId: request.entityId,
      recipients,
      subject: request.subject,
      body: request.body,
      status: 'pending',
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      actorId: request.actorId
    };

    const pendingResult = this.persist(record, request.actorId, 'notification-pending');
    if (!pendingResult.ok) return pendingResult;
    return this.deliverPersisted(pendingResult.data);
  }

  retry(caller: Caller, notificationId: string): ServiceResult<NotificationRetryResult> {
    if (!isAdministrator(caller)) return failure('FORBIDDEN', 'Administrator role is required');
    const current = this.repository.get(notificationId);
    if (!current) return failure('NOT_FOUND', 'Notification was not found');
    if (current.status === 'sent') return failure('CONFLICT', 'Notification has already been delivered');
    const result = this.deliverPersisted(current);
    if (!result.ok) return result;
    return success({ notification: result.data, delivered: result.data.status === 'sent' });
  }

  private deliverPersisted(record: NotificationStatusRecord): ServiceResult<NotificationStatusRecord> {
    const attempted: NotificationStatusRecord = {
      ...record,
      attempts: record.attempts + 1,
      updatedAt: this.clock.now()
    };
    if (attempted.recipients.length === 0) {
      return this.persistFailure(attempted, 'No administrator recipients are configured');
    }
    if (!this.mailer) return this.persistFailure(attempted, 'Administrator mail delivery is unavailable');

    try {
      const message: NotificationMessage = { to: attempted.recipients, subject: attempted.subject, body: attempted.body };
      this.mailer.send(message);
      const sent: NotificationStatusRecord = { ...attempted, status: 'sent' };
      return this.persist(sent, sent.actorId, 'notification-sent');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Administrator mail delivery failed';
      return this.persistFailure(attempted, message);
    }
  }

  private persistFailure(record: NotificationStatusRecord, message: string): ServiceResult<NotificationStatusRecord> {
    const failed: NotificationStatusRecord = { ...record, status: 'failed', lastError: message };
    return this.persist(failed, failed.actorId, 'notification-failed');
  }

  private persist(record: NotificationStatusRecord, actorId: string, source: string): ServiceResult<NotificationStatusRecord> {
    try {
      const revision = this.repository.revision().number;
      const nextRevision = this.repository.upsert(record, revision, actorId, source);
      const saved = this.repository.get(record.id);
      if (!saved) return failure('INTERNAL_ERROR', 'Notification status was not persisted');
      return success({ ...saved, recipients: [...saved.recipients] }, nextRevision.number);
    } catch (error) {
      return repositoryFailure(error, 'Unable to persist notification status');
    }
  }
}

/** Compatibility constructor for callers that pass the common repository bundle. */
export function notificationServiceFromRepositories(
  repositories: SelfServiceRepositories,
  dependencies: Omit<NotificationServiceDependencies, 'repository'> = {}
): NotificationService {
  return new NotificationService({ ...dependencies, repository: repositories.notifications });
}

export type { NotificationStatusRecord } from './types.js';
