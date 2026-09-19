import type {
  LifecycleStatus,
  Rank,
  RecurringAvailability,
  Role,
  Volunteer,
  Weekday
} from '../../shared/domain.js';

export type ImportSource = 'whenisgood';

export type Clock = { now(): string };

export type AdministratorActor = {
  id: string;
  roles: readonly Role[];
};

export type RosterRepository = {
  list(): Volunteer[];
  get(id: string): Volunteer | undefined;
  upsert(row: Volunteer, expectedRevision: number, actorId: string, source: string): { number: number; changedAt: string; changedBy: string; source: string };
};

export type IdentityMapping = {
  source: ImportSource;
  sourceParticipantId?: string;
  sourceEmail?: string;
  sourceName?: string;
  volunteerId: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};

export type ParsedAvailabilitySlot = {
  weekday?: Weekday;
  date?: string;
  start: string;
  end: string;
  timeZone?: string;
};

export type ParsedParticipant = {
  sourceParticipantId: string;
  name: string;
  email?: string;
  availability: ParsedAvailabilitySlot[];
};

export type ParsedWhenIsGood = {
  source: ImportSource;
  resultId?: string;
  timeZone?: string;
  participants: ParsedParticipant[];
};

export type ImportedAvailabilityRecord = RecurringAvailability & {
  id: string;
  volunteerId: string;
  sourceParticipantId: string;
  source: ImportSource;
  importedAt: string;
  importRunId: string;
};

/**
 * The interval identity used to compare a staged import with what scheduling
 * actually consumes. Provenance rows and authoritative rows describe the same
 * availability with different bookkeeping ids, so comparison ignores the id.
 */
export type AvailabilityIntervalRecord = RecurringAvailability & { volunteerId: string };

/** One row of the authoritative RecurringAvailability tab. */
export type AuthoritativeAvailabilityRecord = AvailabilityIntervalRecord & {
  id: string;
  revision: number;
  source?: string;
  updatedAt?: string;
};

export function availabilityIntervalKey(row: AvailabilityIntervalRecord): string {
  return `${row.volunteerId}|${row.weekday}|${row.start}|${row.end}|${row.timeZone}`;
}

export type IdentityMatch = {
  participant: ParsedParticipant;
  volunteerId: string;
  method: 'email' | 'source-map' | 'name';
};

export type IdentityQueueReason = 'unmatched' | 'ambiguous' | 'invalid-mapping';

export type IdentityQueueEntry = {
  participant: ParsedParticipant;
  reason: IdentityQueueReason;
  candidateVolunteerIds: string[];
  message: string;
};

export type IdentityMatchResult = {
  matched: IdentityMatch[];
  queue: IdentityQueueEntry[];
};

export type ImportRunStatus = 'staged' | 'promoted' | 'failed' | 'duplicate';

export type ImportDiagnostic = {
  code: 'FETCH_FAILED' | 'PARSE_FAILED' | 'VALIDATION_FAILED' | 'IDENTITY_RECONCILIATION_REQUIRED' | 'PROMOTION_FAILED';
  message: string;
  details?: Record<string, unknown>;
};

export type ImportRun = {
  id: string;
  source: ImportSource;
  contentHash: string;
  status: ImportRunStatus;
  startedAt: string;
  completedAt?: string;
  actorId: string;
  resultId?: string;
  participantCount: number;
  matchedCount: number;
  unmatched: IdentityQueueEntry[];
  stagedAvailability: ImportedAvailabilityRecord[];
  diagnostic?: ImportDiagnostic;
  promotedAt?: string;
  promotedBy?: string;
};

export type ImportPreview = {
  run: ImportRun;
  currentAvailability: AuthoritativeAvailabilityRecord[];
  added: AvailabilityIntervalRecord[];
  removed: AvailabilityIntervalRecord[];
  unchanged: AvailabilityIntervalRecord[];
  canPromote: boolean;
  blockers: string[];
};

export type ImportPromotionResult = {
  runId: string;
  status: 'promoted' | 'already-promoted';
  idempotent: boolean;
  currentAvailability: AuthoritativeAvailabilityRecord[];
  revision: number;
  promotedAt: string;
};

export type ImportRepository = {
  listRuns(): ImportRun[];
  getRun(id: string): ImportRun | undefined;
  findByContentHash(source: ImportSource, contentHash: string): ImportRun | undefined;
  saveRun(run: ImportRun): void;
  /** Authoritative recurring rows — the dataset scheduling, insights, self-service, and coverage consume. */
  currentAvailability(): AuthoritativeAvailabilityRecord[];
  /** Provenance rows: the last promoted import, kept for reconciliation and audit. */
  provenance(): ImportedAvailabilityRecord[];
  /** Revision of the authoritative RecurringAvailability tab. */
  availabilityRevision(): number;
  replaceAuthoritative(rows: readonly AuthoritativeAvailabilityRecord[], actorId: string, source: string): number;
  replaceProvenance(rows: readonly ImportedAvailabilityRecord[], actorId: string, source: string): void;
  mappings(): IdentityMapping[];
  saveMapping(mapping: IdentityMapping): void;
  volunteers?(): Volunteer[];
};

export type FetchResponse = {
  ok: boolean;
  status?: number;
  text(): string;
};

/** Synchronous by contract: Apps Script's UrlFetchApp has no async form. */
export type Fetcher = (url: string) => FetchResponse;

export type WhenIsGoodFetcherOptions = {
  endpoint: string;
  fetch: Fetcher;
  maxPayloadBytes?: number;
};

export type ImportedRosterChange = {
  volunteerId: string;
  before: LifecycleStatus | Rank | null;
  after: LifecycleStatus | Rank | null;
};
