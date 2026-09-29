# Review resolution — 2026-09-29

Two independent reviews ran against the branch at `8d84fac`: a spec-compliance
review (five fixed questions over the spec delta, the pinned design, the ticked
tasks and the implementation) and a repository-standards review (five fixed
questions over the diff, the conventions and the documentation). Every finding was
checked against the code before being accepted; all fifteen were supported and are
resolved here.

## Spec-compliance findings

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | blocker | Reads outside the declared batch plans hydrated domain rows with no control check, so a mutation completing mid-read could be served as one dataset | Every repository hydration now reports its tab to the request's session (`runtime.ts` read hook). The session takes an admission anchor on the first unbracketed read, and the dispatcher closes an admitted read before answering: it re-reads the record and compares the anchor's generation and tuple for those tabs, answering `STALE_REVISION` (or `UNAVAILABLE` for an unusable record) instead of a mixed dataset. Planned reads mark their tabs, so the tight bracket keeps paying for itself and costs nothing extra. |
| 2 | blocker | Payload revisions still came from Script Properties, which stop advancing once the repositories commit to the control record | `globalRevision` and the scheduling-input accessor read the request's session when one is installed and the properties otherwise; a test drives the candidate projection with a record saying 5 and properties saying 999 and expects 5, and the legacy path still reports 999. |
| 3 | major | Write-path `ControlError` reached the transport as `INTERNAL_ERROR` | The session converts through `toRepositoryError`: a closed gate is `UNAVAILABLE`, an unbound or mismatched operation is `CONFLICT`, a malformed record on a write is `UNAVAILABLE`. |
| 4 | major | A missing control tab threw a plain `Error` while building the server and escaped `doPost` | `portableReadiness` is a pure helper for the whole decision; its refusals and the missing-tab case raise `RepositoryError('UNAVAILABLE')`, and `doPost` gained the catch it never had, answering through the adapter's own serialiser and logging one bounded line. |
| 5 | major | `loadMigrationWorkbook` post-activation wrote rows and legacy counters outside the protocol | The loader refuses to apply once the workbook is activated, before writing anything, with the precondition in the loader where it is testable; validation still runs without writing. |
| 6 | major | The documented direct-write reconciliation could not run, and the fence's journal never advanced the generation | `ControlMutationWriter.reconcile` fences a batch applied outside the protocol (a marker naming its tabs) and then settles it with the reviewer's decision; the maintenance fence's journal now advances the generation, so a bracketed read rejects a snapshot spanning a maintenance action. |
| 7 | minor | No capture/activation/rollback transition existed; the `activate` and `rollback` journal events were unreachable and `authorityEpoch` never moved | `activationTransition` (counters as `max(captured, current)`, epoch and generation advances, refusals for a pending mutation, a missing reason and an unknown tab) with `ControlMutationWriter.activate` under the lock and the drained gate. |
| 8 | minor | `PortableSession.provider()` was dead code and `commit()` left per-request state behind | `provider()` is gone; `commit()` clears the request's commit map, scope and marked tabs so a later revision read cannot double-count. |

## Repository-standards findings

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | major | `docs/operations.md` still described the pre-fix Settings reader as current | Rewritten to the effective-last-record resolution and the in-place rewrite, keeping the note that exports taken before 2026-09-29 can hold repeated keys. |
| 2 | major | A handler failure between the row write and the counter registration could abort a marker over a partially written workbook | `settleAfterFailure` no longer clears anything: the marker is published immediately before the first row write, so its existence means rows may have changed. A failure that never published a marker needs no settlement; one that did stays pending for reviewed recovery. The tests that asserted the old behaviour now pin the fail-closed rule. |
| 3 | minor | The client's new "preview needs a revision" behaviour was untested | Three view cases: the action receives `data.revision`, an absent revision is passed through for the controller to refuse, and an empty results code never calls the action. |
| 4 | minor | Both authority-configuration refusals were untested | Table-driven tests for absent, blank, both literals, three typos and a non-string value, on the Apps Script property and the Worker binding. |
| 5 | minor | The rehearsal runner had no contract test | Its entry point is now guarded so the module can be imported, and eleven cases pin the argument refusals, the accepted shapes and the confirmation gate. |
| 6 | minor | The new fail-closed deployment wiring had no test | Extracted into `portableReadiness` and covered: legacy ready, each prerequisite missing with its own message, and all present. |
| 7 | minor | Two documents claimed handlers always read tab expectations from Script Properties | Both now qualify it by authority. |

## What the reviews confirmed as correct

The control codec and its invariants (idle equality, pending requires an operation
and a tab, byte ceilings, unknown names refused), idempotent seeding that never
overwrites unusable state, journal-before-control-row ordering, retention pruning,
the completed-snapshot bracket for the named plans in both adapters with tuple
comparison rather than revision equality, the Worker's read-only posture, read-only
migration validation and the inspection diagnostic, `primeRows` refusing a second
hydration, fail-closed authority configuration, no domain-row writes outside the
repository layer, no new dependency, strict TypeScript respected, and no secret,
identifier or private export in any changed file.

## Verification

`pnpm test` 54 files / 433 tests at the resolution commit (419 before the
review-driven test additions); `pnpm run test:worker` 8 files / 138 tests;
`pnpm run check` exit 0; `pnpm run build` exit 0 with the Apps Script bundle
audit; three Worker dry-run builds exit 0; `openspec validate
make-workbook-state-portable --strict` valid; `git diff --check` clean.
