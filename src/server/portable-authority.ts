import type { RevisionSource } from './integration/dispatcher.js';
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
    settleAfterFailure: (reason) => { session.settleAfterFailure(reason); }
  };

  return {
    session,
    revisionSource,
    read: () => readControlRecord(options.control),
    guard: (reader) => ({
      read(plan) {
        try {
          return withCompletedSnapshot({
            // Two reads straddle the hydration: the first establishes the
            // generation, the second proves nothing completed in between.
            readControl: () => readControlRecord(options.control),
            hydrate: () => reader.read(plan),
            tabs: BATCH_READ_PLANS[plan],
            authority: 'workbook-control'
          }).data;
        } catch (error) {
          throw toRepositoryError(error, 'read');
        }
      }
    })
  };
}
