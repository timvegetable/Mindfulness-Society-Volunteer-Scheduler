export const WORKBOOK_SCHEMA_VERSION = 1;

export type WorkbookTab = {
  name: string;
  columns: readonly string[];
  protectedColumns: readonly string[];
  appendOnly?: boolean;
};

export const WORKBOOK_TABS: readonly WorkbookTab[] = [
  { name: 'Volunteers', columns: ['id', 'name', 'email', 'lifecycleStatus', 'interviewStatus', 'readinessRank', 'revision', 'source', 'createdAt', 'updatedAt'], protectedColumns: ['id', 'revision', 'createdAt', 'updatedAt'] },
  { name: 'RecurringAvailability', columns: ['id', 'volunteerId', 'weekday', 'start', 'end', 'timeZone', 'revision', 'source', 'updatedAt'], protectedColumns: ['id', 'volunteerId', 'revision', 'updatedAt'] },
  { name: 'AvailabilityExceptions', columns: ['id', 'volunteerId', 'date', 'kind', 'start', 'end', 'timeZone', 'reason', 'revision', 'updatedAt'], protectedColumns: ['id', 'volunteerId', 'revision', 'updatedAt'] },
  { name: 'Sessions', columns: ['id', 'kind', 'centerId', 'title', 'date', 'start', 'end', 'timeZone', 'requiredStaffCount', 'status', 'sourceCandidateId', 'revision', 'createdAt', 'updatedAt'], protectedColumns: ['id', 'date', 'start', 'end', 'timeZone', 'requiredStaffCount', 'revision', 'createdAt', 'updatedAt'] },
  { name: 'Assignments', columns: ['id', 'sessionId', 'volunteerId', 'scheduleRevision', 'status', 'createdAt', 'cancelledAt', 'cancellationReason'], protectedColumns: ['id', 'scheduleRevision', 'createdAt'] },
  { name: 'Backups', columns: ['id', 'sessionId', 'volunteerId', 'scheduleRevision', 'position', 'status'], protectedColumns: ['id', 'scheduleRevision', 'position'] },
  { name: 'SchedulingRuns', columns: ['id', 'inputRevision', 'outputRevision', 'status', 'startedAt', 'completedAt', 'assignmentIds', 'backupIds', 'shortfalls', 'diagnostic'], protectedColumns: ['id', 'inputRevision', 'outputRevision', 'status', 'startedAt', 'completedAt'] },
  { name: 'Imports', columns: ['id', 'source', 'contentHash', 'status', 'startedAt', 'completedAt', 'participantCount', 'unmatched', 'diagnostic'], protectedColumns: ['id', 'source', 'contentHash', 'startedAt', 'completedAt'] },
  { name: 'Users', columns: ['id', 'email', 'roles', 'volunteerId', 'centerIds', 'active', 'revision'], protectedColumns: ['id', 'roles', 'volunteerId', 'centerIds', 'revision'] },
  { name: 'Settings', columns: ['key', 'value', 'updatedAt', 'updatedBy'], protectedColumns: ['key', 'updatedAt', 'updatedBy'] },
  { name: 'AuditLog', columns: ['id', 'entity', 'entityId', 'action', 'source', 'actorId', 'timestamp', 'before', 'after'], protectedColumns: ['id', 'timestamp'], appendOnly: true },
  { name: 'Centers', columns: ['id', 'name', 'active', 'revision', 'createdAt', 'updatedAt'], protectedColumns: ['id', 'revision', 'createdAt', 'updatedAt'] },
  { name: 'CandidateSchedules', columns: ['id', 'centerId', 'weekday', 'start', 'end', 'timeZone', 'requestedStaffCount', 'status', 'createdBy', 'revision', 'createdAt', 'updatedAt'], protectedColumns: ['id', 'centerId', 'createdBy', 'revision', 'createdAt', 'updatedAt'] }
] as const;

export const WORKBOOK_SCHEMA = {
  version: WORKBOOK_SCHEMA_VERSION,
  metadataKey: 'workbookSchemaVersion',
  tabs: WORKBOOK_TABS
} as const;

export function tabDefinition(name: string): WorkbookTab {
  const definition = WORKBOOK_TABS.find((tab) => tab.name === name);
  if (!definition) throw new Error(`Unknown workbook tab: ${name}`);
  return definition;
}
