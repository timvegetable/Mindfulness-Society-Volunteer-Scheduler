import type { RevisionState, RevisionedRepository } from '../workbook/repository.js';
import { MemoryRepository } from '../workbook/repository.js';
import type {
  CandidateSchedule,
  Center,
  CenterUser
} from './models.js';

export type CenterStore = RevisionedRepository<Center>;
export type CenterUserStore = RevisionedRepository<CenterUser>;
export type CandidateScheduleStore = RevisionedRepository<CandidateSchedule>;

/** Session stores are intentionally structural so the center feature can use the scheduler's store. */
export type SessionStoreLike<T extends { id: string }> = RevisionedRepository<T>;

export type RemovableStore<T extends { id: string }> = RevisionedRepository<T> & {
  remove?(id: string, expectedRevision: number, actorId: string, source: string): RevisionState;
};

class SeededMemoryRepository<T extends { id: string }> extends MemoryRepository<T> {
  constructor(initialRows: readonly T[] = []) {
    super();
    for (const row of initialRows) {
      super.upsert(row, super.revision().number, 'seed', 'center-seed');
    }
  }

  remove(id: string, expectedRevision: number, actorId: string, source: string): RevisionState {
    const existing = super.get(id);
    if (!existing) return super.revision();
    return super.replace(super.list().filter((row) => row.id !== id), expectedRevision, actorId, source);
  }
}

export class MemoryCenterStore extends SeededMemoryRepository<Center> implements CenterStore {}

export class MemoryCenterUserStore extends SeededMemoryRepository<CenterUser> implements CenterUserStore {}

export class MemoryCandidateScheduleStore extends SeededMemoryRepository<CandidateSchedule> implements CandidateScheduleStore {}

/** Generic in-memory occurrence store for confirmation smoke tests. */
export class MemorySessionStore<T extends { id: string }> extends SeededMemoryRepository<T> {}

export type CenterStores = {
  centers: CenterStore;
  users: CenterUserStore;
  candidates: CandidateScheduleStore;
};

