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

## 2026-09-29 (later) — portable authority adaptation: tasks 3.2 and 3.5 done

- **3.2, 3.5** — `evidence/portable-authority-adaptation-2026-09-29.md`. The
  `CONTROL_AUTHORITY` deployment switch, the request-scoped `PortableSession`,
  the `beforeCommit` seam that adapts every domain repository at once, the
  dispatcher `begin`/`settleAfterFailure` hooks, and the guard wiring that
  brackets named plan reads with two control reads. A portable-authority
  deployment without the batched read path now refuses to serve instead of
  hydrating unguarded.
- The build gate caught a real regression in this batch: an unguarded
  `globalThis.crypto` access in the new operation-id helper failed the Apps
  Script bundle audit (`dist/apps-script/Code.js:63 … references unsupported
  global crypto`). Fixed by using the same `typeof`-guarded access the audit id
  in `repository.ts` documents.
- Gates at this commit: `pnpm test` 47 files / 354 tests; `pnpm run check` exit
  0; `pnpm run build` exit 0 with the bundle audit; `pnpm run test:worker`
  8 files / 127 tests; three Worker dry-run builds exit 0; strict OpenSpec
  validation valid.
- **Still open**: 2.4 (private `phamily-env` interpreter), 3.4 (fenced
  maintenance procedures) and 3.6 (reviewed recovery). The session leaves a
  partial-write failure pending on purpose; 3.6 owns clearing it.

## 2026-09-29 (later still) — tasks 3.4 and 3.6 done

- **3.6** — `evidence/maintenance-and-recovery-2026-09-29.md`. Reviewed recovery:
  the three decisions with their counter arithmetic, a refused repeat, a
  mandatory recorded reason, the journal naming the interrupted operation, and a
  fault-injected failure during recovery followed by a successful retry.
- **3.4** — same evidence. `withMaintenanceFence` (script lock held, live gate
  required closed, idempotent control seeding, journal) wraps the editor
  initializer and the migration loader; validation is now genuinely read-only
  (it used to initialize, creating tabs, protections and a Settings row); the
  loader interlock is inverted to the drained posture and the docs record it; and
  the direct-write reconciliation procedure in `docs/operations.md` is adapted to
  the control record. The writer inventory was re-run and is recorded there,
  including the one injectable surface (`createServer({...}).initializeWorkbook()`)
  that no trampoline or route reaches.
- Gates: `pnpm test` 49 files / 370 tests; `pnpm run check` exit 0; `pnpm run
  build` exit 0 with the bundle audit.
- **Section 3 is complete.** What remains is task 2.4 (private `phamily-env`
  snapshot interpreter), the bounded staging rehearsal (4.1/4.2), release and
  rollback artefacts (5.1), the documentation/validation pass (4.3) and the
  independent reviews.

## 2026-09-29 — Worker reader bracketed (second adapter)

- `evidence/worker-reader-bracket-2026-09-29.md`. The staging Worker's named-plan
  hydration is bracketed by control reads when `STAGING_CONTROL_AUTHORITY` is
  `workbook-control`, with a `ControlError` becoming a bounded
  `STALE_REVISION`/`UNAVAILABLE` envelope and no change to the response shape
  (the archived parity evidence pins those envelopes). `controlRecordFromRows`
  and `withCompletedSnapshotAsync` are shared with the Apps Script path.
- The fixture renderer no longer applies its date/time heuristics to control
  tabs, where the protocol writes numbers and text.
- Five Worker cases: identical envelope with the bracket on, the exact read
  sequence (`Users`, control, plan, control), pending refusal, a generation that
  moves between the two control reads, a missing record failing closed, and the
  unguarded legacy path issuing no control read.
- Worker suite 8 files / 132 tests. Full gates: `pnpm test` 49 files / 370
  tests, `pnpm run check` exit 0, `pnpm run build` exit 0 with the bundle audit,
  three Worker dry-run builds exit 0.
- The deployed staging Worker does not carry the binding yet, so it serves
  unguarded until the rehearsal's approved redeploy sets it.

## 2026-09-29 — release artefacts prepared, staging approval requested

- `evidence/release-artefacts-2026-09-29.md` — task 5.1's preparation: the server
  release manifest with its behavioural deltas and deployment order (client
  first, then server with the authority unset), the workbook migration manifest
  M1–M4 with per-step verification, the rollback table for before/after
  activation including the prohibited counter copy-back, the activation
  verification steps, and the list of production actions that remain
  unauthorized.
- `evidence/staging-rehearsal-manifest-2026-09-29.md` — the bounded approval
  request for tasks 4.1/4.2: two synthetic targets, two individually approved host
  redeployments, mutations S1–S8 with their expected effects and reversals,
  snapshots and cleanup, at most 200 further attempts against the retained
  529/1,000 ledger, reads paced at ≤ 40 per 60 seconds through the shared ledger,
  and the six verification outputs the rehearsal must produce.
- Task 5.1 stays unticked: its manifests are prepared, but the production
  authorizations it sequences are not requested yet and the plan calls for its
  authorization-dependent portions to stay open.

## 2026-09-29 — staging rehearsal approved and batch 1 executed

The operator approved the [rehearsal manifest](../changes/make-workbook-state-portable/evidence/staging-rehearsal-manifest-2026-09-29.md).

- Built `scripts/staging/rehearse-portable-state.ts` (run with `vite-node`, so it
  imports the production initializer and control codecs rather than
  reimplementing them) plus control-tab support and batched writes in
  `scripts/staging/workbook.mjs`, with `scripts/**/*.ts` now inside the type-check
  program.
- **S1/S2 executed on the representative workbook**:
  `evidence/staging-rehearsal-run-2026-09-29.md`. The baseline digest equals the
  archived campaign's pinned digest; initialization is idempotent on a live
  workbook (one effective Settings record, nothing appended on the second pass);
  protections apply with zero refusals once batched.
- **Two incidents, both detected and repaired, both recorded**: the runner wrote
  data values into every header row (mirror treated `A2:` reads as including the
  header) — data rows verified byte-identical by baseline diff, headers restored
  from the schema and verified 17/17; and the first pass hit the Sheets write
  quota with one call per protected range (retained 429) — fixed by batching, 82
  calls down to 6.
- **Finding C**: repeated initialization duplicates protected ranges (measured);
  recorded as a follow-up with its evidence and its scope limit.
- Attempt ledger unchanged at 529; no deployment changed; no reader check yet.

S2 is complete on both targets: the larger workbook's baseline digest matched the
archived pin (`fc05ff65…`), its first initialization pass created the control tabs
with 54 protections and zero refusals in 13 calls, and its second pass reported
`alreadyInitialized` without appending a Settings row.

## 2026-09-29 — S3–S8 counter transitions rehearsed (batch 2)

`evidence/staging-rehearsal-run-2026-09-29.md` (batch 2). Capture wrote the
counters the deployment itself serves; an abort and a restore each advanced the
generation with every counter untouched; completion moved the global revision by
one, the composed scheduling-input revision by one because Volunteers is a
scheduling input, and each committed tab by one; the tagged fixture row was
removed and its tab returned byte-for-byte to the baseline digest; and the
authority rollback pair advanced both the epoch and the generation. Every step
reported `rereadMatches: true`.

Three runner defects were found and fixed in this batch: `verify` dropped the
control record row, baseline row counts were one short per tab, and `rollback`
did not advance the generation. A restore attempted with nothing pending was
refused with `OPERATION_MISMATCH`, retained as intended protocol behaviour.

## Next eligible action

The two approved host redeployments (D1/D2) and the reader checks. The operator
chose to supply a fresh Google ID token as `staging-local/credential-rehearsal.txt`;
once that file exists the sequence in the rehearsal evidence runs unchanged (D1,
the six read checks with their expected codes and read counts, D2). Nothing has
been deployed or claimed in the meantime. Two independent reviews — spec
compliance and repository standards — are running against the branch and their
findings are processed before the final brief.
