# Workbook foundation evidence — 2026-09-29 (tasks 2.1, 2.2)

Original defects: [task 10.24](../volunteer-session-scheduling/tasks.md) (schema
version resolution and repeated initialization) and task 10.25 (declared
protected data columns). Both are confirmed in source and both now have
regressions that fail against the unfixed code.

## What was wrong

- `readSchemaVersion` returned the **first** `workbookSchemaVersion` row in
  `Settings`, while `initializeWorkbook` **appended** another row whenever the
  resolved value differed from the code's version. The production workbook
  exported on 2026-09-21 holds seven rows for that key, the first carrying `1`
  and later rows `3`, so the reader reported `1`, `alreadyInitialized` was never
  true, and every initialization appended again.
- `protectColumns` protected `getRange(1, 1, 1, columns.length)` — the header
  row, all columns, one row — while labelling it "Protected columns: …". Every
  data cell in a declared protected column was editable.
- No test file covered the initializer at all.

## What changed

`src/server/workbook/initializer.ts`:

- `resolveSchemaVersion` returns the effective version — the **last** matching
  row whose value parses as a non-negative safe integer — and counts the
  matching records and the malformed ones instead of coercing them. The first
  stale row no longer wins, so a workbook already carrying the documented
  duplicate residue resolves to the current version.
- `initializeWorkbook` rewrites the effective version record **in place** and
  appends only when the workbook has none, so repeated initialization converges
  and appends nothing. `InitializationResult` now reports
  `schemaVersionRecords`, `malformedVersionRecords` and `updatedVersionRecord`.
- `assertSchemaVersion` distinguishes "no version record", a malformed record and
  a mismatched one in its message.
- `checkActiveWorkbookSchema` reports `records` and `malformed` alongside
  `valid`/`version`, so the editor diagnostic describes the duplicate residue
  instead of only the wrong version.
- `protectColumns` protects the full header row (so a column cannot be renamed
  out from under the codecs) **and** every run of declared protected columns from
  row 2 to the last existing row, at least row 2, with `warningOnly` false and
  the protected-column description on the data ranges. Adjacent protected
  columns are grouped by `protectedColumnRuns`, so the number of protection
  calls is proportional to the runs, not the columns.
- `src/server/workbook/in-memory-sheet.ts` records protections so tests can
  assert coverage, and `setValue` now writes one cell instead of replacing the
  whole row, matching `Range.setValue`.

## Regression evidence

New file `src/server/workbook/initializer.contract.test.ts`, 10 tests. Run
against the pre-fix `initializer.ts` (restored from `HEAD`, then reverted):

```text
× schema-version resolution > resolves the effective version from the last matching record, not the first
× schema-version resolution > counts malformed version records instead of coercing them
× schema-version resolution > reports a workbook whose only version record is malformed
× schema-version resolution > resolves to null when the Settings tab holds no version record
× initialization idempotence > rewrites the effective version record in place and appends nothing on a rerun
× initialization idempotence > does not append a duplicate row when stale duplicates already exist
× initialization idempotence > converges stale duplicates onto the current version without shrinking history
× declared data-column protection > groups adjacent protected columns into runs
× declared data-column protection > protects every declared data column and the header row for each tab
× declared data-column protection > protects the next data row even when a tab holds only its header
Test Files  1 failed (1)      Tests  10 failed (10)
```

The substantive regressions are the five resolution/idempotence tests and the
data-column protection test, which assert behaviour the pre-fix code lacks. The
two `protectedColumnRuns` grouping tests fail against the pre-fix code only
because the helper is new; they are unit coverage for the fix, not regressions.

With the fix in place:

```text
Test Files  1 passed (1)      Tests  10 passed (10)
```

## Scope and limits

- Full suite and static checks at this commit: `pnpm test` 42 files / 273 tests
  passed; `pnpm run check` clean.
- These are source-level fixes. The **production workbook still holds the
  duplicate version rows** and the header-only protections applied by earlier
  runs; removing or extending them is a workbook mutation that runs under the
  approved maintenance procedure (tasks 2.4 and 5.2), not here. The fix is what
  makes that procedure safe to run: it converges on the latest row and writes in
  place.
- Original tasks 10.24 and 10.25 keep their own acceptance checkboxes open. 10.24
  additionally requires a production snapshot recapture with zero canonical
  difference, which is a production export and stays open with the rest of
  section 5.
- Protection covers the rows that exist plus the next one; a tab that grows by
  more than one row after initialization needs the procedure to run again. That
  bound is inherent to range-based Sheets protections and is recorded here rather
  than claimed away.
