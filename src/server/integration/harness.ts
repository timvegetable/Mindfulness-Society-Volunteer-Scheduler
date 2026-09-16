import { z } from 'zod';
import { WeekdaySchema, type ApiResponse, type Assignment, type AvailabilityException, type Session, type User, type Volunteer } from '../../shared/domain.js';
import {
  INTEGRATION_OPERATIONS,
  IntegrationError,
  MemoryRevisionSource,
  MemoryWriteLock,
  createIntegrationDispatcher,
  type IntegrationDispatcher,
  type IntegrationDispatcherOptions,
  type HandlerContext,
  type OperationHandlers
} from './dispatcher.js';
import { MemoryTokenVerifier, MemoryUserDirectory, type VerifiedIdentityClaims } from './auth.js';
import {
  projectAggregateVolunteers,
  projectIdentity,
  projectVolunteerDashboard
} from './projections.js';

const recurringPayload = z.object({ intervals: z.array(z.object({
  weekday: WeekdaySchema,
  start: z.string(),
  end: z.string(),
  timeZone: z.string()
})) });
const exceptionPayload = z.object({
  id: z.string().optional(),
  date: z.string(),
  kind: z.enum(['unavailable', 'available']),
  interval: z.object({ start: z.string(), end: z.string(), timeZone: z.string() }),
  reason: z.string().optional()
});
const cancelPayload = z.object({ assignmentId: z.string(), reason: z.string().optional() });

type HarnessState = {
  volunteer: Volunteer;
  exceptions: AvailabilityException[];
  assignments: Assignment[];
  sessions: Session[];
};

export type IntegrationHarness = Readonly<{
  dispatcher: IntegrationDispatcher;
  verifier: MemoryTokenVerifier;
  users: MemoryUserDirectory;
  revision: MemoryRevisionSource;
  lock: MemoryWriteLock;
  state: HarnessState;
  credentials: Readonly<{ volunteer: string; administrator: string; center: string }>;
}>;

export type HarnessScenarioResults = Readonly<{
  unauthorized: ApiResponse<unknown>;
  wrongRole: ApiResponse<unknown>;
  staleRevision: ApiResponse<unknown>;
  duplicateRequest: Readonly<{ first: ApiResponse<unknown>; second: ApiResponse<unknown> }>;
  concurrentWrite: ApiResponse<unknown>;
}>;

function claim(email: string, subject: string): VerifiedIdentityClaims {
  return {
    iss: 'https://accounts.google.com',
    aud: 'harness-client',
    sub: subject,
    email,
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000)
  };
}

function now(): string {
  return new Date().toISOString();
}

function makeVolunteer(): Volunteer {
  const timestamp = now();
  return {
    id: 'volunteer-1',
    name: 'Alex Example',
    email: 'alex@example.test',
    lifecycleStatus: 'active',
    interviewStatus: 'complete',
    readinessRank: 1,
    recurringAvailability: [{ weekday: 2, start: '09:00', end: '12:00', timeZone: 'America/Los_Angeles' }],
    revision: 0,
    source: 'harness',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function makeUser(id: string, email: string, roles: User['roles'], extras: { volunteerId?: string; centerIds?: string[] } = {}): User {
  return {
    id,
    email,
    roles,
    ...(extras.volunteerId === undefined ? {} : { volunteerId: extras.volunteerId }),
    ...(extras.centerIds === undefined ? {} : { centerIds: extras.centerIds }),
    active: true,
    revision: 0
  };
}

function handlersFor(state: HarnessState, revision: MemoryRevisionSource): OperationHandlers {
  const handlers: OperationHandlers = {
    [INTEGRATION_OPERATIONS.me]: ({ actor }: HandlerContext) => projectIdentity(actor),
    [INTEGRATION_OPERATIONS.volunteerDashboard]: ({ actor }: HandlerContext) => {
      const volunteerId = actor.user.volunteerId;
      if (!volunteerId || volunteerId !== state.volunteer.id) throw new IntegrationError('FORBIDDEN', 'Your account is not linked to a volunteer record.');
      return projectVolunteerDashboard({ volunteer: state.volunteer, exceptions: state.exceptions, assignments: state.assignments, sessions: state.sessions });
    },
    [INTEGRATION_OPERATIONS.recurringAvailabilityUpdate]: ({ actor }: HandlerContext, payload: unknown) => {
      if (actor.user.volunteerId !== state.volunteer.id) throw new IntegrationError('FORBIDDEN', 'Your account is not linked to a volunteer record.');
      const value = recurringPayload.parse(payload);
      const nextRevision = revision.current() + 1;
      state.volunteer = { ...state.volunteer, recurringAvailability: value.intervals, revision: nextRevision, updatedAt: now() };
      return projectVolunteerDashboard({ volunteer: state.volunteer, exceptions: state.exceptions, assignments: state.assignments, sessions: state.sessions });
    },
    [INTEGRATION_OPERATIONS.availabilityExceptionCreate]: ({ actor }: HandlerContext, payload: unknown) => {
      if (actor.user.volunteerId !== state.volunteer.id) throw new IntegrationError('FORBIDDEN', 'Your account is not linked to a volunteer record.');
      const value = exceptionPayload.parse(payload);
      const exception: AvailabilityException = {
        id: value.id ?? `exception-${revision.current() + 1}`,
        volunteerId: state.volunteer.id,
        date: value.date,
        kind: value.kind,
        interval: value.interval,
        ...(value.reason === undefined ? {} : { reason: value.reason }),
        revision: revision.current() + 1
      };
      state.exceptions = [...state.exceptions, exception];
      return exception;
    },
    [INTEGRATION_OPERATIONS.assignmentCancel]: ({ actor }: HandlerContext, payload: unknown) => {
      const value = cancelPayload.parse(payload);
      const index = state.assignments.findIndex((assignment) => assignment.id === value.assignmentId && assignment.volunteerId === actor.user.volunteerId);
      if (index < 0) throw new IntegrationError('NOT_FOUND', 'Assignment was not found.');
      const assignment = state.assignments[index]!;
      const cancelled: Assignment = {
        ...assignment,
        status: 'cancelled',
        cancelledAt: now(),
        ...(value.reason === undefined ? {} : { cancellationReason: value.reason })
      };
      state.assignments = state.assignments.map((candidate, candidateIndex) => candidateIndex === index ? cancelled : candidate);
      return { assignment: cancelled };
    },
    [INTEGRATION_OPERATIONS.adminSchedule]: () => ({ assignments: state.assignments, sessions: state.sessions, revision: revision.current() }),
    [INTEGRATION_OPERATIONS.adminScheduleRerun]: () => ({ status: 'completed', revision: revision.current() + 1 }),
    [INTEGRATION_OPERATIONS.adminImportPreview]: (_context: HandlerContext, payload: unknown) => ({ status: 'staged', ...(payload as { resultsCode: string }) }),
    [INTEGRATION_OPERATIONS.adminImportPromote]: (_context: HandlerContext, payload: unknown) => ({ status: 'completed', ...(payload as { resultsCode: string }) }),
    [INTEGRATION_OPERATIONS.adminInsights]: ({ actor }: HandlerContext) => ({ volunteers: projectAggregateVolunteers(actor, [state.volunteer]), revision: revision.current() }),
    [INTEGRATION_OPERATIONS.adminInsightsRefresh]: () => ({ status: 'current', revision: revision.current() + 1 }),
    [INTEGRATION_OPERATIONS.centerCandidate]: ({ actor }: HandlerContext) => ({ centerIds: actor.user.centerIds ?? [], candidates: [] }),
    [INTEGRATION_OPERATIONS.centerCandidateUpdate]: ({ actor }: HandlerContext, payload: unknown) => ({ actorId: actor.user.id, centerIds: actor.user.centerIds ?? [], candidate: payload }),
    [INTEGRATION_OPERATIONS.adminCenterCandidateConfirm]: (_context: HandlerContext, payload: unknown) => ({ status: 'confirmed', ...(payload as { candidateId: string }) })
  };
  return handlers;
}

export function createInMemoryIntegrationHarness(
  overrides: Partial<Omit<IntegrationDispatcherOptions, 'verifier' | 'users' | 'handlers' | 'revision' | 'writeLock'>> = {}
): IntegrationHarness {
  const volunteer = makeVolunteer();
  const users = new MemoryUserDirectory([
    makeUser('user-volunteer', volunteer.email, ['volunteer'], { volunteerId: volunteer.id }),
    makeUser('user-admin', 'admin@example.test', ['administrator']),
    makeUser('user-center', 'center@example.test', ['center-contact'], { centerIds: ['center-1'] })
  ]);
  const verifier = new MemoryTokenVerifier({
    'token-volunteer': claim(volunteer.email, 'subject-volunteer'),
    'token-admin': claim('admin@example.test', 'subject-admin'),
    'token-center': claim('center@example.test', 'subject-center')
  });
  const revision = new MemoryRevisionSource();
  const lock = new MemoryWriteLock();
  const state: HarnessState = { volunteer, exceptions: [], assignments: [], sessions: [] };
  const dispatcher = createIntegrationDispatcher({
    ...overrides,
    verifier,
    users,
    revision,
    writeLock: lock,
    handlers: handlersFor(state, revision)
  });
  return { dispatcher, verifier, users, revision, lock, state, credentials: { volunteer: 'token-volunteer', administrator: 'token-admin', center: 'token-center' } };
}

export async function runIntegrationHarnessScenarios(): Promise<HarnessScenarioResults> {
  const harness = createInMemoryIntegrationHarness();
  const unauthorized = await harness.dispatcher.dispatch({ operation: INTEGRATION_OPERATIONS.me, payload: {}, idempotencyKey: 'unauthorized-1', credential: 'not-valid' });
  const wrongRole = await harness.dispatcher.dispatch({ operation: INTEGRATION_OPERATIONS.adminSchedule, payload: {}, idempotencyKey: 'wrong-role-1', credential: harness.credentials.volunteer });
  const staleRevision = await harness.dispatcher.dispatch({ operation: INTEGRATION_OPERATIONS.recurringAvailabilityUpdate, payload: { intervals: [] }, expectedRevision: 99, idempotencyKey: 'stale-revision-1', credential: harness.credentials.volunteer });
  const duplicateInput = { operation: INTEGRATION_OPERATIONS.adminSchedule, payload: {}, idempotencyKey: 'duplicate-1', credential: harness.credentials.administrator };
  const first = await harness.dispatcher.dispatch(duplicateInput);
  const second = await harness.dispatcher.dispatch(duplicateInput);
  harness.lock.hold();
  const concurrentWrite = await harness.dispatcher.dispatch({ operation: INTEGRATION_OPERATIONS.recurringAvailabilityUpdate, payload: { intervals: [] }, expectedRevision: 0, idempotencyKey: 'concurrent-1', credential: harness.credentials.volunteer });
  harness.lock.release();
  return { unauthorized, wrongRole, staleRevision, duplicateRequest: { first, second }, concurrentWrite };
}
