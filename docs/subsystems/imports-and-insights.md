# Imports and insights subsystems

## WhenIsGood imports

`src/server/imports/` owns fetch, embedded-data parsing, roster normalization, identity matching, staging, promotion, and in-memory test repositories. The browser supplies only a results code; Apps Script performs the remote fetch.

The importer parses the complete source, normalizes time-zone intervals, hashes content, matches stable participant identifiers/email before administrator mappings, and records unmatched or ambiguous participants. A preview is staged before authoritative data changes. Repeated identical content is idempotent. Parser/fetch/validation failure records diagnostics and preserves the last promoted availability.

Promotion is all-or-nothing from the staged result. It replaces authoritative `RecurringAvailability` for imported participants and writes `ImportedAvailability` provenance. Because promoted availability is authoritative for scheduling and insights, promotion must use repository revisions and advance scheduling-input staleness. A mapping update may re-stage unresolved imports; it must rebuild rather than append duplicate rows.

The promote operation returns both mutation metadata and an `import` projection rebuilt from the persisted promoted run. The client uses that projection to repaint the import route and retain its promotion notice; the route has no separate read operation and must not replace a successful result with an empty form.

The WhenIsGood page is an undocumented external format. Keep parser fixtures scrubbed and representative. Do not move parsing into the browser or expose result data/codes in committed artifacts.

## Availability insights

`src/server/insights/` owns leftover-volunteer derivation, overlap cells, projection, storage, and Script Cache serialization. A leftover volunteer is active, ranked, and absent from the current schedule output assignments. It uses authoritative recurring availability.

The overlap grid uses configured operating hours and fixed increments. Adjacent increments merge only when their exact volunteer sets match. Table and heatmap are projections of the same cells; counts and names must agree, with names restricted to administrators.

An insight dataset records its source tuple, including eligibility/availability and current schedule assignment revisions. Reuse is legal only for an exact source match. A source change returns/regenerates stale data from one consistent snapshot. Script Cache is an optimization: malformed, missing, oversize, or evicted entries must fall back safely to regeneration and can never authorize access.

The authorized administrator Insights handler uses the workbook batch plan: it reads `SchedulingRuns` first, then reads `Volunteers`, `RecurringAvailability`, and `Assignments` only for a cache miss or explicit refresh. The plan excludes `Users`; authorization still uses a fresh request-local Users read. Both batches and the decoded rows remain within one execution, and the runtime rejects a revision change observed during hydration.
