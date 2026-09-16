import type {
  Assignment,
  AvailabilityException,
  Session,
  Volunteer
} from '../../shared/domain.js';
import { isRankEligible } from '../../shared/domain.js';
import { intervalsOverlap } from '../../shared/time.js';
import { rankEligibleCandidates, type CandidateVolunteer } from './scheduler.js';
import { SchedulingInputError, validateSessionInput } from './inputs.js';
export type CoverageInput = {
  session?: Session;
  sessions?: readonly Session[];
  volunteers: readonly Volunteer[];
  exceptions?: readonly AvailabilityException[];
  availabilityExceptions?: readonly AvailabilityException[];
  assignments?: readonly Assignment[];
  currentAssignments?: readonly Assignment[];
  existingAssignments?: readonly Assignment[];
};

export type CoverageEvaluation = {
  sessionId: string;
  kind: Session['kind'];
  status: Session['status'];
  requiredStaffCount: number;
  /** Candidates cover the complete interval and are ordered by scheduler rules. */
  candidates: CandidateVolunteer[];
  eligibleVolunteerIds: string[];
  availableCount: number;
  shortfall: number;
  sufficient: boolean;
  /** Proposed classes become promises only after this is true and confirmation. */
  canConfirm: boolean;
};

export type CoverageReport = {
  evaluations: CoverageEvaluation[];
  results: CoverageEvaluation[];
  sufficient: boolean;
  canConfirm: boolean;
  insufficientSessionIds: string[];
};

function candidateHasNoConflict(
  candidate: CandidateVolunteer,
  session: Session,
  sessions: readonly Session[],
  assignments: readonly Assignment[]
): boolean {
  const assignedSessionIds = new Set(assignments
    .filter((assignment) => assignment.status === 'assigned' && assignment.volunteerId === candidate.volunteerId)
    .map((assignment) => assignment.sessionId));
  return !sessions.some((other) => other.id !== session.id
    && other.date === session.date
    && assignedSessionIds.has(other.id)
    && (other.status === 'locked' || (other.kind === 'univ100' && other.status === 'confirmed'))
    && intervalsOverlap(session, other, session.date));
}

function evaluateOne(input: CoverageInput, session: Session): CoverageEvaluation {
  const exceptions = input.exceptions ?? input.availabilityExceptions ?? [];
  const assignments = input.assignments ?? input.currentAssignments ?? input.existingAssignments ?? [];
  const allSessions = input.sessions ?? [session];
  // rankEligibleCandidates applies all eligibility, full-session availability,
  // and stable ordering. It also excludes currently assigned conflicts.
  const candidates = rankEligibleCandidates(session, input.volunteers, {
    exceptions,
    assignments,
    sessions: allSessions
  }).filter((candidate) => candidateHasNoConflict(candidate, session, allSessions, assignments));
  // A supplied session list may omit a session referenced by an assignment;
  // retain safety by excluding only conflicts we can compare exactly.
  const availableCount = candidates.length;
  const shortfall = Math.max(0, session.requiredStaffCount - availableCount);
  return {
    sessionId: session.id,
    kind: session.kind,
    status: session.status,
    requiredStaffCount: session.requiredStaffCount,
    candidates,
    eligibleVolunteerIds: candidates.map((candidate) => candidate.volunteerId),
    availableCount,
    shortfall,
    sufficient: availableCount >= session.requiredStaffCount,
    canConfirm: session.kind !== 'univ100' || session.status !== 'proposed' || availableCount >= session.requiredStaffCount
  };
}

/**
 * Advisory coverage uses the exact same candidate rules as scheduling but does
 * not create assignments. Proposed UNIV100 sessions are intentionally valid
 * here, even though they are excluded from committed scheduling.
 */
export function evaluateCoverage(input: CoverageInput): CoverageReport {
  const rawSessions = input.sessions ?? (input.session ? [input.session] : []);
  if (rawSessions.length === 0) throw new SchedulingInputError('At least one session is required for coverage evaluation');
  const sessions = rawSessions.map((session) => validateSessionInput(session));
  const evaluations = sessions.map((session) => evaluateOne(input, session));
  const insufficientSessionIds = evaluations
    .filter((evaluation) => !evaluation.sufficient)
    .map((evaluation) => evaluation.sessionId);
  const sufficient = insufficientSessionIds.length === 0;
  return {
    evaluations,
    results: evaluations,
    sufficient,
    canConfirm: evaluations.every((evaluation) => evaluation.canConfirm),
    insufficientSessionIds
  };
}

export function evaluateSessionCoverage(input: CoverageInput): CoverageEvaluation;
export function evaluateSessionCoverage(
  session: Session,
  volunteers: readonly Volunteer[],
  options?: Omit<CoverageInput, 'session' | 'sessions' | 'volunteers'>
): CoverageEvaluation;
export function evaluateSessionCoverage(
  sessionOrInput: Session | CoverageInput,
  volunteersArgument?: readonly Volunteer[],
  optionsArgument: Omit<CoverageInput, 'session' | 'sessions' | 'volunteers'> = {}
): CoverageEvaluation {
  const report = 'volunteers' in sessionOrInput
    ? evaluateCoverage(sessionOrInput)
    : evaluateCoverage({ ...optionsArgument, session: sessionOrInput, volunteers: volunteersArgument ?? [] });
  const evaluation = report.evaluations[0];
  if (!evaluation) throw new SchedulingInputError('Coverage evaluation did not produce a result');
  return evaluation;
}

/*
 * Kept as a named function rather than a direct alias so both object and
 * positional forms remain discoverable in generated Apps Script declarations.
 */
export const sessionCoverage = evaluateSessionCoverage;

/**
 * Confirm a proposed UNIV100 occurrence only after fresh advisory coverage
 * demonstrates enough currently eligible people. The returned object is new;
 * the proposal and its input arrays are never mutated.
 */
export function confirmUniv100Session(session: Session, input: Omit<CoverageInput, 'session' | 'sessions'>): Session {
  const candidate = validateSessionInput(session);
  if (candidate.kind !== 'univ100' || candidate.status !== 'proposed') {
    throw new SchedulingInputError('Only proposed UNIV100 sessions can be confirmed through this boundary');
  }
  const evaluation = evaluateSessionCoverage(candidate, input.volunteers, input);
  if (!evaluation.sufficient) {
    throw new SchedulingInputError(`UNIV100 session ${candidate.id} is short by ${evaluation.shortfall} eligible volunteer(s)`);
  }
  return { ...candidate, status: 'confirmed' };
}

export const confirmCoveredUniv100Session = confirmUniv100Session;
export const assertCoverageForConfirmation = confirmUniv100Session;

export function canConfirmUniv100Session(
  session: Session,
  input: Omit<CoverageInput, 'session' | 'sessions'>
): boolean {
  try {
    confirmUniv100Session(session, input);
    return true;
  } catch (error) {
    if (error instanceof SchedulingInputError) return false;
    throw error;
  }
}

/** A helper for callers that need to inspect rank eligibility independently. */
export function coverageEligibleVolunteerIds(volunteers: readonly Volunteer[]): string[] {
  return volunteers
    .filter((volunteer) => isRankEligible(volunteer)
      && (volunteer.readinessRank === 1 || volunteer.readinessRank === 2 || volunteer.readinessRank === 3))
    .map((volunteer) => volunteer.id);
}
