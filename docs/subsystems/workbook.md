# Workbook subsystem

## Ownership

`schema.ts` is the versioned tab/column definition. `initializer.ts` creates/checks tabs and protected columns. `sheet-values.ts` normalizes raw Sheet types. `codecs.ts` maps rows to validated domain values. `repository.ts` provides request-scoped snapshots, optimistic writes, audit append, and revision storage. `loader.ts` validates and applies reviewed migration payloads.

Raw `SpreadsheetApp` values must not escape this layer.

## Schema

Schema version 3 defines `Volunteers`, `RecurringAvailability`, `AvailabilityExceptions`, `Sessions`, `Assignments`, `Backups`, `SchedulingRuns`, `Imports`, `ImportMappings`, `ImportedAvailability`, `Users`, `Settings`, append-only `AuditLog`, `Centers`, and `CandidateSchedules`.

Stable opaque IDs link rows. Display names are not keys. Protected columns include IDs, ownership/role fields, revisions, timestamps, and scheduling-critical fields. Adding or changing a tab/column requires coordinated schema, codec, initializer/migration, runtime, tests, and documentation changes.

## Repository contract

`SheetRepository.list()` performs at most one tab read in an Apps Script request and returns copies of its in-memory snapshot. `replace` and `upsert` compare the tab revision, write the complete encoded range, clear stale trailing rows, update the request snapshot, append an audit entry, then persist the next tab revision. `AuditLog` is append-only.

Google Sheets is not transactional. Higher-level services must stage complete results, use the script lock, and define compensation or preservation behavior for multi-tab publication. Never mutate rows while iterating toward a partially published result.

## Revisions and time cells

Tab revisions live in Script Properties and are advanced only through repository commits. Writes to scheduling-input tabs also advance the separate scheduling-input counter. Manual/Sheets API changes are invisible to both.

Decode `Date` values in the spreadsheet's time zone, not the configured scheduling zone. Time-only Sheets cells are anchored to historical dates and can shift by non-whole hours if decoded in the wrong zone. Domain rows should contain normalized date, time, instant, and IANA-zone strings after decoding.

## Migration

`validateMigrationWorkbook()` may initialize missing tabs and reports rejected rows without loading them. `loadMigrationWorkbook()` requires live `WRITE_ENABLED=true`, rejects the entire load if any row fails validation, and records the configured migration actor. `MigrationPayload.gs` is temporary private material and must not remain in an ordinary server bundle.

