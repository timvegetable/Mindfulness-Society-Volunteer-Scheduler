export const WORKBOOK_SCHEMA_VERSION = 4;

export type WorkbookTab = {
  name: string;
  columns: readonly string[];
  protectedColumns: readonly string[];
  appendOnly?: boolean;
};

export const WORKBOOK_TABS = [
  { name: 'Volunteers', columns: ['id', 'name', 'email', 'lifecycleStatus', 'interviewStatus', 'readinessRank', 'revision', 'source', 'createdAt', 'updatedAt'], protectedColumns: ['id', 'revision', 'createdAt', 'updatedAt'] },
  { name: 'RecurringAvailability', columns: ['id', 'volunteerId', 'weekday', 'start', 'end', 'timeZone', 'revision', 'source', 'updatedAt'], protectedColumns: ['id', 'volunteerId', 'revision', 'updatedAt'] },
  { name: 'AvailabilityExceptions', columns: ['id', 'volunteerId', 'date', 'kind', 'start', 'end', 'timeZone', 'reason', 'revision', 'updatedAt'], protectedColumns: ['id', 'volunteerId', 'revision', 'updatedAt'] },
  { name: 'Sessions', columns: ['id', 'kind', 'centerId', 'title', 'date', 'start', 'end', 'timeZone', 'requiredStaffCount', 'status', 'sourceCandidateId', 'revision', 'createdAt', 'updatedAt'], protectedColumns: ['id', 'date', 'start', 'end', 'timeZone', 'requiredStaffCount', 'revision', 'createdAt', 'updatedAt'] },
  { name: 'Assignments', columns: ['id', 'sessionId', 'volunteerId', 'scheduleRevision', 'status', 'createdAt', 'cancelledAt', 'cancellationReason'], protectedColumns: ['id', 'scheduleRevision', 'createdAt'] },
  { name: 'Backups', columns: ['id', 'sessionId', 'volunteerId', 'scheduleRevision', 'position', 'status'], protectedColumns: ['id', 'scheduleRevision', 'position'] },
  { name: 'SchedulingRuns', columns: ['id', 'inputRevision', 'outputRevision', 'status', 'startedAt', 'completedAt', 'assignmentIds', 'backupIds', 'shortfalls', 'diagnostic'], protectedColumns: ['id', 'inputRevision', 'outputRevision', 'status', 'startedAt', 'completedAt'] },
  { name: 'Imports', columns: ['id', 'source', 'contentHash', 'status', 'startedAt', 'completedAt', 'actorId', 'resultId', 'participantCount', 'matchedCount', 'unmatched', 'stagedAvailability', 'diagnostic', 'promotedAt', 'promotedBy'], protectedColumns: ['id', 'source', 'contentHash', 'startedAt', 'completedAt', 'actorId', 'promotedAt', 'promotedBy'] },
  { name: 'ImportMappings', columns: ['id', 'source', 'sourceParticipantId', 'sourceEmail', 'sourceName', 'volunteerId', 'createdAt', 'updatedAt', 'updatedBy'], protectedColumns: ['id', 'source', 'createdAt', 'updatedAt', 'updatedBy'] },
  { name: 'ImportedAvailability', columns: ['id', 'volunteerId', 'sourceParticipantId', 'source', 'weekday', 'start', 'end', 'timeZone', 'importedAt', 'importRunId'], protectedColumns: ['id', 'volunteerId', 'sourceParticipantId', 'source', 'importedAt', 'importRunId'] },
  { name: 'Users', columns: ['id', 'email', 'roles', 'volunteerId', 'centerIds', 'active', 'revision'], protectedColumns: ['id', 'roles', 'volunteerId', 'centerIds', 'revision'] },
  { name: 'Settings', columns: ['key', 'value', 'updatedAt', 'updatedBy'], protectedColumns: ['key', 'updatedAt', 'updatedBy'] },
  { name: 'AuditLog', columns: ['id', 'entity', 'entityId', 'action', 'source', 'actorId', 'timestamp', 'before', 'after'], protectedColumns: ['id', 'timestamp'], appendOnly: true },
  { name: 'Centers', columns: ['id', 'name', 'active', 'revision', 'createdAt', 'updatedAt'], protectedColumns: ['id', 'revision', 'createdAt', 'updatedAt'] },
  { name: 'CandidateSchedules', columns: ['id', 'centerId', 'weekday', 'start', 'end', 'timeZone', 'requestedStaffCount', 'status', 'createdBy', 'revision', 'createdAt', 'updatedAt'], protectedColumns: ['id', 'centerId', 'createdBy', 'revision', 'createdAt', 'updatedAt'] }
] as const satisfies readonly WorkbookTab[];

/**
 * Control tabs are schema-defined but deliberately **not** part of
 * `WORKBOOK_TABS`. The synthetic fixture identity digest is computed over
 * `WORKBOOK_TABS`, and it is pinned to the deployed staging workbooks and quoted
 * as cross-campaign evidence; folding protocol metadata into the domain tab list
 * would silently redefine that identity. Initialization creates and protects
 * these tabs, `tabDefinition` resolves them, and readers derive their ranges
 * from the same schema.
 */
export const WORKBOOK_CONTROL_TABS = [
  /**
   * Portable control metadata: one row, rewritten as a whole by every mutation
   * lifecycle transition. Every column is protected metadata, and no counter in
   * it is authoritative until `authority` says so.
   */
  { name: 'WorkbookControl', columns: ['protocolVersion', 'authorityEpoch', 'authority', 'generation', 'completedGeneration', 'dataRevision', 'schedulingInputRevision', 'tabRevisions', 'mutationState', 'operationId', 'operationStartedAt', 'operationTabs', 'operationBaseline', 'updatedAt', 'updatedBy'], protectedColumns: ['protocolVersion', 'authorityEpoch', 'authority', 'generation', 'completedGeneration', 'dataRevision', 'schedulingInputRevision', 'tabRevisions', 'mutationState', 'operationId', 'operationStartedAt', 'operationTabs', 'operationBaseline', 'updatedAt', 'updatedBy'] },
  /** Bounded append-only recovery journal; entries are never rewritten. */
  { name: 'ControlJournal', columns: ['id', 'generation', 'event', 'operationId', 'actorId', 'tabs', 'before', 'after', 'reason', 'timestamp'], protectedColumns: ['id', 'generation', 'event', 'operationId', 'actorId', 'tabs', 'before', 'after', 'reason', 'timestamp'], appendOnly: true }
] as const satisfies readonly WorkbookTab[];

/** Every tab name the schema defines; a wider `string` would defeat the allowlist. */
export type WorkbookTabName = (typeof WORKBOOK_TABS)[number]['name'] | (typeof WORKBOOK_CONTROL_TABS)[number]['name'];

/**
 * Scheduling input tabs. Their tab revisions compose into a dedicated monotonic
 * counter so a change to an unrelated tab never marks the published schedule
 * stale, and a change to a scheduling input always does. Declared here so the
 * runtime and the control protocol advance the same set.
 */
export const SCHEDULING_INPUT_TABS: ReadonlySet<string> = new Set(['Volunteers', 'RecurringAvailability', 'AvailabilityExceptions', 'Sessions']);

const ALL_TABS: readonly WorkbookTab[] = [...WORKBOOK_TABS, ...WORKBOOK_CONTROL_TABS];

export const WORKBOOK_SCHEMA = {
  version: WORKBOOK_SCHEMA_VERSION,
  metadataKey: 'workbookSchemaVersion',
  tabs: ALL_TABS
} as const;

export function tabDefinition(name: string): WorkbookTab {
  const definition = ALL_TABS.find((tab) => tab.name === name);
  if (!definition) throw new Error(`Unknown workbook tab: ${name}`);
  return definition;
}
