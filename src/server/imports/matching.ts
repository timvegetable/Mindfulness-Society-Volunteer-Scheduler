import type { Volunteer } from '../../shared/domain.js';
import { requireAdministrator } from './roster.js';
import type {
  AdministratorActor,
  Clock,
  IdentityMapping,
  IdentityMatch,
  IdentityMatchResult,
  IdentityQueueEntry,
  ImportRepository,
  ParsedParticipant
} from './types.js';

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function normalizedEmail(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function sourceMappingKey(participant: Pick<ParsedParticipant, 'sourceParticipantId' | 'email' | 'name'>): string[] {
  const keys = [`id:${participant.sourceParticipantId}`];
  if (participant.email) keys.push(`email:${normalizedEmail(participant.email)}`);
  keys.push(`name:${normalizedName(participant.name)}`);
  return keys;
}

function queue(participant: ParsedParticipant, reason: IdentityQueueEntry['reason'], candidateVolunteerIds: string[], message: string): IdentityQueueEntry {
  return { participant, reason, candidateVolunteerIds, message };
}

export class IdentityMatcher {
  private readonly byEmail = new Map<string, Volunteer[]>();
  private readonly byName = new Map<string, Volunteer[]>();
  private readonly byMappingKey = new Map<string, IdentityMapping>();

  constructor(private readonly volunteers: readonly Volunteer[], mappings: readonly IdentityMapping[] = []) {
    for (const volunteer of volunteers) {
      const email = normalizedEmail(volunteer.email);
      const emailRows = this.byEmail.get(email) ?? [];
      emailRows.push(volunteer);
      this.byEmail.set(email, emailRows);
      const name = normalizedName(volunteer.name);
      const nameRows = this.byName.get(name) ?? [];
      nameRows.push(volunteer);
      this.byName.set(name, nameRows);
    }
    for (const mapping of mappings) {
      for (const key of sourceMappingKey({ sourceParticipantId: mapping.sourceParticipantId ?? '', email: mapping.sourceEmail, name: mapping.sourceName ?? '' })) {
        if (key !== 'id:' && key !== 'email:' && key !== 'name:') this.byMappingKey.set(`${mapping.source}:${key}`, mapping);
      }
    }
  }

  match(participants: readonly ParsedParticipant[]): IdentityMatchResult {
    const matched: IdentityMatch[] = [];
    const queueEntries: IdentityQueueEntry[] = [];
    for (const participant of participants) {
      const emailCandidates = participant.email ? this.byEmail.get(normalizedEmail(participant.email)) ?? [] : [];
      if (emailCandidates.length === 1) {
        const volunteer = emailCandidates[0];
        if (volunteer) matched.push({ participant, volunteerId: volunteer.id, method: 'email' });
        continue;
      }
      if (emailCandidates.length > 1) {
        queueEntries.push(queue(participant, 'ambiguous', emailCandidates.map((candidate) => candidate.id), 'The participant email matches more than one roster record'));
        continue;
      }

      const mapping = this.mappingFor(participant);
      if (mapping) {
        const mappedVolunteer = this.volunteers.find((volunteer) => volunteer.id === mapping.volunteerId);
        if (mappedVolunteer) {
          matched.push({ participant, volunteerId: mappedVolunteer.id, method: 'source-map' });
        } else {
          queueEntries.push(queue(participant, 'invalid-mapping', [], `Source mapping points to missing volunteer ${mapping.volunteerId}`));
        }
        continue;
      }

      const nameCandidates = this.byName.get(normalizedName(participant.name)) ?? [];
      if (nameCandidates.length === 1) {
        const volunteer = nameCandidates[0];
        if (volunteer) matched.push({ participant, volunteerId: volunteer.id, method: 'name' });
      } else if (nameCandidates.length > 1) {
        queueEntries.push(queue(participant, 'ambiguous', nameCandidates.map((candidate) => candidate.id), 'The participant name matches more than one roster record; add a source mapping'));
      } else {
        queueEntries.push(queue(participant, 'unmatched', [], 'No email, source mapping, or unique roster name matched this participant'));
      }
    }
    return { matched, queue: queueEntries };
  }

  private mappingFor(participant: ParsedParticipant): IdentityMapping | undefined {
    for (const key of sourceMappingKey(participant)) {
      const mapping = this.byMappingKey.get(`whenisgood:${key}`);
      if (mapping) return mapping;
    }
    return undefined;
  }
}

export type SourceMappingInput = {
  sourceParticipantId?: string;
  sourceEmail?: string;
  sourceName?: string;
  volunteerId: string;
};

export class SourceMappingService {
  constructor(private readonly repository: ImportRepository, private readonly clock: Clock = { now: () => new Date().toISOString() }) {}

  list(actor: AdministratorActor): IdentityMapping[] {
    requireAdministrator(actor);
    return this.repository.mappings().map((mapping) => ({ ...mapping }));
  }

  save(actor: AdministratorActor, input: SourceMappingInput): IdentityMapping {
    requireAdministrator(actor);
    if (!input.sourceParticipantId && !input.sourceEmail && !input.sourceName) throw new Error('At least one source identity field is required');
    if (!input.volunteerId.trim()) throw new Error('A volunteer ID is required');
    const now = this.clock.now();
    const existing = this.repository.mappings().find((mapping) => mapping.sourceParticipantId === input.sourceParticipantId && mapping.sourceEmail === input.sourceEmail && mapping.sourceName === input.sourceName);
    const mapping: IdentityMapping = {
      source: 'whenisgood',
      volunteerId: input.volunteerId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      updatedBy: actor.id,
      ...(input.sourceParticipantId ? { sourceParticipantId: input.sourceParticipantId } : {}),
      ...(input.sourceEmail ? { sourceEmail: normalizedEmail(input.sourceEmail) } : {}),
      ...(input.sourceName ? { sourceName: input.sourceName.trim() } : {})
    };
    this.repository.saveMapping(mapping);
    return mapping;
  }
}

export function matchParticipantIdentities(participants: readonly ParsedParticipant[], volunteers: readonly Volunteer[], mappings: readonly IdentityMapping[] = []): IdentityMatchResult {
  return new IdentityMatcher(volunteers, mappings).match(participants);
}

export const matchIdentities = matchParticipantIdentities;
