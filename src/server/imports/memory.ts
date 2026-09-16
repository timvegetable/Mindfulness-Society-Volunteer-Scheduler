import type { Volunteer } from '../../shared/domain.js';
import type {
  Clock,
  IdentityMapping,
  ImportRepository,
  ImportRun,
  ImportedAvailabilityRecord,
  ImportSource,
  RosterRepository
} from './types.js';

function copyAvailability(rows: readonly ImportedAvailabilityRecord[]): ImportedAvailabilityRecord[] {
  return rows.map((row) => ({ ...row }));
}

function copyRun(run: ImportRun): ImportRun {
  return {
    ...run,
    unmatched: run.unmatched.map((entry) => ({ ...entry, candidateVolunteerIds: [...entry.candidateVolunteerIds], participant: { ...entry.participant, availability: entry.participant.availability.map((slot) => ({ ...slot })) } })),
    stagedAvailability: copyAvailability(run.stagedAvailability)
  };
}

export class MemoryImportRepository implements ImportRepository {
  private readonly runRows = new Map<string, ImportRun>();
  private readonly mappingRows: IdentityMapping[] = [];
  private currentRows: ImportedAvailabilityRecord[] = [];
  private revisionNumber = 0;
  private rosterRows: Volunteer[];

  constructor(volunteers: readonly Volunteer[] = [], private readonly clock: Clock = { now: () => new Date().toISOString() }) {
    this.rosterRows = volunteers.map((volunteer) => ({ ...volunteer, recurringAvailability: [...volunteer.recurringAvailability] }));
  }

  listRuns(): ImportRun[] {
    return [...this.runRows.values()].map(copyRun);
  }

  getRun(id: string): ImportRun | undefined {
    const run = this.runRows.get(id);
    return run ? copyRun(run) : undefined;
  }

  findByContentHash(source: ImportSource, contentHash: string): ImportRun | undefined {
    for (const run of this.runRows.values()) {
      if (run.source === source && run.contentHash === contentHash) return copyRun(run);
    }
    return undefined;
  }

  saveRun(run: ImportRun): void {
    this.runRows.set(run.id, copyRun(run));
  }

  currentAvailability(): ImportedAvailabilityRecord[] {
    return copyAvailability(this.currentRows);
  }

  currentRevision(): number {
    return this.revisionNumber;
  }

  replaceCurrentAvailability(rows: readonly ImportedAvailabilityRecord[], _actorId: string, _source: string): number {
    this.currentRows = copyAvailability(rows);
    this.revisionNumber += 1;
    return this.revisionNumber;
  }

  mappings(): IdentityMapping[] {
    return this.mappingRows.map((mapping) => ({ ...mapping }));
  }

  saveMapping(mapping: IdentityMapping): void {
    const keys = (candidate: IdentityMapping): string => `${candidate.source}|${candidate.sourceParticipantId ?? ''}|${candidate.sourceEmail ?? ''}|${candidate.sourceName ?? ''}`;
    const key = keys(mapping);
    const index = this.mappingRows.findIndex((candidate) => keys(candidate) === key);
    if (index >= 0) this.mappingRows[index] = { ...mapping };
    else this.mappingRows.push({ ...mapping });
  }

  volunteers(): Volunteer[] {
    return this.rosterRows.map((volunteer) => ({ ...volunteer, recurringAvailability: [...volunteer.recurringAvailability] }));
  }

  setVolunteers(volunteers: readonly Volunteer[]): void {
    this.rosterRows = volunteers.map((volunteer) => ({ ...volunteer, recurringAvailability: [...volunteer.recurringAvailability] }));
  }

  addVolunteer(volunteer: Volunteer): void {
    this.rosterRows = [...this.rosterRows.filter((candidate) => candidate.id !== volunteer.id), { ...volunteer, recurringAvailability: [...volunteer.recurringAvailability] }];
  }

  now(): string {
    return this.clock.now();
  }
}

export class MemoryRosterRepository implements RosterRepository {
  private readonly rows = new Map<string, Volunteer>();
  private revisionNumber = 0;
  private readonly clock: Clock;

  constructor(volunteers: readonly Volunteer[] = [], clock: Clock = { now: () => new Date().toISOString() }) {
    this.clock = clock;
    for (const volunteer of volunteers) this.rows.set(volunteer.id, { ...volunteer, recurringAvailability: [...volunteer.recurringAvailability] });
  }

  list(): Volunteer[] {
    return [...this.rows.values()].map((volunteer) => ({ ...volunteer, recurringAvailability: [...volunteer.recurringAvailability] }));
  }

  get(id: string): Volunteer | undefined {
    const volunteer = this.rows.get(id);
    return volunteer ? { ...volunteer, recurringAvailability: [...volunteer.recurringAvailability] } : undefined;
  }

  upsert(row: Volunteer, expectedRevision: number, actorId: string, source: string): { number: number; changedAt: string; changedBy: string; source: string } {
    if (expectedRevision !== this.revisionNumber) throw new Error(`Expected revision ${expectedRevision}, current revision is ${this.revisionNumber}`);
    this.rows.set(row.id, { ...row, recurringAvailability: [...row.recurringAvailability] });
    this.revisionNumber += 1;
    return { number: this.revisionNumber, changedAt: this.clock.now(), changedBy: actorId, source };
  }
}
