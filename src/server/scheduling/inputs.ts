import { SessionSchema, type Session } from '../../shared/domain.js';

export class SchedulingInputError extends Error {
  readonly code = 'INVALID_REQUEST' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SchedulingInputError';
  }
}

/**
 * SessionSchema intentionally rejects a proposed UNIV100 session because it
 * is not schedulable.  Inputs still need to be inspectable for advisory
 * coverage, so this validator validates its shape while retaining proposal
 * status for that boundary.
 */
export function validateSessionInput(value: unknown): Session {
  if (!value || typeof value !== 'object') {
    throw new SchedulingInputError('Session must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const status = candidate.status;
  const parseCandidate = status === 'proposed'
    ? { ...candidate, status: 'confirmed' }
    : candidate;
  const parsed = SessionSchema.safeParse(parseCandidate);
  if (!parsed.success) {
    throw new SchedulingInputError(`Invalid session input: ${parsed.error.message}`);
  }
  if (status === 'proposed') return { ...parsed.data, status: 'proposed' } as Session;
  return parsed.data;
}

export function validateLockedCenterSession(value: unknown): Session {
  const session = validateSessionInput(value);
  if (session.kind !== 'center' || session.status !== 'locked') {
    throw new SchedulingInputError('Only locked center sessions are committed center inputs');
  }
  return session;
}

export function validateConfirmedUniv100Session(value: unknown): Session {
  const session = validateSessionInput(value);
  if (session.kind !== 'univ100' || session.status !== 'confirmed') {
    throw new SchedulingInputError('Only confirmed UNIV100 sessions are committed class inputs');
  }
  return session;
}

/** Validate all rows, allowing proposals to remain outside a committed run. */
export function validateSessionInputs(values: readonly unknown[]): Session[] {
  return values.map((value) => validateSessionInput(value));
}

/** Return only the immutable, schedulable session kinds. */
export function validateCommittedSessionInputs(values: readonly unknown[]): Session[] {
  return validateSessionInputs(values).filter((session) => {
    if (session.kind === 'center') {
      if (session.status !== 'locked') {
        throw new SchedulingInputError(`Center session ${session.id} must be locked`);
      }
      return true;
    }
    if (session.status === 'proposed') return false;
    if (session.status !== 'confirmed') {
      throw new SchedulingInputError(`UNIV100 session ${session.id} must be confirmed`);
    }
    return true;
  });
}

/**
 * Locked occurrence fields cannot be changed by a scheduling or center
 * operation.  Comparing an explicit whitelist avoids allowing an accidental
 * title/status update to alter an occurrence's identity.
 */
export function assertLockedSessionUnchanged(previous: Session, next: Session): void {
  validateLockedCenterSession(previous);
  validateLockedCenterSession(next);
  const immutableFields: readonly (keyof Session)[] = [
    'id', 'kind', 'centerId', 'date', 'start', 'end', 'timeZone', 'requiredStaffCount'
  ];
  for (const field of immutableFields) {
    if (previous[field] !== next[field]) {
      throw new SchedulingInputError(`Locked session field ${String(field)} cannot change`);
    }
  }
}

// Compatibility aliases make the boundary explicit to Apps Script callers.
export const validateLockedSessionInput = validateLockedCenterSession;
export const validateConfirmedClassInput = validateConfirmedUniv100Session;
export const assertLockedInputUnchanged = assertLockedSessionUnchanged;
