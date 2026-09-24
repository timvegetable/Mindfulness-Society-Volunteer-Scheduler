import { describe, expect, it } from 'vitest';
import type { Volunteer } from '../../shared/domain.js';
import { volunteerCodec } from './codecs.js';
import { InMemorySheet } from './in-memory-sheet.js';
import { RevisionStore, SheetRepository, type RevisionState } from './repository.js';
import { tabDefinition } from './schema.js';

/** Counts how often a tab hands out a range, which is the read this bounds. */
class CountingSheet extends InMemorySheet {
  reads = 0;

  override getRange(row: number, column: number, rows = 1, columns = 1) {
    this.reads += 1;
    return super.getRange(row, column, rows, columns);
  }
}

function revisionStore(): RevisionStore {
  let current: RevisionState = { number: 0, changedAt: '2026-09-01T00:00:00.000Z', changedBy: 'test', source: 'test' };
  return new RevisionStore({
    get: () => current,
    set: (value) => {
      current = value;
    }
  });
}

const volunteerRow = ['vol-1', 'Example Volunteer', 'volunteer@example.test', 'active', 'complete', 1, 0, 'roster', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'];

function repositoryWith(rows: readonly unknown[][]) {
  const sheet = new CountingSheet('Volunteers', tabDefinition('Volunteers').columns);
  for (const row of rows) sheet.appendRow(row);
  return { sheet, repository: new SheetRepository(sheet, tabDefinition('Volunteers').columns, volunteerCodec, revisionStore()) };
}

describe('request-scoped sheet reads', () => {
  it('reads a tab once and serves list and get from that snapshot', () => {
    const { sheet, repository } = repositoryWith([volunteerRow]);

    expect(repository.list()).toHaveLength(1);
    expect(repository.get('vol-1')?.name).toBe('Example Volunteer');
    expect(repository.list()).toHaveLength(1);
    expect(repository.list()).toHaveLength(1);
    expect(sheet.reads).toBe(1);
  });

  it('caches an empty tab so repeated reads never touch the sheet', () => {
    const { sheet, repository } = repositoryWith([]);

    expect(repository.list()).toEqual([]);
    expect(repository.get('vol-1')).toBeUndefined();
    expect(sheet.reads).toBe(0);
  });

  it('decodes a validated batch into the same request snapshot without Sheet calls', () => {
    const { sheet, repository } = repositoryWith([volunteerRow]);
    repository.primeRows([volunteerRow]);

    expect(repository.get('vol-1')?.name).toBe('Example Volunteer');
    expect(repository.list()).toHaveLength(1);
    expect(sheet.reads).toBe(0);
    expect(() => repository.primeRows([volunteerRow])).toThrow('already read');
  });

  it('serves a committed upsert from the same snapshot without re-reading', () => {
    const { sheet, repository } = repositoryWith([volunteerRow]);
    const current = repository.get('vol-1');
    expect(current).toBeDefined();
    const updated: Volunteer = { ...(current as Volunteer), name: 'Renamed Volunteer', revision: 1 };

    repository.upsert(updated, repository.revision().number, 'admin@example.test', 'test-update');

    expect(repository.list().map((row) => row.name)).toEqual(['Renamed Volunteer']);
    expect(sheet.reads).toBe(2); // one read, then the write range
  });

  it('removes rows dropped from a replacement', () => {
    const { sheet, repository } = repositoryWith([volunteerRow, ['vol-2', 'Second Volunteer', 'second@example.test', 'active', 'complete', 2, 0, 'roster', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']]);
    expect(repository.list()).toHaveLength(2);

    repository.replace([repository.get('vol-1') as Volunteer], repository.revision().number, 'admin@example.test', 'test-prune');

    expect(repository.list().map((row) => row.id)).toEqual(['vol-1']);
    expect(sheet.values).toHaveLength(2);
  });
});
