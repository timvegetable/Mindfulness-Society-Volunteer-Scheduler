import { Temporal } from '@js-temporal/polyfill';
import { intervalsOverlap, isAvailableForSession } from '../../shared/time.js';
import { isRankEligible, type Assignment, type AvailabilityException, type Backup, type Session, type Volunteer } from '../../shared/domain.js';
import type { AuditEntry, RevisionedRepository } from '../workbook/repository.js';
import { hydratedVolunteers } from '../workbook/hydration.js';
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
  type ServiceResult,
  type TransactionRunner
} from './types.js';
import type { RecurringAvailabilityRecord, SelfServiceRepositories, NotificationStatusRecord } from './types.js';
import { NotificationService, type NotificationServiceDependencies } from './notifications.js';

export type CancelAssignedOccurrenceRequest = {
  assignmentId?: string;
  sessionId?: string;
  volunteerId?: string;
  reason?: string;
  expectedRevision?: number;
  expectedExceptionRevision?: number;
};

export type BackupPromotionData = {
  sessionId: string;
  requiredStaffCount: number;
  assignedCount: number;
  understaffed: boolean;
  skippedVolunteerIds: string[];
  backups: Backup[];
  promotedVolunteerId?: string;
  promotedAssignment?: Assignment;
};

export type CancellationData = {
  assignment: Assignment;
  exception: AvailabilityException;
  promotion: BackupPromotionData;
  changedAt: string;
  notification?: NotificationStatusRecord;
};

export type CancellationServiceDependencies = {
  assignments?: RevisionedRepository<Assignment>;
  sessions?: RevisionedRepository<Session>;
  backups?: RevisionedRepository<Backup>;
  volunteers?: RevisionedRepository<Volunteer>;
  recurringAvailability?: RevisionedRepository<RecurringAvailabilityRecord>;
  exceptions?: RevisionedRepository<AvailabilityException>;
  repositories?: SelfServiceRepositories;
  notificationService?: NotificationService;
  mailer?: NotificationServiceDependencies['mailer'];
  administratorRecipients?: AdministratorRecipients;
  clock?: Clock;
  idGenerator?: IdGenerator;
  transaction?: TransactionRunner;
};

function sessionStart(session: Session): Temporal.Instant {
  const date = Temporal.PlainDate.from(session.date);
  return Temporal.ZonedDateTime.from({
    timeZone: session.timeZone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour: Number(session.start.slice(0, 2)),
    minute: Number(session.start.slice(3, 5))
  }).toInstant();
}


function cancellationAudit(id: string, actorId: string, entity: string, entityId: string, action: string, timestamp: string, before: unknown, after: unknown): AuditEntry {
  return { id, entity, entityId, action, source: 'self-service-cancellation', actorId, timestamp, before: serializeAuditValue(before), after: serializeAuditValue(after) };
}

function copyBackup(backup: Backup): Backup {
  return { ...backup };
}

/**
 * Promotes backups after a cancellation. This service deliberately reads the
 * saved assignment/exception state, so it cannot promote against an unsaved
 * cancellation.
 */
export class BackupPromotionService {
  private readonly assignments: RevisionedRepository<Assignment> | undefined;
  private readonly sessions: RevisionedRepository<Session> | undefined;
  private readonly backups: RevisionedRepository<Backup> | undefined;
  private readonly volunteers: RevisionedRepository<Volunteer> | undefined;
  private readonly recurringAvailability: RevisionedRepository<RecurringAvailabilityRecord> | undefined;
  private readonly exceptions: RevisionedRepository<AvailabilityException> | undefined;
  private readonly repositories: SelfServiceRepositories;
  private readonly idGenerator: IdGenerator;
  private readonly clock: Clock;
  private readonly transaction: TransactionRunner;

  constructor(dependencies: CancellationServiceDependencies) {
    this.assignments = dependencies.assignments ?? dependencies.repositories?.assignments;
    this.sessions = dependencies.sessions ?? dependencies.repositories?.sessions;
    this.backups = dependencies.backups ?? dependencies.repositories?.backups;
    this.volunteers = dependencies.volunteers ?? dependencies.repositories?.volunteers;
    this.recurringAvailability = dependencies.recurringAvailability ?? dependencies.repositories?.recurringAvailability;
    this.exceptions = dependencies.exceptions ?? dependencies.repositories?.exceptions;
    this.repositories = dependencies.repositories ?? {
      assignments: this.assignments,
      sessions: this.sessions,
      backups: this.backups,
      volunteers: this.volunteers,
      recurringAvailability: this.recurringAvailability,
      exceptions: this.exceptions
    };
    this.idGenerator = dependencies.idGenerator ?? defaultIdGenerator;
    this.clock = dependencies.clock ?? systemClock;
    this.transaction = dependencies.transaction ?? ((action) => action());
  }

  promote(sessionId: string, actorId: string): ServiceResult<BackupPromotionData> {
    if (!this.sessions || !this.assignments || !this.backups || !this.volunteers || !this.exceptions) return failure('UNAVAILABLE', 'Backup promotion repositories are not configured');
    const session = this.sessions.get(sessionId);
    if (!session) return failure('NOT_FOUND', 'Session was not found');
    if (session.status === 'cancelled') return failure('CONFLICT', 'Cancelled sessions cannot receive a promotion');
    try {
      const allAssignments = this.assignments.list();
      const allBackups = this.backups.list().filter((backup) => backup.sessionId === sessionId);
      const assigned = allAssignments.filter((assignment) => assignment.sessionId === sessionId && assignment.status === 'assigned');
      // Recurring availability lives in its own tab, so the roster row alone
      // carries no intervals: hydrate once, then index everything the candidate
      // loop needs instead of rescanning per candidate.
      const volunteers = hydratedVolunteers({ volunteers: this.volunteers, recurringAvailability: this.recurringAvailability });
      const exceptions = this.exceptions.list();
      const volunteersById = new Map(volunteers.map((volunteer) => [volunteer.id, volunteer]));
      const exceptionsByVolunteer = new Map<string, AvailabilityException[]>();
      for (const exception of exceptions) {
        const existing = exceptionsByVolunteer.get(exception.volunteerId);
        if (existing) existing.push(exception);
        else exceptionsByVolunteer.set(exception.volunteerId, [exception]);
      }
      const assignmentsByVolunteer = new Map<string, Assignment[]>();
      for (const assignment of allAssignments) {
        const existing = assignmentsByVolunteer.get(assignment.volunteerId);
        if (existing) existing.push(assignment);
        else assignmentsByVolunteer.set(assignment.volunteerId, [assignment]);
      }
      const occupied = new Set(assigned.map((assignment) => assignment.volunteerId));
      const candidates = allBackups.filter((backup) => backup.status === 'available').sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
      const skippedVolunteerIds: string[] = [];
      let selected: Backup | undefined;
      for (const candidate of candidates) {
        const volunteer = volunteersById.get(candidate.volunteerId);
        const eligible = assigned.length < session.requiredStaffCount && volunteer !== undefined && isRankEligible(volunteer) && isAvailableForSession(session, volunteer.recurringAvailability, exceptionsByVolunteer.get(volunteer.id) ?? []) && !occupied.has(volunteer.id) && !this.hasOverlappingAssignment(volunteer.id, session, assignmentsByVolunteer.get(volunteer.id) ?? []);
        if (eligible && !selected) {
          selected = candidate;
          occupied.add(candidate.volunteerId);
        } else if (!eligible) {
          skippedVolunteerIds.push(candidate.volunteerId);
        }
      }

      const currentAssignmentRevision = repositoryRevision(this.assignments);
      const currentBackupRevision = repositoryRevision(this.backups);
      const timestamp = this.clock.now();
      let promotedAssignment: Assignment | undefined;
      const reordered = allBackups.map((backup) => ({ ...backup }));
      const skipped = new Set(skippedVolunteerIds);
      reordered.forEach((backup) => {
        if (skipped.has(backup.volunteerId)) backup.status = 'skipped';
      });
      if (selected) {
        const selectedRow = reordered.find((backup) => backup.id === selected.id);
        if (!selectedRow) return failure('CONFLICT', 'Backup changed before promotion');
        selectedRow.status = 'promoted';
        promotedAssignment = {
          id: this.idGenerator.next('assignment'),
          sessionId,
          volunteerId: selected.volunteerId,
          scheduleRevision: selected.scheduleRevision,
          status: 'assigned',
          createdAt: timestamp
        };
      }
      const availableAfter = reordered
        .filter((backup) => backup.status === 'available')
        .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
      availableAfter.forEach((backup, index) => { backup.position = index + 1; });
      const commit = this.transaction(() => {
        let assignmentRevision = currentAssignmentRevision;
        if (promotedAssignment) {
          const assignmentRevisionState = this.assignments?.upsert(promotedAssignment, currentAssignmentRevision, actorId, 'self-service-backup-promotion');
          assignmentRevision = assignmentRevisionState?.number ?? currentAssignmentRevision;
        }
        const backupRevision = this.backups?.replace(reordered, currentBackupRevision, actorId, 'self-service-backup-promotion') ?? { number: currentBackupRevision };
        const audit: AuditEntry = cancellationAudit(this.idGenerator.next('audit'), actorId, 'backup', sessionId, selected ? 'promote' : 'understaffed', timestamp, allBackups, reordered);
        this.backups?.appendAudit(audit);
        appendAudit(this.repositories, audit);
        return { assignmentRevision, backupRevision: backupRevision.number };
      });
      const assignedCount = assigned.length + (promotedAssignment ? 1 : 0);
      const data: BackupPromotionData = {
        sessionId,
        requiredStaffCount: session.requiredStaffCount,
        assignedCount,
        understaffed: assignedCount < session.requiredStaffCount,
        skippedVolunteerIds: [...skippedVolunteerIds],
        backups: reordered.map(copyBackup)
      };
      if (selected) data.promotedVolunteerId = selected.volunteerId;
      if (promotedAssignment) data.promotedAssignment = { ...promotedAssignment };
      void commit;
      return success(data);
    } catch (error) {
      return repositoryFailure(error, 'Unable to promote a backup volunteer');
    }
  }

  private hasOverlappingAssignment(volunteerId: string, session: Session, assignments: readonly Assignment[]): boolean {
    if (!this.sessions) return true;
    return assignments.some((assignment) => {
      if (assignment.volunteerId !== volunteerId || assignment.status !== 'assigned') return false;
      const other = this.sessions?.get(assignment.sessionId);
      return other !== undefined && other.id !== session.id && other.date === session.date && other.status !== 'cancelled' && intervalsOverlap(session, other, session.date);
    });
  }
}

/** Volunteer-owned future assigned-occurrence cancellation. */
export class AssignedOccurrenceCancellationService {
  private readonly assignments: RevisionedRepository<Assignment> | undefined;
  private readonly sessions: RevisionedRepository<Session> | undefined;
  private readonly exceptions: RevisionedRepository<AvailabilityException> | undefined;
  private readonly repositories: SelfServiceRepositories;
  private readonly idGenerator: IdGenerator;
  private readonly clock: Clock;
  private readonly transaction: TransactionRunner;
  private readonly promotion: BackupPromotionService;
  private readonly notifications: NotificationService | undefined;

  constructor(dependencies: CancellationServiceDependencies) {
    this.assignments = dependencies.assignments ?? dependencies.repositories?.assignments;
    this.sessions = dependencies.sessions ?? dependencies.repositories?.sessions;
    this.exceptions = dependencies.exceptions ?? dependencies.repositories?.exceptions;
    this.repositories = dependencies.repositories ?? {
      assignments: this.assignments,
      sessions: this.sessions,
      exceptions: this.exceptions
    };
    this.idGenerator = dependencies.idGenerator ?? defaultIdGenerator;
    this.clock = dependencies.clock ?? systemClock;
    this.transaction = dependencies.transaction ?? ((action) => action());
    this.promotion = new BackupPromotionService(dependencies);
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

  cancel(caller: Caller, request: CancelAssignedOccurrenceRequest): ServiceResult<CancellationData> {
    const volunteerId = caller.volunteerId;
    if (!volunteerId) return failure('FORBIDDEN', 'A linked volunteer identity is required');
    const denied = authorizeVolunteer(caller, volunteerId);
    if (denied) return denied;
    if (request.volunteerId !== undefined && request.volunteerId !== volunteerId) return failure('FORBIDDEN', 'Assignment belongs to the signed-in volunteer');
    if (request.expectedRevision === undefined) return failure('INVALID_REQUEST', 'expectedRevision is required');
    if (request.reason !== undefined && request.reason.length > 500) return failure('INVALID_REQUEST', 'Cancellation reason is too long');
    if (!this.assignments || !this.sessions || !this.exceptions) return failure('UNAVAILABLE', 'Cancellation repositories are not configured');

    try {
      const assignment = this.findAssignment(volunteerId, request);
      if (!assignment) return failure('NOT_FOUND', 'Assigned occurrence was not found');
      if (assignment.status !== 'assigned') return failure('CONFLICT', 'Assignment has already been cancelled');
      if (this.assignments.revision().number !== request.expectedRevision) return failure('STALE_REVISION', 'Assignment changed; refresh before cancelling');
      const session = this.sessions.get(assignment.sessionId);
      if (!session) return failure('NOT_FOUND', 'Session was not found');
      if (session.status === 'cancelled') return failure('CONFLICT', 'Session is cancelled');
      if (Temporal.Instant.compare(sessionStart(session), Temporal.Instant.from(this.clock.now())) <= 0) return failure('CONFLICT', 'Only future assignments can be cancelled');
      const expectedExceptionRevision = request.expectedExceptionRevision ?? this.exceptions.revision().number;
      if (this.exceptions.revision().number !== expectedExceptionRevision) return failure('STALE_REVISION', 'Availability exceptions changed; refresh before cancelling');

      const timestamp = this.clock.now();
      const exception: AvailabilityException = {
        id: this.idGenerator.next('availability-exception'),
        volunteerId,
        date: session.date,
        kind: 'unavailable',
        interval: { start: session.start, end: session.end, timeZone: session.timeZone },
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        revision: expectedExceptionRevision + 1
      };
      const cancelled: Assignment = {
        ...assignment,
        status: 'cancelled',
        cancelledAt: timestamp,
        ...(request.reason === undefined ? {} : { cancellationReason: request.reason })
      };
      const persisted = this.transaction(() => {
        const exceptionRevision = this.exceptions?.upsert(exception, expectedExceptionRevision, caller.id, 'self-service-assignment-cancellation');
        const assignmentRevision = this.assignments?.upsert(cancelled, request.expectedRevision as number, caller.id, 'self-service-assignment-cancellation');
        const audit: AuditEntry = cancellationAudit(this.idGenerator.next('audit'), caller.id, 'assignment', assignment.id, 'cancel', timestamp, assignment, cancelled);
        this.assignments?.appendAudit(audit);
        this.exceptions?.appendAudit(cancellationAudit(this.idGenerator.next('audit'), caller.id, 'availability-exception', exception.id, 'create', timestamp, undefined, exception));
        appendAudit(this.repositories, audit);
        return { exceptionRevision: exceptionRevision?.number ?? expectedExceptionRevision + 1, assignmentRevision: assignmentRevision?.number ?? request.expectedRevision as number + 1 };
      });
      void persisted;

      // The cancellation is fully persisted above before this call is made.
      const promotionResult = this.promotion.promote(session.id, caller.id);
      if (!promotionResult.ok) return promotionResult;
      const notification = this.notifyCancellation(caller.id, volunteerId, session, promotionResult.data);
      const data: CancellationData = { assignment: cancelled, exception, promotion: promotionResult.data, changedAt: timestamp };
      if (notification) data.notification = notification;
      return success(data, persisted.assignmentRevision);
    } catch (error) {
      return repositoryFailure(error, 'Unable to cancel assigned occurrence');
    }
  }

  cancelAssignment(caller: Caller, request: CancelAssignedOccurrenceRequest): ServiceResult<CancellationData> {
    return this.cancel(caller, request);
  }

  private findAssignment(volunteerId: string, request: CancelAssignedOccurrenceRequest): Assignment | undefined {
    if (!this.assignments) return undefined;
    if (request.assignmentId) {
      const assignment = this.assignments.get(request.assignmentId);
      if (assignment?.volunteerId === volunteerId && (!request.sessionId || assignment.sessionId === request.sessionId)) return assignment;
      return undefined;
    }
    if (!request.sessionId) return undefined;
    return this.assignments.list().find((item) => item.sessionId === request.sessionId && item.volunteerId === volunteerId && item.status === 'assigned');
  }

  private notifyCancellation(actorId: string, volunteerId: string, session: Session, promotion: BackupPromotionData): NotificationStatusRecord | undefined {
    if (!this.notifications) return undefined;
    const staffing = promotion.understaffed ? `understaffed (${promotion.assignedCount}/${promotion.requiredStaffCount})` : promotion.promotedVolunteerId ? `backup ${promotion.promotedVolunteerId} promoted` : `${promotion.assignedCount}/${promotion.requiredStaffCount} staffed`;
    const result = this.notifications.notifyAdministrators({
      kind: 'assignment-cancellation',
      entityId: session.id,
      actorId,
      subject: 'Volunteer cancelled an assigned session',
      body: `Volunteer ${volunteerId} cancelled ${session.title ?? session.id} on ${session.date} ${session.start}-${session.end}; result: ${staffing}.`,
    });
    return result.ok ? result.data : undefined;
  }
}

export { BackupPromotionService as CancellationBackupPromotionService };
export { AssignedOccurrenceCancellationService as CancellationService };
