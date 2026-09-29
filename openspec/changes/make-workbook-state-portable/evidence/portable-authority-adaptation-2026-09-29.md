# Portable authority adaptation evidence — 2026-09-29 (tasks 3.2 and 3.5)

Task 3.2: adapt repository commits (and therefore every path that writes through
them) to the protocol and verify the revision kinds stay distinct. Task 3.5:
completed-generation checks around read hydration. Both land through one seam,
so they are recorded together; 3.5's guard was implemented earlier
(`2b03e76`) and is wired here.

## Activation

`src/server/workbook/authority.ts` resolves the authority this process may use
from the `CONTROL_AUTHORITY` Script Property: absent or `script-properties`
keeps today's behaviour, `workbook-control` selects the protocol, and any other
value throws rather than silently downgrading — a typo must not leave a
deployment writing legacy counters against a workbook whose authority moved.
The value is deployment configuration, not workbook state (task 1.3), and the
control record's own `authority` field must agree with it or every request fails
closed with `AUTHORITY_MISMATCH`.

## The repository seam

`src/server/workbook/repository.ts` gains one optional hook on the revision
store's backing: `beforeCommit()`, which runs after the expected-revision check
and **before** the rows change. `src/server/runtime.ts` builds each repository's
backing from the request's session when one is installed:

- `get()` reads the tab counter from the control record plus this request's own
  commits, so in-request revision continuity is preserved;
- `beforeCommit()` publishes or widens the in-progress marker;
- `set()` registers the tab for the completion transition instead of writing
  `TAB_REVISION_<Tab>`.

Because every domain repository is constructed here, this adapts repository
commits for all of them at once: scheduling publication and compensation,
volunteer availability and cancellation, candidate confirmation and center
updates, import promotion and mapping, and Insights refresh. No Script Property
is read or written for revisions under the portable authority, and the
completion transition advances the global revision once, the scheduling-input
revision once when a committed tab is a scheduling input, and each committed tab
once.

`src/server/workbook/portable-session.ts` is the request's session. The marker is
published lazily, when a repository is about to write its first tab, and widened
if the mutation turns out to touch another tab: the tabs a handler touches are
knowable only at the moment it touches them, and a policy table predicting them
would have to be complete or it would refuse legitimate writes. Widening changes
no counter — it is a declaration, and the journal records it.

## Dispatcher lifecycle

`RevisionSource` gains optional `begin(actorId, operation)` and
`settleAfterFailure(reason)` hooks. The dispatcher calls `begin` after the write
lock is held and the revision check has passed, and calls `settleAfterFailure`
when the handler throws. The portable source opens the session on `begin` and
completes it on `advance`. Settlement is deliberately asymmetric:

- a failure that changed **no** rows aborts the mutation, so the next request is
  not blocked behind a marker for work that never happened;
- a failure that **did** change rows leaves the marker pending, because clearing
  it would present a partially written workbook as current. That state belongs to
  the reviewed recovery procedure (task 3.6).

## The read seam

`src/server/portable-authority.ts` wires the `workbook-control` process: one
session per script execution (production builds a fresh server per request), the
revision source above, a `read()` for the current tuple, and a guard that wraps
the batch reader so every named plan read is bracketed by two control reads. The
guard maps its `ControlError` through `toRepositoryError`, so the transport keeps
returning `STALE_REVISION` or `UNAVAILABLE` and never learns the protocol's own
taxonomy.

Under the portable authority a deployment without the batched read path refuses
to serve at all (`CONTROL_AUTHORITY is workbook-control but the batched read path
is unavailable`), because an unbatched read would hydrate without the
completed-snapshot bracket. The control tabs must also exist, or startup fails
with an explicit message instead of falling back to counters the workbook no
longer treats as authoritative.

## Revision kinds remain distinct

`portable-session.contract.test.ts` drives `repositories(...)` with a session and
asserts a publication-shaped mutation (Assignments plus SchedulingRuns): the
global revision advances once, the scheduling-input revision does **not** move
because neither committed tab is a scheduling input, each committed tab advances
by one, and the run row's own `outputRevision` stays a domain value in its row
rather than becoming a control counter.

## Tests

| File | Covers |
| --- | --- |
| `portable-session.contract.test.ts` (15) | counters from the record, in-request commits, marker before rows, tab widening without double-widening, no-row completion, closed gate, unbound write, undeclared commit, both settlement paths, the repository seam end to end (rows land, marker published before them, no legacy property written, counters commit) and the legacy path still advancing properties, plus the distinct-revision case |
| `portable-authority.contract.test.ts` (8) | revision source reading and completing, no-row completion, both settlement paths, guarded read agreement, a read straddling a concurrent completion (`STALE_REVISION`), a read during a pending mutation (`UNAVAILABLE`), and refusal under the legacy authority |

## Not done here

- Task 3.4 (fenced maintenance procedures for the initializer, loader,
  diagnostics and direct-write reconciliation) and task 3.6 (reviewed recovery,
  including the repeated-recovery and failure-during-recovery tests) remain open;
  the session's `settleAfterFailure` deliberately leaves partial writes for 3.6.
- Task 2.4 still needs the private `phamily-env` interpreter for the snapshot
  tooling.
- The control reads this wiring adds on read paths (two per plan read) and on
  mutations are not yet measured; task 4.1 owns that measurement against the
  task 1.7 read plan.

Verification: `pnpm test`, `pnpm run test:worker`, `pnpm run check`,
`pnpm run build` with the Apps Script bundle audit, and the three Worker dry-run
builds are recorded in the execution record for this commit.
