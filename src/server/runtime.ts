import type { Assignment, AvailabilityException, Backup, Session, User, Volunteer } from '../shared/domain.js';
import { projectIdentity, projectVolunteerDashboard } from './integration/projections.js';
import type { OperationHandlers } from './integration/dispatcher.js';
import { INTEGRATION_OPERATIONS, IntegrationError } from './integration/dispatcher.js';
import type { AuthenticatedPrincipal } from './integration/auth.js';
import { StagedWhenIsGoodImportService } from './imports/service.js';
import { WhenIsGoodFetcher } from './imports/fetcher.js';
import type { IdentityMapping, ImportRepository, ImportRun } from './imports/types.js';
import { SelfServiceService, type ServiceResult } from './self-service/index.js';
import { createCenterWorkflow } from './centers/service.js';
import type { CenterCaller } from './centers/models.js';
import { centerCodec, centerUserCodec, candidateScheduleCodec } from './centers/codecs.js';
import { InsightStore, projectInsights as projectInsightDataset } from './insights/index.js';
import { runScheduling, SchedulingStore } from './scheduling/index.js';
import { validateCommittedSessionInputs } from './scheduling/inputs.js';
import {
  assignmentCodec,
  availabilityExceptionCodec,
  backupCodec,
  identityMappingCodec,
  importRunCodec,
  importedAvailabilityCodec,
  recurringAvailabilityCodec,
  schedulingRunCodec,
  sessionCodec,
  volunteerCodec
} from './workbook/codecs.js';
import { RevisionStore, SheetRepository, type AuditEntry, type RevisionedRepository, type SheetCodec } from './workbook/repository.js';
import type { SheetValueContext } from './workbook/sheet-values.js';
import { tabDefinition, type WorkbookTab } from './workbook/schema.js';
import type { SpreadsheetLike, SheetLike } from './workbook/initializer.js';
import type { RecurringAvailabilityRecord } from './self-service/types.js';
import type { ImportedAvailabilityRecord } from './imports/types.js';
import type { Center, CenterUser, CandidateSchedule } from './centers/models.js';
import type { SchedulingRun } from '../shared/domain.js';

export type ScriptProperties = {
  getProperty(name: string): string | null;
  setProperty(name: string, value: string): void;
};

/**
 * Scheduling and insight policy resolved from Script Properties. The defaults
 * mirror the deployed policy so a missing property cannot silently narrow the
 * insight grid or halve the display increment; `describeSignIn` reports both the
 * resolved values and whether each property was configured.
 */
export type RuntimeConfiguration = {
  timeZone: string;
  incrementMinutes: number;
  operatingHours: { start: string; end: string };
};

export const DEFAULT_TIME_ZONE = 'America/New_York';
export const DEFAULT_DISPLAY_INCREMENT_MINUTES = 30;
export const DEFAULT_OPERATING_HOURS = { start: '09:00', end: '21:00' } as const;

export function runtimeConfiguration(properties: ScriptProperties): RuntimeConfiguration {
  const increment = Number(properties.getProperty('DISPLAY_INCREMENT_MINUTES') ?? '');
  return {
    timeZone: properties.getProperty('TIME_ZONE')?.trim() || DEFAULT_TIME_ZONE,
    incrementMinutes: Number.isInteger(increment) && increment > 0 && increment <= 24 * 60 ? increment : DEFAULT_DISPLAY_INCREMENT_MINUTES,
    operatingHours: {
      start: properties.getProperty('OPERATING_HOURS_START')?.trim() || DEFAULT_OPERATING_HOURS.start,
      end: properties.getProperty('OPERATING_HOURS_END')?.trim() || DEFAULT_OPERATING_HOURS.end
    }
  };
}

export type RuntimeRepositories = {
  volunteers: SheetRepository<Volunteer>;
  recurringAvailability: SheetRepository<RecurringAvailabilityRecord>;
  exceptions: SheetRepository<AvailabilityException>;
  sessions: SheetRepository<Session>;
  assignments: SheetRepository<Assignment>;
  backups: SheetRepository<Backup>;
  schedulingRuns: SheetRepository<SchedulingRun>;
  imports: SheetRepository<ImportRun>;
  importedAvailability: SheetRepository<ImportedAvailabilityRecord>;
  mappings: SheetRepository<StoredIdentityMapping>;
  centers: SheetRepository<Center>;
  centerUsers: SheetRepository<CenterUser>;
  candidates: SheetRepository<CandidateSchedule>;
};

type StoredIdentityMapping = IdentityMapping & { id: string };

type ProductionRuntime = {
  handlers: OperationHandlers;
  users: User[];
};

function listField(value: string | null): string[] {
  if (!value?.trim()) return [];
  const trimmed = value.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    // Comma-separated administrator settings remain supported for hand-edited properties.
  }
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
}

function now(): string {
  return new Date().toISOString();
}

function repositoryRevision(properties: ScriptProperties, name: string): { get(): { number: number; changedAt: string; changedBy: string; source: string }; set(value: { number: number; changedAt: string; changedBy: string; source: string }): void } {
  const key = `TAB_REVISION_${name}`;
  return {
    get() {
      const value = Number(properties.getProperty(key) ?? '0');
      return { number: Number.isSafeInteger(value) && value >= 0 ? value : 0, changedAt: now(), changedBy: 'system', source: 'runtime-read' };
    },
    set(value) {
      properties.setProperty(key, String(value.number));
    }
  };
}

function auditWriter(sheet: SheetLike): (entry: AuditEntry) => void {
  return (entry) => sheet.appendRow([
    entry.id,
    entry.entity,
    entry.entityId,
    entry.action,
    entry.source,
    entry.actorId,
    entry.timestamp,
    JSON.stringify(entry.before ?? null),
    JSON.stringify(entry.after ?? null)
  ]);
}

function makeRepository<T extends { id: string }>(spreadsheet: SpreadsheetLike, properties: ScriptProperties, definition: WorkbookTab, codec: { fromRow(row: Record<string, unknown>, context?: SheetValueContext): T; toRow(value: T): Record<string, unknown> }, audit: (entry: AuditEntry) => void, context: SheetValueContext): SheetRepository<T> {
  const sheet = spreadsheet.getSheetByName(definition.name);
  if (!sheet) throw new Error(`Workbook tab ${definition.name} is missing; initialize the workbook before serving requests`);
  return new SheetRepository(sheet, definition.columns, codec, new RevisionStore(repositoryRevision(properties, definition.name)), audit, context);
}

export function repositories(spreadsheet: SpreadsheetLike, properties: ScriptProperties, context: SheetValueContext = { timeZone: runtimeConfiguration(properties).timeZone }): RuntimeRepositories {
  const auditSheet = spreadsheet.getSheetByName('AuditLog');
  if (!auditSheet) throw new Error('Workbook tab AuditLog is missing; initialize the workbook before serving requests');
  const audit = auditWriter(auditSheet);
  const make = <T extends { id: string }>(definition: WorkbookTab, codec: SheetCodec<T>): SheetRepository<T> => makeRepository(spreadsheet, properties, definition, codec, audit, context);
  return {
    volunteers: make(tabDefinition('Volunteers'), volunteerCodec),
    recurringAvailability: make(tabDefinition('RecurringAvailability'), recurringAvailabilityCodec),
    exceptions: make(tabDefinition('AvailabilityExceptions'), availabilityExceptionCodec),
    sessions: make(tabDefinition('Sessions'), sessionCodec),
    assignments: make(tabDefinition('Assignments'), assignmentCodec),
    backups: make(tabDefinition('Backups'), backupCodec),
    schedulingRuns: make(tabDefinition('SchedulingRuns'), schedulingRunCodec),
    imports: make(tabDefinition('Imports'), importRunCodec),
    importedAvailability: make(tabDefinition('ImportedAvailability'), importedAvailabilityCodec),
    mappings: make(tabDefinition('ImportMappings'), identityMappingCodec),
    centers: make(tabDefinition('Centers'), centerCodec),
    centerUsers: make(tabDefinition('Users'), centerUserCodec),
    candidates: make(tabDefinition('CandidateSchedules'), candidateScheduleCodec)
  };
}

function mappingId(mapping: IdentityMapping): string {
  const key = [mapping.source, mapping.sourceParticipantId, mapping.sourceEmail, mapping.sourceName].filter(Boolean).join('|').toLowerCase();
  let hash = 2166136261;
  for (const character of key) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return `mapping-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

class SheetImportRepository implements ImportRepository {
  constructor(private readonly runs: SheetRepository<ImportRun>, private readonly current: SheetRepository<ImportedAvailabilityRecord>, private readonly mappingRows: SheetRepository<StoredIdentityMapping>, private readonly roster: SheetRepository<Volunteer>) {}

  listRuns(): ImportRun[] { return this.runs.list(); }
  getRun(id: string): ImportRun | undefined { return this.runs.get(id); }
  findByContentHash(source: ImportRun['source'], contentHash: string): ImportRun | undefined { return this.runs.list().find((run) => run.source === source && run.contentHash === contentHash); }
  saveRun(run: ImportRun): void { this.runs.upsert(run, this.runs.revision().number, run.actorId, 'whenisgood-import-run'); }
  currentAvailability(): ImportedAvailabilityRecord[] { return this.current.list(); }
  currentRevision(): number { return this.current.revision().number; }
  replaceCurrentAvailability(rows: readonly ImportedAvailabilityRecord[], actorId: string, source: string): number { return this.current.replace(rows, this.current.revision().number, actorId, source).number; }
  mappings(): IdentityMapping[] { return this.mappingRows.list().map(({ id: _id, ...mapping }) => mapping); }
  saveMapping(mapping: IdentityMapping): void { this.mappingRows.upsert({ ...mapping, id: mappingId(mapping) }, this.mappingRows.revision().number, mapping.updatedBy, 'whenisgood-identity-mapping'); }
  volunteers(): Volunteer[] { return this.roster.list(); }
}

function caller(actor: AuthenticatedPrincipal): CenterCaller {
  return { id: actor.user.id, active: actor.user.active, roles: actor.user.roles, centerIds: actor.user.centerIds };
}

function serviceData<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new IntegrationError(result.error.code, result.error.message, result.error.details);
  return result.data;
}

function projectImport(result: { run: ImportRun; preview: { canPromote: boolean; blockers: string[] } }, resultId: string, revision: number): Record<string, unknown> {
  return {
    status: result.run.status,
    resultsCode: resultId,
    runId: result.run.id,
    participantCount: result.run.participantCount,
    matchedCount: result.run.matchedCount,
    unmatchedCount: result.run.unmatched.length,
    diagnostics: [result.run.diagnostic?.message, ...result.preview.blockers].filter((item): item is string => Boolean(item)),
    preview: result.run.unmatched.map((entry) => ({ name: entry.participant.name, email: entry.participant.email ?? '', status: entry.reason })),
    revision,
    canPromote: result.preview.canPromote
  };
}

function latestCompletedRun(runs: readonly SchedulingRun[]): SchedulingRun | undefined {
  return [...runs].filter((run) => run.status === 'completed').sort((left, right) => (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt))[0];
}

function schedulingSourceRevision(repositories: RuntimeRepositories): number {
  return Math.max(
    repositories.volunteers.revision().number,
    repositories.recurringAvailability.revision().number,
    repositories.exceptions.revision().number,
    repositories.sessions.revision().number
  );
}

function scheduleProjection(repositories: RuntimeRepositories, globalRevision: number): Record<string, unknown> {
  const runs = repositories.schedulingRuns.list();
  const run = latestCompletedRun(runs);
  const assignments = repositories.assignments.list();
  const backups = repositories.backups.list();
  const sessions = repositories.sessions.list();
  const outputRevision = run?.outputRevision ?? 0;
  const sourceRevision = schedulingSourceRevision(repositories);
  return {
    sessions: sessions.map((session) => {
      const sessionAssignments = assignments.filter((assignment) => assignment.sessionId === session.id && assignment.scheduleRevision === outputRevision && assignment.status === 'assigned').map((assignment) => ({ ...assignment, volunteerName: repositories.volunteers.get(assignment.volunteerId)?.name }));
      const sessionBackups = backups.filter((backup) => backup.sessionId === session.id && backup.scheduleRevision === outputRevision && backup.status === 'available').sort((left, right) => left.position - right.position).map((backup) => repositories.volunteers.get(backup.volunteerId)?.name ?? backup.volunteerId);
      const shortfall = Math.max(0, session.requiredStaffCount - sessionAssignments.length);
      return { ...session, assignments: sessionAssignments, backups: sessionBackups, shortfall };
    }),
    revision: globalRevision,
    inputRevision: run?.inputRevision ?? sourceRevision,
    stale: run ? run.inputRevision !== sourceRevision : false,
    runStatus: run?.status ?? 'none',
    diagnostic: run?.diagnostic
  };
}

function buildInsight(repositories: RuntimeRepositories, configuration: RuntimeConfiguration): Record<string, unknown> {
  const store = new InsightStore();
  const dataset = store.regenerate({
    volunteers: repositories.volunteers.list().map((volunteer) => ({ ...volunteer, recurringAvailability: repositories.recurringAvailability.list().filter((row) => row.volunteerId === volunteer.id).map(({ volunteerId: _volunteerId, id: _id, revision: _revision, source: _source, updatedAt: _updatedAt, ...interval }) => interval) })),
    assignments: repositories.assignments.list(),
    sourceRevision: {
      assignmentRevision: repositories.assignments.revision().number,
      eligibilityRevision: repositories.volunteers.revision().number,
      availabilityRevision: repositories.recurringAvailability.revision().number
    },
    config: {
      timeZone: configuration.timeZone,
      incrementMinutes: configuration.incrementMinutes,
      operatingHours: { ...configuration.operatingHours }
    }
  });
  return { ...projectInsightDataset(dataset, true), revision: Math.max(repositories.volunteers.revision().number, repositories.recurringAvailability.revision().number, repositories.assignments.revision().number) };
}

export function createProductionRuntime(spreadsheet: SpreadsheetLike, properties: ScriptProperties): ProductionRuntime {
  const configuration = runtimeConfiguration(properties);
  const store = repositories(spreadsheet, properties, { timeZone: configuration.timeZone });
  const administratorRecipients = listField(properties.getProperty('ADMINISTRATOR_RECIPIENTS'));
  const mailer = (globalThis as unknown as { GmailApp?: { sendEmail(to: string, subject: string, body: string): void } }).GmailApp;
  const selfService = new SelfServiceService({
    recurringAvailability: store.recurringAvailability,
    volunteers: store.volunteers,
    exceptions: store.exceptions,
    assignments: store.assignments,
    sessions: store.sessions,
    backups: store.backups,
    administratorRecipients,
    mailer: mailer ? { send: ({ to, subject, body }) => mailer.sendEmail(to.join(','), subject, body) } : undefined,
    configuredTimeZone: configuration.timeZone
  });
  const importRepository = new SheetImportRepository(store.imports, store.importedAvailability, store.mappings, store.volunteers);
  const imports = new StagedWhenIsGoodImportService(importRepository, { defaultTimeZone: configuration.timeZone });
  const endpoint = properties.getProperty('WHENISGOOD_ENDPOINT')?.trim();
  const urlFetch = (globalThis as unknown as { UrlFetchApp?: { fetch(url: string): { getResponseCode(): number; getContentText(): string } } }).UrlFetchApp;
  const fetcher = endpoint && urlFetch ? new WhenIsGoodFetcher({ endpoint, fetch: (url) => { const response = urlFetch.fetch(url); return { ok: response.getResponseCode() >= 200 && response.getResponseCode() < 300, status: response.getResponseCode(), text: () => response.getContentText() }; }, parserOptions: { defaultTimeZone: configuration.timeZone } }) : undefined;
  const centerWorkflow = createCenterWorkflow({ centers: store.centers, users: store.centerUsers, candidates: store.candidates, sessions: store.sessions, coverage: { volunteers: store.volunteers, exceptions: store.exceptions, assignments: store.assignments, sessions: store.sessions } });
  const handlers: OperationHandlers = {
    [INTEGRATION_OPERATIONS.me]: ({ actor }) => projectIdentity(actor),
    [INTEGRATION_OPERATIONS.volunteerDashboard]: ({ actor }) => {
      const volunteerId = actor.user.volunteerId;
      if (!volunteerId) throw new IntegrationError('FORBIDDEN', 'A linked volunteer identity is required');
      const volunteer = store.volunteers.get(volunteerId);
      if (!volunteer) throw new IntegrationError('NOT_FOUND', 'Volunteer record was not found');
      const hydrated = { ...volunteer, recurringAvailability: store.recurringAvailability.list().filter((row) => row.volunteerId === volunteerId).map(({ volunteerId: _id, id: _rowId, revision: _revision, source: _source, updatedAt: _updatedAt, ...interval }) => interval) };
      const projection = projectVolunteerDashboard({ volunteer: hydrated, exceptions: store.exceptions.list(), assignments: store.assignments.list(), sessions: store.sessions.list() });
      return { ...projection, recurringAvailability: projection.volunteer.recurringAvailability, revision: Math.max(store.volunteers.revision().number, store.recurringAvailability.revision().number, store.exceptions.revision().number, store.assignments.revision().number) };
    },
    [INTEGRATION_OPERATIONS.recurringAvailabilityUpdate]: ({ actor }, payload) => {
      const value = payload as { intervals: Array<{ weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; start: string; end: string; timeZone: string }> };
      return serviceData(selfService.updateRecurringAvailability({ id: actor.user.id, volunteerId: actor.user.volunteerId, roles: actor.user.roles, active: actor.user.active }, { intervals: value.intervals, expectedRevision: store.recurringAvailability.revision().number, expectedVolunteerRevision: store.volunteers.revision().number }));
    },
    [INTEGRATION_OPERATIONS.availabilityExceptionCreate]: ({ actor }, payload) => {
      const value = payload as { date: string; kind: 'available' | 'unavailable'; interval: { start: string; end: string; timeZone: string }; reason?: string };
      return serviceData(selfService.recordAvailabilityException({ id: actor.user.id, volunteerId: actor.user.volunteerId, roles: actor.user.roles, active: actor.user.active }, { ...value, expectedRevision: store.exceptions.revision().number }));
    },
    [INTEGRATION_OPERATIONS.assignmentCancel]: ({ actor }, payload) => {
      const value = payload as { assignmentId: string; reason?: string };
      return serviceData(selfService.cancelAssignedOccurrence({ id: actor.user.id, volunteerId: actor.user.volunteerId, roles: actor.user.roles, active: actor.user.active }, { ...value, expectedRevision: store.assignments.revision().number, expectedExceptionRevision: store.exceptions.revision().number }));
    },
    [INTEGRATION_OPERATIONS.adminSchedule]: () => scheduleProjection(store, Number(properties.getProperty('DATA_REVISION') ?? '0')),
    [INTEGRATION_OPERATIONS.adminScheduleRerun]: ({ actor }) => {
      const inputRevision = schedulingSourceRevision(store);
      const previous = latestCompletedRun(store.schedulingRuns.list());
      const committedSessions = validateCommittedSessionInputs(store.sessions.list());
      const schedulingStore = new SchedulingStore({ inputRevision, currentRevision: previous?.outputRevision ?? 0 });
      const result = runScheduling(schedulingStore, { inputRevision, actorId: actor.user.id, volunteers: store.volunteers.list(), sessions: committedSessions, exceptions: store.exceptions.list(), assignments: store.assignments.list(), runId: `scheduling-${inputRevision}-${Date.now()}` });
      const beforeAssignments = store.assignments.list();
      const beforeBackups = store.backups.list();
      try {
        store.assignments.replace(result.schedule.assignments, store.assignments.revision().number, actor.user.id, 'schedule-publication');
        store.backups.replace(result.schedule.backups, store.backups.revision().number, actor.user.id, 'schedule-publication');
        store.schedulingRuns.upsert(result.run, store.schedulingRuns.revision().number, actor.user.id, 'schedule-publication');
      } catch (error) {
        try { store.assignments.replace(beforeAssignments, store.assignments.revision().number, actor.user.id, 'schedule-rollback'); } catch { /* preserve original error */ }
        try { store.backups.replace(beforeBackups, store.backups.revision().number, actor.user.id, 'schedule-rollback'); } catch { /* preserve original error */ }
        throw error;
      }
      return scheduleProjection(store, Number(properties.getProperty('DATA_REVISION') ?? '0'));
    },
    [INTEGRATION_OPERATIONS.adminImportPreview]: ({ actor }, payload) => {
      if (!fetcher) throw new IntegrationError('UNAVAILABLE', 'WhenIsGood endpoint is not configured');
      const resultId = (payload as { resultsCode: string }).resultsCode;
      const staged = imports.stageFromFetcher({ id: actor.user.id, roles: actor.user.roles }, fetcher, resultId);
      return projectImport(staged, resultId, Number(properties.getProperty('DATA_REVISION') ?? '0'));
    },
    [INTEGRATION_OPERATIONS.adminImportPromote]: ({ actor }, payload) => {
      if (!fetcher) throw new IntegrationError('UNAVAILABLE', 'WhenIsGood endpoint is not configured');
      const resultId = (payload as { resultsCode: string }).resultsCode;
      const staged = imports.stageFromFetcher({ id: actor.user.id, roles: actor.user.roles }, fetcher, resultId);
      if (!staged.preview.canPromote) throw new IntegrationError('CONFLICT', `Import cannot be promoted: ${staged.preview.blockers.join('; ')}`);
      return imports.promote({ id: actor.user.id, roles: actor.user.roles }, staged.run.id);
    },
    [INTEGRATION_OPERATIONS.adminInsights]: () => buildInsight(store, configuration),
    [INTEGRATION_OPERATIONS.adminInsightsRefresh]: () => buildInsight(store, configuration),
    [INTEGRATION_OPERATIONS.centerCandidate]: ({ actor }) => {
      const centerCaller = caller(actor);
      const candidates = centerWorkflow.schedule.list(centerCaller).map((candidate) => ({ ...candidate, coverage: centerWorkflow.coverage.compareAuthorized(centerCaller, candidate) }));
      const names = new Set(candidates.map((candidate) => candidate.centerId));
      const centerName = names.size === 1 ? store.centers.get([...names][0]!)?.name : undefined;
      return { centerName, candidates, revision: store.candidates.revision().number };
    },
    [INTEGRATION_OPERATIONS.centerCandidateUpdate]: ({ actor }, payload) => {
      const value = payload as { candidateId?: string; id?: string; centerId?: string; weekday?: number; start?: string; end?: string; timeZone?: string; requestedStaffCount?: number; intervals?: Array<{ weekday: number; start: string; end: string; timeZone: string }> };
      const centerCaller = caller(actor);
      const candidateId = value.candidateId ?? value.id;
      if (!candidateId) throw new IntegrationError('INVALID_REQUEST', 'candidateId is required');
      const existing = centerWorkflow.schedule.get(centerCaller, candidateId);
      const interval = value.intervals?.[0];
      const updated = centerWorkflow.schedule.update(centerCaller, candidateId, {
        ...(value.weekday === undefined && interval === undefined ? {} : { weekday: (value.weekday ?? interval?.weekday) as 1 | 2 | 3 | 4 | 5 }),
        ...(value.start === undefined && interval === undefined ? {} : { start: value.start ?? interval?.start ?? existing.start }),
        ...(value.end === undefined && interval === undefined ? {} : { end: value.end ?? interval?.end ?? existing.end }),
        ...(value.timeZone === undefined && interval === undefined ? {} : { timeZone: value.timeZone ?? interval?.timeZone ?? existing.timeZone }),
        ...(value.requestedStaffCount === undefined ? {} : { requestedStaffCount: value.requestedStaffCount })
      }, store.candidates.revision().number);
      return { candidate: updated, coverage: centerWorkflow.coverage.compareAuthorized(centerCaller, updated), revision: store.candidates.revision().number };
    },
    [INTEGRATION_OPERATIONS.adminCenterCandidateConfirm]: ({ actor }, payload) => {
      const candidateId = (payload as { candidateId: string }).candidateId;
      const result = centerWorkflow.confirmation.confirm(caller(actor), candidateId, { expectedRevision: store.candidates.revision().number });
      return { ...result, revision: store.candidates.revision().number };
    }
  };
  return { handlers, users: store.centerUsers.list() };
}

