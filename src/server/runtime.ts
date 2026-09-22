import type { Assignment, AvailabilityException, Backup, RecurringAvailability, Session, User, Volunteer } from '../shared/domain.js';
import { projectIdentity, projectVolunteerDashboard } from './integration/projections.js';
import type { OperationHandlers } from './integration/dispatcher.js';
import { INTEGRATION_OPERATIONS, IntegrationError } from './integration/dispatcher.js';
import type { AuthenticatedPrincipal } from './integration/auth.js';
import { StagedWhenIsGoodImportService } from './imports/service.js';
import { WhenIsGoodFetcher } from './imports/fetcher.js';
import type { IdentityMapping, ImportRepository, ImportRun } from './imports/types.js';
import { SelfServiceService, type ServiceResult } from './self-service/index.js';
import { createCenterWorkflow, CenterWorkflowError } from './centers/service.js';
import type { CenterCaller } from './centers/models.js';
import { centerCodec, centerUserCodec, candidateScheduleCodec } from './centers/codecs.js';
import { CacheInsightRepository, InsightStore, projectInsights as projectInsightDataset, type InsightConfig, type InsightDataset, type InsightSnapshot, type InsightSourceRevision, type ScriptCache } from './insights/index.js';
import { filterSessionsAfterCutoff, isSessionSchedulable, runScheduling, SchedulingStore } from './scheduling/index.js';
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
import { hydratedVolunteers } from './workbook/hydration.js';
import { tabDefinition, type WorkbookTab } from './workbook/schema.js';
import type { SpreadsheetLike, SheetLike } from './workbook/initializer.js';
import type { Mailer, RecurringAvailabilityRecord } from './self-service/types.js';
import type { AuthoritativeAvailabilityRecord, ImportedAvailabilityRecord } from './imports/types.js';
import { SourceMappingService, type SourceMappingInput } from './imports/matching.js';
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

/**
 * Scheduling input tabs. Their tab revisions compose into a dedicated monotonic
 * counter so a change to an unrelated tab (mappings, candidates, audit) never
 * marks the published schedule stale, and a change to a scheduling input always
 * does — even when that tab's own revision is not the highest in the workbook.
 */
const SCHEDULING_INPUT_REVISION_KEY = 'SCHEDULING_INPUT_REVISION';
const SCHEDULING_INPUT_TABS: ReadonlySet<string> = new Set(['Volunteers', 'RecurringAvailability', 'AvailabilityExceptions', 'Sessions']);

export function schedulingInputRevision(properties: ScriptProperties): number {
  const value = Number(properties.getProperty(SCHEDULING_INPUT_REVISION_KEY) ?? '0');
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function advanceSchedulingInputRevision(properties: ScriptProperties): void {
  properties.setProperty(SCHEDULING_INPUT_REVISION_KEY, String(schedulingInputRevision(properties) + 1));
}

function repositoryRevision(properties: ScriptProperties, name: string, onCommit?: () => void): { get(): { number: number; changedAt: string; changedBy: string; source: string }; set(value: { number: number; changedAt: string; changedBy: string; source: string }): void } {
  const key = `TAB_REVISION_${name}`;
  return {
    get() {
      const value = Number(properties.getProperty(key) ?? '0');
      return { number: Number.isSafeInteger(value) && value >= 0 ? value : 0, changedAt: now(), changedBy: 'system', source: 'runtime-read' };
    },
    set(value) {
      properties.setProperty(key, String(value.number));
      onCommit?.();
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
  const tracksSchedulingInput = SCHEDULING_INPUT_TABS.has(definition.name);
  return new SheetRepository(sheet, definition.columns, codec, new RevisionStore(repositoryRevision(properties, definition.name, tracksSchedulingInput ? () => advanceSchedulingInputRevision(properties) : undefined)), audit, context);
}

/**
 * Zone that a workbook's date and time cells are anchored to. Sheets stores a
 * time-only cell as an instant on 1899-12-30 in the *spreadsheet's* zone, so
 * decoding in any other zone shifts every clock by that day's offset difference
 * — and because 1899 anchors land on pre-standard-time local mean time, the
 * shift is not even a whole hour: a Detroit workbook read as New York reports
 * 09:32 for a 09:00 session. The configured TIME_ZONE governs scheduling and
 * display, never cell decoding.
 */
export function workbookTimeZone(spreadsheet: SpreadsheetLike, properties: ScriptProperties): string {
  const zone = spreadsheet.getSpreadsheetTimeZone?.().trim();
  return zone || runtimeConfiguration(properties).timeZone;
}

export function repositories(spreadsheet: SpreadsheetLike, properties: ScriptProperties, context: SheetValueContext = { timeZone: workbookTimeZone(spreadsheet, properties) }): RuntimeRepositories {
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
  constructor(private readonly runs: SheetRepository<ImportRun>, private readonly provenanceRows: SheetRepository<ImportedAvailabilityRecord>, private readonly authoritativeRows: SheetRepository<RecurringAvailabilityRecord>, private readonly mappingRows: SheetRepository<StoredIdentityMapping>, private readonly roster: SheetRepository<Volunteer>) {}

  listRuns(): ImportRun[] { return this.runs.list(); }
  getRun(id: string): ImportRun | undefined { return this.runs.get(id); }
  findByContentHash(source: ImportRun['source'], contentHash: string): ImportRun | undefined { return this.runs.list().find((run) => run.source === source && run.contentHash === contentHash); }
  saveRun(run: ImportRun): void { this.runs.upsert(run, this.runs.revision().number, run.actorId, 'whenisgood-import-run'); }
  currentAvailability(): AuthoritativeAvailabilityRecord[] { return this.authoritativeRows.list(); }
  provenance(): ImportedAvailabilityRecord[] { return this.provenanceRows.list(); }
  availabilityRevision(): number { return this.authoritativeRows.revision().number; }
  replaceAuthoritative(rows: readonly AuthoritativeAvailabilityRecord[], actorId: string, source: string): number { return this.authoritativeRows.replace(rows, this.authoritativeRows.revision().number, actorId, source).number; }
  replaceProvenance(rows: readonly ImportedAvailabilityRecord[], actorId: string, source: string): void { this.provenanceRows.replace(rows, this.provenanceRows.revision().number, actorId, source); }
  mappings(): IdentityMapping[] { return this.mappingRows.list().map(({ id: _id, ...mapping }) => mapping); }
  saveMapping(mapping: IdentityMapping): void { this.mappingRows.upsert({ ...mapping, id: mappingId(mapping) }, this.mappingRows.revision().number, mapping.updatedBy, 'whenisgood-identity-mapping'); }
  volunteers(): Volunteer[] { return this.roster.list(); }
}

function caller(actor: AuthenticatedPrincipal): CenterCaller {
  return { id: actor.user.id, active: actor.user.active, roles: actor.user.roles, centerIds: actor.user.centerIds };
}

/**
 * The centers package throws its own error type and knows nothing about the
 * transport, so an unmapped throw reaches the dispatcher as an unrecognised
 * error and every refusal — a locked occurrence, an insufficient-coverage
 * confirmation — is reported as a generic failure with the reason and the
 * shortfall counts dropped. Translating here keeps those messages and details.
 */
function withCenterWorkflowErrors<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof CenterWorkflowError) throw new IntegrationError(error.code, error.message, error.details, error.code === 'CONFLICT');
    throw error;
  }
}

function serviceData<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new IntegrationError(result.error.code, result.error.message, result.error.details);
  return result.data;
}

function projectImport(result: { run: ImportRun; preview: { canPromote: boolean; blockers: string[] } }, resultId: string, revision: number, roster: readonly Volunteer[]): Record<string, unknown> {
  const namesById = new Map(roster.map((volunteer) => [volunteer.id, volunteer.name]));
  const intervalsByVolunteer = new Map<string, Array<{ weekday: number; start: string; end: string; timeZone: string }>>();
  for (const row of result.run.stagedAvailability) {
    const interval = { weekday: row.weekday, start: row.start, end: row.end, timeZone: row.timeZone };
    const existing = intervalsByVolunteer.get(row.volunteerId);
    if (existing) existing.push(interval);
    else intervalsByVolunteer.set(row.volunteerId, [interval]);
  }
  const availabilityPreview = [...intervalsByVolunteer.entries()]
    .map(([volunteerId, intervals]) => ({ volunteerId, volunteerName: namesById.get(volunteerId) ?? volunteerId, intervals }))
    .sort((left, right) => left.volunteerName.localeCompare(right.volunteerName) || left.volunteerId.localeCompare(right.volunteerId));
  return {
    status: result.run.status,
    resultsCode: resultId,
    runId: result.run.id,
    participantCount: result.run.participantCount,
    matchedCount: result.run.matchedCount,
    unmatchedCount: result.run.unmatched.length,
    diagnostics: [result.run.diagnostic?.message, ...result.preview.blockers].filter((item): item is string => Boolean(item)),
    preview: result.run.unmatched.map((entry) => ({ name: entry.participant.name, email: entry.participant.email ?? '', status: entry.reason, sourceParticipantId: entry.participant.sourceParticipantId })),
    availabilityPreview,
    mappingOptions: roster
      .map((volunteer) => ({ volunteerId: volunteer.id, name: volunteer.name, email: volunteer.email, lifecycleStatus: volunteer.lifecycleStatus }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.volunteerId.localeCompare(right.volunteerId)),
    revision,
    canPromote: result.preview.canPromote
  };
}

function latestCompletedRun(runs: readonly SchedulingRun[]): SchedulingRun | undefined {
  return [...runs].filter((run) => run.status === 'completed').sort((left, right) => (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt))[0];
}

/** Wire label for a session: the workbook's center name, its title, then its center id. */
function sessionDisplayName(centers: ReadonlyMap<string, Center>, session: Session): string {
  return (session.centerId ? centers.get(session.centerId)?.name : undefined) ?? session.title ?? session.centerId ?? session.kind;
}

type ScheduleRows = {
  assignments: readonly Assignment[];
  backups: readonly Backup[];
  outputRevision: number;
};

type ScheduleReadState = {
  globalRevision: number;
  schedulingInput: number;
  run: SchedulingRun | undefined;
  preview: boolean;
  computedAt: string;
  schedulingTimeZone: string;
};

/**
 * One projection shape for both the published schedule and a read-only preview:
 * `revision` is always the global workbook revision used for concurrency
 * control, `inputRevision` is the dedicated scheduling-input counter, and
 * `scheduleRevision` is the output revision of the latest completed run.
 */
function scheduleProjection(repositories: RuntimeRepositories, rows: ScheduleRows, state: ScheduleReadState): Record<string, unknown> {
  const sessions = repositories.sessions.list();
  const projectedSessions = filterSessionsAfterCutoff(
    sessions.filter(isSessionSchedulable),
    state.computedAt,
    state.schedulingTimeZone
  );
  const projectedSessionIds = new Set(projectedSessions.map((session) => session.id));
  const volunteers = new Map(repositories.volunteers.list().map((volunteer) => [volunteer.id, volunteer]));
  const centers = new Map(repositories.centers.list().map((center) => [center.id, center]));
  // Index the published rows once instead of scanning them per session.
  const assignmentsBySession = new Map<string, ScheduleRows['assignments'][number][]>();
  for (const assignment of rows.assignments) {
    if (assignment.status !== 'assigned' || assignment.scheduleRevision !== rows.outputRevision || !projectedSessionIds.has(assignment.sessionId)) continue;
    const existing = assignmentsBySession.get(assignment.sessionId);
    if (existing) existing.push(assignment);
    else assignmentsBySession.set(assignment.sessionId, [assignment]);
  }
  const backupsBySession = new Map<string, ScheduleRows['backups'][number][]>();
  for (const backup of rows.backups) {
    if (backup.status !== 'available' || backup.scheduleRevision !== rows.outputRevision || !projectedSessionIds.has(backup.sessionId)) continue;
    const existing = backupsBySession.get(backup.sessionId);
    if (existing) existing.push(backup);
    else backupsBySession.set(backup.sessionId, [backup]);
  }
  const sessionProjection = projectedSessions.map((session) => {
        const sessionAssignments = (assignmentsBySession.get(session.id) ?? []).map((assignment) => ({ ...assignment, volunteerName: volunteers.get(assignment.volunteerId)?.name }));
        const sessionBackups = (backupsBySession.get(session.id) ?? [])
          .sort((left, right) => left.position - right.position)
          .map((backup) => volunteers.get(backup.volunteerId)?.name ?? backup.volunteerId);
        return { ...session, displayName: sessionDisplayName(centers, session), assignments: sessionAssignments, backups: sessionBackups, shortfall: Math.max(0, session.requiredStaffCount - sessionAssignments.length) };
      });
  return {
    sessions: sessionProjection,
    preview: state.preview,
    revision: state.globalRevision,
    inputRevision: state.schedulingInput,
    scheduleRevision: state.run?.outputRevision ?? null,
    outputRevision: rows.outputRevision,
    computedAt: state.computedAt,
    summary: {
      assignmentCount: sessionProjection.reduce((total, session) => total + session.assignments.length, 0),
      backupCount: sessionProjection.reduce((total, session) => total + session.backups.length, 0),
      shortfallCount: sessionProjection.reduce((total, session) => total + session.shortfall, 0)
    },
    stale: state.run ? state.run.inputRevision !== state.schedulingInput : false,
    runStatus: state.run?.status ?? 'none',
    diagnostic: state.run?.diagnostic,
    excludedProposedSessions: sessions
      .filter((session) => session.kind === 'univ100' && session.status === 'proposed')
      .map((session) => ({ id: session.id, displayName: sessionDisplayName(centers, session), reason: 'proposed' }))
  };
}

function insightSourceRevision(repositories: RuntimeRepositories): InsightSourceRevision {
  const run = latestCompletedRun(repositories.schedulingRuns.list());
  return {
    // The completed run's output revision is what filters assignment rows, so a
    // cancelled assignment row cannot hide a volunteer on its own.
    assignmentRevision: run?.outputRevision ?? 0,
    assignmentRowsRevision: repositories.assignments.revision().number,
    eligibilityRevision: repositories.volunteers.revision().number,
    availabilityRevision: repositories.recurringAvailability.revision().number
  };
}

/**
 * Resolve the notification mailer from the Apps Script runtime.
 *
 * This reads `MailApp` and deliberately not `GmailApp`. Every `GmailApp` method requires the
 * full-mailbox `https://mail.google.com/` scope, which `src/server/appsscript.json` does not declare
 * and should not: the web app executes as the deploying account for anonymous callers, so granting
 * that scope would expose the deployer's entire mailbox to any code path an anonymous request can
 * reach. `MailApp` is authorized by the already-declared
 * `https://www.googleapis.com/auth/script.send_mail`, which grants sending only. Declaring a Gmail
 * scope instead is not a drop-in alternative — `GmailApp.sendEmail` still throws until the broader
 * scope is granted and the deploying account re-authorizes.
 */
export type AppsScriptMailServices = {
  MailApp?: { sendEmail(to: string, subject: string, body: string): void };
  GmailApp?: { sendEmail(to: string, subject: string, body: string): void };
};

export function resolveMailer(services: AppsScriptMailServices): Mailer | undefined {
  const mailApp = services.MailApp;
  return mailApp ? { send: ({ to, subject, body }) => mailApp.sendEmail(to.join(','), subject, body) } : undefined;
}

export function createProductionRuntime(spreadsheet: SpreadsheetLike, properties: ScriptProperties, options: { scriptCache?: ScriptCache } = {}): ProductionRuntime {
  const configuration = runtimeConfiguration(properties);
  const store = repositories(spreadsheet, properties);
  const administratorRecipients = listField(properties.getProperty('ADMINISTRATOR_RECIPIENTS'));
  const mailer = resolveMailer(globalThis as unknown as AppsScriptMailServices);
  const selfService = new SelfServiceService({
    recurringAvailability: store.recurringAvailability,
    volunteers: store.volunteers,
    exceptions: store.exceptions,
    assignments: store.assignments,
    sessions: store.sessions,
    backups: store.backups,
    administratorRecipients,
    mailer,
    configuredTimeZone: configuration.timeZone
  });
  const importRepository = new SheetImportRepository(store.imports, store.importedAvailability, store.recurringAvailability, store.mappings, store.volunteers);
  const imports = new StagedWhenIsGoodImportService(importRepository, { defaultTimeZone: configuration.timeZone });
  const endpoint = properties.getProperty('WHENISGOOD_ENDPOINT')?.trim();
  const urlFetch = (globalThis as unknown as { UrlFetchApp?: { fetch(url: string): { getResponseCode(): number; getContentText(): string } } }).UrlFetchApp;
  const fetcher = endpoint && urlFetch ? new WhenIsGoodFetcher({ endpoint, fetch: (url) => { const response = urlFetch.fetch(url); return { ok: response.getResponseCode() >= 200 && response.getResponseCode() < 300, status: response.getResponseCode(), text: () => response.getContentText() }; }, parserOptions: { defaultTimeZone: configuration.timeZone } }) : undefined;
  const centerWorkflow = createCenterWorkflow({ centers: store.centers, users: store.centerUsers, candidates: store.candidates, sessions: store.sessions, coverage: { volunteers: hydratedVolunteers(store), exceptions: store.exceptions, assignments: store.assignments, sessions: store.sessions } });
  // Reads report the global workbook revision for concurrency control; schedule
  // staleness is derived from the dedicated scheduling-input counter.
  const globalRevision = (): number => {
    const value = Number(properties.getProperty('DATA_REVISION') ?? '0');
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  const computeSchedule = (inputRevision: number, previous: SchedulingRun | undefined, actorId: string, startedAt: string) => {
    const schedulingStore = new SchedulingStore({ inputRevision, currentRevision: previous?.outputRevision ?? 0 });
    return runScheduling(schedulingStore, {
      inputRevision,
      actorId,
      volunteers: hydratedVolunteers(store),
      sessions: validateCommittedSessionInputs(store.sessions.list()),
      schedulingTimeZone: configuration.timeZone,
      exceptions: store.exceptions.list(),
      assignments: store.assignments.list(),
      runId: `scheduling-${inputRevision}-${Date.now()}`,
      startedAt
    });
  };
  // The derivation lives behind the script cache: a read serves the stored
  // dataset when its four source revisions still match, marks it stale (rather
  // than deriving) when they changed, and derives only when nothing is stored.
  const insightConfig: InsightConfig = {
    timeZone: configuration.timeZone,
    incrementMinutes: configuration.incrementMinutes,
    operatingHours: { ...configuration.operatingHours }
  };
  const insights = new InsightStore(options.scriptCache ? { repository: new CacheInsightRepository({ cache: options.scriptCache, config: insightConfig }) } : {});
  const insightSnapshot = (): InsightSnapshot => ({
    volunteers: hydratedVolunteers(store),
    assignments: store.assignments.list(),
    sourceRevision: insightSourceRevision(store),
    config: insightConfig
  });
  const projectInsightRead = (dataset: InsightDataset): Record<string, unknown> => ({ ...projectInsightDataset(dataset, true), revision: globalRevision() });
  const handlers: OperationHandlers = {
    [INTEGRATION_OPERATIONS.me]: ({ actor }) => projectIdentity(actor),
    [INTEGRATION_OPERATIONS.volunteerDashboard]: ({ actor }) => {
      const volunteerId = actor.user.volunteerId;
      if (!volunteerId) throw new IntegrationError('FORBIDDEN', 'A linked volunteer identity is required');
      const volunteer = store.volunteers.get(volunteerId);
      if (!volunteer) throw new IntegrationError('NOT_FOUND', 'Volunteer record was not found');
      const hydrated = { ...volunteer, recurringAvailability: store.recurringAvailability.list().filter((row) => row.volunteerId === volunteerId).map(({ volunteerId: _id, id: _rowId, revision: _revision, source: _source, updatedAt: _updatedAt, ...interval }) => interval) };
      const projection = projectVolunteerDashboard({ volunteer: hydrated, exceptions: store.exceptions.list(), assignments: store.assignments.list(), sessions: store.sessions.list() });
      const completed = latestCompletedRun(store.schedulingRuns.list());
      return {
        ...projection,
        recurringAvailability: projection.volunteer.recurringAvailability,
        revision: globalRevision(),
        inputRevision: schedulingInputRevision(properties),
        scheduleRevision: completed?.outputRevision ?? null,
        stale: completed ? completed.inputRevision !== schedulingInputRevision(properties) : false
      };
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
    [INTEGRATION_OPERATIONS.adminSchedule]: ({ now: requestNow }) => {
      const run = latestCompletedRun(store.schedulingRuns.list());
      return scheduleProjection(store, { assignments: store.assignments.list(), backups: store.backups.list(), outputRevision: run?.outputRevision ?? 0 }, { globalRevision: globalRevision(), schedulingInput: schedulingInputRevision(properties), run, preview: false, computedAt: requestNow, schedulingTimeZone: configuration.timeZone });
    },
    // Read-only: the deterministic scheduler runs in memory against this
    // request's snapshot and writes no Sheet row, run record, audit entry, or revision.
    [INTEGRATION_OPERATIONS.adminSchedulePreview]: ({ now: requestNow }) => {
      const inputRevision = schedulingInputRevision(properties);
      const previous = latestCompletedRun(store.schedulingRuns.list());
      const result = computeSchedule(inputRevision, previous, 'administrator-preview', requestNow);
      return scheduleProjection(
        store,
        { assignments: result.schedule.assignments, backups: result.schedule.backups, outputRevision: result.schedule.revision },
        { globalRevision: globalRevision(), schedulingInput: inputRevision, run: previous, preview: true, computedAt: requestNow, schedulingTimeZone: configuration.timeZone }
      );
    },
    [INTEGRATION_OPERATIONS.adminScheduleRerun]: ({ actor, now: requestNow }) => {
      const inputRevision = schedulingInputRevision(properties);
      const previous = latestCompletedRun(store.schedulingRuns.list());
      const result = computeSchedule(inputRevision, previous, actor.user.id, requestNow);
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
      return scheduleProjection(store, { assignments: result.schedule.assignments, backups: result.schedule.backups, outputRevision: result.schedule.revision }, { globalRevision: globalRevision(), schedulingInput: inputRevision, run: result.run, preview: false, computedAt: requestNow, schedulingTimeZone: configuration.timeZone });
    },
    [INTEGRATION_OPERATIONS.adminImportPreview]: ({ actor }, payload) => {
      if (!fetcher) throw new IntegrationError('UNAVAILABLE', 'WhenIsGood endpoint is not configured');
      const request = payload as { resultsCode: string }; // validated by the operation policy before dispatch
      const staged = imports.stageFromFetcher({ id: actor.user.id, roles: actor.user.roles }, fetcher, request.resultsCode);
      return projectImport(staged, request.resultsCode, globalRevision(), hydratedVolunteers(store));
    },
    [INTEGRATION_OPERATIONS.adminImportPromote]: ({ actor }, payload) => {
      if (!fetcher) throw new IntegrationError('UNAVAILABLE', 'WhenIsGood endpoint is not configured');
      const request = payload as { resultsCode: string }; // validated by the operation policy before dispatch
      const staged = imports.stageFromFetcher({ id: actor.user.id, roles: actor.user.roles }, fetcher, request.resultsCode);
      if (!staged.preview.canPromote) throw new IntegrationError('CONFLICT', `Import cannot be promoted: ${staged.preview.blockers.join('; ')}`);
      const promotion = imports.promote({ id: actor.user.id, roles: actor.user.roles }, staged.run.id);
      // Promotion mutates the saved run, so return a projection built from the
      // persisted value rather than the stale staged object. The import route
      // has no independent read operation; without this projection the client
      // can only repaint an empty form after a successful promotion.
      const promotedRun = importRepository.getRun(promotion.runId);
      if (!promotedRun) throw new IntegrationError('UNAVAILABLE', 'The promoted import could not be read back');
      return {
        ...promotion,
        import: projectImport(
          { run: promotedRun, preview: { canPromote: false, blockers: [] } },
          request.resultsCode,
          globalRevision(),
          hydratedVolunteers(store)
        )
      };
    },
    [INTEGRATION_OPERATIONS.adminImportMappingUpsert]: ({ actor }, payload) => {
      const adminActor = { id: actor.user.id, roles: actor.user.roles };
      const input = payload as SourceMappingInput; // validated by the operation policy before dispatch
      const mapping = new SourceMappingService(importRepository, { now }).save(adminActor, input);
      // Re-match whatever the new mapping can now resolve; the staged run keeps
      // its id and availability rows are rebuilt rather than appended.
      const restaged = fetcher ? imports.restageUnresolved(adminActor, fetcher)[0] : undefined;
      return {
        mapping,
        ...(restaged ? { import: projectImport(restaged, restaged.run.resultId ?? '', globalRevision(), hydratedVolunteers(store)) } : {})
      };
    },
    [INTEGRATION_OPERATIONS.adminInsights]: () => {
      const current = insights.read(insightSourceRevision(store));
      return projectInsightRead(current ?? insights.regenerate(insightSnapshot()));
    },
    [INTEGRATION_OPERATIONS.adminInsightsRefresh]: () => projectInsightRead(insights.refresh(insightSnapshot())),
    [INTEGRATION_OPERATIONS.centerCandidate]: ({ actor }) => withCenterWorkflowErrors(() => {
      const centerCaller = caller(actor);
      const candidates = centerWorkflow.schedule.list(centerCaller).map((candidate) => ({
        ...candidate,
        // An administrator reads every center's rows at once, so each row carries
        // its own center name rather than relying on one shared heading.
        centerName: store.centers.get(candidate.centerId)?.name ?? candidate.centerId,
        coverage: centerWorkflow.coverage.compareAuthorized(centerCaller, candidate)
      }));
      const names = new Set(candidates.map((candidate) => candidate.centerId));
      const centerName = names.size === 1 ? store.centers.get([...names][0]!)?.name : undefined;
      return { centerName, candidates, revision: globalRevision() };
    }),
    [INTEGRATION_OPERATIONS.centerCandidateUpdate]: ({ actor }, payload) => withCenterWorkflowErrors(() => {
      const value = payload as { candidateId?: string; id?: string; centerId?: string; weekday?: number; start?: string; end?: string; timeZone?: string; requestedStaffCount?: number; intervals?: Array<{ weekday: number; start: string; end: string; timeZone: string }> };
      const centerCaller = caller(actor);
      const candidateId = value.candidateId ?? value.id;
      const interval = value.intervals?.[0];
      const currentCandidateRevision = store.candidates.revision().number;
      if (!candidateId) {
        // No id means a new interval rather than an edit: the client has no id to
        // send, so the schedule service mints one. Rejecting the payload here made
        // the create path unreachable and a center could never enter a candidate.
        const created = centerWorkflow.schedule.create(centerCaller, {
          ...(value.centerId === undefined ? {} : { centerId: value.centerId }),
          weekday: (value.weekday ?? interval?.weekday) as 1 | 2 | 3 | 4 | 5,
          start: value.start ?? interval?.start ?? '',
          end: value.end ?? interval?.end ?? '',
          timeZone: value.timeZone ?? interval?.timeZone ?? '',
          requestedStaffCount: value.requestedStaffCount ?? 1
        }, currentCandidateRevision);
        return { candidate: created, coverage: centerWorkflow.coverage.compareAuthorized(centerCaller, created), revision: globalRevision() };
      }
      const existing = centerWorkflow.schedule.get(centerCaller, candidateId);
      const updated = centerWorkflow.schedule.update(centerCaller, candidateId, {
        ...(value.weekday === undefined && interval === undefined ? {} : { weekday: (value.weekday ?? interval?.weekday) as 1 | 2 | 3 | 4 | 5 }),
        ...(value.start === undefined && interval === undefined ? {} : { start: value.start ?? interval?.start ?? existing.start }),
        ...(value.end === undefined && interval === undefined ? {} : { end: value.end ?? interval?.end ?? existing.end }),
        ...(value.timeZone === undefined && interval === undefined ? {} : { timeZone: value.timeZone ?? interval?.timeZone ?? existing.timeZone }),
        ...(value.requestedStaffCount === undefined ? {} : { requestedStaffCount: value.requestedStaffCount })
      }, currentCandidateRevision);
      return { candidate: updated, coverage: centerWorkflow.coverage.compareAuthorized(centerCaller, updated), revision: globalRevision() };
    }),
    [INTEGRATION_OPERATIONS.adminCenterCandidateConfirm]: ({ actor }, payload) => withCenterWorkflowErrors(() => {
      const candidateId = (payload as { candidateId: string }).candidateId;
      const result = centerWorkflow.confirmation.confirm(caller(actor), candidateId, { expectedRevision: store.candidates.revision().number });
      return { ...result, revision: globalRevision() };
    })
  };
  return { handlers, users: store.centerUsers.list() };
}
