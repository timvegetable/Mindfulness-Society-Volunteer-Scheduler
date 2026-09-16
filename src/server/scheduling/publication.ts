import type { Assignment, Backup, SchedulingRun, Shortfall } from '../../shared/domain.js';
import { AssignmentSchema, BackupSchema, SchedulingRunSchema, ShortfallSchema } from '../../shared/domain.js';
import type { ScheduleResult, SchedulerInput } from './scheduler.js';
import { scheduleSessions } from './scheduler.js';

export type SchedulingClock = { now(): string };
export type SchedulingLock = { tryLock(timeoutMilliseconds: number): boolean; releaseLock(): void };

export class SchedulingPublicationError extends Error {
  readonly code: 'CONFLICT' | 'STALE_REVISION' | 'DUPLICATE_REQUEST' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'INTERNAL_ERROR';

  constructor(
    code: SchedulingPublicationError['code'],
    message: string
  ) {
    super(message);
    this.name = 'SchedulingPublicationError';
    this.code = code;
  }
}

export type PublishedSchedule = {
  revision: number;
  runId: string;
  assignments: Assignment[];
  backups: Backup[];
  shortfalls: Shortfall[];
};

type StagedSchedule = {
  run: SchedulingRun;
  assignments: Assignment[];
  backups: Backup[];
  shortfalls: Shortfall[];
};

const defaultClock: SchedulingClock = { now: () => new Date().toISOString() };
const noOpLock: SchedulingLock = { tryLock: () => true, releaseLock: () => undefined };

function copyPublished(schedule: PublishedSchedule): PublishedSchedule {
  return {
    revision: schedule.revision,
    runId: schedule.runId,
    assignments: schedule.assignments.map((assignment) => ({ ...assignment })),
    backups: schedule.backups.map((backup) => ({ ...backup })),
    shortfalls: schedule.shortfalls.map((shortfall) => ({ ...shortfall }))
  };
}

function copyRun(run: SchedulingRun): SchedulingRun {
  return {
    ...run,
    assignmentIds: [...run.assignmentIds],
    backupIds: [...run.backupIds],
    shortfalls: run.shortfalls.map((shortfall) => ({ ...shortfall }))
  };
}

function runIdentifier(sequence: number): string {
  return `scheduling-run-${sequence}`;
}

export type SchedulingStoreOptions = {
  inputRevision?: number;
  clock?: SchedulingClock;
  lock?: SchedulingLock;
};

/**
 * In-memory implementation of the staged scheduling publication boundary.
 * Staged rows and run metadata are private until publishRun succeeds; current
 * therefore always refers to one complete revision.
 */
export class SchedulingStore {
  private readonly clock: SchedulingClock;
  private readonly lock: SchedulingLock;
  private inputRevisionValue: number | undefined;
  private currentScheduleValue: PublishedSchedule | undefined;
  private sequence = 0;
  private readonly runRows = new Map<string, SchedulingRun>();
  private readonly stagedRows = new Map<string, StagedSchedule>();

  constructor(options: SchedulingStoreOptions = {}) {
    this.clock = options.clock ?? defaultClock;
    this.lock = options.lock ?? noOpLock;
    this.inputRevisionValue = options.inputRevision;
  }

  inputRevision(): number | undefined {
    return this.inputRevisionValue;
  }

  setInputRevision(revision: number): void {
    if (!Number.isInteger(revision) || revision < 0) {
      throw new SchedulingPublicationError('INVALID_REQUEST', 'Input revision must be a non-negative integer');
    }
    this.inputRevisionValue = revision;
  }

  currentRevision(): number {
    return this.currentScheduleValue?.revision ?? 0;
  }

  current(): PublishedSchedule | undefined {
    return this.currentScheduleValue ? copyPublished(this.currentScheduleValue) : undefined;
  }

  currentSchedule(): PublishedSchedule | undefined {
    return this.current();
  }

  run(runId: string): SchedulingRun | undefined {
    const row = this.runRows.get(runId);
    return row ? copyRun(row) : undefined;
  }

  runs(): SchedulingRun[] {
    return [...this.runRows.values()].map((run) => copyRun(run));
  }

  nextRunId(): string {
    this.sequence += 1;
    return runIdentifier(this.sequence);
  }

  beginRun(inputRevision: number, runId = this.nextRunId(), startedAt = this.clock.now()): SchedulingRun {
    if (!Number.isInteger(inputRevision) || inputRevision < 0) {
      throw new SchedulingPublicationError('INVALID_REQUEST', 'Input revision must be a non-negative integer');
    }
    if (this.runRows.has(runId)) throw new SchedulingPublicationError('DUPLICATE_REQUEST', `Scheduling run ${runId} already exists`);
    if (this.inputRevisionValue !== undefined && this.inputRevisionValue !== inputRevision) {
      throw new SchedulingPublicationError('STALE_REVISION', `Expected input revision ${inputRevision}, current revision is ${this.inputRevisionValue}`);
    }
    const run: SchedulingRun = {
      id: runId,
      inputRevision,
      outputRevision: null,
      status: 'staged',
      startedAt,
      assignmentIds: [],
      backupIds: [],
      shortfalls: []
    };
    this.runRows.set(runId, run);
    return copyRun(run);
  }
  startRun(inputRevision: number, runId?: string, startedAt?: string): SchedulingRun {
    return this.beginRun(inputRevision, runId, startedAt);
  }


  /** Stage a complete result without changing the current pointer. */
  stageRun(runId: string, result: ScheduleResult): SchedulingRun {
    const run = this.runRows.get(runId);
    if (!run) throw new SchedulingPublicationError('NOT_FOUND', `Scheduling run ${runId} was not started`);
    if (run.status !== 'staged') throw new SchedulingPublicationError('CONFLICT', `Scheduling run ${runId} is not staged`);
    const outputRevision = this.currentRevision() + 1;
    const stagedRun: SchedulingRun = {
      ...run,
      outputRevision,
      assignmentIds: result.assignments.map((assignment) => assignment.id),
      backupIds: result.backups.map((backup) => backup.id),
      shortfalls: result.shortfalls.map((shortfall) => ({ ...shortfall }))
    };
    // Validate before either staged map or run metadata is changed. This keeps
    // a malformed result from ever becoming a partially visible revision.
    for (const assignment of result.assignments) {
      if (!AssignmentSchema.safeParse(assignment).success) {
        throw new SchedulingPublicationError('INVALID_REQUEST', `Invalid staged assignment ${assignment.id}`);
      }
    }
    for (const backup of result.backups) {
      if (!BackupSchema.safeParse(backup).success) {
        throw new SchedulingPublicationError('INVALID_REQUEST', `Invalid staged backup ${backup.id}`);
      }
    }
    for (const shortfall of result.shortfalls) {
      if (!ShortfallSchema.safeParse(shortfall).success) {
        throw new SchedulingPublicationError('INVALID_REQUEST', `Invalid staged shortfall for ${shortfall.sessionId}`);
      }
    }
    const parsed = SchedulingRunSchema.safeParse(stagedRun);
    if (!parsed.success) throw new SchedulingPublicationError('INVALID_REQUEST', `Invalid staged scheduling run: ${parsed.error.message}`);
    this.stagedRows.set(runId, {
      run: stagedRun,
      assignments: result.assignments.map((assignment) => ({ ...assignment, scheduleRevision: outputRevision })),
      backups: result.backups.map((backup) => ({ ...backup, scheduleRevision: outputRevision })),
      shortfalls: result.shortfalls.map((shortfall) => ({ ...shortfall }))
    });
    this.runRows.set(runId, stagedRun);
    return copyRun(stagedRun);
  }
  stage(runId: string, result: ScheduleResult): SchedulingRun {
    return this.stageRun(runId, result);
  }


  /**
   * Make the complete staged result current in one in-memory commit. A failed
   * or incomplete run cannot alter the prior current schedule.
   */
  publishRun(runId: string, completedAt = this.clock.now()): PublishedSchedule {
    const staged = this.stagedRows.get(runId);
    if (!staged) throw new SchedulingPublicationError('CONFLICT', `Scheduling run ${runId} has no complete staged result`);
    const completedRun: SchedulingRun = { ...staged.run, status: 'completed', completedAt };
    const parsed = SchedulingRunSchema.safeParse(completedRun);
    if (!parsed.success) throw new SchedulingPublicationError('INVALID_REQUEST', `Invalid completed scheduling run: ${parsed.error.message}`);
    const published: PublishedSchedule = {
      revision: staged.run.outputRevision ?? 0,
      runId,
      assignments: staged.assignments.map((assignment) => ({ ...assignment })),
      backups: staged.backups.map((backup) => ({ ...backup })),
      shortfalls: staged.shortfalls.map((shortfall) => ({ ...shortfall }))
    };
    this.currentScheduleValue = published;
    this.runRows.set(runId, completedRun);
    this.stagedRows.delete(runId);
    return copyPublished(published);
  }
  publish(runId: string, completedAt?: string): PublishedSchedule {
    return this.publishRun(runId, completedAt);
  }


  failRun(runId: string, diagnostic: string, completedAt = this.clock.now()): SchedulingRun {
    const run = this.runRows.get(runId);
    if (!run) throw new SchedulingPublicationError('INVALID_REQUEST', `Scheduling run ${runId} was not started`);
    const failed: SchedulingRun = {
      ...run,
      status: 'failed',
      outputRevision: null,
      completedAt,
      diagnostic: diagnostic.slice(0, 2000)
    };
    this.runRows.set(runId, failed);
    this.stagedRows.delete(runId);
    return copyRun(failed);
  }

  withSchedulingLock<T>(action: () => T, timeoutMilliseconds = 10000): T {
    if (!this.lock.tryLock(timeoutMilliseconds)) {
      throw new SchedulingPublicationError('CONFLICT', 'Another scheduling run is already in progress');
    }
    try {
      return action();
    } finally {
      this.lock.releaseLock();
    }
  }
}

export type SchedulingRunInput = SchedulerInput & {
  inputRevision: number;
  actorId?: string;
  source?: string;
  runId?: string;
  startedAt?: string;
};

export type SchedulingRunResult = {
  run: SchedulingRun;
  schedule: PublishedSchedule;
  calculation: ScheduleResult;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Compute, stage, and publish exactly one complete scheduling revision. */
export function runScheduling(
  store: SchedulingStore,
  input: SchedulingRunInput
): SchedulingRunResult {
  return store.withSchedulingLock(() => {
    const run = store.beginRun(input.inputRevision, input.runId, input.startedAt);
    try {
      const schedulerInput: SchedulerInput = {
        volunteers: input.volunteers,
        sessions: input.sessions,
        scheduleRevision: store.currentRevision() + 1
      };
      if (input.exceptions !== undefined) schedulerInput.exceptions = input.exceptions;
      if (input.availabilityExceptions !== undefined) schedulerInput.availabilityExceptions = input.availabilityExceptions;
      if (input.assignments !== undefined) schedulerInput.assignments = input.assignments;
      if (input.currentAssignments !== undefined) schedulerInput.currentAssignments = input.currentAssignments;
      if (input.existingAssignments !== undefined) schedulerInput.existingAssignments = input.existingAssignments;
      if (input.startedAt !== undefined) schedulerInput.createdAt = input.startedAt;
      const calculation = scheduleSessions(schedulerInput);
      const staged = store.stageRun(run.id, calculation);
      const schedule = store.publishRun(run.id);
      const completed = store.run(run.id);
      if (!completed || !staged.outputRevision) {
        throw new SchedulingPublicationError('INTERNAL_ERROR', 'Scheduling publication did not produce a completed run');
      }
      return { run: completed, schedule, calculation };
    } catch (error) {
      store.failRun(run.id, errorMessage(error));
      throw error;
    }
  });
}
export const InMemorySchedulingStore = SchedulingStore;
export const MemorySchedulingStore = SchedulingStore;

export const publishSchedulingRun = runScheduling;
