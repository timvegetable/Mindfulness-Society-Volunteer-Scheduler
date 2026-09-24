## Context

The original change requires fresh warm Schedule and Insights reads to complete within 2000 ms at nearest-rank p95. On 2026-09-20, 42 deployed-client warm samples per route measured 6966 ms for Schedule and 6239 ms for Insights; even the fastest observations were 4520 ms and 3162 ms. Each route currently builds a broad workbook store through sequential Sheet calls, so the gap appears structural.

## Goals / Non-Goals

**Goals:**

- Attribute elapsed time to authentication, Sheet hydration, derivation, serialization, and network-visible request duration.
- Reduce operation reads to the smallest authorized, internally consistent tab/range set.
- Batch independent range reads when that materially improves latency and remains compatible with Apps Script deployment.
- Either meet the existing objective with evidence or obtain an explicit stakeholder decision to amend it.

**Non-Goals:**

- Caching authorization rows across executions.
- Treating stale browser snapshots as authoritative fresh reads.
- Hiding failed requests, cold starts, or upstream delays from measurement reports.
- Quietly changing the performance threshold to match current behavior.

## Decisions

### Measure the browser outcome and server phases separately

Add sanitized request-local timing for credential verification, authorization, workbook hydration, derivation, and response construction. The browser probe drives fresh Schedule and Insights reads, retains only duration and outcome, and treats a redirect ending in 404 HTML as a failed request even when Apps Script reports a completed execution. Run two warm-ups, then gather at least 40 successful warm reads per route. Report all attempts, failures, excluded cold starts or upstream delays, and min/median/max/nearest-rank p95 of successful eligible reads; never remove a slow success. Use clasp's read-only deployment and log inspection to correlate the version and server phases. Browser durations decide the objective.

Alternative considered: immediately adopt the advanced Sheets service. Rejected because it adds deployment configuration and may not address authentication or transport costs.

### Audit the bundle before changing schema or time libraries

Record esbuild input contributions and emitted bytes. Trial minification while retaining the English-only Zod locale exclusion, then check exported entry points, failure envelopes, and Apps Script global compatibility. Compare startup and route timings in a production-shaped non-production setup; retain minification only without measured regression. Zod Mini is a later trial only if bundle/startup evidence still justifies a migration, and requires validation-contract parity plus a measured gain. Temporal and JSBI remain until a replacement passes date and time-zone checks.

### Define operation-specific workbook hydration plans

Schedule and Insights reads declare their tabs/ranges rather than constructing an all-purpose store. Published Schedule requires `Users` for fresh authorization, then `SchedulingRuns`, `Assignments`, `Backups`, `Sessions`, `Volunteers`, and `Centers`. Insights requires `Users`, `SchedulingRuns`, and source revisions; a cache miss additionally requires `Volunteers`, `RecurringAvailability`, and `Assignments`. Revisions are read from Script Properties. Center workflow construction must not hydrate volunteers. Repository snapshots memoize decoded rows within one request; authorization is never cached across executions.

Alternative considered: globally cache decoded workbook rows. Rejected because it can serve stale authorization or revision state and violates the architecture.

### Gate batching on scoped-read evidence

After scoped reads, collect a new sample set. Prepare an Advanced Sheets `spreadsheets.values.batchGet` trial only if either route still exceeds 2000 ms and multiple sequential Sheet reads account for at least half of its median server duration. Before enabling the service or adding `spreadsheets.readonly`, obtain explicit approval for that OAuth expansion; `spreadsheets.currentonly` does not authorize batchGet. Restrict the spreadsheet ID to the bound workbook and ranges to schema-declared tabs. Preserve workbook-zone date/time decoding and fail closed on configuration, missing ranges, or revision inconsistency.

The 2026-09-22 scoped-read deployment met this gate: 40 successful fresh warm browser reads per route gave Schedule p95 7283 ms and Insights p95 15472 ms, with 18 and 6 measured failures respectively. The latest 100 sanitized server phase records had median Sheet-call shares of 93.2% for Schedule and 71.8% for Insights, across 14 and 4–10 sequential calls. A batchGet trial is justified for server latency. Repeated client-visible `script.googleusercontent.com` 404 handoff failures after long waits and a maximum measured server phase duration under 4 seconds indicate a separate transport reliability problem that batching may not solve. Retain the 2000 ms objective and report both effects after the trial.

The approval decision is a security boundary: this web app executes as the deploying owner, and `spreadsheets.readonly` grants the script read access beyond the bound workbook even if the adapter restricts its own calls to that workbook. The reviewed trial must make that expanded authority explicit, retain `spreadsheets.currentonly` for existing repository operations, enable only the Sheets v4 advanced service, and keep all range names derived from the workbook schema rather than request payloads. Before approval, code and contract tests could be prepared without changing the manifest or enabling the service. The 2026-09-23 approval outcome and local activation are recorded below.

On 2026-09-23 the user explicitly approved the Advanced Sheets read trial and the broader `spreadsheets.readonly` scope. The local implementation sets `ADVANCED_SHEETS_READS_ENABLED` true and updates `src/server/appsscript.json` to declare `dependencies.enabledAdvancedServices` with `{ "userSymbol": "Sheets", "serviceId": "sheets", "version": "v4" }` and add `https://www.googleapis.com/auth/spreadsheets.readonly`; it retains `spreadsheets.currentonly`, external-request, and send-mail scopes. The bound spreadsheet ID comes from `SpreadsheetApp.getActiveSpreadsheet().getId()`; no workbook ID or range comes from a browser payload. Runtime calls are limited to schema-derived ranges in the active workbook, but the OAuth scope grants the deploying user read access to other spreadsheets they can access. On 2026-09-24, after owner authorization and approved deployment, the live editor parity check passed for Schedule and Insights, revisions remained stable, and the write gate remained disabled.

The 2026-09-24 browser report showed a response-transport failure after a successful Schedule POST: `/exec` POST redirected to `/echo`, then a slow `/echo` GET redirected back to `/exec`; repeated redirects ended with JSON `INVALID_REQUEST` listing missing `operation` and `idempotencyKey`. That final bodyless GET enters `doGet`, so its validation error does not mean the original POST omitted its envelope. Sanitized server logs show successful batched Schedule handlers with three Sheet calls and about 1.5–1.85 seconds of derivation. ContentService is documented to redirect text responses to a one-time `script.googleusercontent.com` URL, but the repeated bounce is not explained by the local handler code. The browser already follows redirects; no safe code-only transport workaround has been established. Keep the 2000 ms objective and collect the post-batch route sample and a platform-level diagnosis before choosing another architecture or changing the requirement.

Alternative considered: issue direct Sheets calls from services. Rejected because raw Sheet access must remain in the workbook layer.

### Treat renegotiation as a requirements decision

After reasonable scoped and batched-read work, rerun the specified sample set. If the p95 remains above 2000 ms because of the platform floor, present timings and architectural alternatives to administrators. Change the requirement only through an explicit spec amendment.

An external serverless API could keep GitHub Pages and Sheets while replacing Apps Script's one-time response handoff. It would require a new server authorization and Sheets credential model, revision and write-gate migration, and a parallel deployment/rollback path. The browser failure evidence makes a small non-production API prototype reasonable before a full migration decision; it does not justify silently changing the production API or its data access.

## Risks / Trade-offs

- [Instrumentation changes measured latency] → Keep timers lightweight and compare instrumented versus uninstrumented samples.
- [Advanced service configuration complicates deployment] → Add fail-fast configuration checks and document enablement and rollback.
- [Scoped reads omit a hidden dependency] → Pin each operation plan with contract tests and compare projections against the current implementation.
- [Batch reads weaken consistency assumptions] → Fetch related ranges in one batch and retain revision checks before using or mutating the snapshot.

## Migration Plan

1. Pin the browser probe and server phases, then capture baseline evidence.
2. Audit inputs/output bytes and trial minification in a non-production build.
3. Introduce scoped reads with exact read-count and projection parity tests.
4. Re-measure; prepare batching only when its numeric gate is met and separately approved.
5. For each approved server or client deployment, export a snapshot, verify the live write gate, inspect clasp file status, and retain rollback versions.
6. Collect the required deployed browser sample set and either record a pass or seek an explicit administrator specification decision.

## Open Questions

- Whether the advanced Sheets service is already enabled in the production Apps Script project.
- What bound constitutes a reasonable optimization attempt before administrators decide on architecture or objective changes.
