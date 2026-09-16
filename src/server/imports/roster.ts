import { normalizeRank, type InterviewStatus, type LifecycleStatus, type Rank, type Volunteer } from '../../shared/domain.js';
import type { AdministratorActor, Clock, RosterRepository } from './types.js';

export class RosterAuthorizationError extends Error {
  constructor(message = 'Administrator role is required') {
    super(message);
    this.name = 'RosterAuthorizationError';
  }
}

function requireAdministrator(actor: AdministratorActor): void {
  if (!actor.id || !actor.roles.includes('administrator')) throw new RosterAuthorizationError();
}

function stableId(input: string): string {
  let hash = 2166136261;
  for (const character of input) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `vol-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

export type RosterUpdateResult = {
  volunteer: Volunteer;
  revision: number;
};

export type CreateNewJoinerInput = {
  name: string;
  email?: string;
  source?: string;
  sourceParticipantId?: string;
};

export class AdministratorRosterService {
  constructor(private readonly repository: RosterRepository, private readonly clock: Clock = { now: () => new Date().toISOString() }) {}

  list(actor: AdministratorActor): Volunteer[] {
    requireAdministrator(actor);
    return this.repository.list().map((volunteer) => ({ ...volunteer, recurringAvailability: [...volunteer.recurringAvailability] }));
  }

  get(actor: AdministratorActor, volunteerId: string): Volunteer | undefined {
    requireAdministrator(actor);
    const volunteer = this.repository.get(volunteerId);
    return volunteer ? { ...volunteer, recurringAvailability: [...volunteer.recurringAvailability] } : undefined;
  }

  setLifecycle(actor: AdministratorActor, volunteerId: string, lifecycleStatus: LifecycleStatus, expectedRevision: number): RosterUpdateResult {
    requireAdministrator(actor);
    const volunteer = this.requireVolunteer(volunteerId);
    const updated = { ...volunteer, lifecycleStatus, revision: expectedRevision + 1, updatedAt: this.clock.now() };
    const revision = this.repository.upsert(updated, expectedRevision, actor.id, 'admin-roster-lifecycle');
    return { volunteer: updated, revision: revision.number };
  }

  setInterviewStatus(actor: AdministratorActor, volunteerId: string, interviewStatus: InterviewStatus, expectedRevision: number): RosterUpdateResult {
    requireAdministrator(actor);
    const volunteer = this.requireVolunteer(volunteerId);
    const readinessRank = interviewStatus === 'complete' ? volunteer.readinessRank : null;
    const updated = { ...volunteer, interviewStatus, readinessRank, revision: expectedRevision + 1, updatedAt: this.clock.now() };
    const revision = this.repository.upsert(updated, expectedRevision, actor.id, 'admin-roster-interview-status');
    return { volunteer: updated, revision: revision.number };
  }

  setRank(actor: AdministratorActor, volunteerId: string, label: string | number | null, expectedRevision: number): RosterUpdateResult {
    requireAdministrator(actor);
    const volunteer = this.requireVolunteer(volunteerId);
    const readinessRank = normalizeRank(label);
    if (label !== null && readinessRank === null) throw new Error('Rank must be Primary, Secondary, Tertiary, or a number from 1 to 3');
    const updated = { ...volunteer, readinessRank, revision: expectedRevision + 1, updatedAt: this.clock.now() };
    const revision = this.repository.upsert(updated, expectedRevision, actor.id, 'admin-roster-ranking');
    return { volunteer: updated, revision: revision.number };
  }

  updateLifecycle(actor: AdministratorActor, volunteerId: string, lifecycleStatus: LifecycleStatus, expectedRevision: number): RosterUpdateResult {
    return this.setLifecycle(actor, volunteerId, lifecycleStatus, expectedRevision);
  }

  updateInterviewStatus(actor: AdministratorActor, volunteerId: string, interviewStatus: InterviewStatus, expectedRevision: number): RosterUpdateResult {
    return this.setInterviewStatus(actor, volunteerId, interviewStatus, expectedRevision);
  }

  updateReadinessRank(actor: AdministratorActor, volunteerId: string, label: string | number | null, expectedRevision: number): RosterUpdateResult {
    return this.setRank(actor, volunteerId, label, expectedRevision);
  }

  createNewlyJoined(actor: AdministratorActor, input: CreateNewJoinerInput, expectedRevision: number): RosterUpdateResult {
    requireAdministrator(actor);
    const name = input.name.trim();
    if (!name) throw new Error('Volunteer name is required');
    const email = input.email ? emailKey(input.email) : `${stableId(`${input.source ?? 'whenisgood'}:${input.sourceParticipantId ?? name}`)}@unlinked.invalid`;
    if (this.repository.list().some((volunteer) => emailKey(volunteer.email) === email)) throw new Error(`Volunteer email ${email} is already in the roster`);
    const now = this.clock.now();
    const volunteer: Volunteer = {
      id: stableId(`${email}:${name}`),
      name,
      email,
      lifecycleStatus: 'newly-joined',
      interviewStatus: 'incomplete',
      readinessRank: null,
      recurringAvailability: [],
      revision: expectedRevision + 1,
      source: input.source,
      createdAt: now,
      updatedAt: now
    };
    const revision = this.repository.upsert(volunteer, expectedRevision, actor.id, 'admin-roster-new-joiner');
    return { volunteer, revision: revision.number };
  }

  private requireVolunteer(volunteerId: string): Volunteer {
    const volunteer = this.repository.get(volunteerId);
    if (!volunteer) throw new Error(`Volunteer ${volunteerId} was not found`);
    return volunteer;
  }
}

export { requireAdministrator };
