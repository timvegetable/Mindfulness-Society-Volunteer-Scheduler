import {
  isRankEligible,
  type Assignment,
  type AvailabilityException,
  type Backup,
  type Session,
  type Shortfall,
  type Volunteer
} from '../../shared/domain.js';
import { intervalsOverlap, isAvailableForSession } from '../../shared/time.js';
import { validateSessionInputs, type SchedulingInputError } from './inputs.js';

export type SchedulerInput = {
  volunteers: readonly Volunteer[];
  sessions: readonly Session[];
  exceptions?: readonly AvailabilityException[];
  /** Alias used by workbook-facing adapters. */
  availabilityExceptions?: readonly AvailabilityException[];
  /** Existing current assignments are considered for continuity and conflicts. */
  assignments?: readonly Assignment[];
  /** Aliases accepted by integrations that call these current assignments. */
  currentAssignments?: readonly Assignment[];
  existingAssignments?: readonly Assignment[];
  /** Revision attached to generated Assignment and Backup rows. */
  scheduleRevision?: number;
  /** Deterministic creation instant for newly generated rows. */
  createdAt?: string;
};

export type ScheduleSessionsOptions = Pick<SchedulerInput, 'exceptions' | 'availabilityExceptions' | 'assignments' | 'currentAssignments' | 'existingAssignments' | 'scheduleRevision' | 'createdAt'>;

export type CandidateVolunteer = {
  volunteerId: string;
  rank: 1 | 2 | 3;
  /** Existing assignment to this same session, used to minimize churn. */
  continuity: boolean;
};

export type ScheduleResult = {
  assignments: Assignment[];
  backups: Backup[];
  shortfalls: Shortfall[];
  /** Session IDs excluded because they are proposed/cancelled or not committed. */
  excludedSessionIds: string[];
  /** Active volunteers without a completed numeric rank. */
  ineligibleVolunteerIds: string[];
};

type OccupiedSession = { sessionId: string; session: Session };
type VolunteerMap = Map<string, Volunteer>;
type Occupancy = Map<string, OccupiedSession[]>;

const DEFAULT_CREATED_AT = '1970-01-01T00:00:00.000Z';

function isSchedulableVolunteer(volunteer: Volunteer): volunteer is Volunteer & { readinessRank: 1 | 2 | 3 } {
  return isRankEligible(volunteer)
    && (volunteer.readinessRank === 1 || volunteer.readinessRank === 2 || volunteer.readinessRank === 3);
}

function stableCompare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sessionOrder(left: Session, right: Session): number {
  return stableCompare(left.date, right.date)
    || stableCompare(left.start, right.start)
    || stableCompare(left.end, right.end)
    || stableCompare(left.id, right.id);
}

function isCommittedSession(session: Session): boolean {
  return (session.kind === 'center' && session.status === 'locked')
    || (session.kind === 'univ100' && session.status === 'confirmed');
}

function assignmentKey(sessionId: string, volunteerId: string): string {
  return `${sessionId}\u0000${volunteerId}`;
}
function addOccupancy(occupancy: Occupancy, volunteerId: string, session: Session): void {
  const rows = occupancy.get(volunteerId) ?? [];
  if (!rows.some((row) => row.sessionId === session.id)) rows.push({ sessionId: session.id, session });
  occupancy.set(volunteerId, rows);
}

function removeSessionOccupancy(occupancy: Occupancy, sessionId: string): void {
  for (const [volunteerId, rows] of occupancy) {
    const remaining = rows.filter((row) => row.sessionId !== sessionId);
    if (remaining.length === 0) occupancy.delete(volunteerId);
    else occupancy.set(volunteerId, remaining);
  }
}

function hasOverlap(session: Session, occupancy: Occupancy, volunteerId: string): boolean {
  const rows = occupancy.get(volunteerId) ?? [];
  return rows.some((row) => session.date === row.session.date
    && intervalsOverlap(session, row.session, session.date));
}

function sortedCandidates(candidates: readonly CandidateVolunteer[]): CandidateVolunteer[] {
  return [...candidates].sort((left, right) => left.rank - right.rank
    || Number(right.continuity) - Number(left.continuity)
    || stableCompare(left.volunteerId, right.volunteerId));
}

function sessionAssignments(
  session: Session,
  assignments: readonly Assignment[]
): Assignment[] {
  return assignments.filter((assignment) => assignment.sessionId === session.id && assignment.status === 'assigned');
}

function buildOccupancy(
  sessions: readonly Session[],
  assignments: readonly Assignment[],
  volunteers: VolunteerMap
): Occupancy {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const occupancy: Occupancy = new Map();
  for (const assignment of assignments) {
    if (assignment.status !== 'assigned') continue;
    const session = sessionById.get(assignment.sessionId);
    const volunteer = volunteers.get(assignment.volunteerId);
    if (!session || !isCommittedSession(session) || !volunteer || !isSchedulableVolunteer(volunteer)) continue;
    addOccupancy(occupancy, assignment.volunteerId, session);
  }
  return occupancy;
}

function candidateRows(
  session: Session,
  volunteers: readonly Volunteer[],
  exceptions: readonly AvailabilityException[],
  occupancy: Occupancy,
  assignments: readonly Assignment[]
): CandidateVolunteer[] {
  const sameSessionIds = new Set(sessionAssignments(session, assignments).map((assignment) => assignment.volunteerId));
  const candidates: CandidateVolunteer[] = [];
  const seenVolunteerIds = new Set<string>();
  for (const volunteer of volunteers) {
    if (seenVolunteerIds.has(volunteer.id)) continue;
    seenVolunteerIds.add(volunteer.id);
    if (!isSchedulableVolunteer(volunteer)) continue;
    const volunteerExceptions = exceptions.filter((exception) => exception.volunteerId === volunteer.id);
    if (!isAvailableForSession(session, volunteer.recurringAvailability, volunteerExceptions)) continue;
    if (hasOverlap(session, occupancy, volunteer.id)) continue;
    candidates.push({
      volunteerId: volunteer.id,
      rank: volunteer.readinessRank,
      continuity: sameSessionIds.has(volunteer.id)
    });
  }
  return sortedCandidates(candidates);
}

/**
 * Compute candidates for a session using the same complete-interval,
 * eligibility, overlap, rank, continuity, and ID ordering as a run.
 */
export function rankEligibleCandidates(
  session: Session,
  volunteers: readonly Volunteer[],
  options: ScheduleSessionsOptions & { sessions?: readonly Session[] } = {}
): CandidateVolunteer[] {
  const validated = validateSessionInputs([session])[0];
  if (!validated) throw new Error('Session is required');
  const allSessions = (options.sessions ?? [validated]).filter(isCommittedSession);
  const assignments = options.assignments ?? options.currentAssignments ?? options.existingAssignments ?? [];
  const volunteerMap = new Map(volunteers.map((volunteer) => [volunteer.id, volunteer]));
  const occupancy = buildOccupancy(allSessions, assignments, volunteerMap);
  // An existing assignment to the evaluated session is not a conflict with
  // itself; it is continuity evidence instead.
  removeSessionOccupancy(occupancy, validated.id);
  return candidateRows(validated, volunteers, options.exceptions ?? options.availabilityExceptions ?? [], occupancy, assignments);
}
export const eligibleCandidatesForSession = rankEligibleCandidates;


function createAssignment(
  session: Session,
  volunteerId: string,
  scheduleRevision: number,
  createdAt: string,
  existing: Map<string, Assignment>
): Assignment {
  const prior = existing.get(assignmentKey(session.id, volunteerId));
  return {
    id: prior?.id ?? `assignment:${session.id}:${volunteerId}`,
    sessionId: session.id,
    volunteerId,
    scheduleRevision,
    status: 'assigned',
    createdAt: prior?.createdAt ?? createdAt
  };
}

function createBackup(
  session: Session,
  volunteerId: string,
  position: number,
  scheduleRevision: number,
  existing: Map<string, Backup>
): Backup {
  const prior = existing.get(assignmentKey(session.id, volunteerId));
  return {
    id: prior?.id ?? `backup:${session.id}:${volunteerId}`,
    sessionId: session.id,
    volunteerId,
    scheduleRevision,
    position,
    status: 'available'
  };
}

/**
 * Pure deterministic scheduler. It never mutates inputs, proposed sessions,
 * or existing assignment rows. Every committed session is evaluated in a
 * stable chronological/ID order, with rank first, continuity second, and ID
 * last. Existing assignments reserve their occurrences until that occurrence
 * is evaluated, at which point its own rows are replaced by the new result.
 */
export function scheduleSessions(input: SchedulerInput): ScheduleResult;
export function scheduleSessions(
  volunteers: readonly Volunteer[],
  sessions: readonly Session[],
  options?: ScheduleSessionsOptions
): ScheduleResult;
export function scheduleSessions(
  inputOrVolunteers: SchedulerInput | readonly Volunteer[],
  sessionsArgument?: readonly Session[],
  optionsArgument: ScheduleSessionsOptions = {}
): ScheduleResult {
  const input: SchedulerInput = Array.isArray(inputOrVolunteers)
    ? { volunteers: inputOrVolunteers as readonly Volunteer[], sessions: sessionsArgument ?? [], ...optionsArgument }
    : inputOrVolunteers as SchedulerInput;
  const volunteers = [...input.volunteers];
  const validatedSessions = validateSessionInputs(input.sessions);
  const exceptions = input.exceptions ?? input.availabilityExceptions ?? [];
  const assignments = input.assignments ?? input.currentAssignments ?? input.existingAssignments ?? [];
  const committedSessions = validatedSessions.filter(isCommittedSession).sort(sessionOrder);
  const excludedSessionIds = validatedSessions
    .filter((session) => !isCommittedSession(session))
    .map((session) => session.id)
    .sort((left, right) => stableCompare(left, right));
  const ineligibleVolunteerIds = volunteers
    .filter((volunteer) => !isSchedulableVolunteer(volunteer))
    .map((volunteer) => volunteer.id)
    .sort((left, right) => stableCompare(left, right));
  const scheduleRevision = input.scheduleRevision ?? 0;
  const createdAt = input.createdAt ?? DEFAULT_CREATED_AT;
  const volunteerMap = new Map(volunteers.map((volunteer) => [volunteer.id, volunteer]));
  const occupancy = buildOccupancy(committedSessions, assignments, volunteerMap);
  const priorAssignments = new Map<string, Assignment>();
  for (const assignment of assignments) {
    if (assignment.status === 'assigned') priorAssignments.set(assignmentKey(assignment.sessionId, assignment.volunteerId), assignment);
  }
  const priorBackups = new Map<string, Backup>();
  const result: ScheduleResult = {
    assignments: [],
    backups: [],
    shortfalls: [],
    excludedSessionIds,
    ineligibleVolunteerIds
  };

  for (const session of committedSessions) {
    removeSessionOccupancy(occupancy, session.id);
    const candidates = candidateRows(session, volunteers, exceptions, occupancy, assignments);
    const selected = candidates.slice(0, session.requiredStaffCount);
    for (const candidate of selected) {
      result.assignments.push(createAssignment(session, candidate.volunteerId, scheduleRevision, createdAt, priorAssignments));
      addOccupancy(occupancy, candidate.volunteerId, session);
    }
    if (selected.length < session.requiredStaffCount) {
      result.shortfalls.push({
        sessionId: session.id,
        required: session.requiredStaffCount,
        assigned: selected.length,
        unfilled: session.requiredStaffCount - selected.length
      });
    }
    const selectedIds = new Set(selected.map((candidate) => candidate.volunteerId));
    const backups = candidates.filter((candidate) => !selectedIds.has(candidate.volunteerId));
    const uniqueBackups = new Set<string>();
    let position = 1;
    for (const candidate of backups) {
      // Keep one row per volunteer even if malformed source data repeated it.
      if (uniqueBackups.has(candidate.volunteerId)) continue;
      uniqueBackups.add(candidate.volunteerId);
      result.backups.push(createBackup(session, candidate.volunteerId, position, scheduleRevision, priorBackups));
      position += 1;
    }
  }
  return result;
}

/** Alias for callers that use "run" to describe the pure calculation. */
export const runSchedulingAlgorithm = scheduleSessions;

export function isSessionSchedulable(session: Session): boolean {
  return isCommittedSession(session);
}

export type { SchedulingInputError };
