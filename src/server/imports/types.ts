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
  currentAvailability: ImportedAvailabilityRecord[];
  added: ImportedAvailabilityRecord[];
  removed: ImportedAvailabilityRecord[];
  unchanged: ImportedAvailabilityRecord[];
  canPromote: boolean;
  blockers: string[];
};

export type ImportPromotionResult = {
  runId: string;
  status: 'promoted' | 'already-promoted';
  idempotent: boolean;
  currentAvailability: ImportedAvailabilityRecord[];
  revision: number;
  promotedAt: string;
};

export type ImportRepository = {
  listRuns(): ImportRun[];
  getRun(id: string): ImportRun | undefined;
  findByContentHash(source: ImportSource, contentHash: string): ImportRun | undefined;
  saveRun(run: ImportRun): void;
  currentAvailability(): ImportedAvailabilityRecord[];
  currentRevision(): number;
  replaceCurrentAvailability(rows: readonly ImportedAvailabilityRecord[], actorId: string, source: string): number;
  mappings(): IdentityMapping[];
  saveMapping(mapping: IdentityMapping): void;
  volunteers?(): Volunteer[];
};

export type FetchResponse = {
  ok: boolean;
  status?: number;
  text(): Promise<string>;
};

export type Fetcher = (url: string) => Promise<FetchResponse>;

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
