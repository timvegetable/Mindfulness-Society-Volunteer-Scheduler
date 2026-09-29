# Mutation lifecycle evidence — 2026-09-29 (task 3.1)

Task 3.1: script lock plus live gate/authority checks and durable
pending/completed generation transitions, with tests for failure before rows,
mid-write and before final completion. The transitions are the ones task 1.2
pinned in `design.md`; this is the writer-side implementation, exercised against
the control tab.

## What is implemented

`src/server/workbook/control.ts`:

- **Pure transitions.** `beginMutationRecord` publishes the in-progress marker
  (generation + 1, `pending`, operation id, start, affected tabs, the captured
  baseline tuple) and refuses an already-pending record, an empty operation id or
  an empty tab set. `commitMutationRecord` advances the global revision by one,
  the scheduling-input revision by one when a committed tab is a scheduling input,
  and each committed tab by one, then clears the marker and sets
  `completedGeneration = generation`. `abortMutationRecord` advances the
  generation only: an aborted mutation is not a revision, and the advanced
  generation is what stops a read that began under the marker from accepting its
  snapshot.
- **`ControlMutationWriter`.** One fenced entry point per transition. Each holds
  the script lock (`tryLock`, released in `finally`), checks the **live write
  gate** through a supplied predicate and the **authority** the writer was
  activated for, and refuses a mismatch before writing anything. The journal
  entry is appended *before* the control row it describes, so a crash between the
  two leaves an auditable attempt rather than an unexplained counter jump.
- **`MutationScope`.** The begin result. Repositories register the tabs they
  actually committed with `markCommitted`, which refuses a tab the mutation did
  not declare; `commit` therefore advances exactly the tabs that persisted, and a
  repeated `markCommitted` for one tab advances it once.
- **Journal bounds.** `appendJournalEntry` refuses an entry that cannot fit
  inside the 2,048-byte ceiling instead of truncating it, and prunes
  oldest-first past the 200-entry retention when the sheet supports `deleteRows`.
- **Failure taxonomy.** `OPERATION_MISMATCH`, `GATE_CLOSED` and `LOCKED` join the
  task 1.2 codes, mapped to `CONFLICT` (a completion that does not match the
  pending operation, an undeclared tab, a contended lock) and `UNAVAILABLE` (a
  closed live gate), with `controlFailureCode` covering every code.
- `SCHEDULING_INPUT_TABS` moved into `schema.ts` so the runtime and the control
  protocol advance the same set instead of two copies drifting apart.

## Tests

`src/server/workbook/control-mutation.contract.test.ts`, 17 tests:

| Requirement | Test |
| --- | --- |
| Marker published before any row change, journal first | begin writes the pending record, `log` equals `['journal', 'control']`, journal entry matches generation and operation |
| Live gate | closed gate refuses with `GATE_CLOSED`, writes no journal row and leaves the record at generation 0 |
| Authority | a writer activated for `script-properties` is refused against a `workbook-control` record |
| Script lock | a held lock refuses with `LOCKED` and writes nothing |
| Failure before rows | begin, then no completion: the marker survives, the provider reports not idle, and a second writer against the same workbook is refused with `PENDING` |
| Mid-write failure | begin, `markCommitted`, then abort: generation advances, every counter stays put, journal records `begin` then `abort` with the reason |
| Before final completion | a completion or abort whose operation id differs from the pending one is refused with `OPERATION_MISMATCH`; a commit of an undeclared tab is refused |
| Counter rules | commit advances data revision once, scheduling-input revision once for a scheduling input, each committed tab once, and sets `completedGeneration = generation`; a non-scheduling-input commit leaves the composed counter alone |
| Journal before/after tuples | both sides of each transition are recorded |
| Journal bounds | pruning keeps 200 entries and drops the oldest; an oversized entry is refused |
| Control-tab protection | initialization protects every control column as data, not only the header (the control-tab half of task 2.2) |

## Boundary and what is still open

This is the writer side of the protocol against the control tab. What remains is
the integration the following tasks own: adapting repository commits and the
dispatcher to hold a mutation scope across a request (3.2), reading through the
completed-generation bracket (3.5), the import-preview reclassification (3.3),
fenced maintenance paths (3.4) and reviewed recovery (3.6). Until those land, no
production request path writes a control record, so nothing here changes current
serving behaviour — the module is dormant code with its own tests.

Verification at this commit: `pnpm test` 44 files / 315 tests passed;
`pnpm run check` exit 0 (both type programs and ESLint).
