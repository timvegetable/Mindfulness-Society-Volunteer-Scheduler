import { Temporal } from '@js-temporal/polyfill';
import {
  CandidateScheduleSchema,
  CenterSchema,
  CenterUserSchema,
  asCandidateInterval,
  callerCenterIds,
  isAdministrator,
  isCenterContact,
  type CandidateCoverage,
  type CandidateSchedule,
  type CandidateScheduleInput,
  type CandidateScheduleUpdate,
  type CandidateVolunteer,
  type Center,
  type CenterCaller,
  type CenterUser,
  type Clock,
  type ConfirmationOptions,
  type ConfirmationResult,
  type IdGenerator,
  type CoverageData
} from './models.js';
import {
  type CandidateScheduleStore,
  type CenterStore,
  type CenterUserStore,
  type RemovableStore,
  type SessionStoreLike,
  MemoryCandidateScheduleStore,
  MemoryCenterStore,
  MemoryCenterUserStore,
  MemorySessionStore
} from './stores.js';
import {
  type ApiError,
  type Assignment,
  type AvailabilityException,
  type Session,
  type Volunteer,
  isRankEligible
} from '../../shared/domain.js';
import {
  intervalContains,
  intervalsOverlap,
  isAvailableForSession,
  recurringWeekdayIntervals
} from '../../shared/time.js';
import type { RevisionState } from '../workbook/repository.js';

export type CenterWorkflowErrorCode = Extract<ApiError['code'], 'UNAUTHORIZED' | 'FORBIDDEN' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'STALE_REVISION' | 'CONFLICT'>;

export class CenterWorkflowError extends Error {
  readonly code: CenterWorkflowErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CenterWorkflowErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CenterWorkflowError';
    this.code = code;
    if (details) this.details = details;
  }
}

const systemClock: Clock = {
  now() {
    return new Date().toISOString();
  }
};

const randomIds: IdGenerator = {
  next(prefix: string) {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi?.randomUUID) return `${prefix}-${cryptoApi.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
};

function rows<T>(source: readonly T[] | { list(): T[] } | undefined): readonly T[] {
  if (!source) return [];
  if (typeof source === 'object' && 'list' in source) return source.list();
  return source;
}

function hasRole(caller: CenterCaller, role: 'administrator' | 'center-contact'): boolean {
  return caller.roles?.includes(role) === true || caller.role === role;
}

function requireActive(caller: CenterCaller): void {
  if (!caller.active) throw new CenterWorkflowError('UNAUTHORIZED', 'Caller is inactive');
}

function requireAdministrator(caller: CenterCaller): void {
  requireActive(caller);
  if (!hasRole(caller, 'administrator')) throw new CenterWorkflowError('FORBIDDEN', 'Administrator role required');
}

function requireCenterAccess(caller: CenterCaller, centerId: string): void {
  requireActive(caller);
  if (hasRole(caller, 'administrator')) return;
  if (!hasRole(caller, 'center-contact')) throw new CenterWorkflowError('FORBIDDEN', 'Center-contact role required');
  if (!callerCenterIds(caller).includes(centerId)) {
    throw new CenterWorkflowError('FORBIDDEN', 'Caller is not authorized for this center', { centerId });
  }
}

function assertWeekday(value: number): asserts value is 1 | 2 | 3 | 4 | 5 {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new CenterWorkflowError('INVALID_REQUEST', 'Candidate schedules are limited to Monday through Friday', { weekday: value });
  }
}

function validateDates(weekday: number, dates: readonly string[]): string[] {
  assertWeekday(weekday);
  const uniqueDates = new Set<string>();
  for (const date of dates) {
    try {
      const parsed = Temporal.PlainDate.from(date);
      if (parsed.toString() !== date) throw new CenterWorkflowError('INVALID_REQUEST', `Invalid occurrence date: ${date}`);
      if (parsed.dayOfWeek !== weekday) {
        throw new CenterWorkflowError('INVALID_REQUEST', 'Occurrence date does not match candidate weekday', { date, weekday });
      }
    } catch (error) {
      if (error instanceof CenterWorkflowError) throw error;
      throw new CenterWorkflowError('INVALID_REQUEST', `Invalid occurrence date: ${date}`);
    }
    if (uniqueDates.has(date)) throw new CenterWorkflowError('INVALID_REQUEST', 'Occurrence dates must be unique', { date });
    uniqueDates.add(date);
  }
  return [...uniqueDates].sort();
}

function cloneCandidate(candidate: CandidateSchedule): CandidateSchedule {
  const result: CandidateSchedule = { ...candidate };
  if (candidate.occurrenceDates) result.occurrenceDates = [...candidate.occurrenceDates];
  return result;
}

function validateCandidateShape(candidate: CandidateSchedule): CandidateSchedule {
  try {
    const parsed = CandidateScheduleSchema.parse(candidate);
    assertWeekday(parsed.weekday);
    if (parsed.occurrenceDates) validateDates(parsed.weekday, parsed.occurrenceDates);
    return parsed;
  } catch (error) {
    if (error instanceof CenterWorkflowError) throw error;
    throw new CenterWorkflowError('INVALID_REQUEST', error instanceof Error ? error.message : 'Invalid candidate schedule');
  }
}

function nextWeekdayDate(now: string, weekday: number): string {
  const today = Temporal.Instant.from(now).toZonedDateTimeISO('UTC').toPlainDate();
  const daysAhead = (weekday - today.dayOfWeek + 7) % 7;
  return today.add({ days: daysAhead }).toString();
}

function candidateMatchesSession(candidate: CandidateSchedule, session: Session): boolean {
  if (session.kind !== 'center' || session.centerId !== candidate.centerId || session.timeZone !== candidate.timeZone) return false;
  const candidateDates = candidate.occurrenceDates;
  if (candidateDates && candidateDates.length > 0 && !candidateDates.includes(session.date)) return false;
  const sessionWeekday = Temporal.PlainDate.from(session.date).dayOfWeek;
  if (sessionWeekday !== candidate.weekday) return false;
  return intervalsOverlap(asCandidateInterval(candidate), { start: session.start, end: session.end, timeZone: session.timeZone }, session.date);
}

function lockedOccurrenceForCandidate(candidate: CandidateSchedule, sessions: readonly Session[]): Session | undefined {
  return sessions.find((session) => session.status === 'locked' && candidateMatchesSession(candidate, session));
}

/** Per-comparison indexes so a coverage check never rescans rows per volunteer. */
type CoverageIndex = {
  sessionsById: ReadonlyMap<string, Session>;
  assignmentsByVolunteer: ReadonlyMap<string, readonly Assignment[]>;
  exceptionsByVolunteer: ReadonlyMap<string, readonly AvailabilityException[]>;
};

function coverageIndex(assignments: readonly Assignment[], sessions: readonly Session[], exceptions: readonly AvailabilityException[]): CoverageIndex {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const assignmentsByVolunteer = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    const existing = assignmentsByVolunteer.get(assignment.volunteerId);
    if (existing) existing.push(assignment);
    else assignmentsByVolunteer.set(assignment.volunteerId, [assignment]);
  }
  const exceptionsByVolunteer = new Map<string, AvailabilityException[]>();
  for (const exception of exceptions) {
    const existing = exceptionsByVolunteer.get(exception.volunteerId);
    if (existing) existing.push(exception);
    else exceptionsByVolunteer.set(exception.volunteerId, [exception]);
  }
  return { sessionsById, assignmentsByVolunteer, exceptionsByVolunteer };
}

function assignmentBlocksVolunteer(volunteerId: string, session: Session, index: CoverageIndex): boolean {
  for (const assignment of index.assignmentsByVolunteer.get(volunteerId) ?? []) {
    if (assignment.status !== 'assigned') continue;
    const assignedSession = index.sessionsById.get(assignment.sessionId);
    if (!assignedSession || assignedSession.status === 'cancelled' || assignedSession.id === session.id) continue;
    if (intervalsOverlap(
      { start: assignedSession.start, end: assignedSession.end, timeZone: assignedSession.timeZone },
      { start: session.start, end: session.end, timeZone: session.timeZone },
      session.date
    ) && assignedSession.date === session.date) return true;
  }
  return false;
}

function candidateVolunteer(volunteer: Volunteer): CandidateVolunteer {
  const rank = volunteer.readinessRank as 1 | 2 | 3;
  return {
    volunteerId: volunteer.id,
    name: volunteer.name,
    readinessRank: rank,
    rank
  };
}

export type CoverageComparisonOptions = {
  date?: string;
  requiredStaffCount?: number;
  /** Optional current scheduling snapshot; useful for date-specific confirmation. */
  assignments?: readonly Assignment[] | { list(): Assignment[] };
  sessions?: readonly Session[] | { list(): Session[] };
  exceptions?: readonly AvailabilityException[] | { list(): AvailabilityException[] };
};

export class CandidateCoverageService {
  private readonly data: CoverageData;

  constructor(data: CoverageData | readonly Volunteer[]) {
    if (typeof data === 'object' && data !== null && 'volunteers' in data) this.data = data;
    else this.data = { volunteers: data as readonly Volunteer[] };
  }

  compare(candidate: CandidateSchedule, options: CoverageComparisonOptions = {}): CandidateCoverage {
    const checkedCandidate = validateCandidateShape(candidate);
    const requiredStaffCount = options.requiredStaffCount ?? checkedCandidate.requestedStaffCount;
    if (!Number.isInteger(requiredStaffCount) || requiredStaffCount < 0 || requiredStaffCount > 2) {
      throw new CenterWorkflowError('INVALID_REQUEST', 'Requested staffing count must be between zero and two');
    }
    let eligible: Volunteer[];
    if (options.date) {
      validateDates(checkedCandidate.weekday, [options.date]);
      const session: Session = {
        id: `coverage-${checkedCandidate.id}-${options.date}`,
        kind: 'center',
        centerId: checkedCandidate.centerId,
        date: options.date,
        start: checkedCandidate.start,
        end: checkedCandidate.end,
        timeZone: checkedCandidate.timeZone,
        requiredStaffCount,
        status: 'locked',
        revision: 0,
        sourceCandidateId: checkedCandidate.id
      };
      const exceptions = rows(options.exceptions ?? this.data.exceptions);
      const assignments = rows(options.assignments ?? this.data.assignments);
      const sessions = rows(options.sessions ?? this.data.sessions);
      const index = coverageIndex(assignments, sessions, exceptions);
      eligible = rows(this.data.volunteers).filter((volunteer) => {
        if (!isRankEligible(volunteer)) return false;
        if (!isAvailableForSession(session, volunteer.recurringAvailability, index.exceptionsByVolunteer.get(volunteer.id) ?? [])) return false;
        return !assignmentBlocksVolunteer(volunteer.id, session, index);
      }) as Volunteer[];
    } else {
      const interval = asCandidateInterval(checkedCandidate);
      eligible = rows(this.data.volunteers).filter((volunteer) => {
        if (!isRankEligible(volunteer)) return false;
        const intervals = recurringWeekdayIntervals(volunteer.recurringAvailability, checkedCandidate.weekday, checkedCandidate.timeZone);
        return intervals.some((available) => intervalContains(available, interval));
      }) as Volunteer[];
    }
    eligible.sort((left, right) => (left.readinessRank as number) - (right.readinessRank as number) || left.id.localeCompare(right.id));
    const volunteers = eligible.map(candidateVolunteer);
    const shortfall = Math.max(0, requiredStaffCount - volunteers.length);
    return {
      candidateId: checkedCandidate.id,
      centerId: checkedCandidate.centerId,
      weekday: checkedCandidate.weekday,
      start: checkedCandidate.start,
      end: checkedCandidate.end,
      timeZone: checkedCandidate.timeZone,
      requiredStaffCount,
      matchingVolunteerCount: volunteers.length,
      candidateCount: volunteers.length,
      coveredCount: volunteers.length,
      shortfall,
      sufficient: shortfall === 0,
      volunteers,
      rankedVolunteers: volunteers.map((volunteer) => ({ ...volunteer })),
      label: 'Candidate coverage',
      coverageType: 'advisory',
      advisory: true,
      nonPromissory: true,
      promissory: false
    };
  }

  compareCandidate(candidate: CandidateSchedule, options: CoverageComparisonOptions = {}): CandidateCoverage {
    return this.compare(candidate, options);
  }

  compareAuthorized(caller: CenterCaller, candidate: CandidateSchedule, options: CoverageComparisonOptions = {}): CandidateCoverage {
    requireCenterAccess(caller, candidate.centerId);
    return this.compare(candidate, options);
  }

  compareCoverage(candidate: CandidateSchedule, options: CoverageComparisonOptions = {}): CandidateCoverage {
    return this.compare(candidate, options);
  }
}

export type CenterScheduleServiceOptions = {
  centers?: CenterStore;
  users?: CenterUserStore;
  candidates: CandidateScheduleStore;
  sessions?: SessionStoreLike<Session>;
  clock?: Clock;
  idGenerator?: IdGenerator;
};

export class CenterScheduleService {
  private readonly centers: CenterStore | undefined;
  private readonly candidates: CandidateScheduleStore;
  private readonly sessions: SessionStoreLike<Session>;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;

  constructor(options: CenterScheduleServiceOptions) {
    this.centers = options.centers;
    this.candidates = options.candidates;
    this.sessions = options.sessions ?? new MemorySessionStore<Session>();
    this.clock = options.clock ?? systemClock;
    this.idGenerator = options.idGenerator ?? randomIds;
  }

  list(caller: CenterCaller, centerId?: string): CandidateSchedule[] {
    if (centerId) requireCenterAccess(caller, centerId);
    else {
      requireActive(caller);
      if (!isAdministrator(caller) && !isCenterContact(caller)) throw new CenterWorkflowError('FORBIDDEN', 'Center-contact role required');
    }
    const allowed = centerId ? [centerId] : (isAdministrator(caller) ? undefined : callerCenterIds(caller));
    return this.candidates.list().filter((candidate) => !allowed || allowed.includes(candidate.centerId)).map(cloneCandidate);
  }

  listCandidateSchedules(caller: CenterCaller, centerId?: string): CandidateSchedule[] {
    return this.list(caller, centerId);
  }

  get(caller: CenterCaller, candidateId: string): CandidateSchedule {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new CenterWorkflowError('NOT_FOUND', 'Candidate schedule not found', { candidateId });
    requireCenterAccess(caller, candidate.centerId);
    return cloneCandidate(candidate);
  }

  getCandidateSchedule(caller: CenterCaller, candidateId: string): CandidateSchedule {
    return this.get(caller, candidateId);
  }


  create(caller: CenterCaller, input: CandidateScheduleInput, expectedRevision?: number): CandidateSchedule {
    const centerId = input.centerId ?? this.singleCallerCenter(caller);
    requireCenterAccess(caller, centerId);
    this.assertActiveCenter(centerId);
    const weekday = input.weekday;
    assertWeekday(weekday);
    const now = this.clock.now();
    const id = input.id ?? this.idGenerator.next('candidate');
    if (this.candidates.get(id)) throw new CenterWorkflowError('CONFLICT', 'Candidate schedule already exists', { candidateId: id });
    const occurrenceDates = input.occurrenceDates ? validateDates(weekday, input.occurrenceDates) : undefined;
    const rowBase = {
      id,
      centerId,
      weekday,
      start: input.start,
      end: input.end,
      timeZone: input.timeZone,
      requestedStaffCount: input.requestedStaffCount,
      status: 'candidate' as const,
      createdBy: caller.id,
      revision: this.candidates.revision().number + 1,
      createdAt: now,
      updatedAt: now
    };
    const row: CandidateSchedule = occurrenceDates ? { ...rowBase, occurrenceDates } : rowBase;
    const checked = validateCandidateShape(row);
    const revision = expectedRevision ?? this.candidates.revision().number;
    this.candidates.upsert(checked, revision, caller.id, 'center-candidate-create');
    return checked;
  }

  createCandidateSchedule(caller: CenterCaller, input: CandidateScheduleInput, expectedRevision?: number): CandidateSchedule {
    return this.create(caller, input, expectedRevision);

  }
  update(caller: CenterCaller, candidateId: string, update: CandidateScheduleUpdate, expectedRevision?: number): CandidateSchedule {
    const existing = this.candidates.get(candidateId);
    if (!existing) throw new CenterWorkflowError('NOT_FOUND', 'Candidate schedule not found', { candidateId });
    requireCenterAccess(caller, existing.centerId);
    this.assertActiveCenter(existing.centerId);
    if (existing.status !== 'candidate') {
      throw new CenterWorkflowError('CONFLICT', 'Confirmed or cancelled candidate schedules cannot be edited');
    }
    const weekday = update.weekday ?? existing.weekday;
    assertWeekday(weekday);
    const start = update.start ?? existing.start;
    const end = update.end ?? existing.end;
    const timeZone = update.timeZone ?? existing.timeZone;
    const requestedStaffCount = update.requestedStaffCount ?? existing.requestedStaffCount;
    const occurrenceDates = update.occurrenceDates === undefined
      ? existing.occurrenceDates
      : validateDates(weekday, update.occurrenceDates);
    const base = {
      ...existing,
      weekday,
      start,
      end,
      timeZone,
      requestedStaffCount,
      revision: this.candidates.revision().number + 1,
      updatedAt: this.clock.now()
    };
    const proposed: CandidateSchedule = occurrenceDates ? { ...base, occurrenceDates: [...occurrenceDates] } : base;
    const checked = validateCandidateShape(proposed);
    const locked = lockedOccurrenceForCandidate(checked, this.sessions.list());
    if (locked) {
      throw new CenterWorkflowError('CONFLICT', 'Locked session occurrences are immutable; an administrator must manage the existing session', {
        candidateId,
        lockedSessionId: locked.id,
        centerId: existing.centerId
      });
    }
    const revision = expectedRevision ?? existing.revision;
    this.candidates.upsert(checked, revision, caller.id, 'center-candidate-update');
    return checked;
  }

  updateCandidateSchedule(caller: CenterCaller, candidateId: string, update: CandidateScheduleUpdate, expectedRevision?: number): CandidateSchedule {
    return this.update(caller, candidateId, update, expectedRevision);
  }

  remove(caller: CenterCaller, candidateId: string, expectedRevision?: number): RevisionState {
    const existing = this.candidates.get(candidateId);
    if (!existing) throw new CenterWorkflowError('NOT_FOUND', 'Candidate schedule not found', { candidateId });
    requireCenterAccess(caller, existing.centerId);
    this.assertActiveCenter(existing.centerId);
    if (existing.status !== 'candidate') throw new CenterWorkflowError('CONFLICT', 'Confirmed candidate schedules cannot be removed');
    const locked = lockedOccurrenceForCandidate(existing, this.sessions.list());
    if (locked) throw new CenterWorkflowError('CONFLICT', 'Locked session occurrences are immutable; an administrator must manage the existing session', { lockedSessionId: locked.id });
    const revision = expectedRevision ?? existing.revision;
    const removable = this.candidates as RemovableStore<CandidateSchedule>;
    if (removable.remove) return removable.remove(candidateId, revision, caller.id, 'center-candidate-remove');
    return this.candidates.replace(this.candidates.list().filter((candidate) => candidate.id !== candidateId), revision, caller.id, 'center-candidate-remove');
  }

  deleteCandidateSchedule(caller: CenterCaller, candidateId: string, expectedRevision?: number): RevisionState {
    return this.remove(caller, candidateId, expectedRevision);
  }

  private singleCallerCenter(caller: CenterCaller): string {
    requireActive(caller);
    if (!isCenterContact(caller)) throw new CenterWorkflowError('FORBIDDEN', 'Center-contact role required');
    const centerIds = callerCenterIds(caller);
    if (centerIds.length !== 1 || !centerIds[0]) throw new CenterWorkflowError('INVALID_REQUEST', 'A center must be selected when a caller manages multiple centers');
    return centerIds[0];
  }

  private assertActiveCenter(centerId: string): void {
    const center = this.centers?.get(centerId);
    if (center && !center.active) throw new CenterWorkflowError('CONFLICT', 'Center is inactive', { centerId });
    if (this.centers && !center) throw new CenterWorkflowError('NOT_FOUND', 'Center not found', { centerId });
  }
}

export type CenterDirectoryOptions = {
  centers: CenterStore;
  users?: CenterUserStore;
  clock?: Clock;
  idGenerator?: IdGenerator;
};

export class CenterDirectoryService {
  private readonly centers: CenterStore;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;

  constructor(options: CenterDirectoryOptions) {
    this.centers = options.centers;
    this.clock = options.clock ?? systemClock;
    this.idGenerator = options.idGenerator ?? randomIds;
  }

  list(caller: CenterCaller): Center[] {
    requireActive(caller);
    if (!isAdministrator(caller)) {
      if (!isCenterContact(caller)) throw new CenterWorkflowError('FORBIDDEN', 'Center-contact role required');
      const allowed = callerCenterIds(caller);
      return this.centers.list().filter((center) => allowed.includes(center.id));
    }
    return this.centers.list();
  }

  create(caller: CenterCaller, name: string, expectedRevision?: number): Center {
    requireAdministrator(caller);
    const now = this.clock.now();
    const center: Center = { id: this.idGenerator.next('center'), name: name.trim(), active: true, revision: this.centers.revision().number + 1, createdAt: now, updatedAt: now };
    try {
      const checked = CenterSchema.parse(center);
      this.centers.upsert(checked, expectedRevision ?? this.centers.revision().number, caller.id, 'center-create');
      return checked;
    } catch (error) {
      if (error instanceof CenterWorkflowError) throw error;
      throw new CenterWorkflowError('INVALID_REQUEST', error instanceof Error ? error.message : 'Invalid center');
    }
  }

  update(caller: CenterCaller, centerId: string, update: { name?: string; active?: boolean }, expectedRevision?: number): Center {
    requireAdministrator(caller);
    const existing = this.centers.get(centerId);
    if (!existing) throw new CenterWorkflowError('NOT_FOUND', 'Center not found', { centerId });
    const center: Center = { ...existing, ...update, name: update.name?.trim() ?? existing.name, revision: this.centers.revision().number + 1, updatedAt: this.clock.now() };
    const checked = CenterSchema.parse(center);
    this.centers.upsert(checked, expectedRevision ?? existing.revision, caller.id, 'center-update');
    return checked;
  }
}

export class CenterUserService {
  constructor(private readonly users: CenterUserStore, private readonly centers: CenterStore) {}

  list(caller: CenterCaller): CenterUser[] {
    requireAdministrator(caller);
    return this.users.list();
  }

  upsert(caller: CenterCaller, user: CenterUser, expectedRevision?: number): CenterUser {
    requireAdministrator(caller);
    const centerIds = user.centerIds ?? [];
    for (const centerId of centerIds) {
      const center = this.centers.get(centerId);
      if (!center || !center.active) throw new CenterWorkflowError('INVALID_REQUEST', 'Center-contact users must reference active centers', { centerId });
    }
    if (!user.roles.includes('center-contact')) throw new CenterWorkflowError('INVALID_REQUEST', 'User must have center-contact role');
    const checked = CenterUserSchema.parse(user);
    this.users.upsert(checked, expectedRevision ?? this.users.revision().number, caller.id, 'center-user-upsert');
    return checked;
  }
}

export class CenterConfirmationService {
  private readonly coverageService: CandidateCoverageService;
  private readonly candidates: CandidateScheduleStore;
  private readonly sessions: SessionStoreLike<Session>;
  private readonly clock: Clock;

  constructor(options: {
    coverage: CandidateCoverageService;
    candidates: CandidateScheduleStore;
    sessions?: SessionStoreLike<Session>;
    clock?: Clock;
  }) {
    this.coverageService = options.coverage;
    this.candidates = options.candidates;
    this.sessions = options.sessions ?? new MemorySessionStore<Session>();
    this.clock = options.clock ?? systemClock;
  }

  confirm(caller: CenterCaller, candidateId: string, options: ConfirmationOptions = {}): ConfirmationResult {
    requireAdministrator(caller);
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new CenterWorkflowError('NOT_FOUND', 'Candidate schedule not found', { candidateId });
    const checkedCandidate = validateCandidateShape(candidate);
    if (checkedCandidate.status !== 'candidate') throw new CenterWorkflowError('CONFLICT', 'Candidate schedule is no longer pending confirmation', { candidateId, status: checkedCandidate.status });
    const expectedCandidateRevision = options.expectedRevision ?? checkedCandidate.revision;
    if (expectedCandidateRevision !== this.candidates.revision().number) {
      throw new CenterWorkflowError('STALE_REVISION', `Expected candidate revision ${expectedCandidateRevision}, current revision is ${this.candidates.revision().number}`, { candidateId, expectedRevision: expectedCandidateRevision, currentRevision: this.candidates.revision().number });
    }
    const requestedDates = options.occurrenceDates ?? options.dates ?? checkedCandidate.occurrenceDates ?? [options.nextOccurrenceDate ?? nextWeekdayDate(this.clock.now(), checkedCandidate.weekday)];
    const dates = validateDates(checkedCandidate.weekday, requestedDates);
    const currentSessions = this.sessions.list();
    const coverages = dates.map((date) => this.coverageService.compare(checkedCandidate, {
      date,
      sessions: currentSessions
    }));
    const failed = coverages.find((coverage) => !coverage.sufficient);
    if (failed) {
      throw new CenterWorkflowError('CONFLICT', 'Current candidate coverage is insufficient; confirmation was not created', {
        candidateId,
        requiredStaffCount: checkedCandidate.requestedStaffCount,
        matchingVolunteerCount: failed.matchingVolunteerCount,
        shortfall: failed.shortfall,
        coverage: failed
      });
    }
    const candidateAtDates: CandidateSchedule = { ...checkedCandidate, occurrenceDates: dates };
    const existingLocked = lockedOccurrenceForCandidate(candidateAtDates, currentSessions);
    if (existingLocked) {
      throw new CenterWorkflowError('CONFLICT', `A locked session already exists for this occurrence: ${existingLocked.id}`, {
        candidateId,
        existingSessionId: existingLocked.id
      });
    }
    const sessionRevision = this.sessions.revision().number;
    const occurrences: Session[] = dates.map((date, index) => ({
      id: `session-${checkedCandidate.id}-${date}`,
      kind: 'center',
      centerId: checkedCandidate.centerId,
      title: `Center session: ${checkedCandidate.centerId}`,
      date,
      start: checkedCandidate.start,
      end: checkedCandidate.end,
      timeZone: checkedCandidate.timeZone,
      requiredStaffCount: checkedCandidate.requestedStaffCount,
      status: 'locked',
      revision: sessionRevision + index + 1,

      sourceCandidateId: checkedCandidate.id
    }));
    const auditIds: string[] = [];
    for (const occurrence of occurrences) {
      const expected = this.sessions.revision().number;
      this.sessions.upsert(occurrence, expected, caller.id, 'center-candidate-confirm');
      const audits = this.sessions.audits();
      const audit = audits[audits.length - 1];
      if (audit) auditIds.push(audit.id);
    }
    const confirmed: CandidateSchedule = { ...checkedCandidate, status: 'confirmed', revision: this.candidates.revision().number + 1, updatedAt: this.clock.now() };
    this.candidates.upsert(confirmed, expectedCandidateRevision, caller.id, 'center-candidate-confirm');
    const candidateAudit = this.candidates.audits().at(-1);
    if (candidateAudit) auditIds.push(candidateAudit.id);
    return { candidate: confirmed, occurrences, sessions: occurrences, coverage: coverages, auditIds };
  }

  confirmCandidate(caller: CenterCaller, candidateId: string, options: ConfirmationOptions = {}): ConfirmationResult {
    return this.confirm(caller, candidateId, options);
  }
}

export function createCenterWorkflow(options: {
  centers?: CenterStore;
  users?: CenterUserStore;
  candidates?: CandidateScheduleStore;
  sessions?: SessionStoreLike<Session>;
  coverage: CoverageData | readonly Volunteer[];
  clock?: Clock;
  idGenerator?: IdGenerator;
}): {
  schedule: CenterScheduleService;
  coverage: CandidateCoverageService;
  confirmation: CenterConfirmationService;
  centers: CenterStore;
  users: CenterUserStore;
  candidates: CandidateScheduleStore;
  sessions: SessionStoreLike<Session>;
} {
  const centers = options.centers ?? new MemoryCenterStore();
  const users = options.users ?? new MemoryCenterUserStore();
  const candidates = options.candidates ?? new MemoryCandidateScheduleStore();
  const sessions = options.sessions ?? new MemorySessionStore<Session>();
  const coverage = new CandidateCoverageService(options.coverage);
  const schedule = new CenterScheduleService({ centers, users, candidates, sessions, clock: options.clock ?? systemClock, idGenerator: options.idGenerator ?? randomIds });
  const confirmation = new CenterConfirmationService({ coverage, candidates, sessions, clock: options.clock ?? systemClock });
  return { schedule, coverage, confirmation, centers, users, candidates, sessions };
}

export {
  CenterScheduleService as CandidateScheduleService,
  CandidateCoverageService as CoverageComparisonService,
  CenterConfirmationService as AdministratorConfirmationService
};
