import type { Assignment, AvailabilityException, Role, Session, User, Volunteer } from '../../shared/domain.js';
import type { AuthenticatedPrincipal } from './auth.js';

export type VolunteerSelfProjection = {
  id: string;
  name: string;
  email: string;
  lifecycleStatus: Volunteer['lifecycleStatus'];
  interviewStatus: Volunteer['interviewStatus'];
  readinessRank: Volunteer['readinessRank'];
  recurringAvailability: Volunteer['recurringAvailability'];
  revision: number;
  updatedAt: string;
};

export type AssignmentSelfProjection = Pick<Assignment, 'id' | 'sessionId' | 'scheduleRevision' | 'status' | 'createdAt' | 'cancelledAt' | 'cancellationReason'>;

export type SessionSelfProjection = Pick<Session, 'id' | 'kind' | 'centerId' | 'title' | 'date' | 'start' | 'end' | 'timeZone' | 'requiredStaffCount' | 'status'>;

export type AvailabilityExceptionSelfProjection = AvailabilityException;

export type AggregateVolunteerProjection = Pick<Volunteer, 'id' | 'name' | 'readinessRank'>;

export type IdentityProjection = {
  email: string;
  name?: string;
  role: Role;
  volunteerId?: string;
  centerId?: string;
};

export type VolunteerDashboardInput = {
  volunteer: Volunteer;
  exceptions?: readonly AvailabilityException[];
  assignments?: readonly Assignment[];
  sessions?: readonly Session[];
};

export type VolunteerDashboardProjection = {
  volunteer: VolunteerSelfProjection;
  exceptions: AvailabilityExceptionSelfProjection[];
  assignments: AssignmentSelfProjection[];
  sessions: SessionSelfProjection[];
};

function copyRecurringAvailability(volunteer: Volunteer): Volunteer['recurringAvailability'] {
  return volunteer.recurringAvailability.map((interval) => ({ ...interval }));
}

export function projectVolunteerSelf(volunteer: Volunteer): VolunteerSelfProjection {
  return {
    id: volunteer.id,
    name: volunteer.name,
    email: volunteer.email,
    lifecycleStatus: volunteer.lifecycleStatus,
    interviewStatus: volunteer.interviewStatus,
    readinessRank: volunteer.readinessRank,
    recurringAvailability: copyRecurringAvailability(volunteer),
    revision: volunteer.revision,
    updatedAt: volunteer.updatedAt
  };
}

export function projectAssignmentSelf(assignment: Assignment): AssignmentSelfProjection {
  const projection: AssignmentSelfProjection = {
    id: assignment.id,
    sessionId: assignment.sessionId,
    scheduleRevision: assignment.scheduleRevision,
    status: assignment.status,
    createdAt: assignment.createdAt
  };
  if (assignment.cancelledAt !== undefined) projection.cancelledAt = assignment.cancelledAt;
  if (assignment.cancellationReason !== undefined) projection.cancellationReason = assignment.cancellationReason;
  return projection;
}

export function projectSessionSelf(session: Session): SessionSelfProjection {
  const projection: SessionSelfProjection = {
    id: session.id,
    kind: session.kind,
    date: session.date,
    start: session.start,
    end: session.end,
    timeZone: session.timeZone,
    requiredStaffCount: session.requiredStaffCount,
    status: session.status
  };
  if (session.centerId !== undefined) projection.centerId = session.centerId;
  if (session.title !== undefined) projection.title = session.title;
  return projection;
}

export function projectAvailabilityExceptionSelf(exception: AvailabilityException): AvailabilityExceptionSelfProjection {
  return { ...exception, interval: { ...exception.interval } };
}

export function projectVolunteerDashboard(input: VolunteerDashboardInput): VolunteerDashboardProjection {
  const assignments = (input.assignments ?? []).filter((assignment) => assignment.volunteerId === input.volunteer.id);
  const sessionsById = new Map((input.sessions ?? []).map((session) => [session.id, session]));
  return {
    volunteer: projectVolunteerSelf(input.volunteer),
    exceptions: (input.exceptions ?? [])
      .filter((exception) => exception.volunteerId === input.volunteer.id)
      .map(projectAvailabilityExceptionSelf),
    assignments: assignments.map(projectAssignmentSelf),
    sessions: assignments
      .map((assignment) => sessionsById.get(assignment.sessionId))
      .filter((session): session is Session => session !== undefined)
      .map(projectSessionSelf)
  };
}

export function projectAggregateVolunteer(volunteer: Volunteer): AggregateVolunteerProjection {
  return { id: volunteer.id, name: volunteer.name, readinessRank: volunteer.readinessRank };
}

export function projectAggregateVolunteers(principal: AuthenticatedPrincipal, volunteers: readonly Volunteer[]): AggregateVolunteerProjection[] {
  if (!principal.user.roles.includes('administrator')) throw new Error('Administrator access is required.');
  return volunteers.map(projectAggregateVolunteer);
}

function primaryRole(roles: readonly Role[]): Role {
  if (roles.includes('administrator')) return 'administrator';
  if (roles.includes('center-contact')) return 'center-contact';
  return 'volunteer';
}

export function projectIdentity(principal: AuthenticatedPrincipal): IdentityProjection {
  const role = primaryRole(principal.user.roles);
  const identity: IdentityProjection = {
    email: principal.email,
    role,
    ...(principal.claims.name === undefined ? {} : { name: principal.claims.name })
  };
  if (principal.user.volunteerId !== undefined) identity.volunteerId = principal.user.volunteerId;
  if (role === 'center-contact' && principal.user.centerIds?.length === 1) identity.centerId = principal.user.centerIds[0];
  return identity;
}

export function projectCenterCandidateCoverage(
  principal: AuthenticatedPrincipal,
  candidates: readonly AggregateVolunteerProjection[]
): AggregateVolunteerProjection[] {
  if (!principal.user.roles.includes('administrator') && !principal.user.roles.includes('center-contact')) {
    throw new Error('Center-contact or administrator access is required.');
  }
  return candidates.map((candidate) => ({ ...candidate }));
}

export function assertOwnVolunteer(principal: AuthenticatedPrincipal, volunteerId: string): void {
  if (!principal.user.roles.includes('administrator') && principal.user.volunteerId !== volunteerId) {
    throw new Error('The requested volunteer record is not available.');
  }
}

export function projectUserForAdministrator(principal: AuthenticatedPrincipal, user: User): User {
  if (!principal.user.roles.includes('administrator')) throw new Error('Administrator access is required.');
  return { ...user, roles: [...user.roles], ...(user.centerIds ? { centerIds: [...user.centerIds] } : {}) };
}
