import { Temporal } from '@js-temporal/polyfill';
import type { RecurringAvailability, Volunteer, Weekday } from '../../shared/domain.js';
import { requireAdministrator } from './roster.js';
import { IdentityMatcher } from './matching.js';
import type {
  AdministratorActor,
  Clock,
  ImportDiagnostic,
  ImportPreview,
  ImportPromotionResult,
  ImportRepository,
  ImportRun,
  ImportedAvailabilityRecord,
  ParsedAvailabilitySlot,
  ParsedWhenIsGood
} from './types.js';
import type { WhenIsGoodFetcher } from './fetcher.js';

export type StagedImportOptions = {
  clock?: Clock;
  defaultTimeZone: string;
  maxParticipants?: number;
  maxIntervalsPerParticipant?: number;
};

export type StageResult = {
  run: ImportRun;
  preview: ImportPreview;
  idempotent: boolean;
};

function hashContent(value: string): string {
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ (code + index), 3266489917);
  }
  return `fnv-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export { hashContent as contentHash };

function stableRowId(volunteerId: string, interval: RecurringAvailability): string {
  return `whenisgood-${volunteerId}-${interval.weekday}-${interval.start.replace(':', '')}-${interval.end.replace(':', '')}-${interval.timeZone.replace(/[^A-Za-z0-9]+/g, '-')}`;
}

function intervalKey(interval: Pick<RecurringAvailability, 'weekday' | 'start' | 'end' | 'timeZone'>): string {
  return `${interval.weekday}|${interval.start}|${interval.end}|${interval.timeZone}`;
}

function parseWeekday(slot: ParsedAvailabilitySlot): Weekday | undefined {
  if (slot.weekday && Number.isInteger(slot.weekday) && slot.weekday >= 1 && slot.weekday <= 7) return slot.weekday as Weekday;
  if (!slot.date) return undefined;
  const parts = slot.date.split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return undefined;
  const date = new Date(Date.UTC(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1));
  if (Number.isNaN(date.getTime())) return undefined;
  const day = date.getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}

function validTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function convertSlot(slot: ParsedAvailabilitySlot, sourceTimeZone: string | undefined, targetTimeZone: string): RecurringAvailability[] {
  const source = slot.timeZone ?? sourceTimeZone ?? targetTimeZone;
  if (!slot.date || source === targetTimeZone) {
    const weekday = parseWeekday(slot);
    if (!weekday) return [];
    return [{ weekday, start: slot.start, end: slot.end, timeZone: targetTimeZone }];
  }
  const date = Temporal.PlainDate.from(slot.date);
  const start = Temporal.ZonedDateTime.from({ timeZone: source, year: date.year, month: date.month, day: date.day, hour: Number(slot.start.slice(0, 2)), minute: Number(slot.start.slice(3, 5)) });
  const end = Temporal.ZonedDateTime.from({ timeZone: source, year: date.year, month: date.month, day: date.day, hour: Number(slot.end.slice(0, 2)), minute: Number(slot.end.slice(3, 5)) });
  const convertedStart = start.withTimeZone(targetTimeZone);
  const convertedEnd = end.withTimeZone(targetTimeZone);
  if (!convertedStart.toPlainDate().equals(convertedEnd.toPlainDate())) throw new Error('Availability interval crosses a date boundary during time-zone normalization');
  const startText = `${convertedStart.hour.toString().padStart(2, '0')}:${convertedStart.minute.toString().padStart(2, '0')}`;
  const endText = `${convertedEnd.hour.toString().padStart(2, '0')}:${convertedEnd.minute.toString().padStart(2, '0')}`;
  return [{ weekday: convertedStart.dayOfWeek as Weekday, start: startText, end: endText, timeZone: targetTimeZone }];
}

function normalizedRows(parsed: ParsedWhenIsGood, matches: ReturnType<IdentityMatcher['match']>, runId: string, importedAt: string, defaultTimeZone: string, maxIntervalsPerParticipant: number): ImportedAvailabilityRecord[] {
  const participantById = new Map(parsed.participants.map((participant) => [participant.sourceParticipantId, participant]));
  const rows = new Map<string, ImportedAvailabilityRecord>();
  for (const match of matches.matched) {
    const participant = participantById.get(match.participant.sourceParticipantId);
    if (!participant) continue;
    if (participant.availability.length > maxIntervalsPerParticipant) throw new Error(`Participant ${participant.name} has too many availability intervals`);
    for (const slot of participant.availability) {
      if (!validTime(slot.start) || !validTime(slot.end) || slot.start >= slot.end) throw new Error(`Invalid availability interval for ${participant.name}`);
      const intervals = convertSlot(slot, parsed.timeZone, defaultTimeZone);
      if (intervals.length === 0) throw new Error(`Availability interval for ${participant.name} has no valid weekday`);
      for (const interval of intervals) {
        const id = stableRowId(match.volunteerId, interval);
        rows.set(id, { ...interval, id, volunteerId: match.volunteerId, sourceParticipantId: participant.sourceParticipantId, source: 'whenisgood', importedAt, importRunId: runId });
      }
    }
  }
  return [...rows.values()].sort((left, right) => left.volunteerId.localeCompare(right.volunteerId) || intervalKey(left).localeCompare(intervalKey(right)));
}

function copyRun(run: ImportRun): ImportRun {
  return { ...run, unmatched: run.unmatched.map((entry) => ({ ...entry, candidateVolunteerIds: [...entry.candidateVolunteerIds], participant: { ...entry.participant, availability: entry.participant.availability.map((slot) => ({ ...slot })) } })), stagedAvailability: run.stagedAvailability.map((row) => ({ ...row })) };
}

function compareRows(current: readonly ImportedAvailabilityRecord[], staged: readonly ImportedAvailabilityRecord[]): Pick<ImportPreview, 'added' | 'removed' | 'unchanged'> {
  const currentById = new Map(current.map((row) => [row.id, row]));
  const stagedById = new Map(staged.map((row) => [row.id, row]));
  const added = staged.filter((row) => !currentById.has(row.id));
  const removed = current.filter((row) => !stagedById.has(row.id));
  const unchanged = staged.filter((row) => currentById.has(row.id));
  return { added: added.map((row) => ({ ...row })), removed: removed.map((row) => ({ ...row })), unchanged: unchanged.map((row) => ({ ...row })) };
}

function blockersFor(run: ImportRun): string[] {
  const blockers: string[] = [];
  if (run.status !== 'staged') blockers.push(`Import run is ${run.status}`);
  if (run.unmatched.length > 0) blockers.push(`${run.unmatched.length} participant(s) require reconciliation`);
  if (run.diagnostic) blockers.push(run.diagnostic.message);
  return blockers;
}

function asDiagnostic(error: unknown, code: ImportDiagnostic['code']): ImportDiagnostic {
  return { code, message: error instanceof Error ? error.message : String(error) };
}

export class StagedWhenIsGoodImportService {
  private readonly clock: Clock;
  private readonly maxParticipants: number;
  private readonly maxIntervalsPerParticipant: number;
  private readonly defaultTimeZone: string;

  constructor(private readonly repository: ImportRepository, options: StagedImportOptions) {
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    this.maxParticipants = options.maxParticipants ?? 1000;
    this.maxIntervalsPerParticipant = options.maxIntervalsPerParticipant ?? 1000;
    this.defaultTimeZone = options.defaultTimeZone;
    if (!this.defaultTimeZone.trim()) throw new Error('A default scheduling time zone is required');
  }

  async stageFromFetcher(actor: AdministratorActor, fetcher: WhenIsGoodFetcher, resultId: string): Promise<StageResult> {
    requireAdministrator(actor);
    try {
      const fetched = await fetcher.fetchResult(resultId);
      return this.stage(actor, fetched.parsed, fetched.html, fetched.resultId);
    } catch (error) {
      const failed = this.recordFailure(actor, resultId, error, 'FETCH_FAILED');
      return { run: failed, preview: this.previewFor(failed), idempotent: false };
    }
  }

  stage(actor: AdministratorActor, parsed: ParsedWhenIsGood, rawContent: string, resultId?: string): StageResult {
    requireAdministrator(actor);
    const contentHashValue = hashContent(rawContent);
    const existing = this.repository.findByContentHash('whenisgood', contentHashValue);
    if (existing) return { run: copyRun(existing), preview: this.previewFor(existing), idempotent: true };
    const startedAt = this.clock.now();
    const runId = `import-${contentHashValue}`;
    try {
      if (parsed.participants.length > this.maxParticipants) throw new Error(`Import contains more than ${this.maxParticipants} participants`);
      const volunteers = this.rosterVolunteers();
      const matcher = new IdentityMatcher(volunteers, this.repository.mappings());
      const matches = matcher.match(parsed.participants);
      const run: ImportRun = {
        id: runId,
        source: 'whenisgood',
        contentHash: contentHashValue,
        status: 'staged',
        startedAt,
        completedAt: this.clock.now(),
        actorId: actor.id,
        ...(resultId ? { resultId } : {}),
        participantCount: parsed.participants.length,
        matchedCount: matches.matched.length,
        unmatched: matches.queue,
        stagedAvailability: normalizedRows(parsed, matches, runId, this.clock.now(), this.defaultTimeZone, this.maxIntervalsPerParticipant)
      };
      this.repository.saveRun(run);
      return { run: copyRun(run), preview: this.previewFor(run), idempotent: false };
    } catch (error) {
      const failed = this.recordFailure(actor, resultId, error, 'VALIDATION_FAILED', contentHashValue, parsed.participants.length, runId, startedAt);
      return { run: failed, preview: this.previewFor(failed), idempotent: false };
    }
  }

  preview(actor: AdministratorActor, runId: string): ImportPreview {
    requireAdministrator(actor);
    const run = this.repository.getRun(runId);
    if (!run) throw new Error(`Import run ${runId} was not found`);
    return this.previewFor(run);
  }

  promote(actor: AdministratorActor, runId: string): ImportPromotionResult {
    requireAdministrator(actor);
    const run = this.repository.getRun(runId);
    if (!run) throw new Error(`Import run ${runId} was not found`);
    if (run.status === 'promoted') {
      return { runId: run.id, status: 'already-promoted', idempotent: true, currentAvailability: this.repository.currentAvailability(), revision: this.repository.currentRevision(), promotedAt: run.promotedAt ?? run.completedAt ?? this.clock.now() };
    }
    const blockers = blockersFor(run);
    if (blockers.length > 0) throw new Error(`Import cannot be promoted: ${blockers.join('; ')}`);
    const promotedAt = this.clock.now();
    try {
      const revision = this.repository.replaceCurrentAvailability(run.stagedAvailability, actor.id, 'whenisgood-import-promotion');
      const promoted: ImportRun = { ...run, status: 'promoted', promotedAt, promotedBy: actor.id, completedAt: promotedAt };
      this.repository.saveRun(promoted);
      return { runId: run.id, status: 'promoted', idempotent: false, currentAvailability: this.repository.currentAvailability(), revision, promotedAt };
    } catch (error) {
      const failed: ImportRun = { ...run, status: 'failed', completedAt: promotedAt, diagnostic: asDiagnostic(error, 'PROMOTION_FAILED') };
      this.repository.saveRun(failed);
      throw error;
    }
  }

  listRuns(actor: AdministratorActor): ImportRun[] {
    requireAdministrator(actor);
    return this.repository.listRuns().map(copyRun);
  }

  private previewFor(run: ImportRun): ImportPreview {
    const current = this.repository.currentAvailability();
    const changes = compareRows(current, run.stagedAvailability);
    return { run: copyRun(run), currentAvailability: current.map((row) => ({ ...row })), ...changes, canPromote: run.status === 'staged' && run.unmatched.length === 0 && !run.diagnostic, blockers: blockersFor(run) };
  }

  private recordFailure(actor: AdministratorActor, resultId: string | undefined, error: unknown, code: ImportDiagnostic['code'], hash = hashContent(`${resultId ?? 'whenisgood'}:${error instanceof Error ? error.message : String(error)}`), participantCount = 0, runId = `import-${hash}`, startedAt = this.clock.now()): ImportRun {
    const existing = this.repository.findByContentHash('whenisgood', hash);
    if (existing) return copyRun(existing);
    const now = this.clock.now();
    const run: ImportRun = {
      id: runId,
      source: 'whenisgood',
      contentHash: hash,
      status: 'failed',
      startedAt,
      completedAt: now,
      actorId: actor.id,
      ...(resultId ? { resultId } : {}),
      participantCount,
      matchedCount: 0,
      unmatched: [],
      stagedAvailability: [],
      diagnostic: asDiagnostic(error, code)
    };
    this.repository.saveRun(run);
    return run;
  }

  private rosterVolunteers(): Volunteer[] {
    const volunteers = this.repository.volunteers?.();
    if (volunteers) return volunteers;
    throw new Error('Import repository must provide roster volunteers for identity matching');
  }
}
