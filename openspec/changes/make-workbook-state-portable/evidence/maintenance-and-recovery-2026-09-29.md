# Fenced maintenance and reviewed recovery — 2026-09-29 (tasks 3.4 and 3.6)

## Task 3.6 — reviewed recovery of an interrupted mutation

`src/server/workbook/control.ts` gains `recoveryTransition`, the pure
counter arithmetic for the three decisions the design pins, and
`ControlMutationWriter.recover`, the fenced way to apply one.

| Decision | Counters | Generated state |
| --- | --- | --- |
| `completed` — persistence verified | global +1, scheduling input +1 when a named tab is one, each named tab +1 | generation +1, `completedGeneration` = generation, idle |
| `not-started` — no row changed | unchanged | generation +1, `completedGeneration` = generation, idle |
| `restored` — partial rows restored from the approved snapshot | unchanged | generation +1, `completedGeneration` = generation, idle |

Properties of the implementation, each with a test:

- **A repeated recovery stops.** The transition refuses unless a mutation is
  actually pending, so a second run cannot advance every counter twice; the test
  performs one recovery and then asserts the second is refused with
  `OPERATION_MISMATCH` and that the record did not move.
- **Rows are never restored by this code.** The reviewed procedure restores rows;
  the protocol only records the decision. A `restored` recovery leaves every
  counter exactly where it was — counters only ever increase, and a restore is a
  new change, not an undo of the counter history.
- **A decision must explain itself.** An empty reason is refused, and a
  `completed` decision that names no verified tab is refused, because a recovery
  with no recorded basis is indistinguishable from an improvised counter bump.
- **The journal names the interrupted operation.** The entry records the pending
  operation id, the reviewer, the reason, and the counter tuple on both sides —
  the recovery actor is not substituted for the operation under review.
- **Failure during recovery is recoverable.** The journal entry is written before
  the control row, so a failed transition leaves an auditable attempt, the record
  still pending and the counters untouched; a retry then succeeds and moves the
  counters once. This is asserted with a fault injected into the control-row
  write.
- **The live gate is deliberately not consulted.** Recovery is a stopped-service
  procedure: the test shows `begin` refusing with `GATE_CLOSED` while `recover`
  runs in the same drained state. Nothing else in the writer skips that check.
- Lock and authority are still required (`LOCKED`, `AUTHORITY_MISMATCH`).

## Task 3.4 — fenced maintenance procedures

`src/server/workbook/maintenance.ts` adds `withMaintenanceFence`: the script lock
is held for the whole action, the **live write gate must be closed** (writers
drained), and the control record is seeded idempotently through a lazily resolved
control tab — lazy because initialization is what creates that tab. A malformed,
duplicated or unsupported record is never overwritten, and a maintenance run
journals one `capture` entry naming the action once the record exists.

Adapted entrypoints (`src/server/main.ts`):

- `initializeWorkbook()` (editor trampoline) now runs inside the fence, seeds the
  empty control record on its first run and returns the record's generation
  alongside the initialization result. The control record keeps `authority:
  script-properties` and zero counters: initialization never invents authority or
  a revision.
- `loadMigrationWorkbook()` runs inside the fence. Its interlock is **inverted**:
  it used to require `WRITE_ENABLED=true`, and now requires the gate closed and
  the lock held, which is the drained posture the design requires for a Sheet
  mutation. The migration manifest and `docs/subsystems/workbook.md` record the
  inversion.
- `validateMigrationWorkbook()` is now genuinely read-only. It used to initialize
  the workbook before validating the payload, so a diagnostic created tabs,
  headers, protections and a Settings row; `applyMigrationPayload` initializes
  only on the apply path, and a new test proves a validation run against a
  workbook missing its tabs creates none of them while an apply run does.

`docs/operations.md` gains the protocol-aware direct-write reconciliation: with
control state present, the batch is recorded as a recovery decision
(`not-started`, `restored`, or `completed` with the touched tabs) instead of
hand-bumped Script Properties, the record must be idle before the batch, and
which procedure applies is read from the record's `authority` rather than
assumed.

### No unaccounted writer

Re-running the writer inventory over `src/server` (excluding tests and the
in-memory stand-in) finds raw Sheet writes in exactly four modules — the
initializer, the control module, the repository, and the runtime's audit writer —
plus Script Property writes in `runtime.ts` and `main.ts`:

| Writer | Reachable from | Fenced by |
| --- | --- | --- |
| `initializer.ts` (tabs, headers, protections, version row) | the editor trampoline and the loader's apply path | `withMaintenanceFence` in both |
| `loader.ts` row writes | the editor trampoline `loadMigrationWorkbook` | `withMaintenanceFence` |
| `repository.ts` row and audit writes | the dispatcher (served requests) or the fenced loader | the dispatcher's write lock; the fence for the loader |
| `control.ts` record and journal writes | the request session (dispatcher lock) or `recover`/the fence | the same lock, or the writer's own lock |
| `runtime.ts` / `main.ts` revision properties | the dispatcher path only | the dispatcher's write lock |

The injectable `createServer({…}).initializeWorkbook()` surface remains on the
composition root; no editor trampoline or HTTP route reaches it, and the eight
trampolines emitted by `scripts/expose-appsscript.mjs` are the only editor
entrypoints. That is the strongest statement this inventory supports — a writer
reaching `SpreadsheetApp` through an indirection the search does not name, or
living outside this repository, would not appear here.

## Verification

`pnpm test` 49 files / 370 tests passed; `pnpm run check` exit 0; `pnpm run build`
exit 0 with the Apps Script bundle audit. New coverage: eight recovery tests and
eight maintenance tests, including the loader-purity cases.

## Not done here

- Task 2.4 (snapshot tooling and private recovery manifests) still needs the
  private `phamily-env` interpreter for the snapshot tooling; the recovery
  manifests it extends are the task 5.1 release artefacts.
- The staging rehearsal (4.1/4.2) that exercises these paths against the
  synthetic workbooks needs the bounded staging approval.
