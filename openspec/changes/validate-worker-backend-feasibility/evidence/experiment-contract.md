# Worker feasibility experiment contract

Task 1.1–1.3 evidence. Written 2026-09-24 before any Worker code was added, so the
fixture dimensions, measurement protocol and acceptance thresholds below are
predeclared rather than tuned to a result. Sources are repository files and
platform documentation fetched on 2026-09-24; the platform excerpts are archived
in [platform-limits-2026-09-24.md](platform-limits-2026-09-24.md). Nothing in this
document is a measurement or a production claim.

## 1. Baseline and reusable evidence

| Item | Revision / location |
| --- | --- |
| Reviewed base commit | `dae580f` "don't track ephemeral plans" — the branch tip when this contract was written, and the base any milestone diff is measured against. `design.md` instead names `01c735c` as the commit its investigation followed; `dae580f` is used here because it is the tip the milestones actually build on. |
| Documentation baseline named by design.md | `01c735c` "Batch Schedule and Insights reads" |
| Prototype branch tip | `a47b274` "Prototype direct JSON read transport locally" (`codex/read-api-prototype`) |
| Prototype merge base | `01c735c` "Batch Schedule and Insights reads" — the prototype predates the OpenSpec roadmap commits, so it is a sibling of master, not an ancestor |
| Planning artifacts | `openspec/changes/validate-worker-backend-feasibility/{proposal,design,tasks}.md` and `specs/worker-backend-feasibility/spec.md` |

Reusable prototype assets, all re-derivable from `a47b274` and none of them
carrying production authority:

| Path on `a47b274` | Reuse decision |
| --- | --- |
| `src/server/prototype/synthetic-fixture.ts` | Reuse as the fixture *generator*: it populates an `InMemorySpreadsheet` through the real `createProductionRuntime` and re-reads `Users` per request. Its `MemoryTokenVerifier` is deliberately unusable in staging. Its constants (`TIME_ZONE=America/New_York`, 30-minute increments, 09:00–21:00 operating hours, `DATA_REVISION=42`, `SCHEDULING_INPUT_REVISION=5`, `outputRevision=7`) are inherited verbatim unless section 1.2 overrides them. |
| `src/server/prototype/read-api.contract.test.ts` | Reuse the parity and negative-authorization case list (allowlist, origin, oversized body, revoked user, mutation denial). Note its mutation denial is a `FORBIDDEN` allowlist rejection at the HTTP boundary; a lock-less dispatcher would instead answer `UNAVAILABLE`, so both outcomes are pinned in section 1.2. |
| `src/server/prototype/read-api.ts` | Reuse the bounded-transport semantics (64 KiB, `text/plain`, origin allowlist, no redirects, direct JSON). Its raw `node:http` server is replaced by a Worker `fetch` handler. |
| `scripts/run-read-api-prototype.mjs`, `scripts/probe-read-api-prototype.mjs`, `scripts/read-api-browser-probe.{html,js}` | Reuse the probe shape, but loopback timings stay labelled local prototype evidence and are never reported as deployed measurements. |
| `src/server/prototype/probe-runtime.ts` | Reuse only the timing/probe bookkeeping ideas. |

Existing (master) assets the slice must reuse instead of reimplementing:

* `src/shared/domain.ts` — `ApiRequestSchema`/`ApiResponse` envelope and row schemas.
* `src/server/integration/dispatcher.ts` — operation registry, `OPERATION_POLICIES`, envelope rejection rules, error mapping.
* `src/server/integration/auth.ts` — `createJwtClaimVerifier` (issuer/audience/expiry/`email_verified` checks with an injectable signature check) and `authenticateCredential` (fresh `Users` lookup and inactive-row rejection).
* `src/server/workbook/{schema,read-plans,batch-read,codecs,repository,initializer}.ts` — schema-derived ranges, response validation, serial-date/blank normalization, row codecs.
* `src/server/runtime.ts` — `createProductionRuntime` (including the authoritative `Users` decoder) and `workbookTimeZone`.
* `src/server/integration/{projections,claim-cache,read-timing}.ts`.
* `differingProjectionFields` in `src/server/main.ts` is currently module-private; task 2.6 exports it (or moves it to a shared test helper) so the differential harness compares projections with the same rule the Apps Script parity report already uses.

### 1.1 Actual-effect inventory of all 16 operations

Columns: policy from `OPERATION_POLICIES` (`mutating`, `expectedRevision`); the
tabs each handler actually touches; the revisions it advances; whether the
dispatcher's global write lock is taken. `DATA_REVISION` is advanced by the
dispatcher for every policy-mutating operation. Per-tab revisions advance inside
`RevisionStore`; `SCHEDULING_INPUT_REVISION` advances when a
`Volunteers`/`RecurringAvailability`/`AvailabilityExceptions`/`Sessions` tab commits.
`Lock: yes` is itself conditional: with no lock configured the dispatcher refuses
every policy-mutating operation as `UNAVAILABLE` before a lock is acquired
(`src/server/main.ts` only builds the lock when `WRITE_ENABLED` is `true`).

| # | Operation | Roles | `mutating`/`expectedRevision` | Reads | Writes | Revisions advanced | Lock | External I/O |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `session.me` | all three | false / false | none (actor projection) | none | none | no | ID-token verify, `Users` read |
| 2 | `volunteer.dashboard` | volunteer | false / false | Volunteers, RecurringAvailability, AvailabilityExceptions, Assignments, Sessions, SchedulingRuns | none | none | no | token, `Users` |
| 3 | `volunteer.availability.recurring.update` | volunteer | true / true | Volunteers, RecurringAvailability | RecurringAvailability rows, Volunteers row, AuditLog | `TAB_REVISION_RecurringAvailability`, `TAB_REVISION_Volunteers`, `SCHEDULING_INPUT_REVISION` (+2: both tabs are scheduling inputs), `DATA_REVISION` | yes | token, `Users`, mail when `ADMINISTRATOR_RECIPIENTS` is set |
| 4 | `volunteer.availability.exception.create` | volunteer | true / true | Volunteers | AvailabilityExceptions, AuditLog | `TAB_REVISION_AvailabilityExceptions`, `SCHEDULING_INPUT_REVISION`, `DATA_REVISION` | yes | token, `Users`, mail when `ADMINISTRATOR_RECIPIENTS` is set |
| 5 | `volunteer.assignment.cancel` | volunteer | true / true | Assignments, Backups, Sessions, Volunteers, RecurringAvailability (backup promotion hydrates the roster), AvailabilityExceptions | Assignments, Backups (promotion), AvailabilityExceptions, AuditLog | `TAB_REVISION_Assignments`, `TAB_REVISION_Backups`, `TAB_REVISION_AvailabilityExceptions`, `SCHEDULING_INPUT_REVISION`, `DATA_REVISION` | yes | token, `Users`, mail when `ADMINISTRATOR_RECIPIENTS` is set |
| 6 | `admin.schedule.read` | administrator | false / false | SchedulingRuns, Assignments, Backups, Sessions, Volunteers, Centers (one batch) | none | none | no | token, `Users`, 1 Sheets batch |
| 7 | `admin.schedule.preview` | administrator | false / false | SchedulingRuns, Volunteers, RecurringAvailability, AvailabilityExceptions, Sessions, Assignments, **Centers** (the projection always lists centers) | none (pure calculation) | none | no | token, `Users` |
| 8 | `admin.schedule.rerun` | administrator | true / true | as row 7, including Centers | Assignments, Backups, SchedulingRuns, AuditLog (with in-handler rollback) | `TAB_REVISION_Assignments`, `TAB_REVISION_Backups`, `TAB_REVISION_SchedulingRuns`, `DATA_REVISION` | yes | token, `Users` |
| 9 | `admin.import.whenIsGood.preview` | administrator | **false** / false | Imports, ImportMappings, Volunteers, **RecurringAvailability** (`previewFor` calls `currentAvailability()`) | **Imports + AuditLog** (see finding) | **`TAB_REVISION_Imports`** while `DATA_REVISION` stays put | **no** | token, `Users`, WhenIsGood HTTP fetch |
| 10 | `admin.import.whenIsGood.promote` | administrator | true / true | Imports, ImportMappings, Volunteers, RecurringAvailability, **ImportedAvailability** (`promoteAvailability` reads provenance for rollback) | ImportedAvailability, RecurringAvailability, Imports, AuditLog | `TAB_REVISION_ImportedAvailability`, `TAB_REVISION_RecurringAvailability`, `TAB_REVISION_Imports`, `SCHEDULING_INPUT_REVISION`, `DATA_REVISION` | yes | token, `Users`, WhenIsGood HTTP fetch |
| 11 | `admin.import.mapping.upsert` | administrator | true / true | ImportMappings, Imports, Volunteers, RecurringAvailability | ImportMappings, Imports (re-stage), AuditLog | `TAB_REVISION_ImportMappings`, `TAB_REVISION_Imports`, `DATA_REVISION` | yes | token, `Users`, WhenIsGood HTTP fetch |
| 12 | `admin.insights.read` | administrator | false / false | SchedulingRuns (hit) or SchedulingRuns + Volunteers + RecurringAvailability + Assignments (miss) | ScriptCache entry on derive | none | no | token, `Users`, 1–2 Sheets batches |
| 13 | `admin.insights.refresh` | administrator | true / true | as row 12 | ScriptCache entry (no `AuditLog` row: `InsightStore` is built without an audit writer) | `DATA_REVISION` | yes | token, `Users`, 1 Sheets batch |
| 14 | `center.candidate.read` | administrator, center-contact | false / false | CandidateSchedules, Centers, Volunteers, RecurringAvailability (the no-date coverage path reads only volunteers and their availability) | none | none | no | token, `Users` |
| 15 | `center.candidate.update` | administrator, center-contact | true / true | CandidateSchedules, Centers, Volunteers, RecurringAvailability, **Sessions** (`lockedOccurrenceForCandidate` guards create and update) | CandidateSchedules, AuditLog; center-scoped deny for non-administrators | `TAB_REVISION_CandidateSchedules`, `DATA_REVISION` | yes | token, `Users` |
| 16 | `admin.center.candidate.confirm` | administrator | true / true | CandidateSchedules, Centers, Volunteers, RecurringAvailability, **AvailabilityExceptions, Assignments, Sessions** (date-scoped coverage comparison) | CandidateSchedules, Sessions, AuditLog | `TAB_REVISION_CandidateSchedules`, `TAB_REVISION_Sessions`, `SCHEDULING_INPUT_REVISION`, `DATA_REVISION` | yes | token, `Users` |

**Finding (task 1.1, import preview):** `admin.import.whenIsGood.preview` is
registered non-mutating but `StagedWhenIsGoodImportService.stageFromFetcher` →
`stage` → `repository.saveRun(run)` writes an `Imports` row and an audit entry
(`src/server/imports/service.ts:227`), and `recordFailure` writes one on the error
path too. Because the policy is non-mutating, the dispatcher neither takes the
write lock nor advances `DATA_REVISION`, so this write is invisible to the global
revision contract while still advancing `TAB_REVISION_Imports` — and the unlocked
read-modify-write can race another writer. The integration contract already
documents the misclassification. The feasibility slice excludes imports entirely,
so the finding is recorded here, not fixed here.

**Consequences for the slice.** The three served operations are #1, #6 and #12.
Together they exercise a handler with no domain reads (#1), the largest published
batch (#6), and the cache-miss derivation path with Zod projection and Temporal
date filtering (#12). They do not exercise the write lock, `expectedRevision`
comparison, `AuditLog` append, mail, or `UrlFetchApp`; the transport tests must
therefore *prove denial* for the other thirteen operations rather than test them.

### 1.2 Pinned synthetic fixture and expected semantics

**Authoritative `Users` decoder.** The runtime path decodes `Users` through
`SheetRepository` + `centerUserCodec` (`src/server/runtime.ts` maps
`centerUsers` to the `Users` tab and returns `users: store.centerUsers.list()`),
and `centerUserCodec` calls `cellBoolean(row.active)` with the default fallback
`false`. A **blank `active` cell therefore decodes as inactive and the account is
denied** by `authenticateCredential`. `usersFromSheet` in `src/server/main.ts`
passes an explicit `true` fallback and is used only when a production runtime
cannot be built, so it is *not* the decoder the Worker slice reproduces. The
divergence is a real inconsistency between the two paths; this experiment pins the
runtime behaviour and records the divergence as an input to
`make-workbook-state-portable`.

Fixture inputs. Two workbooks are deployed for measurement; the edge-case
variants are local, in-memory fixtures because they test codec and authorization
semantics rather than platform behaviour. Configuration is inherited from the
`a47b274` generator unless stated: `TIME_ZONE=America/New_York`,
`DISPLAY_INCREMENT_MINUTES=30`, `OPERATING_HOURS_START=09:00`,
`OPERATING_HOURS_END=21:00`, `DATA_REVISION=42`,
`SCHEDULING_INPUT_REVISION=5`, `TAB_REVISION_*=1`, newest completed
`SchedulingRuns` row `inputRevision=5`, `outputRevision=7`, `status=completed`.
Workbook time zone and `TIME_ZONE` are both `America/New_York`.
**Revised 2026-09-27 at the operator's instruction** ("all time zones should be
EST"): the original contract deliberately used `America/Chicago` for `TIME_ZONE`
to exercise a workbook-zone/display-zone mismatch in the deployed fixture. That
mismatch is now exercised only in the local differential suite
(`src/worker/staging.test.ts` keeps a workbook-Chicago variant that fails if the
decode zone is ignored, and the shared codec tests cover the same ground). The
consequence is recorded rather than hidden: deployed staging no longer
demonstrates the mismatch case, so a regression that ignored the workbook zone
would pass the deployed measurement and fail the local suite.

| Dimension | Representative (deployed) | Larger (deployed) | Empty (local) |
| --- | --- | --- | --- |
| Centers | 4 | 10 | 0 |
| Volunteers | 40 | 200 | 0 |
| RecurringAvailability rows | 200 (5 weekdays × 40) | 1,000 (5 weekdays × 200) | 0 |
| AvailabilityExceptions | 12 | 60 | 0 |
| Sessions (`kind=center`, `status=locked`) | 20 | 400 | 0 |
| Assignments (`scheduleRevision=7`, `status=assigned`) | 20 | 400 | 0 |
| Backups (`scheduleRevision=7`, `status=available`) | 4 | 80 | 0 |
| Users rows | 6 | 6 | 0 |
| Completed SchedulingRuns | 1 | 4 | 0 |

Pinned volunteer inputs, because eligibility drives the Insights workload:
for the representative fixture, volunteers `…-001` to `…-030` are
`lifecycleStatus=active`, `interviewStatus=complete`, `readinessRank` 1–3;
`…-031` to `…-034` are `lifecycleStatus=graduated`; `…-035` to `…-037` are
`lifecycleStatus=inactive` (the domain schema has no "cancelled" value —
`LifecycleStatusSchema` is `active | newly-joined | inactive | graduated`);
`…-038` and `…-039` are `interviewStatus=incomplete` (again the only non-complete
value); `…-040` has a blank `readinessRank`. Every pinned value is therefore a
member of the schema, which matters because the fixture-loading path validates each
row with `VolunteerSchema` and refuses the entire payload if any row fails, so an
invented enum value would make the pinned fixture unreachable. Member ids are pinned
rather than left to the generator's index arithmetic, so two independent
implementers produce the same fixture and the leftover population is a fixed,
non-trivial set. Required staff counts are pinned as `requiredStaffCount=2` for
sessions whose id ordinal is a multiple of five in ascending id order (`…-05`,
`…-10`, …) and `1` otherwise, so `summary.shortfallCount` is not a tautology; with
the representative fixture that forces `Σ required = 24` against 20 assignments. The
larger fixture is 150 eligible volunteers followed by the same four ineligible
categories repeated five times (150 + 50 = 200). The larger fixture's four completed
runs carry distinct `completedAt` timestamps so `latestCompletedRun` (which sorts by
`completedAt ?? startedAt`) selects the `outputRevision=7` row deterministically; the
other three runs are pinned to `outputRevision` 4, 5 and 6 with earlier timestamps.
One session is pinned to start exactly at the harness clock, to pin the cutoff
comparison (`isSessionAfterCutoff` is strictly `>`), and the larger fixture spans the
2026-11-01 US DST transition.

Pinned `Users` mix — the same six rows in both deployed workbooks, because this
mix is the authorization surface rather than a workload dimension:

| Row | Roles / values | Purpose |
| --- | --- | --- |
| `synthetic-user-admin` | `administrator`, blank `volunteerId` and blank `centerIds` cells | primary administrator path; proves a blank optional cell still decodes |
| `synthetic-user-volunteer` | `volunteer` linked to `synthetic-volunteer-001` | volunteer path |
| `synthetic-user-multi` | `administrator` + `volunteer` + `center-contact` | primary-role preference and multi-role authorization |
| `synthetic-user-contact` | `center-contact` scoped to `synthetic-center-1` | center-scoping and the confirm denial for non-administrators |
| `synthetic-user-blank-active` | `administrator` with a blank `active` cell | **denied** — the cell decodes inactive |
| `synthetic-user-inactive` | `administrator` with `active=false` | **denied** control for the row above |

An seventh test identity is cryptographically valid but has **no** `Users` row at
all, which is why the table counts six rows; it pins the `unknown-identity`
rejection path.

Pinned edge cases and their expected outcomes:

* **Temporal/DST.** Session dates derive from `FIXTURE_EPOCH` Monday `2026-10-05`.
  The harness clock is pinned at `2026-10-05T12:00:00Z` for the representative
  parity run and `2026-11-03T12:00:00Z` for the post-transition case.
* **Blank/omitted cells.** One `Users` row has a blank `centerIds` cell; one
  volunteer row omits trailing `source`/`updatedAt` cells entirely (the REST
  matrix is short); one `Sessions` row has a blank `title`. Serial dates and time
  fractions arrive as numbers because the read requests
  `dateTimeRenderOption=SERIAL_NUMBER`.
* **Malformed rows.** One local variant contains a row with a non-numeric
  `revision` and one session with an unknown `kind`. Codecs are total, so the
  expected result is: `cellNumber('abc')` coerces to `0` and the row is retained;
  the unknown `kind` survives decoding and is excluded only from the schedulable
  projection (`isSessionSchedulable`) or rejected by
  `validateCommittedSessionInputs` on the preview/rerun path. Parity must hold on
  the surviving rows.
* **Stale Insights.** The freshness tuple has four components:
  `assignmentRevision` (the latest completed run's `outputRevision`),
  `assignmentRowsRevision` (`TAB_REVISION_Assignments`), `eligibilityRevision`
  (`TAB_REVISION_Volunteers`) and `availabilityRevision`
  (`TAB_REVISION_RecurringAvailability`). Four positive variants pin all four:
  flipping `TAB_REVISION_Volunteers`; flipping `TAB_REVISION_RecurringAvailability`;
  cancelling one assignment row, which advances `TAB_REVISION_Assignments` without
  republishing the run and must report `assignmentRowsRevision` as the reason; and
  republishing the run so `assignmentRevision` changes. Each must mark a retained
  dataset stale while an unchanged tuple reuses it. Flipping
  `AvailabilityExceptions` or `Sessions` must *not* make it stale, and that negative
  case is asserted too. The Worker slice has no Insights cache, so these variants run
  in the local differential harness only.
* **Mutation denial.** Posting any of the thirteen non-served operations must be
  rejected at the HTTP boundary with `FORBIDDEN` and must issue **zero** domain
  Sheets reads; the same operation posted to a dispatcher without a write lock
  must answer `UNAVAILABLE`. Both outcomes are asserted separately so the
  transport allowlist and the dispatcher policy cannot be confused.

Expected semantic results are asserted two ways; absolute numbers are recorded
when the fixture generator is written (task 2.6) rather than guessed here:

1. **Differential equality** against the existing implementation over the same
   snapshot and fixed clock, ignoring only `computedAt`/`generatedAt` — the rule
   `differingProjectionFields` already implements.
2. **Pinned invariants** independent of any implementation, for the representative
   fixture at the pinned clock: `revision=42`, `inputRevision=5`,
   `scheduleRevision=7`, `outputRevision=7`, `preview=false`, `stale=false`;
   `summary.assignmentCount` equals the number of assignment rows whose
   `scheduleRevision` equals the completed run's `outputRevision` and whose
   session survives the cutoff; `summary.shortfallCount` equals
   `Σ max(0, requiredStaffCount − assignedCount)` and is non-zero because some
   sessions require two staff. For Insights the grid contains **covered slots
   only** — `includeEmpty` defaults to `false` and adjacent slots merge when their
   sorted volunteer-ID sets are equal — so the invariant is "cells are covered
   slots, merged where adjacent slots share the same sorted volunteer-ID set", not
   a fixed column count. The nominal grid width is 24 slots per weekday at
   09:00–21:00 with 30-minute increments.

**Fixture identity.** The generator emits a canonical SHA-256 digest over all tab
matrices (the prototype's `snapshotWorkbook()` serialization is the shape). The
digest is recorded in the staging manifest and in every result set; deployed
measurements are only comparable to a local differential run whose digest matches.

### 1.3 Resource prerequisites, dated platform limits, measurement protocol

#### Dated platform limits (fetched 2026-09-24)

Cloudflare Workers Free, from the
[limits page](https://developers.cloudflare.com/workers/platform/limits/) (page
states "Last updated Sep 5, 2026"; archived in
[platform-limits-2026-09-24.md](platform-limits-2026-09-24.md)): **10 ms CPU per
HTTP request**, **100,000 requests/day**, **128 MB memory per isolate**, **50
subrequests/request**, **6 simultaneous connections awaiting response headers**,
**64 MiB Worker size**, **64 environment variables × 5 KB**, **1 s startup time**.
HTTP duration is unlimited while the client stays connected, and CPU time excludes
time spent waiting on `fetch`. Exceeding CPU or memory returns error 1102
(`exceededCpu` / `exceededMemory`); exceeding the daily request count returns
error 1027.

The same page adds a prerequisite that affects this slice: *"If your Worker uses
Zod, use version 4.5.0 or later. Earlier versions use substantially more memory
per schema."* The repository pins `zod@4.6.5` (verified in `package-lock.json` and
`node_modules/zod/package.json`), so this is satisfied and the dependency must not
be downgraded for staging.

Google Sheets, from the
[usage limits page](https://developers.google.com/workspace/sheets/api/limits)
(fetched 2026-09-24): **300 read requests/minute/project**, **60 read
requests/minute/user/project**, the same for writes, 2 MB recommended maximum
payload, `429` with exponential backoff on over-quota, no daily request cap while
under the per-minute quota, and *"Each batch request, including any subrequest, is
counted as one API request toward your usage limit."* The page also states that
exceeding the quota limits is planned to incur charges to the Google Cloud billing
account later in 2026, so free operation is a dated observation, not a permanent
assumption. A service account counts as one user.

**Derived quota ceiling (feasibility-relevant).** Every served request performs at
least one `Users` read as the *same* service account, so the per-user ceiling of
60 reads/minute caps the slice at roughly **30 read operations per minute** with no
safety margin, and at ~20/minute with the 2/3 headroom this contract budgets. This
is a property of the experiment's identity design, not of Worker CPU, and it must
appear in the verdict.

#### Prerequisites (all require separate approval)

1. A Cloudflare account on the **Free** plan with one staging Worker, reachable on
   its `*.workers.dev` hostname, with no paid feature enabled.
2. One Google Cloud project with the Sheets API enabled, an OAuth **web** client
   used as the ID-token audience, and a **read-only service account** whose key is
   shared read-only on the two synthetic workbooks only. No domain-wide
   delegation.
3. Two dedicated synthetic spreadsheets (representative and larger), each with the
   workbook time zone pinned independently of `TIME_ZONE`, plus a one-time
   **fixture-loading identity** that can write them: either the workbook owner
   running the existing `loadMigrationWorkbook` editor path, or a separate
   write-scoped credential used once. That identity is a distinct approval from the
   read-only service account and is not used during measurement.
4. Authorized test identities: seven Google accounts that can actually sign in and
   are deliberately represented by the six pinned `Users` rows — administrator,
   volunteer, multi-role, center-contact, blank-`active`, `active=false` — plus one
   outsider account with no `Users` row. A denial case needs a *valid* token for a
   row that is denied, so the two inactive cases cannot be covered by reusing the
   administrator account without editing the workbook mid-measurement. Their
   addresses are staging configuration, never committed.
5. A local staging directory for the service-account key, raw probe traces and
   deployment notes. It must be covered by an ignore rule before any secret is
   written; task 3.1 adds that rule and the directory is never committed. Secrets
   are supplied to the Worker through `wrangler secret put`, never through
   `wrangler.jsonc` variables.
6. Fixture digests recorded in the staging manifest for both workbooks, matching
   the digests used by the local differential runs.

#### Measurement sources and statistics

* **CPU time** is read from the Workers **CPU Time per execution** quantile series
  (dashboard and the GraphQL series behind it), aggregated over the measured
  window, and independently cross-checked against the GraphQL aggregate
  `sum.cpuTime / sum.requests`. Those series are the only CPU numbers Cloudflare
  documents for Free-plan Workers, so **the CPU threshold statistic is a published
  quantile (p99), not an invented p95 or a per-request maximum.**
* **Per-invocation CPU and wall time** are recorded when obtainable (Workers trace
  root-span attributes `cloudflare.cpu_time_ms` / `cloudflare.wall_time_ms`). This
  is an *optional secondary* source: whether a Free-plan staging Worker can export
  them was not verified, so no threshold depends on it. If they are available, the
  report adds per-request p50/p95/max; if not, it says so and reports the quantile
  series alone.
* **Memory** is read from the **Memory usage** P50/P90/P99/P999 series, and the
  invocation-status breakdown is checked for `exceededResources`.
* **Cold** = the first request served by a fresh isolate after a staging version
  upload or deploy; **warm** = later requests in the same isolate. Cloudflare
  exposes no supported isolate-eviction control, so cold observations come from
  successive approved uploads. **Minimum 5 cold observations.** If fewer than 5 are
  collected, cold CPU is *not evaluated* and the verdict cannot be an unconditional
  go.
* **Wall time** is measured from a real browser probe served by the repository's
  local preview server on one named measurement host (its origin is added to the
  staging allowlist for the measurement window only, and origin is never identity).
  The resolved Worker PoP is recorded from the `cf-ray` response header. Loopback
  prototype timings are reported separately and never mixed in.
* **Sheets reads and subrequests** are counted by the Worker for **every Sheets API
  call it makes** — the `Users` read and every `values:batchGet` — and by the same
  per-request counter for **every outgoing `fetch`**, so the subrequest total is a
  measured per-request value reported separately for the cold and warm phases rather
  than an assumption. Sheets reads are cross-checked against the counters reported by
  the Google Cloud console after the run; a run whose Worker counter and console
  counter disagree does not count as budgeted. Counting only the batch calls would
  understate the rate by half for schedule and insights reads.
* **Retries:** the measurement path performs none. A `429`, `5xx`, timeout or
  `exceededCpu` is a retained failure, attributed to quota or platform, and never
  silently retried into a success.

**Read budget and pacing (derived, not guessed).** The Worker prefetches, per
request, `Users` (always, before authorization) plus exactly one `values:batchGet`
for a **named plan** that is the superset of what the handler primes:

| Operation | Prefetched plan | Sheets reads |
| --- | --- | --- |
| `session.me` | none (no domain ranges) | 1 (`Users`) |
| `admin.schedule.read` | `BATCH_READ_PLANS.publishedSchedule` | 2 |
| `admin.insights.read` | `BATCH_READ_PLANS.insightCacheMiss` (the superset of `insightCacheHit`, so the handler's hit-then-miss priming issues no second fetch) | 2 |
| `admin.schedule.preview` (harness only) | both plans, in two `batchGet` calls (the reader accepts one named plan and there is no union operation) | 3 if it were served; **0 in the local workerd benchmark**, which runs it over an already-primed snapshot |

`createWorkbookBatchReader.read` accepts one plan and fetches only that plan's tabs
missing from its per-request snapshot; it has no union operation and must be
constructed once per request with that single `read` call. Prefetching
`insightCacheHit` instead would force a second `batchGet` on the miss path and cost
3 reads per request — 60 reads/minute at the paced rate, exactly the ceiling with no
headroom — so the miss plan is pinned here as the Worker's contract. The Apps Script
path primes hit-then-miss lazily and can issue two domain batches; the Worker's
single superset batch is a deliberate difference in **read count**, not in
projection, and projection parity is what the differential harness asserts. The slice
runs with **no Insights cache** (no portable state in this change), so
`admin.insights.read` always takes the miss path and measures the worst case.

The campaign uses **one shared sliding-window limiter that permits at most 40 Sheets
reads in any 60-second window** — two thirds of the 60/minute/user ceiling, leaving
one-third headroom. A request is issued only while its operation's read count fits
the remaining window budget, so the limiter is read-denominated and cannot admit a
full-bucket burst on top of a refill. Two phases run per workload:

* **Burst phase (4 in flight).** Submit bursts of **20 requests** with **4
  concurrent in flight**, then idle until the window rolls. For schedule and
  insights that burst is the entire 40-read budget for that window; for
  `session.me` it is 20 of 40. At roughly 1.5 s per request and 4 in flight a burst
  takes about 7.5 s, yielding about 20 observations at genuine 4-concurrency per
  window, and about 5 bursts per workload. The report states the **observed**
  in-flight concurrency rather than assuming it. If fewer than 30 observations at
  ≥ 3 in flight are collected, the 4-concurrency wall-time threshold is *not
  evaluated*.
* **Sustained phase (1 in flight).** 100 sequential warm observations per workload
  through the same limiter, reporting the achieved requests/minute, reads/minute
  and the resulting sustained-request ceiling.

The total campaign is capped at 1,000 requests. The verdict reports the achieved
read and request rates and the derived sustained ceiling.

#### Acceptance thresholds (fixed before measurement)

| Dimension | Threshold |
| --- | --- |
| Correctness | 100% of parity cases match the existing implementation; every negative-authorization and mutation-denial case is rejected; workbook contents and all revision counters are unchanged after every read; denied requests issue zero domain Sheets reads. |
| CPU headroom | Warm CPU **p99** ≤ 5.0 ms for the larger workload (≥ 20% headroom under the 10 ms limit), from the CPU Time per execution quantile series, with the window aggregate `sum.cpuTime / sum.requests` reported alongside. Zero `exceededResources` invocations. Cold CPU reported separately with ≥ 5 observations and must also stay under 10 ms. |
| Failure rate | Zero **unexpected** failures on the representative workload, where "unexpected" means a response that is not a 200 carrying a parity-matching envelope and is not a deliberately submitted negative-path probe or an attributed quota/platform failure. Counts are reported per category: `parity-mismatch`, `wrong-status`, `429`, `5xx`, `timeout`, `exceededCpu`, `exceededMemory`. |
| Wall time | Warm p99 ≤ 1500 ms over the observations collected at ≥ 3 in-flight requests for the larger workload, from the named browser host; the achieved concurrency is reported. This is a **staging** threshold; it is not `meet-read-latency-objective` production acceptance and does not satisfy it. |
| Sheets quota | ≤ 2 read requests per served operation, counting every Sheets API call; ≤ 40 read requests in any 60-second window; zero `429` responses during the budgeted runs; Worker and console read counters agree. |
| Other headroom | Zero `exceededResources` invocations in any run; memory P99 ≤ 64 MB (50% of the 128 MB isolate) with no `exceededMemory`; ≤ 3 subrequests per request warm and ≤ 5 cold (against 50, the extra two being the JWKS and token-endpoint calls a cold isolate must make); total campaign ≤ 1,000 requests (≤ 1% of the daily cap); bundle size reported against the 64 MiB limit; environment variable count and size reported against 64 × 5 KB. A missed headroom threshold that is not CPU is reported as a deviation with its cause, not as a failed run. |
| Cost | No paid plan, paid add-on, or billing-account change is enabled at any point. |

A workload that misses the CPU threshold is profiled first; if it still misses,
the free Durable Object path is evaluated against the same workloads and
thresholds; if it also misses, the verdict is **no-go**. Thresholds are never
adjusted after seeing results. A threshold that cannot be evaluated (fewer than 5
cold observations, unavailable per-invocation CPU, a quota-starved run) is
reported as **not evaluated** and yields at most a **conditional-go** that names
it; it is never reported as met.

#### Release constraint carried into every milestone

`.github/workflows/pages.yml` currently deploys on every push to any branch. No
push of any kind is permitted until task 3.1 separates validation from
deployment, and no deployment happens without its own explicit approval.

#### Known evidence limitations

* No Cloudflare or Google staging resource exists yet, so every number in this
  document is a limit, a derived bound, or a prerequisite — never a measurement.
* In-isolate Insights cache-hit behaviour cannot be observed through the deployed
  slice (no portable cache); it is exercised only in the local differential
  harness, and the verdict says so.
* `web_search` was unavailable during this run (provider returned HTTP 401), so
  external facts come from direct page fetches on 2026-09-24; the Google page
  publishes no last-updated date, so its date is the fetch date only.
