import { VolunteerAvailabilityService, type AvailabilityExceptionData, type AvailabilityExceptionInput, type AvailabilityServiceDependencies, type AvailabilityUpdateData, type ReplaceRecurringAvailabilityRequest } from './availability.js';
import { AssignedOccurrenceCancellationService, type CancelAssignedOccurrenceRequest, type CancellationData, type CancellationServiceDependencies } from './cancellation.js';
import { NotificationService, type NotificationRetryResult } from './notifications.js';
import { failure, type Caller, type ServiceResult } from './types.js';

export * from './types.js';
export * from './notifications.js';
export * from './availability.js';
export * from './cancellation.js';

export type SelfServiceDependencies = AvailabilityServiceDependencies & CancellationServiceDependencies;

/** Composition root for API adapters that expose all volunteer self-service mutations. */
export class SelfServiceService {
  readonly availability: VolunteerAvailabilityService;
  readonly cancellation: AssignedOccurrenceCancellationService;
  readonly notifications: NotificationService | undefined;
  constructor(dependencies: SelfServiceDependencies) {
    const notificationService = dependencies.notificationService ?? (
      dependencies.mailer || dependencies.administratorRecipients || dependencies.repositories?.notifications
        ? new NotificationService({
          mailer: dependencies.mailer,
          administratorRecipients: dependencies.administratorRecipients,
          repository: dependencies.repositories?.notifications,
          clock: dependencies.clock,
          idGenerator: dependencies.idGenerator
        })
        : undefined
    );
    const serviceDependencies = notificationService ? { ...dependencies, notificationService } : dependencies;
    this.availability = new VolunteerAvailabilityService(serviceDependencies);
    this.cancellation = new AssignedOccurrenceCancellationService(serviceDependencies);
    this.notifications = notificationService;
  }

  updateRecurringAvailability(caller: Caller, request: ReplaceRecurringAvailabilityRequest): ServiceResult<AvailabilityUpdateData> {
    return this.availability.replaceRecurringAvailability(caller, request);
  }

  recordAvailabilityException(caller: Caller, request: AvailabilityExceptionInput): ServiceResult<AvailabilityExceptionData> {
    return this.availability.recordException(caller, request);
  }

  cancelAssignedOccurrence(caller: Caller, request: CancelAssignedOccurrenceRequest): ServiceResult<CancellationData> {
    return this.cancellation.cancel(caller, request);
  }

  retryFailedNotification(caller: Caller, notificationId: string): ServiceResult<NotificationRetryResult> {
    if (!this.notifications) return failure('UNAVAILABLE', 'Notification service is not configured');
    return this.notifications.retry(caller, notificationId);
  }
}

export { SelfServiceService as VolunteerSelfService };
