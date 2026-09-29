# Workbook subsystem

## Ownership

`schema.ts` is the versioned tab/column definition. `initializer.ts` creates/checks tab headers and applies protections. `sheet-values.ts` normalizes raw Sheet types. `codecs.ts` maps rows to validated domain values. `repository.ts` provides request-scoped snapshots, optimistic writes, audit append, and revision storage. `batch-read.ts` builds and validates allowlisted Schedule/Insights Values API reads. `loader.ts` validates and applies reviewed migration payloads. `control.ts` owns the portable control record — codec, failure taxonomy, transitions, the fenced writer, recovery and the journal — with `portable-session.ts` holding one request's view of it, `completed-snapshot.ts` the reader bracket, `maintenance.ts` the fenced maintenance procedure, and `authority.ts` the deployment's authority selection.

Raw `SpreadsheetApp` values must not escape this layer.

## Schema

Schema version 4 defines `Volunteers`, `RecurringAvailability`, `AvailabilityExceptions`, `Sessions`, `Assignments`, `Backups`, `SchedulingRuns`, `Imports`, `ImportMappings`, `ImportedAvailability`, `Users`, `Settings`, append-only `AuditLog`, `Centers`, and `CandidateSchedules`, plus two schema-defined control tabs: `WorkbookControl` (one protected row of protocol state) and `ControlJournal` (bounded, append-only transitions). The control tabs are deliberately outside `WORKBOOK_TABS`: that list defines the synthetic fixture identity digest, so including protocol metadata in it would redefine an identity the staging campaigns quote as evidence.

Stable opaque IDs link rows. Display names are not keys. The schema declares protected IDs, ownership/role fields, revisions, timestamps and scheduling-critical fields, and the initializer protects those declared data columns as well as the header row (2026-09-29, [task 2.2](../../openspec/changes/make-workbook-state-portable/tasks.md)); before that fix it protected only the header. Protection covers the rows that exist plus the next one, so a tab that grows further needs the maintenance procedure to run again — and repeated runs add their ranges again rather than replacing them, a recorded [follow-up](../../openspec/changes/make-workbook-state-portable/tasks.md) with its measurement. Adding or changing a tab/column requires coordinated schema, codec, initializer/migration, runtime, tests, and documentation changes.

`resolveSchemaVersion` returns the **effective** version — the last Settings record that parses — so a workbook carrying the append defect's duplicate rows reports its current version, and initialization rewrites that record in place instead of appending, so repeated runs converge (2026-09-29, task 2.1). `checkWorkbookSchema()` reports the version record count and any malformed records alongside validity, but still not every header or protection. `validateMigrationWorkbook()` writes nothing: only the apply path initializes, and that path runs under the maintenance fence. See [operational precautions](../operations.md#diagnostics).

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

`validateMigrationWorkbook()` writes nothing: it reports the rows that would be rejected without creating tabs, headers or protections (2026-09-29, [task 3.4](../../openspec/changes/make-workbook-state-portable/tasks.md)). `loadMigrationWorkbook()` is a fenced maintenance action: it runs under the script lock with the live write gate **closed** (writers drained), initializes structure, rejects the entire load if any row fails validation, writes under the configured migration actor, and seeds the control record idempotently once the workbook carries it. Its older interlock required `WRITE_ENABLED=true`; that is inverted, and the migration manifest records it. `MigrationPayload.gs` is temporary private material and must not remain in an ordinary server bundle.

## Control state

`WorkbookControl` holds protocol version, authority and epoch, a monotonic generation, the global/scheduling-input/per-tab counters, and the in-progress operation; `ControlJournal` records every transition with its counter tuple and reason. A mutation publishes a pending marker **before** its first row change and completes with one row write that advances the generation and exactly the counters it touched; an abort or a restore advances only the generation, which is why readers compare the whole tuple. Missing, duplicated, malformed or unsupported state fails closed — never to revision zero — and a malformed record is never overwritten by initialization.

Which authority a deployment may use comes from `CONTROL_AUTHORITY` (absent or `script-properties` is the legacy path), and the record's own `authority` must agree or requests fail closed. Readers hydrate inside a bracket of two control reads and accept the result only when both are idle with the same completed generation and tuple ([architecture](../architecture.md#portable-control-protocol)); `audit` rows are never rewritten by a recovery, and counters only ever increase.

The initializer and the migration loader run under the maintenance fence: script lock held, live write gate required **closed**. Their interlock shipped in the other order (`validateMigrationWorkbook` initialized, and the loader required the gate open), so a reader of this document before 2026-09-29 must not assume the older behaviour.
