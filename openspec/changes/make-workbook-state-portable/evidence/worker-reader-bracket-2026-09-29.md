# Worker reader control bracket — 2026-09-29

The second reader adapter. Task 3.5 implemented the completed-snapshot check for
the shared batch path the Apps Script runtime uses; task 4.1 requires both reader
adapters to be rehearsed, so the staging Worker's read path is now bracketed too.

## What changed

- `src/server/workbook/control.ts` — `controlRecordFromRows` is extracted from
  `readControlRecord`, so both adapters validate the same record from the rows
  they each obtained: SpreadsheetApp ranges for Apps Script, a validated REST
  batch for the Worker.
- `src/server/workbook/completed-snapshot.ts` — `withCompletedSnapshotAsync`, the
  same bracket for a reader whose reads are promises: control read, hydration,
  control read, then the authority check and the tuple comparison.
- `src/worker/config.ts` — `controlAuthority(bindings)` reads an optional
  `STAGING_CONTROL_AUTHORITY` binding, mirroring the Apps Script
  `CONTROL_AUTHORITY` property: absent or `script-properties` leaves the reader
  unguarded, `workbook-control` turns the bracket on, and any other value is a
  configuration fault rather than a silent downgrade.
- `src/worker/staging.ts` — named-plan hydration goes through `readPlanRows`,
  which is the plain read when the authority is legacy and the bracketed read
  when it is `workbook-control`. A `ControlError` from the bracket becomes a
  bounded failure envelope through `controlFailureCode`: `STALE_REVISION` for a
  generation that moved, `UNAVAILABLE` for a pending mutation or unusable
  metadata, each with a `control-*` reason and no row values.
- The response envelope is unchanged. The bracket is invisible to callers, which
  matters because the archived parity evidence pins the Worker's envelopes
  against the Apps Script runtime's field by field.
- `src/worker/staging-test-support.ts` — the fixture renderer no longer applies
  its date/time heuristics to control tabs: the protocol writes counters as
  numbers and the serialized maps and stamps as text, and Sheets returns a text
  cell as text.

## Tests

Five new cases in `src/worker/staging.test.ts` (worker suite now 8 files / 132
tests):

| Case | Assertion |
| --- | --- |
| Activated and consistent | Envelope identical to the legacy runtime's projection; the read sequence is `Users`, `WorkbookControl`, the domain plan, `WorkbookControl` — the plan sits inside the bracket and authorization stays outside it |
| Pending mutation | `UNAVAILABLE` with `reason: control-pending`, before any domain range is fetched |
| Generation moved between the two control reads | `STALE_REVISION` with `reason: control-generation_changed` |
| Binding active, record missing | `UNAVAILABLE` with `reason: control-missing` — the deployment fails closed rather than serving unguarded |
| Binding absent | Serves as before and issues no `WorkbookControl` read |

The third case is the one that matters for correctness: a static router cannot
express a race, so the test mutates the control row between the first and second
control read, which is exactly the interleaving the bracket exists to catch.

## What this does not do

- No response field was added for the revision tuple. The design's read plan
  names the tuple as the reader's acceptance input, not as a response shape, and
  changing the staging envelopes would invalidate the archived parity evidence.
- The staging Worker deployment does not carry `STAGING_CONTROL_AUTHORITY` yet,
  so it still serves unguarded until the rehearsal's approved redeploy sets it.
  That redeploy is part of the task 4.1/4.2 approval request, not of this commit.
- The two extra reads per served plan read are not yet measured against the task
  1.7 read plan: the Worker's own `X-Staging-Sheets-Reads` counter now includes
  them, and task 4.1 is where they are measured.

Verification: worker suite 8 files / 132 tests; the full local gate results for
this commit are recorded in the execution record.
