# Final brief — make-workbook-state-portable, 2026-09-29

**Outcome: Blocked on one input.** Every piece of work this workflow can do
locally is complete and verified: prerequisites resolved with measured evidence,
sections 2 and 3 implemented with tests, the workbook half of the staging
rehearsal executed against the real synthetic workbooks, release and rollback
artefacts prepared, both independent reviews resolved. What remains is the
deployed reader measurement, and it needs a fresh Google ID token that only the
operator can produce.

Branch `dsh/make-workbook-state-portable`, 32 commits from `master` at `cbe4285`,
tree clean, never pushed.

## The single unresolved condition

The staging reader checks (D1 → six checks → D2) need a valid ID token for an
administrator account in the synthetic `Users` tab. The retained tokens expired
hours before this run. The sign-in page is served at `http://localhost:8788/`; a
successful sign-in writes `staging-local/credential-rehearsal.txt` (ignored, mode
600), and the checks then run unchanged from the recorded sequence — D1 is a host
redeploy with `STAGING_CONTROL_AUTHORITY=workbook-control`, D2 restores the
topology.

Nothing has been deployed, pushed, or mutated in production at any point in this
campaign.

## What is delivered, and the evidence for each

### Prerequisites (tasks 1.1–1.7) — complete

The archived campaigns left three conditions unevaluated. All three are closed
from data they never collected, not from a relaxed threshold.

| Task | Result | Evidence |
| --- | --- | --- |
| 1.1 assessment and inventory | met | [prerequisite assessment](prerequisite-assessment-2026-09-29.md) (every predeclared gate with its disposition), [inventory](prerequisite-inventory-2026-09-29.md) (14 property keys, 16 operations, 19 maintenance paths, 238 `path:line` links) |
| 1.2 control schema | pinned | `design.md` — columns, bounds, atomic boundary, counter transitions, failure codes |
| 1.3 classification and rollback | pinned | `design.md` — every property categorised, rollback boundary, stopped-writer rule |
| 1.4 CPU acceptance | met | [CPU assessment](prerequisite-cpu-assessment-2026-09-29.md) — read bound 124.5 ms vs 500 ms, optimized-preview bound 2,724.4 ms vs 3,000 ms, ten cold samples 84.9–891.9 ms vs 5,000 ms, labelled as bounds |
| 1.5 duration | met | [duration assessment](prerequisite-duration-assessment-2026-09-29.md) — platform-published GB-s, 0.37–0.73% of the daily allowance |
| 1.6 reliability | met under the predeclared rules | [classification](prerequisite-503-classification-2026-09-29.md) and [attribution capture](prerequisite-503-attribution-capture-2026-09-29.md) — the recorded mechanism was wrong (a key-set failure returns HTTP 200 with both headers); the event is a platform dispatch failure, 5 gateway dispatches against 4 object requests in that second |
| 1.7 read plan | pinned | `design.md` — per-path read counts, shared-ledger pacing, task 4.1 as the measurement gate |

### Implementation (tasks 2.1–2.4, 3.1–3.6) — complete

| Task | Evidence |
| --- | --- |
| 2.1, 2.2 | [workbook foundation](workbook-foundation-2026-09-29.md) — the initializer contract file fails 10/10 against the pre-fix module and passes with the fix |
| 2.3 | [control foundation](control-foundation-2026-09-29.md) — codec, failure taxonomy, revision provider, idempotent initialization, 25 tests |
| 2.4 | [snapshot control state](snapshot-control-state-2026-09-29.md) — verified end to end against a real workbook export; self-test grew 56 → 82 checks |
| 3.1 | [mutation lifecycle](mutation-lifecycle-2026-09-29.md) — fenced writer, pending marker before rows, exact counter rules, 17 tests |
| 3.2, 3.5 | [portable authority adaptation](portable-authority-adaptation-2026-09-29.md) — the repository seam, the request-scoped session, the read bracket |
| 3.3 | [import preview reclassification](import-preview-reclassification-2026-09-29.md) — six dispatcher cases proving zero persistence on every rejection path |
| 3.4, 3.6 | [maintenance and recovery](maintenance-and-recovery-2026-09-29.md) — fenced maintenance, pure validation, reviewed recovery with a fault-injected retry |
| Worker reader | [worker reader bracket](worker-reader-bracket-2026-09-29.md) — the second adapter, with a generation that moves *between* the two control reads |

### Staging rehearsal (tasks 4.1/4.2) — workbook half complete

[manifest](staging-rehearsal-manifest-2026-09-29.md) (approved) and
[run record](staging-rehearsal-run-2026-09-29.md). On both synthetic workbooks the
baseline digest equals the archived campaign's pin (`aedfec2b…`, `fc05ff65…`);
initialization is idempotent on a live workbook; an abort and a restore each
advanced the generation with **every counter untouched** while completion moved
the global revision, the composed scheduling-input revision (because `Volunteers`
is a scheduling input) and each committed tab exactly once; a tagged fixture row
was removed and its tab returned byte-for-byte to its baseline digest. Two
incidents this campaign caused are recorded with their repairs: the runner wrote
data values into header rows (data rows verified byte-identical, headers restored
and verified 17/17), and a one-call-per-protection run hit the Sheets write quota
(retained 429, fixed by batching, 82 calls → 6). One real finding is recorded as a
follow-up with its measurement: repeated initialization duplicates protected
ranges.

### Release and rollback artefacts (task 5.1) — prepared

[release artefacts](release-artefacts-2026-09-29.md): the server release manifest
with its behavioural deltas, the client-before-server ordering, the workbook
migration M1–M4 with per-step verification, the rollback table (including the
prohibition on copying captured counters back), and the activation verification
steps. Task 5.1 stays unticked because the production authorizations it sequences
have not been requested.

### Independent reviews — both resolved

[review resolution](review-resolution-2026-09-29.md). A spec-compliance review and
a repository-standards review ran against `8d84fac`; all fifteen findings were
checked against the code, found supported and fixed. The two blockers: reads
outside the declared batch plans had no control check at all (now every hydration
is covered by a request-level anchor), and payload revisions still came from
Script Properties, which stop advancing after activation (now sourced from the
control record). The most valuable standards finding: a handler failure could
clear a marker over a partially written workbook — `settleAfterFailure` now clears
nothing.

## Verification at the final commit

| Gate | Result |
| --- | --- |
| `pnpm test` | 54 files / 433 tests |
| `pnpm run test:worker` | 8 files / 138 tests |
| `pnpm run check` | exit 0 |
| `pnpm run build` | exit 0, Apps Script bundle audit passed |
| Three Worker dry-run builds | exit 0 (gateway bundle audit included) |
| Snapshot self-test (`phamily-env`) | 82 checks |
| `openspec validate make-workbook-state-portable --strict` | valid |
| `git diff --check` | clean |

## Remaining production actions (explicitly not performed)

1. Export the production workbook snapshot and record the live counter values.
2. Deploy the client, then the server with `CONTROL_AUTHORITY` unset.
3. Run the fenced initialization (M2) and the capture and activation (M3/M4) in
   one drained window, with the live `WRITE_ENABLED` verified false before and
   after — never inferred from local configuration.
4. Run the activation verification in the release artefacts, including
   `inspectControlState()` and the reader checks on the production workbook.
5. Separately authorize reopening writes, and separately authorize any rollback
   that reverts authority after portable mutations have been admitted.
6. Close original tasks 10.24 and 10.25 with their own production evidence, and
   archive this change only after its production verification is recorded.

## Corrections and limits recorded during the campaign

- The claimed blocker for task 2.4 ("the private `phamily-env` interpreter cannot
  be invoked here") was **wrong**; the interpreter exists and the task is fully
  verified. Corrected in the execution record and the release artefacts.
- The archived "JWKS failed-load window" attribution for the 503 is **refuted** by
  the platform records; the corrected attribution is recorded rather than the
  original.
- One archived quotient ("488 ms per burst preview") divides a 30-request interval
  by 20; the assessments state the correction and no figure depends on it.
- The 1.4 CPU gates pass on **labelled upper bounds**, not measured percentiles:
  exact-sample coverage is 10.2% and 51.4% against the collector's 90% rule.
- The rehearsal runner projects the production initializer's decisions over REST
  rather than executing the Apps Script runtime; the Apps Script path still needs
  its production verification.
- Protected-range duplication on repeated initialization is measured on the
  REST-applied path only; Apps Script's `protect()` may differ.
- The deployment wiring is covered through the extracted `portableReadiness`
  helper rather than by constructing a full server with Apps Script globals; the
  editor entrypoints themselves remain manually verified.
