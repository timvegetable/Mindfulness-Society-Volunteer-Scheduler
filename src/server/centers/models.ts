import { z } from 'zod';
import {
  DateSchema,
  IntervalSchema,
  IsoInstantSchema,
  RankSchema,
  RoleSchema,
  TimeSchema,
  TimeZoneSchema,
  UserSchema,
  WeekdaySchema,
  type Assignment,
  type AvailabilityException,
  type Role,
  type Session,
  type User,
  type Volunteer,
  type Weekday
} from '../../shared/domain.js';

/** A center is a tenant for candidate schedule submissions. */
export const CenterSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  active: z.boolean(),
  revision: z.number().int().nonnegative(),
  createdAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema
});
export type Center = z.infer<typeof CenterSchema>;

/**
 * The workbook Users row is the authorization source for center contacts.  It
 * deliberately uses the shared User shape so a caller cannot smuggle a second
 * role representation into this feature.
 */
export const CenterUserSchema = UserSchema;
export type CenterUser = User;

export const CandidateScheduleStatusSchema = z.enum(['candidate', 'confirmed', 'cancelled']);
export type CandidateScheduleStatus = z.infer<typeof CandidateScheduleStatusSchema>;

const CandidateDatesSchema = z.array(DateSchema).max(366).optional();

/** A proposed weekly weekday interval, kept separate from Session occurrences. */
export const CandidateScheduleSchema = z.object({
  id: z.string().min(1),
  centerId: z.string().min(1),
  weekday: z.union([
    z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)
  ]),
  start: TimeSchema,
  end: TimeSchema,
  timeZone: TimeZoneSchema,
  requestedStaffCount: z.number().int().min(0).max(2),
  status: CandidateScheduleStatusSchema,
  createdBy: z.string().min(1),
  revision: z.number().int().nonnegative(),
  createdAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema,
  /** Optional occurrence dates selected for this candidate at confirmation. */
  occurrenceDates: CandidateDatesSchema
}).superRefine((value, ctx) => {
  if (value.start >= value.end) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: 'end must be after start' });
  }
  if (value.occurrenceDates) {
    const uniqueDates = new Set(value.occurrenceDates);
    if (uniqueDates.size !== value.occurrenceDates.length) {
      ctx.addIssue({ code: 'custom', path: ['occurrenceDates'], message: 'occurrence dates must be unique' });
    }
  }
});
export type CandidateSchedule = z.infer<typeof CandidateScheduleSchema>;

export type CandidateScheduleInput = {
  id?: string;
  centerId?: string;
  weekday: Weekday;
  start: string;
  end: string;
  timeZone: string;
  requestedStaffCount: number;
  occurrenceDates?: readonly string[];
};

export type CandidateScheduleUpdate = Partial<Pick<CandidateScheduleInput, 'weekday' | 'start' | 'end' | 'timeZone' | 'requestedStaffCount' | 'occurrenceDates'>> & {
  /** A center contact may not move a candidate to another tenant. */
  centerId?: never;
};

/** Local caller shape keeps this package independent of the integration layer. */
export type CenterCaller = {
  id: string;
  active: boolean;
  roles?: readonly Role[];
  /** Convenient single-role form for service callers and tests. */
  role?: Role;
  centerIds?: readonly string[];
  /** Convenient single-tenant form for center-contact callers and tests. */
  centerId?: string;
};

export type CandidateVolunteer = {
  volunteerId: string;
  name: string;
  readinessRank: z.infer<typeof RankSchema>;
  rank: z.infer<typeof RankSchema>;
};

export type CandidateCoverage = {
  candidateId: string;
  centerId: string;
  weekday: Weekday;
  start: string;
  end: string;
  timeZone: string;
  requiredStaffCount: number;
  matchingVolunteerCount: number;
  /** Alias useful to API projections. */
  candidateCount: number;
  coveredCount: number;
  shortfall: number;
  sufficient: boolean;
  volunteers: CandidateVolunteer[];
  /** Same values as volunteers, explicitly named for consumers displaying rank. */
  rankedVolunteers: CandidateVolunteer[];
  label: 'Candidate coverage';
  coverageType: 'advisory';
  advisory: true;
  nonPromissory: true;
  /** Alias that makes the non-promise boundary unambiguous in JSON. */
  promissory: false;
};

export type ConfirmationOptions = {
  expectedRevision?: number;
  /** Explicit occurrence dates take precedence over candidate.occurrenceDates. */
  occurrenceDates?: readonly string[];
  dates?: readonly string[];
  /** Used only when no dates were stored on the candidate. */
  nextOccurrenceDate?: string;
};

export type ConfirmationResult = {
  candidate: CandidateSchedule;
  occurrences: Session[];
  sessions: Session[];
  coverage: CandidateCoverage[];
  auditIds: string[];
};

export type CoverageData = {
  volunteers: readonly Volunteer[] | { list(): Volunteer[] };
  exceptions?: readonly AvailabilityException[] | { list(): AvailabilityException[] };
  assignments?: readonly Assignment[] | { list(): Assignment[] };
  sessions?: readonly Session[] | { list(): Session[] };
};

export type CenterAuditEntry = {
  id: string;
  entity: 'center' | 'user' | 'candidate-schedule' | 'session';
  entityId: string;
  action: string;
  source: string;
  actorId: string;
  timestamp: string;
  before?: unknown;
  after?: unknown;
};

export type Clock = { now(): string };
export type IdGenerator = { next(prefix: string): string };

export const CenterRoleSchema = z.enum(['administrator', 'center-contact']);
export type CenterRole = z.infer<typeof CenterRoleSchema>;

export function asCandidateInterval(candidate: Pick<CandidateSchedule, 'start' | 'end' | 'timeZone'>) {
  return IntervalSchema.parse({ start: candidate.start, end: candidate.end, timeZone: candidate.timeZone });
}

export function isAdministrator(caller: CenterCaller): boolean {
  return caller.active && (caller.roles?.includes('administrator') === true || caller.role === 'administrator');
}

export function isCenterContact(caller: CenterCaller): boolean {
  return caller.active && (caller.roles?.includes('center-contact') === true || caller.role === 'center-contact');
}

export function callerCenterIds(caller: CenterCaller): readonly string[] {
  return caller.centerIds ?? (caller.centerId ? [caller.centerId] : []);
}
