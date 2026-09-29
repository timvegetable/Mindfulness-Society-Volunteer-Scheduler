# Execution record — make-workbook-state-portable

Campaign: execute `plan.md` (apply `make-workbook-state-portable` through accepted
prerequisites, implementation, synthetic staging rehearsal, and production release
preparation). Production activation, pushes, paid services and archiving are outside
this workflow.

Branch: `dsh/make-workbook-state-portable`, created 2026-09-29 from `master` at
`cbe4285`. First commit `6905445` carries the four authorized OpenSpec edits
(prerequisite restatement in `tasks.md` 1.1–1.7 and 4.1, the prerequisite
assessment section in `design.md`, the archived-evidence links in `proposal.md`,
and the unresolved-conditions scenario in the spec delta).

## Status (2026-09-29)

- Prerequisite phase. Implementation has not started, because the change's own
  task 1.1 gate forbids implementation while a prerequisite condition is
  conditional-go.
- Task 1.5 (free-tier duration) is resolved. Tasks 1.4 (CPU) and 1.6 (503/JWKS)
  have delegated assessments in flight; task 1.1's inventory is delegated.
- Tasks 1.2, 1.3 and 1.7 design work proceeds while those gaps close; 1.2 and 1.7
  are pinned in `design.md`, 1.3 waits on the inventory.
- OpenSpec task checkboxes remain unticked: a checkbox is set only with the
  evidence the task names, not because work exists.

## Approvals

- None requested yet.
- The next approval this workflow needs is a bounded staging mutation window for
  the task 4.1/4.2 rehearsal (initialization twice, controlled capture/seed/
  activation, interrupted write and forward recovery, rollback) with its
  attempt budget and cleanup. If the task 1.6 classification requires repair, the
  contract additionally requires a repeated cold/burst workload, which needs its
  own individually approved redeployments.

## Durable state and evidence conventions

- Task state: `openspec/changes/make-workbook-state-portable/tasks.md` is
  authoritative. Evidence: dated, sanitized files under `evidence/`.
- Private material (credentials, raw platform reports, workbook identifiers,
  attempt logs) stays in ignored `staging-local/`; the committed evidence refers
  to it by path only.
- Campaign attempt budget: the staging attempt ledger is retained across
  restarts (`.attempt-budget-ledger.json`), and the archived campaign's recorded
  limits are not reopened or extended.
- Verification tooling: `openspec validate make-workbook-state-portable --strict`,
  `pnpm test`, `pnpm run test:worker`, `pnpm run check`, `pnpm run build`, the
  three Worker dry-run builds, and `git diff --check`.
- j-space control state lives in `.jspace/control.json`; the previous campaign's
  state is archived under `.jspace/archive/`.

## 2026-09-29 — prerequisite evidence

### Task 1.5 — free-tier duration: resolved, met

`evidence/prerequisite-duration-assessment-2026-09-29.md`. The platform does
publish billable duration: `durableObjectsPeriodicGroups.sum.duration` is GB-s at
the documented 128 MB per billed unit (verified as an exact 0.128000 ratio against
`sum.activeTime` on all 142 periodic rows of both campaigns). Measured: 95.144 GB-s
and 1,503 object requests on 2026-09-28; 47.622 GB-s and 571 on 2026-09-29 —
0.73% and 0.37% of the 13,000 GB-s/day allowance, 1.5% and 0.57% of the 100,000
requests/day allowance. The 100/500/1,000-per-day projections stay at or below
0.64% of the duration allowance. This corrects both archived verdicts, which
recorded billable duration as unpublished.

### Task 1.4 — CPU acceptance: measured, delegated assessment in flight

The Durable Object invocations dataset does publish per-request CPU statistics
(`quantiles { cpuTimeP25 … cpuTimeP999 }` per one-second bucket, with single-request
buckets yielding exact samples); the archived campaigns never selected the field.
The parent agent's independent bounds over the retained raw rows are recorded in
`staging-local/independent-cpu-bounds-*.txt`, and the detailed, query-documented
assessment is being produced as `evidence/prerequisite-cpu-assessment-2026-09-29.md`.

### Task 1.6 — 503 and JWKS window: delegated classification in flight

Assessment in flight as `evidence/prerequisite-503-classification-2026-09-29.md`.

### Task 1.1 — inventory: delegated in flight

Inventory in flight as `evidence/prerequisite-inventory-2026-09-29.md`.

### Tasks 1.2 and 1.7 — design pinned

`design.md` now records the physical control schema (columns, types, bounds, the
atomic update boundary, and the exact counter transitions for success, abort,
recovery, activation and rollback), the failure conditions after activation with
their response codes, the interrupted-mutation recovery decisions, and the
portable reader's control/Users/domain read plan with its per-path read counts and
quota and latency acceptance.

## Next eligible action

Consume the three delegated reports, verify each against its sources and the
retained raw data, synthesise the task 1.1 prerequisite assessment, and then
either unblock implementation or record the precise unresolved condition.

## 2026-09-29 — prerequisites resolved, implementation opened

All three delegated reports came back and each was verified independently before
acceptance: the CPU assessment's populations against the parent's own queries
over the retained raw rows (the one number that differed was the parent's
classifier filing representative-fixture previews as reads, which the delegate's
per-operation body table resolves), the inventory's property and writer claims
against the source, and the 503 classification against the platform records.
Findings were folded in as corrections rather than accepted as written: the
archived "488 ms per burst preview" divides a 30-request interval by 20, and the
archived "correlation id present" is not reproducible from the attempt log.

Outcome: every prerequisite condition is resolved rather than conditional-go.
Gateway CPU, object read CPU, object preview CPU, wall time, correctness, the
Sheets budget, memory, free-tier consumption and cold coverage are met on
attributed evidence; the reliability row is met under the predeclared attribution
rules with one retained platform failure whose recorded mechanism has been
corrected. Implementation is therefore no longer blocked by task 1.1.

Commits after the checkpoint: `0c21825` (prerequisite evidence and task ticks
1.1–1.7), `726507c` (tasks 2.1 and 2.2).

## Implementation evidence (tasks 2.1–2.3)

- **2.1, 2.2** — `evidence/workbook-foundation-2026-09-29.md`. Schema-version
  resolution reads the last parsable record, initialization rewrites in place
  instead of appending, and the declared protected columns are actually
  protected. A new initializer contract file fails 10/10 against the pre-fix
  initializer restored from `HEAD` and passes with the fix. Original tasks 10.24
  and 10.25 keep their own checkboxes open for their production evidence.
- **2.3** — `evidence/control-foundation-2026-09-29.md`. Control record codec,
  typed failure taxonomy, read-side revision provider, completed-generation
  assertion and idempotent initialization, with 25 tests over malformed,
  missing, duplicate and unsupported records. Schema version 4 adds the control
  tabs; they are deliberately outside `WORKBOOK_TABS` because that list defines
  the fixture identity digest pinned to the deployed staging workbooks — adding
  them there fails the pinned digest test, which is how the boundary was found.
- **2.4 is not done.** Its snapshot tooling needs the private `phamily-env`
  interpreter named in `docs/operations.md`, and its manifest format belongs to
  the task 5.1 release artefacts.

Validation at `726507c` plus the control work: `pnpm test` 43 files / 298 tests
passed; `pnpm run test:worker` 8 files / 127 tests passed; `pnpm run check`
clean; `pnpm run build` with the Apps Script bundle audit passed (Code.js
500 KB); all three Worker dry-run builds passed, including the gateway bundle
audit; `openspec validate make-workbook-state-portable --strict` valid.

## Next eligible action

Implement section 3 (writer protocol, reader completed-generation checks, import
preview reclassification, fenced maintenance paths) and task 2.4, then request
the bounded staging mutation window the task 4.1/4.2 rehearsal needs.

## 2026-09-29 — writer protocol, preview reclassification and the read guard

The operator accepted the corrected task 1.6 attribution, so implementation
continued on the same branch.

- **3.1** — `evidence/mutation-lifecycle-2026-09-29.md`, commit `4c07690`. The
  fenced `ControlMutationWriter` (script lock, live gate, authority) plus pure
  begin/commit/abort transitions, a mutation scope that registers only the tabs
  that persisted, a bounded journal written before the control row, and the
  exact counter rules. 17 tests cover a closed gate, wrong authority, a held
  lock, a crash before rows, a mid-write abort, a mismatched completion and a
  second writer while pending.
- **3.3** — `evidence/import-preview-reclassification-2026-09-29.md`, commit
  `a8ef766`. Import preview is a mutation; the dispatcher enforces the declared
  revision with `INVALID_REQUEST` before any state is touched; the client
  sources the revision from the rendered run. Six dispatcher cases assert zero
  persistence on the write-disabled, read-only, missing and stale paths, and the
  architecture, integration, operations, security and testing documents are
  updated in the same commit, stating the source behaviour and that the deployed
  build carries it only after an approved release.
- **3.5 (mechanism only)** — commit `2b03e76`. `withCompletedSnapshot` hydrates
  inside a bracket of two control reads and rejects a concurrent completion,
  abort, recovery or pending state; eight tests include the abort case where no
  counter moves. It is not wired into a served path yet: the guard installs only
  when the process is activated for `workbook-control` authority, which task 3.2
  introduces. The task stays unticked until that wiring exists.
- **Not started**: task 2.4 (needs the private `phamily-env` snapshot
  interpreter) and tasks 3.2, 3.4, 3.6 (authority provider and repository and
  dispatcher adaptation, fenced maintenance paths, reviewed recovery).

Gates after each commit: `pnpm test` 45 files / 331 tests passed; `pnpm run
check` exit 0; strict OpenSpec validation valid.

## Next eligible action

Task 3.2: introduce the activated-authority configuration and the request-scoped
portable session, adapt the repository revision stores and the dispatcher
lifecycle to it, and wire the completed-snapshot guard into the served read path
(which is also what completes task 3.5). Then task 3.4 and 3.6, then the staging
approval request.
