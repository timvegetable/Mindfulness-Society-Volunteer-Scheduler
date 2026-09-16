import { z } from 'zod';

export const RoleSchema = z.enum(['volunteer', 'administrator', 'center-contact']);
export type Role = z.infer<typeof RoleSchema>;

export const LifecycleStatusSchema = z.enum(['active', 'newly-joined', 'inactive', 'graduated']);
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;
export const InterviewStatusSchema = z.enum(['incomplete', 'complete']);
export type InterviewStatus = z.infer<typeof InterviewStatusSchema>;
export const RankSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Rank = z.infer<typeof RankSchema>;
export const WeekdaySchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)
]);
export type Weekday = z.infer<typeof WeekdaySchema>;

export const TimeZoneSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_+./-]+$/);
export const TimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const IsoInstantSchema = z.string().datetime({ offset: true });

export const IntervalSchema = z.object({
  start: TimeSchema,
  end: TimeSchema,
  timeZone: TimeZoneSchema
}).superRefine((value, ctx) => {
  if (value.start >= value.end) ctx.addIssue({ code: 'custom', path: ['end'], message: 'end must be after start' });
});
export type Interval = z.infer<typeof IntervalSchema>;

export const RecurringAvailabilitySchema = IntervalSchema.extend({ weekday: WeekdaySchema });
export type RecurringAvailability = z.infer<typeof RecurringAvailabilitySchema>;

export const AvailabilityExceptionSchema = z.object({
  id: z.string().min(1), volunteerId: z.string().min(1), date: DateSchema,
  kind: z.enum(['unavailable', 'available']), interval: IntervalSchema,
  reason: z.string().max(500).optional(), revision: z.number().int().nonnegative()
});
export type AvailabilityException = z.infer<typeof AvailabilityExceptionSchema>;

export const VolunteerSchema = z.object({
  id: z.string().min(1), name: z.string().min(1).max(200), email: z.string().email(),
  lifecycleStatus: LifecycleStatusSchema, interviewStatus: InterviewStatusSchema,
  readinessRank: RankSchema.nullable(), recurringAvailability: z.array(RecurringAvailabilitySchema),
  revision: z.number().int().nonnegative(), source: z.string().max(100).optional(),
  createdAt: IsoInstantSchema, updatedAt: IsoInstantSchema
});
export type Volunteer = z.infer<typeof VolunteerSchema>;

export const SessionSchema = z.object({
  id: z.string().min(1), kind: z.enum(['center', 'univ100']),
  centerId: z.string().min(1).optional(), title: z.string().max(200).optional(),
  date: DateSchema, start: TimeSchema, end: TimeSchema, timeZone: TimeZoneSchema,
  requiredStaffCount: z.number().int().min(0).max(2),
  status: z.enum(['locked', 'proposed', 'confirmed', 'cancelled']),
  revision: z.number().int().nonnegative(), sourceCandidateId: z.string().min(1).optional()
}).superRefine((value, ctx) => {
  if (value.start >= value.end) ctx.addIssue({ code: 'custom', path: ['end'], message: 'end must be after start' });
  if (value.kind === 'center' && !value.centerId) ctx.addIssue({ code: 'custom', path: ['centerId'], message: 'center sessions require centerId' });
  if (value.kind === 'univ100' && value.status === 'proposed') ctx.addIssue({ code: 'custom', path: ['status'], message: 'proposed sessions are not schedulable' });
});
export type Session = z.infer<typeof SessionSchema>;

export const AssignmentSchema = z.object({
  id: z.string().min(1), sessionId: z.string().min(1), volunteerId: z.string().min(1),
  scheduleRevision: z.number().int().nonnegative(), status: z.enum(['assigned', 'cancelled']),
  createdAt: IsoInstantSchema, cancelledAt: IsoInstantSchema.optional(), cancellationReason: z.string().max(500).optional()
});
export type Assignment = z.infer<typeof AssignmentSchema>;

export const BackupSchema = z.object({
  id: z.string().min(1), sessionId: z.string().min(1), volunteerId: z.string().min(1),
  scheduleRevision: z.number().int().nonnegative(), position: z.number().int().positive(), status: z.enum(['available', 'promoted', 'skipped'])
});
export type Backup = z.infer<typeof BackupSchema>;

export const ShortfallSchema = z.object({ sessionId: z.string().min(1), required: z.number().int().min(0).max(2), assigned: z.number().int().min(0).max(2), unfilled: z.number().int().min(0).max(2) });
export type Shortfall = z.infer<typeof ShortfallSchema>;

export const SchedulingRunSchema = z.object({
  id: z.string().min(1), inputRevision: z.number().int().nonnegative(), outputRevision: z.number().int().nonnegative().nullable(),
  status: z.enum(['staged', 'completed', 'failed']), startedAt: IsoInstantSchema, completedAt: IsoInstantSchema.optional(),
  assignmentIds: z.array(z.string()), backupIds: z.array(z.string()), shortfalls: z.array(ShortfallSchema), diagnostic: z.string().max(2000).optional()
});
export type SchedulingRun = z.infer<typeof SchedulingRunSchema>;

export const RevisionSchema = z.object({ number: z.number().int().nonnegative(), changedAt: IsoInstantSchema, changedBy: z.string().min(1), source: z.string().min(1) });
export type Revision = z.infer<typeof RevisionSchema>;

export const UserSchema = z.object({ id: z.string().min(1), email: z.string().email(), roles: z.array(RoleSchema).min(1), volunteerId: z.string().min(1).optional(), centerIds: z.array(z.string().min(1)).optional(), active: z.boolean(), revision: z.number().int().nonnegative() });
export type User = z.infer<typeof UserSchema>;

export const ErrorCodeSchema = z.enum(['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_REQUEST', 'NOT_FOUND', 'STALE_REVISION', 'DUPLICATE_REQUEST', 'CONFLICT', 'PAYLOAD_TOO_LARGE', 'INTERNAL_ERROR', 'UNAVAILABLE']);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ApiError = { code: ErrorCode; message: string; details?: Record<string, unknown> };
export type ApiSuccess<T> = { ok: true; data: T; revision?: number };
export type ApiFailure = { ok: false; error: ApiError };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export const ApiRequestSchema = z.object({ operation: z.string().min(1).max(80), payload: z.unknown(), idempotencyKey: z.string().min(8).max(128), expectedRevision: z.number().int().nonnegative().optional(), credential: z.string().min(1).max(10000).optional() });
export type ApiRequest = z.infer<typeof ApiRequestSchema>;

export function normalizeRank(label: string | number | null | undefined): Rank | null {
  if (label === 1 || label === '1' || (typeof label === 'string' && ['primary', 'recurring primary'].includes(label.trim().toLowerCase()))) return 1;
  if (label === 2 || label === '2' || (typeof label === 'string' && label.trim().toLowerCase() === 'secondary')) return 2;
  if (label === 3 || label === '3' || (typeof label === 'string' && label.trim().toLowerCase() === 'tertiary')) return 3;
  return null;
}

export function isRankEligible(volunteer: Pick<Volunteer, 'lifecycleStatus' | 'interviewStatus' | 'readinessRank'>): volunteer is Pick<Volunteer, 'lifecycleStatus' | 'interviewStatus' | 'readinessRank'> & { readinessRank: Rank } {
  return volunteer.lifecycleStatus === 'active' && volunteer.interviewStatus === 'complete' && volunteer.readinessRank !== null;
}
