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
