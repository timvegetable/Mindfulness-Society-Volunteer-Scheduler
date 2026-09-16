import { calculateOverlapCells } from './overlap.js';
import { deriveLeftoverVolunteers } from './derivation.js';
import type {
  InsightDataset,
  InsightRepository,
  InsightRevisionChange,
  InsightSnapshot,
  InsightSourceRevision,
  InsightStoreDependencies,
} from './types.js';
import { cloneDataset } from './types.js';

const DEFAULT_CLOCK = {
  now(): string {
    return new Date().toISOString();
  },
};

function cloneRevision(value: InsightSourceRevision): InsightSourceRevision {
  return { ...value };
}

function changedRevisionFields(left: InsightSourceRevision, right: InsightSourceRevision): InsightRevisionChange[] {
  const changed: InsightRevisionChange[] = [];
  if (left.assignmentRevision !== right.assignmentRevision) changed.push('assignmentRevision');
  if (left.eligibilityRevision !== right.eligibilityRevision) changed.push('eligibilityRevision');
  if (left.availabilityRevision !== right.availabilityRevision) changed.push('availabilityRevision');
  return changed;
}

function addReasons(existing: readonly InsightRevisionChange[], additions: readonly InsightRevisionChange[]): InsightRevisionChange[] {
  const result = [...existing];
  for (const reason of additions) {
    if (!result.includes(reason)) result.push(reason);
  }
  return result;
}

function validateRevision(revision: InsightSourceRevision): void {
  for (const [key, value] of Object.entries(revision)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
  }
}

/** Minimal repository boundary used by InsightStore; a Sheet adapter can implement it. */
export class MemoryInsightRepository implements InsightRepository {
  private dataset: InsightDataset | undefined;

  read(): InsightDataset | undefined {
    return this.dataset ? cloneDataset(this.dataset) : undefined;
  }

  write(dataset: InsightDataset): void {
    this.dataset = cloneDataset(dataset);
  }
}

/**
 * Stores a derived insight snapshot and makes freshness explicit. Regeneration
 * accepts one snapshot (or one snapshot reader invocation), so all cells and
 * leftover volunteers are bound to the same three source revisions.
 */
export class InsightStore {
  private readonly repository: InsightRepository;
  private readonly clock: { now(): string };

  constructor(dependencies: InsightStoreDependencies = {}) {
    this.repository = dependencies.repository ?? new MemoryInsightRepository();
    this.clock = dependencies.clock ?? DEFAULT_CLOCK;
  }

  read(currentRevision?: InsightSourceRevision): InsightDataset | undefined {
    const dataset = this.repository.read();
    if (!dataset) return undefined;
    if (currentRevision) {
      validateRevision(currentRevision);
      const changed = changedRevisionFields(dataset.sourceRevision, currentRevision);
      if (changed.length > 0) {
        const reasons = addReasons(dataset.staleReasons, changed);
        const shouldWrite = !dataset.stale || reasons.length !== dataset.staleReasons.length;
        dataset.stale = true;
        dataset.staleReasons = reasons;
        if (shouldWrite) this.repository.write(dataset);
      }
    }
    return cloneDataset(dataset);
  }

  get(currentRevision?: InsightSourceRevision): InsightDataset | undefined {
    return this.read(currentRevision);
  }

  isStale(currentRevision?: InsightSourceRevision): boolean {
    const dataset = this.read(currentRevision);
    return !dataset || dataset.stale;
  }

  /** Mark a stored dataset stale after any source revision changes. */
  markStale(change?: InsightRevisionChange | readonly InsightRevisionChange[] | InsightSourceRevision): InsightDataset | undefined {
    const dataset = this.repository.read();
    if (!dataset) return undefined;
    let reasons: InsightRevisionChange[];
    if (!change) {
      reasons = ['assignmentRevision', 'eligibilityRevision', 'availabilityRevision'];
    } else if (typeof change === 'string') {
      reasons = [change];
    } else if (Array.isArray(change)) {
      reasons = [...change];
    } else {
      const revision = change as InsightSourceRevision;
      validateRevision(revision);
      reasons = changedRevisionFields(dataset.sourceRevision, revision);
    }
    if (reasons.length === 0) return cloneDataset(dataset);
    dataset.stale = true;
    dataset.staleReasons = addReasons(dataset.staleReasons, reasons);
    this.repository.write(dataset);
    return cloneDataset(dataset);
  }

  save(dataset: InsightDataset): InsightDataset {
    validateRevision(dataset.sourceRevision);
    const value = cloneDataset(dataset);
    this.repository.write(value);
    return cloneDataset(value);
  }

  regenerate(snapshot: InsightSnapshot): InsightDataset;
  regenerate(readSnapshot: () => InsightSnapshot): InsightDataset;
  regenerate(snapshotOrReader: InsightSnapshot | (() => InsightSnapshot)): InsightDataset {
    const snapshot = typeof snapshotOrReader === 'function' ? snapshotOrReader() : snapshotOrReader;
    validateRevision(snapshot.sourceRevision);
    const leftoverVolunteers = deriveLeftoverVolunteers({
      volunteers: snapshot.volunteers,
      assignments: snapshot.assignments,
      assignmentRevision: snapshot.sourceRevision.assignmentRevision,
    });
    const cells = calculateOverlapCells(leftoverVolunteers, snapshot.config);
    const dataset: InsightDataset = {
      sourceRevision: cloneRevision(snapshot.sourceRevision),
      generatedAt: this.clock.now(),
      stale: false,
      staleReasons: [],
      leftoverVolunteers,
      cells,
    };
    this.repository.write(dataset);
    return cloneDataset(dataset);
  }

  refresh(snapshot: InsightSnapshot): InsightDataset;
  refresh(readSnapshot: () => InsightSnapshot): InsightDataset;
  refresh(snapshotOrReader: InsightSnapshot | (() => InsightSnapshot)): InsightDataset {
    if (typeof snapshotOrReader === 'function') return this.regenerate(snapshotOrReader);
    return this.regenerate(snapshotOrReader);
  }

  regenerateIfStale(snapshot: InsightSnapshot): InsightDataset;
  regenerateIfStale(readSnapshot: () => InsightSnapshot): InsightDataset;
  regenerateIfStale(snapshotOrReader: InsightSnapshot | (() => InsightSnapshot)): InsightDataset {
    const snapshot = typeof snapshotOrReader === 'function' ? snapshotOrReader() : snapshotOrReader;
    const current = this.read(snapshot.sourceRevision);
    if (current && !current.stale) return current;
    return this.regenerate(snapshot);
  }
}
