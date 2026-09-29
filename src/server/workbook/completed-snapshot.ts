import { ControlError, assertAuthority, assertCompletedGeneration, portableRevisionProvider, type ControlAuthority, type ControlRecord } from './control.js';
import type { WorkbookTabName } from './schema.js';

/**
 * The reader half of the consistency protocol: hydrate inside a bracket of two
 * control reads and accept the result only when both observations show the same
 * completed generation and revision tuple.
 *
 * Equal revisions alone would not be enough. An aborted or recovered mutation
 * advances the generation without moving a counter, so a reader that compared
 * revisions only would accept rows hydrated across an interruption. The tuple
 * comparison is what makes the acceptance rule "the same completed generation",
 * not "the same numbers".
 */

export type CompletedSnapshotOptions<T> = {
  /** One control read; called once before and once after hydration. */
  readControl: () => ControlRecord;
  /** Hydrates the domain data the snapshot validates. */
  hydrate: () => T;
  /** Tabs the caller consumes; only their counters have to match. */
  tabs: readonly WorkbookTabName[];
  /** Authority this reader was activated for. */
  authority: ControlAuthority;
};

export type CompletedSnapshot<T> = {
  data: T;
  /** The record observed after hydration, for diagnostics and projections. */
  record: ControlRecord;
};

function readAndCheck(readControl: () => ControlRecord, authority: ControlAuthority): ControlRecord {
  const record = readControl();
  assertAuthority(record, authority);
  return record;
}

/**
 * Refuse before hydrating when the first control read already shows a pending
 * mutation: waiting until after hydration would pay for the domain read only to
 * discard it, and the read plan prices that rejection at one control read.
 */
function assertIdleBeforeHydration(record: ControlRecord): void {
  if (!portableRevisionProvider(record).idle) {
    throw new ControlError('PENDING', 'A mutation is in progress; the snapshot would not be current');
  }
}

/**
 * Run `hydrate` between two control reads. Any failure throws before the data is
 * returned, so a caller cannot accidentally serve rows from a snapshot that
 * straddled a mutation; `controlFailureCode` maps the thrown `ControlError` onto
 * the API error code for the response.
 */
export function withCompletedSnapshot<T>(options: CompletedSnapshotOptions<T>): CompletedSnapshot<T> {
  const before = readAndCheck(options.readControl, options.authority);
  assertIdleBeforeHydration(before);
  const data = options.hydrate();
  const after = readAndCheck(options.readControl, options.authority);
  assertCompletedGeneration(portableRevisionProvider(before), portableRevisionProvider(after), options.tabs);
  return { data, record: after };
}

export type CompletedSnapshotAsyncOptions<T> = {
  readControl: () => Promise<ControlRecord>;
  hydrate: () => Promise<T>;
  tabs: readonly WorkbookTabName[];
  authority: ControlAuthority;
};

/**
 * The same bracket for a reader whose reads are asynchronous — the staging
 * Worker fetches every range over REST. The ordering is identical: control,
 * hydration, control, then the tuple comparison.
 */
export async function withCompletedSnapshotAsync<T>(options: CompletedSnapshotAsyncOptions<T>): Promise<CompletedSnapshot<T>> {
  const before = await options.readControl();
  assertAuthority(before, options.authority);
  assertIdleBeforeHydration(before);
  const data = await options.hydrate();
  const after = await options.readControl();
  assertAuthority(after, options.authority);
  assertCompletedGeneration(portableRevisionProvider(before), portableRevisionProvider(after), options.tabs);
  return { data, record: after };
}
