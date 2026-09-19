import { describe, expect, it } from 'vitest';
import type { Volunteer } from '../../shared/domain.js';
import { WhenIsGoodFetcher, type WhenIsGoodFetcher as WhenIsGoodFetcherType } from './fetcher.js';
import { MemoryImportRepository } from './memory.js';
import { SourceMappingService } from './matching.js';
import { StagedWhenIsGoodImportService, contentHash } from './service.js';
import type { ParsedWhenIsGood } from './types.js';

const timestamp = '2026-09-18T00:00:00.000Z';

function volunteer(id: string, name: string, email: string): Volunteer {
  return {
    id,
    name,
    email,
    lifecycleStatus: 'active',
    interviewStatus: 'complete',
    readinessRank: 1,
    recurringAvailability: [],
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

const roster = [volunteer('vol-1', 'Example Volunteer', 'volunteer@example.test'), volunteer('vol-2', 'Second Volunteer', 'second@example.test')];

const admin = { id: 'admin@example.test', roles: ['administrator'] as const };

function parsed(participants: ParsedWhenIsGood['participants']): ParsedWhenIsGood {
  return { source: 'whenisgood', resultId: 'result-1', timeZone: 'America/New_York', participants };
}

const matchedOnly = parsed([
  { sourceParticipantId: 'p-1', name: 'Example Volunteer', email: 'volunteer@example.test', availability: [{ weekday: 1, start: '09:00', end: '10:00' }, { weekday: 3, start: '09:00', end: '10:00' }] }
]);
const withUnmatched = parsed([
  { sourceParticipantId: 'p-1', name: 'Example Volunteer', email: 'volunteer@example.test', availability: [{ weekday: 1, start: '09:00', end: '10:00' }] },
  { sourceParticipantId: 'p-9', name: 'Unlisted Participant', availability: [{ weekday: 2, start: '14:00', end: '15:00' }] }
]);

const RAW = '<html>whenisgood result</html>';

function serviceFor(repository: MemoryImportRepository): StagedWhenIsGoodImportService {
  return new StagedWhenIsGoodImportService(repository, { defaultTimeZone: 'America/New_York' });
}

/** Promotion writes two tabs; this double fails the second one. */
class FailingProvenanceRepository extends MemoryImportRepository {
  override replaceProvenance(): void {
    throw new Error('provenance write failed');
  }
}

describe('staged WhenIsGood import contract', () => {
  it('promotes staged intervals into the authoritative recurring rows', () => {
    const repository = new MemoryImportRepository(roster);
    const service = serviceFor(repository);
    const staged = service.stage(admin, matchedOnly, RAW, 'result-1');
    expect(staged.preview.canPromote).toBe(true);

    const promoted = service.promote(admin, staged.run.id);
    expect(promoted.status).toBe('promoted');
    expect(repository.currentAvailability().map((row) => [row.volunteerId, row.weekday, row.start, row.end, row.timeZone])).toEqual([
      ['vol-1', 1, '09:00', '10:00', 'America/New_York'],
      ['vol-1', 3, '09:00', '10:00', 'America/New_York']
    ]);
    expect(repository.provenance().map((row) => row.id)).toEqual(staged.run.stagedAvailability.map((row) => row.id));

    const again = service.promote(admin, staged.run.id);
    expect(again).toMatchObject({ status: 'already-promoted', idempotent: true });
    expect(repository.currentAvailability()).toHaveLength(2);
  });

  it('keeps an unchanged promoted import idempotent instead of duplicating availability', () => {
    const repository = new MemoryImportRepository(roster);
    const service = serviceFor(repository);
    const staged = service.stage(admin, matchedOnly, RAW, 'result-1');
    service.promote(admin, staged.run.id);

    const restaged = service.stage(admin, matchedOnly, RAW, 'result-1');
    expect(restaged.idempotent).toBe(true);
    expect(restaged.run.id).toBe(staged.run.id);
    expect(restaged.run.status).toBe('promoted');
    expect(repository.currentAvailability()).toHaveLength(2);
    expect(repository.provenance()).toHaveLength(2);
  });

  it('re-matches an unchanged unresolved import after a mapping is saved', () => {
    const repository = new MemoryImportRepository(roster);
    const service = serviceFor(repository);
    const staged = service.stage(admin, withUnmatched, RAW, 'result-1');
    expect(staged.run.unmatched.map((entry) => entry.participant.sourceParticipantId)).toEqual(['p-9']);
    expect(staged.preview.canPromote).toBe(false);

    new SourceMappingService(repository).save(admin, { sourceParticipantId: 'p-9', volunteerId: 'vol-2' });
    const restaged = service.stage(admin, withUnmatched, RAW, 'result-1');
    expect(restaged.idempotent).toBe(false);
    expect(restaged.run.id).toBe(staged.run.id);
    expect(restaged.run.unmatched).toEqual([]);
    expect(restaged.run.matchedCount).toBe(2);
    expect(restaged.run.stagedAvailability.map((row) => [row.volunteerId, row.weekday, row.start, row.end])).toEqual([
      ['vol-1', 1, '09:00', '10:00'],
      ['vol-2', 2, '14:00', '15:00']
    ]);
    expect(restaged.run.contentHash).toBe(contentHash(RAW));
    expect(restaged.preview.canPromote).toBe(true);

    service.promote(admin, restaged.run.id);
    expect(repository.currentAvailability().map((row) => row.volunteerId)).toEqual(['vol-1', 'vol-2']);
  });

  it('re-matches through the fetched source for the saved results code', () => {
    const repository = new MemoryImportRepository(roster);
    const service = serviceFor(repository);
    service.stage(admin, withUnmatched, RAW, 'result-1');
    new SourceMappingService(repository).save(admin, { sourceParticipantId: 'p-9', volunteerId: 'vol-2' });

    const fetcher = { fetchResult: (resultId: string) => ({ resultId, url: 'https://example.test/results', html: RAW, parsed: withUnmatched }) } as unknown as WhenIsGoodFetcherType;
    const restaged = service.restageUnresolved(admin, fetcher);
    expect(restaged).toHaveLength(1);
    expect(restaged[0]?.run.matchedCount).toBe(2);
    expect(restaged[0]?.run.stagedAvailability).toHaveLength(2);
  });

  it('preserves the last authoritative availability when a promotion write fails', () => {
    const repository = new FailingProvenanceRepository(roster);
    const service = serviceFor(repository);
    // The last successful promotion is already authoritative.
    repository.replaceAuthoritative([
      { id: 'whenisgood-vol-1-3-0900-1000-America-New-York', volunteerId: 'vol-1', weekday: 3, start: '09:00', end: '10:00', timeZone: 'America/New_York', revision: 7, source: 'whenisgood', updatedAt: timestamp }
    ], 'admin@example.test', 'whenisgood-import-promotion');
    const staged = service.stage(admin, matchedOnly, RAW, 'result-1');

    expect(() => service.promote(admin, staged.run.id)).toThrow('provenance write failed');
    expect(repository.currentAvailability().map((row) => [row.weekday, row.start, row.end, row.revision])).toEqual([[3, '09:00', '10:00', 7]]);
    expect(repository.provenance()).toEqual([]);
    expect(repository.getRun(staged.run.id)?.status).toBe('failed');
    expect(repository.getRun(staged.run.id)?.diagnostic?.code).toBe('PROMOTION_FAILED');
  });

  it('compares preview intervals with the authoritative rows rather than import ids', () => {
    const repository = new MemoryImportRepository(roster);
    const service = serviceFor(repository);
    const staged = service.stage(admin, matchedOnly, RAW, 'result-1');
    service.promote(admin, staged.run.id);
    // A volunteer adds an interval through self-service after the import.
    repository.replaceAuthoritative([
      ...repository.currentAvailability(),
      { id: 'self-service-1', volunteerId: 'vol-1', weekday: 5, start: '11:00', end: '12:00', timeZone: 'America/New_York', revision: 9, source: 'self-service', updatedAt: timestamp }
    ], 'vol-1', 'self-service-recurring-availability');

    const next = service.stage(admin, parsed([
      { sourceParticipantId: 'p-1', name: 'Example Volunteer', email: 'volunteer@example.test', availability: [{ weekday: 1, start: '09:00', end: '10:00' }] }
    ]), `${RAW}?second`, 'result-2');
    expect(next.preview.unchanged.map((row) => [row.weekday, row.start, row.end])).toEqual([[1, '09:00', '10:00']]);
    expect(next.preview.removed.map((row) => [row.weekday, row.start, row.end])).toEqual([[3, '09:00', '10:00'], [5, '11:00', '12:00']]);
    expect(next.preview.added).toEqual([]);
  });

  it('completes an import preview when Apps Script has no TextEncoder', () => {
    const html = '<script>window.results = {"participants":[{"id":"p-1","name":"Example Volunteer","email":"volunteer@example.test","availability":[{"weekday":1,"start":"09:00","end":"10:00"}]}]};</script>';
    const repository = new MemoryImportRepository(roster);
    const service = serviceFor(repository);
    const fetcher = new WhenIsGoodFetcher({
      endpoint: 'https://whenisgood.example/results/{resultId}',
      fetch: () => ({ ok: true, status: 200, text: () => html }),
      parserOptions: { defaultTimeZone: 'America/New_York' }
    });
    const original = globalThis.TextEncoder;
    Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: undefined });
    try {
      const result = service.stageFromFetcher(admin, fetcher, 'result-without-text-encoder');
      expect(result.run.status).toBe('staged');
      expect(result.preview.canPromote).toBe(true);
      expect(result.run.matchedCount).toBe(1);
    } finally {
      Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: original });
    }
  });
});
