import {
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  ControlMutationWriter,
  assertAuthority,
  assertCompletedGeneration,
  controlOperationId,
  portableRevisionProvider,
  readControlRecord,
  toRepositoryError,
  type ControlRecord,
  type MutationScope,
  type PrunableSheetLike
} from './control.js';
import type { SheetLike } from './initializer.js';
import type { WorkbookTabName } from './schema.js';

/**
 * One request's view of the portable control record under the
 * `workbook-control` authority.
 *
 * The session is created when the dispatcher admits a mutating operation (or
 * lazily for a read), serves the counters the repositories and the response
 * envelope need, and publishes the in-progress marker before the first row
 * change. The marker is written lazily on purpose: the tabs a mutation touches
 * are known only when a repository is about to write, and widening the
 * declaration at that moment is both correct and cheaper than a policy table
 * that would have to predict every write path.
 *
 * The caller must hold the script lock for the whole mutation — the dispatcher's
 * write lock in production — so the writer performs no locking of its own.
 */

export type PortableSessionOptions = {
  control: SheetLike;
  journal: PrunableSheetLike;
  /** Live write gate; a closed gate refuses the first row change. */
  writeEnabled: () => boolean;
  now?: () => string;
  /** A record already read under the lock, so admission costs one read. */
  initialRecord?: ControlRecord;
};

export class PortableSession {
  private readonly writer: ControlMutationWriter;
  private bound: { actorId: string; operation: string } | undefined;
  private cached: ControlRecord | undefined;
  private scope: MutationScope | undefined;
  private readonly markedTabs = new Set<string>();
  private readonly committed = new Map<string, number>();
  /** Tabs hydrated outside a planned, already-bracketed read. */
  private readonly unbracketedReads = new Set<string>();
  private readonly bracketedTabs = new Set<string>();
  private anchor: ControlRecord | undefined;

  constructor(private readonly options: PortableSessionOptions) {
    this.cached = options.initialRecord;
    this.writer = new ControlMutationWriter({
      control: options.control,
      journal: options.journal,
      writeEnabled: options.writeEnabled,
      authority: 'workbook-control',
      ...(options.now ? { now: options.now } : {})
    });
  }

  /**
   * Bind the session to the operation the dispatcher admitted. Nothing may be
   * written before this: an unbound write is a path that bypassed admission.
   */
  bind(actorId: string, operation: string): void {
    this.bound = { actorId, operation };
  }

  /** The record as read at admission, refreshed after every transition. */
  record(): ControlRecord {
    try {
      this.cached ??= readControlRecord(this.options.control);
      return this.cached;
    } catch (error) {
      throw toRepositoryError(error, 'read');
    }
  }

  protocolVersion(): number {
    return CONTROL_PROTOCOL_VERSION;
  }

  /** Counters the repositories must use, including this request's own commits. */
  tabRevision(tab: WorkbookTabName): number {
    try {
      return (this.record().tabRevisions[tab] ?? 0) + (this.committed.get(tab) ?? 0);
    } catch (error) {
      throw toRepositoryError(error, 'read');
    }
  }

  dataRevision(): number {
    return this.record().dataRevision;
  }

  schedulingInputRevision(): number {
    return this.record().schedulingInputRevision;
  }

  /**
   * Record that this request is about to hydrate `tab`, taking the admission
   * anchor on the first such read. Planned reads call `markBracketed` instead:
   * they are already bracketed by two control reads of their own, and anchoring
   * them again would buy the same guarantee for two more reads.
   */
  registerRead(tab: WorkbookTabName): void {
    if (this.bracketedTabs.has(tab)) return;
    try {
      this.anchor ??= readControlRecord(this.options.control);
    } catch (error) {
      throw toRepositoryError(error, 'read');
    }
    this.unbracketedReads.add(tab);
  }

  /** Tabs a completed plan read already bracketed for this request. */
  markBracketed(tabs: readonly WorkbookTabName[]): void {
    for (const tab of tabs) this.bracketedTabs.add(tab);
  }

  /**
   * Close an admitted read: compare the admission anchor with the record now, for
   * the tabs hydrated outside a planned bracket. A mutation that began, completed
   * or recovered during the request changes the generation, so the caller refuses
   * the response instead of serving rows from two generations.
   */
  settleRead(): void {
    if (this.unbracketedReads.size === 0 || !this.anchor) return;
    try {
      const after = readControlRecord(this.options.control);
      assertAuthority(after, 'workbook-control');
      assertCompletedGeneration(
        portableRevisionProvider(this.anchor),
        portableRevisionProvider(after),
        [...this.unbracketedReads] as WorkbookTabName[]
      );
    } catch (error) {
      throw toRepositoryError(error, 'read');
    }
  }

  /**
   * Publish or widen the in-progress marker. Called after the expected-revision
   * check and before the rows of `tab` change, so a crash between the two leaves
   * a fenced pending state.
   */
  ensureMarked(tab: WorkbookTabName): void {
    try {
      this.ensureMarkedInternal(tab);
    } catch (error) {
      throw toRepositoryError(error, 'write');
    }
  }

  private ensureMarkedInternal(tab: WorkbookTabName): void {
    const bound = this.bound;
    if (!bound) {
      throw new ControlError('OPERATION_MISMATCH', 'The portable session has no admitted operation; a maintenance path must open one explicitly');
    }
    if (!this.scope) {
      const { scope } = this.writer.begin({ operationId: controlOperationId(bound.operation), tabs: [tab], actorId: bound.actorId });
      this.scope = scope;
      this.markedTabs.add(tab);
      this.cached = undefined;
      return;
    }
    if (this.markedTabs.has(tab)) return;
    this.writer.extend(this.scope, tab);
    this.scope.declare(tab);
    this.markedTabs.add(tab);
    this.cached = undefined;
  }

  /** Register a tab whose rows and audit data persisted. */
  registerCommitted(tab: WorkbookTabName): void {
    try {
      this.scope?.markCommitted(tab);
    } catch (error) {
      throw toRepositoryError(error, 'write');
    }
    this.committed.set(tab, (this.committed.get(tab) ?? 0) + 1);
    this.cached = undefined;
  }

  /** True once any tab's rows changed; a failure after this must stay pending. */
  hasRowChanges(): boolean {
    return this.committed.size > 0;
  }

  began(): boolean {
    return this.scope !== undefined;
  }

  /**
   * Complete the operation. A mutation that changed no rows still advances the
   * global revision, because the dispatcher admits it as a successful operation.
   */
  commit(): ControlRecord {
    let record: ControlRecord;
    try {
      const bound = this.bound;
      if (!bound) {
        throw new ControlError('OPERATION_MISMATCH', 'The portable session has no admitted operation to complete');
      }
      record = this.scope
        ? this.writer.commit(this.scope).record
        : this.writer.completeWithoutRows(bound.actorId).record;
    } catch (error) {
      throw toRepositoryError(error, 'write');
    }
    this.cached = record;
    // This request's own commits are part of the record now; keeping them here
    // would count them twice for anything that reads a revision afterwards.
    this.committed.clear();
    this.scope = undefined;
    this.markedTabs.clear();
    return record;
  }

  /**
   * Settle a handler failure. **Nothing is cleared automatically.** The marker is
   * published immediately before the first row write, so its existence means rows
   * may already have changed — including when the failure happened inside the
   * write itself (a failed cell write or audit append). Aborting on the strength
   * of "no tab registered its commit" would present a partially written workbook
   * as current, which is the opposite of the protocol's rule. A failure that never
   * published a marker needs no settlement at all; one that did is for the
   * reviewed recovery procedure, which records its reason.
   */
  settleAfterFailure(_reason: string): ControlRecord | undefined {
    return undefined;
  }
}
