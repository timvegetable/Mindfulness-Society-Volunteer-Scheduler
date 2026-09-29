import type { RevisionSource } from './integration/dispatcher.js';
import type { ActivatedAuthority } from './workbook/authority.js';
import { BATCH_READ_PLANS, type WorkbookBatchReader } from './workbook/batch-read.js';
import { withCompletedSnapshot } from './workbook/completed-snapshot.js';
import { readControlRecord, toRepositoryError, type PrunableSheetLike, type ControlRecord } from './workbook/control.js';
import type { SheetLike } from './workbook/initializer.js';
import { PortableSession } from './workbook/portable-session.js';

/**
 * Wiring for a process activated for `workbook-control` authority: one session
 * per script execution (production constructs a fresh server per request), a
 * revision source the dispatcher opens and completes, and a batch-reader guard
 * that brackets hydration with control reads.
 *
 * Everything here is inert until `CONTROL_AUTHORITY` selects the portable
 * authority; the legacy Script Properties path is untouched.
 */

export type PortableReadinessInput = {
  authority: ActivatedAuthority;
  hasSpreadsheet: boolean;
  hasControlTabs: boolean;
  hasBatchReader: boolean;
};

export type PortableReadiness = { ready: true; portable: boolean } | { ready: false; message: string };

/**
 * Whether the process may serve. A deployment that is activated for the portable
 * authority must have all three of its prerequisites — the workbook, both control
 * tabs and the batched read path — because each one without the others would
 * serve unguarded data; a legacy deployment is always ready. Pure, so the
 * decision can be tested without standing up Apps Script globals.
 */
export function portableReadiness(input: PortableReadinessInput): PortableReadiness {
  if (input.authority !== 'workbook-control') return { ready: true, portable: false };
  if (!input.hasSpreadsheet) {
    return { ready: false, message: 'CONTROL_AUTHORITY is workbook-control but no workbook is bound; the control record cannot be read' };
  }
  if (!input.hasControlTabs) {
    return { ready: false, message: 'CONTROL_AUTHORITY is workbook-control but the control tabs are missing; run the approved initialization before serving' };
  }
  if (!input.hasBatchReader) {
    return { ready: false, message: 'CONTROL_AUTHORITY is workbook-control but the batched read path is unavailable; the completed-snapshot check cannot be applied' };
  }
  return { ready: true, portable: true };
}

export type PortableAuthorityOptions = {
  control: SheetLike;
  journal: PrunableSheetLike;
  /** Live write gate; a closed gate refuses the first row change. */
  writeEnabled: () => boolean;
  now?: () => string;
};

export type PortableAuthority = {
  /** The request's session, handed to the runtime so repositories use it. */
  session: PortableSession;
  /** Opens on `begin`, completes on `advance`, settles a failed handler. */
  revisionSource: RevisionSource;
  /** Brackets every named plan read with the completed-snapshot check. */
  guard(reader: WorkbookBatchReader): WorkbookBatchReader;
  /** One control read, for the paths that only need the current tuple. */
  read(): ControlRecord;
};

export function createPortableAuthority(options: PortableAuthorityOptions): PortableAuthority {
  const session = new PortableSession({
    control: options.control,
    journal: options.journal,
    writeEnabled: options.writeEnabled,
    ...(options.now ? { now: options.now } : {})
  });

  const revisionSource: RevisionSource = {
    current: () => session.dataRevision(),
    begin: (actorId, operation) => { session.bind(actorId, operation); },
    advance: () => session.commit().dataRevision,
    settleAfterFailure: (reason) => { session.settleAfterFailure(reason); },
    settleRead: () => { session.settleRead(); }
  };

  return {
    session,
    revisionSource,
    read: () => readControlRecord(options.control),
    guard: (reader) => ({
      read(plan) {
        try {
          const snapshot = withCompletedSnapshot({
            // Two reads straddle the hydration: the first establishes the
            // generation, the second proves nothing completed in between.
            readControl: () => readControlRecord(options.control),
            hydrate: () => reader.read(plan),
            tabs: BATCH_READ_PLANS[plan],
            authority: 'workbook-control'
          });
          // These tabs are bracketed; the request-level check must not pay for
          // them a second time.
          session.markBracketed(BATCH_READ_PLANS[plan]);
          return snapshot.data;
        } catch (error) {
          throw toRepositoryError(error, 'read');
        }
      }
    })
  };
}
