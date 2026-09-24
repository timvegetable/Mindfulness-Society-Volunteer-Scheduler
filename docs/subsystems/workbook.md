# Workbook subsystem

## Ownership

`schema.ts` is the versioned tab/column definition. `initializer.ts` creates/checks tab headers and applies protections, with the limitations below. `sheet-values.ts` normalizes raw Sheet types. `codecs.ts` maps rows to validated domain values. `repository.ts` provides request-scoped snapshots, optimistic writes, audit append, and revision storage. `batch-read.ts` builds and validates allowlisted Schedule/Insights Values API reads. `loader.ts` validates and applies reviewed migration payloads.

Raw `SpreadsheetApp` values must not escape this layer.

## Schema

Schema version 3 defines `Volunteers`, `RecurringAvailability`, `AvailabilityExceptions`, `Sessions`, `Assignments`, `Backups`, `SchedulingRuns`, `Imports`, `ImportMappings`, `ImportedAvailability`, `Users`, `Settings`, append-only `AuditLog`, `Centers`, and `CandidateSchedules`.

Stable opaque IDs link rows. Display names are not keys. The schema declares protected IDs, ownership/role fields, revisions, timestamps and scheduling-critical fields. The initializer currently protects only the header range, not these data columns (original task 10.25); inspect actual protections before relying on them. Adding or changing a tab/column requires coordinated schema, codec, initializer/migration, runtime, tests, and documentation changes.

`readSchemaVersion` returns the first matching Settings key. With duplicate historical version rows, repeated initialization can append another current-version row while still reporting the old version (original task 10.24). `checkWorkbookSchema()` checks that version only, not all headers/protections. `validateMigrationWorkbook()` also initializes before payload validation, even with `apply: false`; see [operational precautions](../operations.md#diagnostics). The [portable-state change](../../openspec/changes/make-workbook-state-portable/tasks.md) incorporates these repairs without marking them complete.

## Repository contract

`SheetRepository.list()` performs at most one tab read in an Apps Script request and returns copies of its in-memory snapshot. Runtime sheet handles resolve on first use, so unrelated tabs do not incur `getSheetByName` calls. `read-plans.ts` names the exact published Schedule and Insights tab sets; `Users` is always fresh for a new request. `replace` and `upsert` compare the tab revision, write the complete encoded range, clear stale trailing rows, update the request snapshot, append an audit entry, then persist the next tab revision. `AuditLog` is append-only.

## Batched Schedule and Insights reads

`batch-read.ts` derives ranges from the tab schema and the named plans in `read-plans.ts`; callers cannot supply a tab, range, workbook ID, or query. The plans exclude `Users`, which the runtime reads freshly with `SpreadsheetApp` before the dispatcher authorizes an operation. The Apps Script adapter binds each request to the active spreadsheet ID and calls the Sheets v4 Values API with `UNFORMATTED_VALUE` and `SERIAL_NUMBER`. It verifies the workbook ID, result order, returned ranges, row widths, and cell types, then pads omitted trailing cells to the schema width. A missing service, malformed response, or missing bound workbook fails the request.

`SheetRepository.primeRows()` decodes a validated batch into the same request snapshot used by `get()` and `list()`. Numeric date/time serials are converted as spreadsheet-local civil values using the workbook time zone; normal `SpreadsheetApp` `Date` decoding is unchanged. Schedule uses one batch. Insights first reads runs to decide whether the cache matches, then reads any missing source tabs in a second batch for a miss or refresh. Revisions are sampled around route hydration, and rows are never retained across requests.

After the deploying owner authorizes the new scope, `compareAdvancedReadParity()` can be run manually from the Apps Script editor before pinning a deployment. It requires the live `WRITE_ENABLED` property to equal `false`, invokes only the read handlers against separate request-local runtimes, ignores the generated timestamp when comparing Insights results, and logs only parity booleans and differing projection field names. It does not write workbook cells or cache data.

Google Sheets is not transactional. Higher-level services must stage complete results, use the script lock, and define compensation or preservation behavior for multi-tab publication. Never mutate rows while iterating toward a partially published result.

## Revisions and time cells

Tab revisions live in Script Properties and are advanced only through repository commits. Writes to scheduling-input tabs also advance the separate scheduling-input counter. Manual/Sheets API changes are invisible to both.

Decode `Date` values in the spreadsheet's time zone, not the configured scheduling zone. Time-only Sheets cells are anchored to historical dates and can shift by non-whole hours if decoded in the wrong zone. Domain rows should contain normalized date, time, instant, and IANA-zone strings after decoding.

## Migration

`validateMigrationWorkbook()` may initialize missing tabs and reports rejected rows without loading them. `loadMigrationWorkbook()` requires live `WRITE_ENABLED=true`, rejects the entire load if any row fails validation, and records the configured migration actor. `MigrationPayload.gs` is temporary private material and must not remain in an ordinary server bundle.
