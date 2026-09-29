import {
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  ControlMutationWriter,
  controlOperationId,
  portableRevisionProvider,
  readControlRecord,
  type ControlRecord,
  type MutationScope,
  type PortableRevisionProvider,
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
    this.cached ??= readControlRecord(this.options.control);
    return this.cached;
  }

  protocolVersion(): number {
    return CONTROL_PROTOCOL_VERSION;
  }

  /** Counters the repositories must use, including this request's own commits. */
  tabRevision(tab: WorkbookTabName): number {
    return (this.record().tabRevisions[tab] ?? 0) + (this.committed.get(tab) ?? 0);
  }

  dataRevision(): number {
    return this.record().dataRevision;
  }

  schedulingInputRevision(): number {
    return this.record().schedulingInputRevision;
  }

  /** A provider over the in-request counters, for the completed-snapshot bracket. */
  provider(): PortableRevisionProvider {
    const record = this.record();
    const tabRevisions = { ...record.tabRevisions };
    for (const [tab, increment] of this.committed) tabRevisions[tab] = (tabRevisions[tab] ?? 0) + increment;
    return portableRevisionProvider({
      ...record,
      tabRevisions,
      // A marker written during this request is visible to a reader bracket in
      // the same request, during which nothing else may complete.
      mutationState: this.scope ? 'pending' : record.mutationState,
      ...(this.scope ? { operationId: this.scope.operationId, operationTabs: [...this.scope.tabs] } : {})
    });
  }

  /**
   * Publish or widen the in-progress marker. Called after the expected-revision
   * check and before the rows of `tab` change, so a crash between the two leaves
   * a fenced pending state.
   */
  ensureMarked(tab: WorkbookTabName): void {
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
    this.scope?.markCommitted(tab);
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
    const bound = this.bound;
    if (!bound) {
      throw new ControlError('OPERATION_MISMATCH', 'The portable session has no admitted operation to complete');
    }
    const record = this.scope
      ? this.writer.commit(this.scope).record
      : this.writer.completeWithoutRows(bound.actorId).record;
    this.cached = record;
    return record;
  }

  /**
   * Settle a handler failure. A mutation that never changed a row is aborted so
   * the next request is not blocked; one that already changed rows stays pending
   * on purpose, because clearing it would present a partially written workbook
   * as current. That state is for the reviewed recovery procedure.
   */
  settleAfterFailure(reason: string): ControlRecord | undefined {
    if (!this.scope || this.hasRowChanges()) return undefined;
    const record = this.writer.abort(this.scope, reason).record;
    this.cached = record;
    this.scope = undefined;
    return record;
  }
}
