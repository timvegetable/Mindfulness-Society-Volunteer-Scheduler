# Staging rehearsal run — 2026-09-29 (tasks 4.1/4.2, batch 1)

Approved by the operator as the [rehearsal manifest](staging-rehearsal-manifest-2026-09-29.md).
This batch covers S1 (baseline) and S2 (initialization, twice) on the
representative synthetic workbook. Raw reports are in ignored private storage;
this file records the sanitized results, including two incidents this batch
caused and repaired.

## S1 — baseline

`rehearsal-baseline-representative-2026-09-29T21-21-40-309Z.json`.

- 16 tabs, `America/New_York`, 39 volunteers, 199 recurring-availability rows,
  11 exceptions, 19 sessions, 19 assignments, 3 backups, 3 users, 3 centers.
- Control tabs absent, as expected before initialization.
- The runner's domain digest, `aedfec2ba6062301…`, **equals the digest the
  archived campaign pinned for this fixture** — the rehearsal is reading the same
  synthetic workbook the Durable Object evidence was measured on.

## S2 — initialization, first pass

`rehearsal-initialize-representative-2026-09-29T21-2*.json`.

Result: schema version 4 with **one** effective Settings record, two control tabs
created (`WorkbookControl`, `ControlJournal`), 50 protected ranges applied and 4
refused, 82 Sheets API calls.

### Incident A — the runner wrote data values into every header row

`readTabs` requests `A2:…` — data rows only — and the runner's in-memory mirror
treated the first read row as the header. It therefore reported every tab as
having a stale header and wrote that first data row into row 1 of all 17 tabs.

- **Detected** by re-running the baseline immediately afterwards: the domain
  digest had changed.
- **Diagnosed** by diffing the two baselines row by row: every domain tab's data
  rows were byte-identical, and the only differences were `Settings` gaining its
  version row and the two control tabs appearing. No row-level data was lost.
- **Repaired** by rewriting every header row from the repository's own schema
  (one batched call), then verifying all 17 header rows match the schema exactly.
- **Fixed** in the runner: the mirror now builds each sheet from the schema header
  and treats every read row as data, so the defect cannot recur.

### Incident B — the Sheets write quota (429)

The first pass issued one call per protected range. The platform returned
`429 RESOURCE_EXHAUSTED` for `Write requests per minute per user` after 82 calls,
and the four "refused" protections in that report were quota failures, not
permission failures.

- **Retained**: the 429 is a recorded platform failure, not a retried-away one.
  No retry loop was used; the repair ran after the quota window rolled over.
- **Fixed** by batching: all headers in one `values:batchUpdate`, all protected
  ranges in one `spreadsheets:batchUpdate`. The second pass used **6** API calls.

## S2 — initialization, second pass (idempotence)

`rehearsal-initialize-representative-2026-09-29T21-24-43-893Z.json`.

- `alreadyInitialized: true`, `createdTabs: []`, `updatedHeaders: []`,
  `updatedVersionRecord: false` — **no Settings row was appended**, which is the
  task 2.1 fix holding on a live workbook that had the append defect's residue.
- `schemaVersionRecords: 1`, `malformedVersionRecords: 0`.
- Protections: 54 applied, **0 refused** — the loader service account can protect
  ranges once the calls are batched.
- 6 API calls.

## Verification (S2 → baseline)

`rehearsal-verify-representative-2026-09-29T21-25-0*.json` against the S1
baseline: the only changed domain tab is `Settings`; version 4 with one record and
no malformed records. `controlRecordPresent: false` is correct at this point —
initialization creates the structure, and the capture (S3) writes the record.

Measured structure after S2: 18 tabs (16 + 2 control tabs), 17 of them defined by
the schema, one tab outside the schema that predates the rehearsal.

## Finding C — repeated initialization duplicates protected ranges

Counted directly from the spreadsheet's metadata after two passes: a domain tab
carries 6 protected ranges and each control tab 2, with `Schema header row`
appearing 32 times across the workbook. Each pass adds its ranges again rather
than replacing them.

- Scope: measured on the **REST-applied** path the runner uses. Apps Script's
  `Range.protect()` may behave differently, so this is not yet a production
  claim.
- Consequence: protection sprawl on a workbook that is initialized repeatedly,
  and eventually per-sheet protection limits.
- Follow-up recorded in the change's task list with this measurement: make
  protection application idempotent, and have the production verification count
  protected ranges before and after initialization.

## S1/S2 on the larger synthetic workbook

Same run, second target, now that the runner is fixed:

- Baseline digest `fc05ff654fff5304…` — again **exactly the archived campaign's
  pinned digest** for the larger fixture (199 volunteers, 399 sessions, 3 users,
  16 tabs, `America/New_York`).
- First pass: two control tabs created, schema 4, **one** effective Settings
  record, 54 protected ranges applied with **zero refusals**, 13 API calls — the
  lower call count versus the representative workbook is the mirror fix working:
  the larger workbook's headers already matched the schema, so nothing was
  rewritten.
- Second pass: `alreadyInitialized: true`, `updatedVersionRecord: false`, 6 API
  calls, no Settings row appended.
- Verification against the baseline: 18 tabs, `Settings` the only changed domain
  tab, version 4 with one record and no malformed records, control record still
  absent (S3 has not run).

## State at the end of this batch

- Representative workbook: initialized (schema 4, two control tabs, one Settings
  version record, protections applied), no control record yet. Data rows
  unchanged from the baseline.
- Larger workbook: initialized the same way (schema 4, two control tabs, one
  Settings version record), no control record yet.
- No Worker deployment changed; no reader check performed yet (those need a fresh
  Google ID-token credential, which the retained ones no longer are).
- Attempt ledger unchanged at 529: this batch was Sheets API calls, not harness
  attempts.

## Honest limitations

- The runner's apply step is a faithful *projection* of the production
  initializer's decisions, not the Apps Script runtime itself: the initializer ran
  against an in-memory mirror of the workbook's rows and its recorded decisions
  (tabs, headers, version record, protections) were applied over REST. The
  Apps Script path still needs its own production verification.
- Only the representative workbook has been rehearsed so far; the larger fixture,
  the counter transitions (S3–S8), the bracketed reader (D1/D2) and the reader
  checks remain.
