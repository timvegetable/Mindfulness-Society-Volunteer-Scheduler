import {
  CONTROL_COLUMNS,
  ControlError,
  appendJournalEntry,
  controlCounters,
  initializeControlRecord,
  readControlRecord,
  serializeControlRecord,
  type ControlAuthority,
  type ControlJournalEntry,
  type ControlRecord,
  type JournalEvent,
  type PrunableSheetLike
} from './control.js';
import type { SheetLike } from './initializer.js';
import type { LockLike } from './repository.js';

/**
 * Fenced maintenance procedures.
 *
 * The initializer, the migration loader and anything else that changes workbook
 * structure or rows outside a served request must run with writers drained:
 * under the script lock, with the live write gate closed. That is the opposite
 * of the request path, where the gate must be open — so these two conditions are
 * deliberately enforced in different places rather than by one shared check.
 *
 * Nothing here writes domain rows. Its jobs are the fence itself and idempotent
 * control-state seeding, so the caller's action stays readable.
 */

export type MaintenanceFenceOptions = {
  lock: LockLike;
  /** Live write gate reader. A maintenance action requires it *closed*. */
  writeEnabled: () => boolean;
  /**
   * Control tabs, resolved when the action asks for them: initialization is what
   * creates them, so they cannot be resolved before it runs.
   */
  controlSheet?: () => SheetLike | undefined;
  journalSheet?: () => PrunableSheetLike | undefined;
  authority?: ControlAuthority;
  actorId?: string;
  now?: () => string;
  lockTimeoutMs?: number;
};

export type MaintenanceContext = {
  /**
   * Idempotently seed the control record. Returns undefined when the workbook
   * has no control tab yet, which is the state before the first initialization.
   * A malformed, duplicated or unsupported record is never overwritten.
   */
  initializeControl(): { record: ControlRecord; created: boolean } | undefined;
  /** Append one maintenance journal entry when the workbook carries a journal. */
  journal(event: JournalEvent, label: string): void;
};

export function withMaintenanceFence<T>(options: MaintenanceFenceOptions, action: (context: MaintenanceContext) => T): T {
  const timeout = options.lockTimeoutMs ?? 10_000;
  if (!options.lock.tryLock(timeout)) {
    throw new ControlError('LOCKED', 'Another write holds the script lock; a maintenance action needs writers drained');
  }
  try {
    if (options.writeEnabled()) {
      throw new ControlError('GATE_OPEN', 'Maintenance requires the live write gate to be closed; verify WRITE_ENABLED is false before running it');
    }
    const now = (): string => options.now?.() ?? new Date().toISOString();
    const actorId = options.actorId ?? 'maintenance';
    const context: MaintenanceContext = {
      initializeControl: () => {
        const control = options.controlSheet?.();
        return control ? initializeControlRecord(control, now(), actorId) : undefined;
      },
      journal: (event, label) => {
        const journal = options.journalSheet?.();
        const control = options.controlSheet?.();
        if (!journal || !control) return;
        let record: ControlRecord;
        try {
          record = readControlRecord(control);
        } catch (error) {
          // A maintenance run that cannot read the record must not invent one.
          if (error instanceof ControlError && error.code === 'MISSING') return;
          throw error;
        }
        // A maintenance action changes structure or rows, so it is a mutation as
        // far as a reader is concerned: the generation advances, which is what
        // makes a reader bracketed across it reject its snapshot. Counters are
        // left alone — the caller's own transition owns any counter movement.
        const next: ControlRecord = {
          ...record,
          generation: record.generation + 1,
          completedGeneration: record.generation + 1,
          updatedAt: now(),
          updatedBy: actorId
        };
        appendJournalEntry(journal, {
          id: `${event}-${next.generation}`,
          generation: next.generation,
          event,
          operationId: record.operationId,
          actorId,
          tabs: record.operationTabs,
          before: controlCounters(record),
          after: controlCounters(next),
          reason: label,
          timestamp: next.updatedAt
        } satisfies ControlJournalEntry);
        control.getRange(2, 1, 1, CONTROL_COLUMNS.length).setValues([serializeControlRecord(next)]);
      }
    };
    return action(context);
  } finally {
    options.lock.releaseLock();
  }
}
