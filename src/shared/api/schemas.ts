import { Schema } from 'effect';
import { roles } from '../domain/roles';
import { isISODate } from '../domain/dates';
import { operations, type Operation } from './operations';
import { applicationTimeZone } from '../domain/models';
export type { Operation } from './operations';

const strict = <S extends Schema.Top>(schema: S): S["Rebuild"] => schema.annotate({ parseOptions: { onExcessProperty: 'error' } });
const object = <F extends Schema.Struct.Fields>(fields: F) => strict(Schema.Struct(fields));
const text = Schema.String.check(Schema.isMinLength(1));
const integer = Schema.Number.check(Schema.isInt());
const revision = integer.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
export const IdentityProofSchema = object({ credential: text, expiresAt: revision });
const readSession = object({ credential: text, expiresAt: revision });
const count = integer.check(Schema.isBetween({ minimum: 0, maximum: 2 }));
const weekday = Schema.Literals([1, 2, 3, 4, 5, 6, 7]);
const workday = Schema.Literals([1, 2, 3, 4, 5]);
const time = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/));
const date = Schema.String.check(Schema.makeFilter(isISODate));
const zone = text.check(Schema.makeFilter((value: string) => value === applicationTimeZone));
const maybeText = Schema.optionalKey(Schema.NullOr(Schema.String));
const timestamps = { createdAt: maybeText, updatedAt: maybeText };
const interval = { start: time, end: time };
const validInterval = Schema.makeFilter((value: { readonly start: string; readonly end: string }) => value.start < value.end, { parseOptions: { onExcessProperty: 'error' } });
export const WeeklyIntervalSchema = object({ ...interval, weekday, timeZone: zone }).check(validInterval);
export const CenterSchema = object({ id: text, name: text, active: Schema.Boolean, ...timestamps });
export const SessionCenterSchema = object({ id: text, name: text });
export const VolunteerSchema = object({
  id: text, name: text, email: text, lifecycleStatus: Schema.Literals(['active', 'newly-joined', 'inactive', 'graduated']),
  interviewStatus: Schema.Literals(['complete', 'incomplete']), readinessRank: Schema.NullOr(integer), source: maybeText, ...timestamps,
});
export const UserSchema = object({ id: text, email: text, roles: Schema.Array(Schema.Literals(roles)), volunteerId: Schema.NullOr(text), centerIds: Schema.Array(text), active: Schema.Boolean });
export const RecurringIntervalSchema = object({ id: text, volunteerId: text, ...interval, weekday, timeZone: zone, source: maybeText, updatedAt: maybeText }).check(validInterval);
export const AvailabilityExceptionSchema = object({ id: text, volunteerId: text, date, kind: Schema.Literals(['available', 'unavailable']), ...interval, timeZone: zone, reason: maybeText, updatedAt: maybeText }).check(validInterval);
export const CandidateSchema = object({ id: text, centerId: text, weekday: workday, ...interval, timeZone: zone, requestedStaffCount: count, status: Schema.Literals(['candidate', 'confirmed', 'cancelled']), createdBy: maybeText, ...timestamps }).check(validInterval);
export const SessionSchema = object({ id: text, kind: Schema.Literals(['center', 'univ100']), centerId: Schema.NullOr(text), title: text, date, ...interval, timeZone: zone, requiredStaffCount: count, status: Schema.Literals(['locked', 'proposed', 'confirmed', 'cancelled']), sourceCandidateId: maybeText, ...timestamps }).check(validInterval);
export const AssignmentSchema = object({ id: text, sessionId: text, volunteerId: text, scheduleRevision: revision, status: Schema.Literals(['assigned', 'cancelled']), createdAt: maybeText, cancelledAt: maybeText, cancellationReason: maybeText });
export const BackupSchema = object({ id: text, sessionId: text, volunteerId: text, scheduleRevision: revision, position: integer.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })), status: Schema.Literals(['available', 'promoted', 'skipped']) });
export const ShortfallSchema = object({ sessionId: text, required: count, assigned: count, missing: count });
export const SchedulingRunSchema = object({ id: text, inputRevision: revision, outputRevision: revision, status: Schema.Literals(['staged', 'completed', 'failed']), startedAt: maybeText, completedAt: maybeText, assignmentIds: Schema.Array(text), backupIds: Schema.Array(text), shortfalls: Schema.Array(ShortfallSchema), diagnostic: maybeText });
export const ImportParticipantSchema = object({ id: text, name: Schema.String, email: Schema.NullOr(Schema.String), intervals: Schema.Array(WeeklyIntervalSchema), identityStable: Schema.optionalKey(Schema.Boolean) });
export const StagedParticipantSchema = object({ ...ImportParticipantSchema.fields, volunteerId: Schema.NullOr(text), pendingReason: Schema.optionalKey(Schema.Literals(['new', 'ambiguous', 'missing-identity', 'unstable-identity'])) });
export const ImportRunSchema = object({ id: text, source: text, contentHash: Schema.String, status: Schema.Literals(['staged', 'completed', 'failed']), startedAt: maybeText, completedAt: maybeText, actorId: maybeText, resultId: maybeText, participantCount: Schema.optionalKey(Schema.NullOr(revision)), matchedCount: Schema.optionalKey(Schema.NullOr(revision)), unmatched: Schema.Array(ImportParticipantSchema), stagedAvailability: Schema.Array(StagedParticipantSchema), diagnostic: maybeText, promotedAt: maybeText, promotedBy: maybeText });
export const ImportHistorySummarySchema = object({ id: ImportRunSchema.fields.id, status: ImportRunSchema.fields.status,
  startedAt: Schema.NullOr(Schema.String), actorId: Schema.NullOr(Schema.String), participantCount: revision, matchedCount: revision });
export const RosterOptionSchema = object({ id: VolunteerSchema.fields.id, name: VolunteerSchema.fields.name, email: VolunteerSchema.fields.email });
export const ImportMappingSchema = object({ id: text, source: text, sourceParticipantId: maybeText, sourceEmail: maybeText, sourceName: maybeText, volunteerId: text, ...timestamps, updatedBy: maybeText });
export const SyncStatusSchema = object({ lastAttemptAt: Schema.NullOr(Schema.String), lastSuccessAt: Schema.NullOr(Schema.String),
  effectiveChangeAt: Schema.NullOr(Schema.String), outcome: Schema.Literals(['never', 'changed', 'unchanged', 'failed']),
  diagnostic: Schema.NullOr(Schema.String), participantCount: revision, matchedCount: revision, pendingCount: revision });
export const SyncJobSchema = object({ id: text, state: Schema.Literals(['queued','running','succeeded','failed']), createdAt: text, updatedAt: text, diagnostic: Schema.NullOr(Schema.String) });
const jobResult = { job: Schema.optionalKey(Schema.NullOr(SyncJobSchema)) };
export const FreshnessSchema = object({ lastSuccessAt: Schema.NullOr(Schema.String), problem: Schema.Boolean });
export const PendingParticipantSchema = object({ ...ImportParticipantSchema.fields,
  resolvable: Schema.Boolean, reason: Schema.Literals(['new', 'ambiguous', 'missing-identity', 'unstable-identity']), present: Schema.Boolean,
  firstSeenAt: text, lastSeenAt: text, conflictingSubmissions: Schema.optionalKey(Schema.Array(ImportParticipantSchema)) });
export const CoverageSchema = object({ volunteers: Schema.Array(VolunteerSchema), requestedCount: count, shortfall: count });
export const CandidateWithCoverageSchema = object({ candidate: CandidateSchema, coverage: CoverageSchema });
export const GridCellSchema = object({ weekday: workday, ...interval, volunteers: Schema.Array(VolunteerSchema), count: revision }).check(validInterval);
export const ScheduleOutputSchema = object({ assignments: Schema.Array(object({ sessionId: text, volunteerId: text })), backups: Schema.Array(object({ sessionId: text, volunteerId: text, position: revision })), shortfalls: Schema.Array(ShortfallSchema) });

const empty = object({}).check(Schema.makeFilter((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && Reflect.ownKeys(value).length === 0));
const candidateUpdate = object({ candidateId: Schema.optionalKey(text), centerId: Schema.optionalKey(text), weekday: Schema.optionalKey(workday), start: Schema.optionalKey(time), end: Schema.optionalKey(time), timeZone: Schema.optionalKey(zone), requestedStaffCount: Schema.optionalKey(count), status: Schema.optionalKey(Schema.Literal('cancelled')) }).check(Schema.makeFilter((value) => {
  if (!value.candidateId && (!value.centerId || !value.weekday || !value.start || !value.end || !value.timeZone || value.status)) return false;
  return !value.start || !value.end || value.start < value.end;
}, { parseOptions: { onExcessProperty: 'error' } }));
export const payloadSchemas = {
  'admin.sync.read': empty, 'admin.sync.now': empty,
  'session.me': empty,
  'volunteer.dashboard': empty,
  'volunteer.availability.recurring.update': object({ intervals: Schema.Array(WeeklyIntervalSchema).check(Schema.isMaxLength(100)) }),
  'volunteer.availability.exception.create': object({ date, kind: Schema.Literals(['available', 'unavailable']), ...interval, timeZone: zone, reason: Schema.optionalKey(Schema.String) }).check(validInterval),
  'volunteer.assignment.cancel': object({ assignmentId: text, reason: Schema.optionalKey(Schema.String) }),
  'volunteer.calendar.read': empty, 'volunteer.calendar.enable': empty,
  'volunteer.calendar.reset': empty, 'volunteer.calendar.disable': empty,
  'admin.schedule.read': empty, 'admin.schedule.preview': empty, 'admin.schedule.rerun': empty,
  'admin.import.whenIsGood.preview': empty,
  'admin.import.whenIsGood.promote': empty,
  'admin.import.mapping.upsert': object({ sourceParticipantId: Schema.optionalKey(text), sourceEmail: Schema.optionalKey(text), sourceName: Schema.optionalKey(text), volunteerId: text }).check(Schema.makeFilter((value) => !!(value.sourceParticipantId || value.sourceEmail || value.sourceName), { parseOptions: { onExcessProperty: 'error' } })),
  'admin.insights.read': empty, 'center.candidate.read': empty,
  'center.candidate.update': candidateUpdate,
  'admin.center.candidate.confirm': object({ candidateId: text }),
  'admin.volunteer.read': empty,
  // Name and email stay plain strings so the handler can explain blank or malformed values.
  'admin.volunteer.create': object({ name: Schema.String, email: Schema.String }),
  'admin.volunteer.update': object({ volunteerId: text, name: Schema.String, email: Schema.String }),
  'admin.volunteer.remove': object({ volunteerId: text }),
} satisfies Record<Operation, Schema.Top>;
const revisions = { dataRevision: revision, schedulingInputRevision: revision };
const scheduleResult = object({ ...revisions, run: Schema.NullOr(SchedulingRunSchema), assignments: Schema.Array(AssignmentSchema), backups: Schema.Array(BackupSchema), shortfalls: Schema.Array(ShortfallSchema), sessions: Schema.Array(SessionSchema), volunteers: Schema.Array(VolunteerSchema), centers: Schema.Array(SessionCenterSchema), stale: Schema.Boolean });
const syncResult = object({ ...revisions, ...jobResult, status: SyncStatusSchema, pending: Schema.Array(PendingParticipantSchema),
  imports: Schema.Array(ImportHistorySummarySchema), volunteers: Schema.Array(RosterOptionSchema) });
export const resultSchemas = {
  'admin.sync.read': syncResult, 'admin.sync.now': object({ ...revisions, ...jobResult, status: SyncStatusSchema }),
  'session.me': object({ ...revisions, user: UserSchema, centers: Schema.Array(CenterSchema), scheduleRead: Schema.optionalKey(readSession), readSession: Schema.optionalKey(readSession) }),
  'volunteer.dashboard': object({ ...revisions, volunteer: VolunteerSchema, calendarEnabled: Schema.Boolean, assignments: Schema.Array(AssignmentSchema), recurringAvailability: Schema.Array(RecurringIntervalSchema), availabilityExceptions: Schema.Array(AvailabilityExceptionSchema), sessions: Schema.Array(SessionSchema), assignmentSessions: Schema.optionalKey(Schema.Array(SessionSchema)), centers: Schema.Array(SessionCenterSchema), freshness: Schema.optionalKey(FreshnessSchema) }),
  'volunteer.availability.recurring.update': object({ ...revisions, intervals: Schema.Array(RecurringIntervalSchema) }),
  'volunteer.availability.exception.create': object({ ...revisions, exception: AvailabilityExceptionSchema }),
  'volunteer.assignment.cancel': object({ ...revisions, assignment: AssignmentSchema, exception: AvailabilityExceptionSchema, promotedAssignment: Schema.NullOr(AssignmentSchema), shortfall: Schema.NullOr(ShortfallSchema) }),
  'volunteer.calendar.read': object({ ...revisions, enabled: Schema.Boolean, token: Schema.NullOr(text) }),
  'volunteer.calendar.enable': object({ ...revisions, enabled: Schema.Boolean }),
  'volunteer.calendar.reset': object({ ...revisions, enabled: Schema.Boolean }),
  'volunteer.calendar.disable': object({ ...revisions, enabled: Schema.Boolean }),
  'admin.schedule.read': scheduleResult, 'admin.schedule.rerun': scheduleResult,
  'admin.schedule.preview': object({ ...revisions, sessions: Schema.Array(SessionSchema), output: ScheduleOutputSchema }),
  'admin.import.whenIsGood.preview': object({ ...revisions, import: ImportRunSchema }),
  'admin.import.whenIsGood.promote': object({ ...revisions, import: ImportRunSchema }),
  'admin.import.mapping.upsert': object({ ...revisions, mapping: ImportMappingSchema }),
  'admin.insights.read': object({ ...revisions, leftoverVolunteers: Schema.Array(VolunteerSchema), grid: Schema.Array(GridCellSchema) }),
  'center.candidate.read': object({ ...revisions, candidates: Schema.Array(CandidateWithCoverageSchema), centers: Schema.Array(CenterSchema) }),
  'center.candidate.update': object({ ...revisions, candidate: CandidateSchema, coverage: CoverageSchema }),
  'admin.center.candidate.confirm': object({ ...revisions, candidate: CandidateSchema, session: SessionSchema }),
  'admin.volunteer.read': object({ ...revisions, volunteers: Schema.Array(VolunteerSchema) }),
  'admin.volunteer.create': object({ ...revisions, volunteer: VolunteerSchema }),
  'admin.volunteer.update': object({ ...revisions, volunteer: VolunteerSchema }),
  'admin.volunteer.remove': object({ ...revisions, volunteer: VolunteerSchema }),
} satisfies Record<Operation, Schema.Top>;
export type PayloadOf<O extends Operation> = typeof payloadSchemas[O]['Type'];
export type ResultOf<O extends Operation> = typeof resultSchemas[O]['Type'];
export const RequestEnvelopeSchema = object({ operation: Schema.Literals(operations), payload: Schema.Unknown, credential: text, idempotencyKey: Schema.optionalKey(text), expectedRevision: Schema.optionalKey(revision) });
export type RequestEnvelope = typeof RequestEnvelopeSchema.Type;
export const PublicErrorSchema = object({ code: Schema.Literals(['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_REQUEST', 'NOT_FOUND', 'STALE_REVISION', 'DUPLICATE_REQUEST', 'CONFLICT', 'INTERNAL_ERROR']), message: Schema.String, details: Schema.optionalKey(Schema.Unknown) });
export const ErrorEnvelopeSchema = object({ ok: Schema.Literal(false), error: PublicErrorSchema });
