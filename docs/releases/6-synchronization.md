# Synchronization release evidence — issue #6

Prepared October 14, 2026 (America/New_York). The corrected release, first actual scheduled update and authorized unchanged manual follow-up are verified; CPU suitability and remaining role verification are pending. This record contains sanitized evidence only.

## Version and review

The operator selected `fresh-start` as the release branch. It has no common ancestor with the repository's default `master` branch, so merging those histories is outside this release. The application candidate is `5b14274674fbedb446f3276a6651b7432a9512d7`, including synchronization implementation `d6b977f`. Subsequent release-record commits change documentation only.

Parallel Standards and Spec reviews of `git diff e459955...5b14274` found no blocking findings. A possible future extraction of pending-state construction was a maintainability observation, not a correctness defect.

## Read-only production preparation

- The actual fixed WhenIsGood page passed the existing bounded fetch adapter and strict parser: HTTP 200, 97,456 bytes, eight participants and 46 weekly intervals. Every participant and nested interval passed `ImportParticipantSchema` decoding. No source availability was applied and no private source data was retained in the repository.
- The private production Wrangler config targets the existing `mindfulness-scheduler-prod` database with the `DB` binding, configured production OAuth client, `America/New_York`, and the same fixed source in application code. Its missing Cron Trigger was corrected locally to `*/30 * * * *`; private configuration remains ignored.
- Read-only production schema inspection found `idempotency` installed and `synchronizations` absent. Only `migrations/0002_synchronization.sql` is needed.
- A fresh production export is stored privately in the ignored root file `production-backup-issue6-20261015T0141Z.local.sql`, mode `0600`, 227,761 bytes. A disposable in-memory SQLite restore passed integrity checking and reported zero foreign-key violations. Applying migration 0002 to that disposable copy succeeded with an empty synchronization table. The production database was not modified.
- Cloudflare deployment history and version inspection confirmed access to prior Worker version `65b315ee-294e-45d3-9801-76473bed47d2`. That deployed version exposes only a fetch handler.

## Validation

Checks cover application candidate `5b14274` and the locally corrected private production config:

- `npm run check`: passed.
- `npm run format:check`: passed.
- `npm test`: 261 tests passed in 14 files, including disposable local D1 integration tests.
- `npm run build`: passed, including tracked-config Worker dry run.
- `WRANGLER_WRITE_LOGS=false WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --config wrangler.production.local.json`: passed; no deployment performed.
- `PLAYWRIGHT_BROWSERS_PATH=/tmp/issue6-playwright npm run test:browser`: 45 checks passed across desktop, tablet and mobile. Its initial attempt could not launch Chromium because the matching Playwright runtime was absent; installing that runtime in `/tmp` resolved setup. The passing rerun used the same application code.

## Approval and remaining evidence

The operator explicitly approved migration 0002 and deployment of `c3941f4`. Migration 0002 completed successfully (one DDL query); a subsequent read confirmed an empty synchronization table. The earlier idempotency migration was not reapplied.

The deployed Worker version is `69752072-d2fb-438f-a436-434828cf2f45`, with the confirmed `*/30 * * * *` trigger. Its client and `/client-config` return HTTP 200. Google sign-in succeeded with the operator's administrator account. Schedule loading, navigation and Reload view succeeded with 70 displayed rows; Center proposals loaded three rows. The administrator was signed out afterward, before the first scheduled check. No manual sync, linking, source edits or email tests were performed.

### Legacy history release blocker

The deployed Availability sync view returned `INTERNAL_ERROR: The operation produced an invalid response.` A private offline backup reproduction traced this to old `imports.staged_availability` JSON containing flat provenance intervals rather than participant records. The observed structure has interval fields and source/volunteer identity, but no participant name or email. The source parser itself remains compatible.

The repository reader now reconstructs participant records from those historical intervals, grouping by both source participant ID and volunteer ID; missing source IDs retain individual row identity. Names remain empty and emails null when absent from the stored format. Interval values remain subject to the ordinary strict response schema, and modern records pass through. This does not rewrite stored production history.

The operator agreed to the existing public API regression seam: read synchronization history, perform a system check, and read history/current volunteer availability again. The synthetic regression failed with the identical production error before the fix and passed afterward. The complete private backup also passed current synchronization response validation with the corrected decoder. Parallel Standards and Spec reviews found no blocking issues in the fix.

Final validation of the corrected application passed: 262 functional tests in 14 files, 45 native browser checks, strict typechecks, CSS formatting, client build, and Worker dry runs with both the tracked and private production configurations.

The original migration command, retained for audit only, was:

```sh
WRANGLER_WRITE_LOGS=false WRANGLER_SEND_METRICS=false npx wrangler d1 execute DB --remote --config wrangler.production.local.json --file=migrations/0002_synchronization.sql
```

The operator separately approved corrected application commit `7bb6851f6491ea82a99ed078e5aa299579bc4d52`. It is deployed as Worker version `783e158f-2e27-4571-8746-49f614cb4bed` with the existing `*/30 * * * *` trigger. Availability sync and Reload view now work, with both legacy imports readable and no error alert. Browser reload required a fresh Google sign-in because credentials remain in memory. A private Worker tail observed no additional API invocations during 64 seconds with that view open; the administrator then signed out before the first cron boundary. Manual Sync now, participant linking, source-submission changes, and email tests remain outside the authorization.

The operator identified three accessible email accounts. A read-only lookup found only the terpmail address enrolled, with administrator and center-contact roles; the other two addresses have no app user records. Thus a deployed volunteer-only check, and a center-contact-only isolation check, remain unverified. No roles or accounts were changed to manufacture evidence.

Read-only Cloudflare analytics access works. Initial D1 daily metrics for October 15 UTC showed 47 read queries, 1,699 rows read, one write query and three rows written (the migration). These preliminary totals include release checks, precede the first scheduled invocation, and do not establish representative synchronization quota usage. Worker metrics were accessible with zero reported invocation errors in the initial window; an application error envelope can still occur inside an otherwise successful invocation.

### First actual scheduled invocation

With the administrator signed out, Cloudflare invoked the scheduled handler at `2026-10-15T02:00:33.844Z` (10:00 p.m. Eastern, October 14). The tail reported `cron: */30 * * * *`, outcome `ok`, zero exceptions, 29 ms CPU and 2,027 ms wall time. Durable status recorded attempt and success at `2026-10-15T02:00:34.126Z`, outcome `changed`, eight source participants, seven matched and one pending.

Domain and scheduling-input revisions advanced from 0/0 to 1/1. Import count advanced from two to three; provenance count advanced from 138 to 180. A read-only post-run export was restored privately and compared with the pre-release backup: centers, volunteers, users, dated exceptions, proposals, sessions, scheduling runs, assignments, backups and import mappings were identical. Both prior import records and every prior provenance record were also identical. No interactive administrator session, manual sync, participant linking or source edits were used to obtain this evidence.

The operator subsequently instructed an immediate manual follow-up instead of waiting for the 02:30 UTC / 10:30 p.m. Eastern boundary. This authorizes that production Sync now operation; it does not authorize participant linking, account/role edits, source-submission changes or email tests. The actual automatic invocation above establishes Cron delivery; the manual follow-up below exercises the same synchronization workflow's unchanged behavior.

The first invocation's 29 ms CPU exceeds Cloudflare's documented [10 ms free-plan CPU limit](https://developers.cloudflare.com/workers/platform/limits/) for Cron Triggers. Cloudflare documents some flexibility for infrequent overruns, but this successful sample does not establish reliable free-plan suitability. Observed authenticated read requests also used 14–23 ms. CPU optimization or an explicitly approved appropriate plan may be needed; increasing the interval reduces daily work but does not fix per-invocation CPU. No plan or billing changes were made. The account subscription endpoint returned HTTP 403, so the actual billing plan was not independently confirmed.

At 02:02 UTC, the aggregate analytics API had not yet included the successful scheduled invocation or its writes; its release-window totals were 176 read queries, 6,305 rows read, one write query and three rows written. These lagging totals include diagnostic reads and are not the scheduled invocation's query/row costs. Re-query scheduled-event CPU and D1 minute/day aggregates after ingestion before claiming quota fit. See [D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

A proposed recurring background observer was rejected by automatic approval review as an unrequested recurring action involving private production reads and documentation publishing. No automation was created. A scheduled follow-up requires explicit operator authorization; all presently gathered evidence is recorded here.

### Authorized manual unchanged check and CPU investigation

The operator explicitly requested Sync now instead of waiting. It succeeded at `2026-10-15T02:10:16.879Z`, displaying “Availability is up to date.” Attempt and success timestamps advanced; effective-change time stayed `2026-10-15T02:00:34.126Z`. Domain/scheduling revisions remained 1/1, imports three, provenance 180, participants eight, matched seven and pending one. Comparing private disposable restores of the post-cron and post-manual exports confirmed every domain table and `meta` were identical; only synchronization status and idempotency bookkeeping changed. No roster link, role change, source edit or email test was performed.

Private tail metrics recorded the manual HTTP request at 55 ms CPU / 704 ms wall time, outcome `ok`, no exceptions; its subsequent view read used 24 ms CPU. That HTTP measurement includes authentication and the full request snapshot, unlike the system scheduled handler. The manual operation was not repeated to manufacture performance samples.

The analytics API later confirmed scheduled CPU at 29,500 microseconds. Its 02:00 UTC D1 minute bucket reported 17 read queries, 604 rows read, eight write queries and 156 rows written. That bucket includes read-only release probes, so it is an upper bound for the invocation rather than its isolated D1 bill. Extrapolating this bucket 48 times gives 28,992 rows read and 7,488 rows written per day for the present input shape, below the documented five-million/100,000 free daily D1 row allowances. This projection is not a full-day observation and excludes unrelated user traffic and future data growth. CPU remains the unresolved limit.

A disposable local profile used native-format synthetic source content, 74 fictional roster records, eight participants, 46 intervals and two representative legacy import records. It identified repeated SQL-column to domain-property conversion as the largest sampled application hotspot. Precomputing that fixed mapping once per table removed all 799 conversion samples; sampled application frames fell from 3,034 to 1,898. Overall Node/Miniflare process CPU fell from 47.60 to 42.00 ms/check over 80 unchanged checks. Harness overhead and different runtime conditions mean these numbers do not establish deployed CPU or free-plan compliance. The temporary profiling test was removed.

The optimization changes no SQL, storage schema, matching rule or public response. Both encoding and decoding retain the existing shared naming rule and authoritative column order. Parallel Standards and Spec reviews found no blocking issues. Focused synchronization/scheduled integration coverage (38 tests) and strict typechecks passed. Final validation also passed: 262 functional tests, 45 native browser checks, CSS formatting, client build and both tracked/private production-config Worker dry runs. Deployment of this new optimization and one subsequent manual timing check require explicit operator approval; the previously approved application remains deployed.

Before closing #6, record the deployed version, same-origin client and Google sign-in checks, role-specific reads and participant privacy, existing schedule, load/navigation/Reload behavior, an actual scheduled run and unchanged follow-up, and measured invocation errors, CPU and D1 query/row usage. Forty-eight scheduled executions per day is the configured rate, not measured free-plan compliance.

### October 16 approved optimization deployment and measurement

The operator approved deployment of `0363c1d` and one manual timing check. The checkout also contained operator commit `7ca5a98`, which changes only `.gitignore`; application files were identical to the approved candidate. A fresh client build and tracked/private production-config dry runs passed. The application optimization is deployed as Worker version `d427883f-df7c-4892-89b9-8481a26a9569`, with the existing `*/30 * * * *` trigger and no migration.

After administrator sign-in, Sync now succeeded at `2026-10-16T04:04:49.010Z`, displaying “Availability is up to date.” Revisions remained 1/1, imports three and provenance 180; participants/matched/pending remained 8/7/1, and effective-change time remained the original October 15 update. Private tail timing recorded 63 ms CPU / 831 ms wall time, outcome `ok`, zero exceptions, on the deployed version. The read before it used 90 ms CPU and the read after it 28 ms. This sample does not demonstrate deployed improvement or free-tier CPU compliance; HTTP synchronization also includes authentication and a full snapshot read.

Pre-deployment analytics covering the elapsed release window reported 53 scheduled successes and zero failures. Their CPU ranged from 24.210 to 58.874 ms, median 29.980 ms. October 15 UTC D1 totals were 669 read queries, 185 write queries, 22,698 rows read and 423 rows written. October 16 partial-day totals at observation were 471 read queries, 44 write queries, 17,825 rows read and 65 written. These account for the database's actual observed traffic, including release probes. The operator confirmed the account uses **Workers Free**; runtime success does not remove the documented per-invocation CPU concern.

### Fixed New York requirement

During the CPU investigation, the operator clarified: “It's always going to be New York timezone.” The former generic zone-validity checks are therefore unnecessary application behavior. The follow-on change defines `applicationTimeZone = 'America/New_York'` once, uses it in Worker/client configuration, checks incoming zone values against it, and removes locale-formatter/Temporal time-zone validation from import parsing and API schemas. The obsolete environment setting cannot override the constant. Existing date calculations and daylight-saving conversion remain unchanged.

A read-only aggregate audit found zero non-New-York values in recurring availability, exceptions, proposals, sessions, provenance, import history and synchronization participants. No stored-data rewrite or migration is needed. Both parser modes reject the entire import when it contains a foreign zone, preserving existing availability and preventing partial promotion. The valid alternate-format fixture uses New York intervals. The public scheduled-workflow regression failed against the old environment-controlled client configuration, then passed with the fixed constant and preserved replay deduplication. Focused workflow/parser tests and strict typechecks passed. Full-suite evidence and the new commit identify the final candidate separately from the already deployed field-mapping optimization.

Standards and Spec reviews found no outstanding issues in the corrected version. Final validation passed: 262 functional tests, 45 synthetic native-browser checks across desktop/tablet/mobile, strict typechecks, CSS formatting, client build and tracked/private production-config Worker dry runs. This New York-only candidate has not been deployed or measured in production; it does not yet establish free-plan CPU compliance.

### October 16 approved New York-only deployment and measurement

The operator explicitly approved deployment of `2a0d359` and one manual Sync now timing check. Worker version `3554f098-e77e-437f-bbec-25ba6443119d` now runs that candidate with the existing `*/30 * * * *` trigger; no migration was performed. The public client configuration returned HTTP 200 and `America/New_York`. The existing authenticated administrator session successfully reloaded Availability sync against the new Worker.

The manual check succeeded at `2026-10-16T04:23:15.992Z` (October 16, 12:23 a.m. New York), with the visible confirmation “Availability is up to date.” Private tail telemetry identified the deployed version and recorded 53 ms CPU / 743 ms wall time, outcome `ok`, zero exceptions. The surrounding reads used 66 ms and 24 ms CPU. A read-only aggregate comparison confirmed unchanged revisions 1/1, three imports, 180 provenance rows, counts 8/7/1, and the original effective-change timestamp. Attempt and success timestamps advanced together; no duplicate history was created. Tail observation was stopped after the check.

This successful invocation still exceeds the documented Workers Free 10 ms CPU allowance and does not establish free-plan suitability or a representative performance improvement. CPU fit and live volunteer-only/contact-only verification remain unresolved, so #6 remains open. No source submissions, user roles or billing settings were changed.

## Rollback

Following explicit rollback approval, use Wrangler's rollback command with the private production config to restore Worker version `65b315ee-294e-45d3-9801-76473bed47d2`. Verify deployed handlers and Cron Trigger state; stop scheduled updates explicitly if necessary and authorized. Leave the additive table intact unless separately reviewed. Code rollback does not restore availability or any other database records: data restoration requires separate authorization and the reviewed private backup. No rollback was performed.


### CPU optimization candidate — October 16

The current follow-on candidate reduces request and synchronization work without changing the public response shapes or the 30-minute schedule:

- Reads select only the required tables while loading current account roles and revision metadata on every request. Read handlers avoid cloning the full snapshot.
- Scheduled checks batch their small status/revision snapshot with the durable replay lookup. Identical parsed source at the last fully synchronized domain revision takes a status-only path. Source changes, any intervening domain write, or an absent marker take the complete reconciliation path. The marker is an ordinary `meta` row written atomically with the successful result; no schema migration is required. The first check after release establishes it.
- Synchronization shares unchanged rows and compares/encodes only changed rows. Existing revision assertions, synchronization generation fences, retry behavior, durable replay, history and provenance remain.
- Runtime services use resource-free Effect contexts instead of acquiring layers per invocation. Authentication still verifies Google credentials and reads current users and roles from D1.
- Insights normalize availability once per volunteer/day. Scheduling reuses dated availability within its fixed input snapshot, computes continuity once per volunteer/session, and avoids rebuilding proposed assignment objects for each conflict check. Bounded caches hold at most 256 pure weekday/instant conversions each. Temporal still owns New York daylight-saving conversion; API calendar-date validation uses an exact native UTC round trip.

A temporary inspector harness exercised the actual Worker HTTP and scheduled entry points with disposable D1, synthetic RSA-signed Google credentials and a mocked public-key endpoint. Initial synthetic profiles were expanded after a read-only aggregate inspection of the existing private backup found 74 volunteers, 70 sessions (45 upcoming at observation), 54 assignments and 55 backups. A second profile restored that backup into an isolated disposable database and fetched the fixed source read-only. No production database, source submission, user role or email was modified. Raw records and credentials were not printed or checked in.

The paired original/candidate local inspector samples, in milliseconds per invocation, were: scheduled 20.38/16.52; manual sync 27.17/19.49; sync view 18.98/12.06; schedule preview 476.09/16.92. Other candidate runs varied substantially, including scheduled estimates around 7–12 ms. These are sampled local-runtime durations with wrapper/profiler/native overhead, not Cloudflare's metered invocation CPU. Warm measurements also do not establish cold-invocation fit. The candidate has **not** established the Workers Free 10 ms requirement.

New behavior coverage exercises identical-source reconciliation after human availability edits, preserved dated exceptions, pending first/last-seen timestamps, concurrent edits, revoked administrator authority after an earlier successful check, leap-year/date boundaries, and New York spring gaps/autumn repeated hours. Final validation passed on the corrected candidate: 276 functional tests, 45 synthetic native-browser checks, strict typechecks, CSS formatting, client build, and tracked/private production-config deployment dry runs. The initial browser run could not launch Chromium from the default cache; rerunning with the existing matching installation passed all 45 checks. Diff review checked current-role authorization, durable replay, concurrent revision/generation fences, history compatibility and date behavior. Temporary profiling probes were moved outside the repository. The application commit is identified in the chat before deployment approval. Deployment and any manual production sync timing checks require the explicit production approval described in README; no new deployment has occurred in this investigation.

### OS process CPU follow-up

Application candidate `2d6ae0135cd0d91c1a4f2d630fc16705f04ae058` was still undeployed at this follow-up. A second temporary harness measured the owned workerd process's user plus system CPU ticks from Linux `/proc`, with inspector profiling disabled. It used the same disposable backup workload, real local RSA verification, 20 warm-up requests and 150 measured invocations per operation. The counter resolution was 10 ms, aggregated across those invocations. Node driver CPU was excluded; local D1 and the synthetic request wrapper were included in workerd's process CPU.

| Operation | Original mean CPU (ms) | Candidate mean CPU (ms) |
| --- | ---: | ---: |
| Scheduled unchanged check | 15.73 | 9.40 |
| Manual unchanged sync | 20.80 | 8.27 |
| Synchronization view | 10.87 | 6.00 |
| Schedule preview | 246.60 | 9.87 |

These measurements strengthen the local improvement evidence but establish only warm mean process CPU on this host. They do not prove individual-invocation, cold-path, changed-source or deployed free-plan CPU compliance. A separate disposable tail-observer probe returned zero CPU/wall values even for deliberate computation, so local tail metrics cannot supply that missing evidence. At the end of this follow-up, the production deployment and up to two manual sync timing checks requested in chat awaited operator approval. No application code changed during that follow-up; the 276 functional and 45 browser results covered the same candidate.

### October 16 approved CPU candidate deployment and measurements

The operator approved deployment of application candidate `2d6ae01` and up to two manual Sync now timing checks. The deployment checkout was `71fd3b2`; its differences from the approved application commit were release documentation only. A fresh private D1 export restored successfully into an in-memory database, passed integrity checking, and reported zero foreign-key violations. Fresh client build and tracked/private production-config dry runs passed. The existing deployment was `3554f098-e77e-437f-bbec-25ba6443119d`, retained as the immediate code rollback target subject to separate rollback approval.

The approved candidate is deployed as Worker version `48b0aa83-44eb-4007-a9c4-75c237e9f372`, with the existing `*/30 * * * *` trigger and no migration. The previous browser session had ended; the operator completed a fresh Google sign-in. Production schedule and Availability sync reads succeeded. Private tail telemetry identified the new version for every measurement below:

| Invocation start (UTC) | Operation | CPU (ms) | Wall (ms) |
| --- | --- | ---: | ---: |
| 18:00:57.952 | First approved manual sync | 27 | 867 |
| 18:00:58.869 | Subsequent sync view read | 5 | 54 |
| 18:01:00.454 | Scheduled sync | 16 | 1,428 |
| 18:01:17.111 | Second approved manual sync | 11 | 695 |
| 18:01:17.832 | Subsequent sync view read | 6 | 46 |

Both manual checks visibly reported “Availability is up to date.” All listed invocations had outcome `ok` and zero exceptions. Fresh aggregate reads confirmed revisions remained 1/1, imports three, provenance 180, and participant/matched/pending counts 8/7/1. Effective-change time remained `2026-10-15T02:00:34.126Z`; attempt and success advanced together to `2026-10-16T18:01:17.179Z`. The new synchronized-domain-revision marker is 1. No duplicate history was created. Tail observation stopped after the authorized checks.

The deployed candidate improves the observed manual and read costs, but **the 10 ms CPU goal remains unmet**: both manual checks and the observed scheduled invocation exceeded it. These few production samples do not establish a cold/warm performance distribution or changed-source fit. Both approved manual timing checks have been used; no further manual synchronization or deployment is covered by that approval.

At the operator's request, all other open issues (#7–12), including their briefs and comments, were checked for a CPU dependency. Label formatting, roster-picker sorting and weekly schedule grouping are presentation work; grouping explicitly preserves the dated data and calculations. Proposal provenance and the single placeholder-account cleanup offer no material reduction in synchronization work. None provides a reason to defer CPU investigation.

### Follow-on interval allocation candidate

The next local candidate addresses measured parser hot spots. Weekly normalization validates each interval once, appends to local groups without repeatedly copying them, and shares a private merge helper with daily normalization. The helper copies output intervals before changing merge endpoints. Clock parsing retains its validation but avoids split/map allocations. Native WhenIsGood parsing formats each grid slot once per response rather than once per respondent selection. This interval-only comparison changes no database, API, authorization or scheduling policy.

A temporary comparison used the same saved private 97,456-byte source response for both versions and asserted identical complete parsed output. Across three batches of 1,000 parses, warm Node process CPU was about 1.01 ms per parse for the deployed source and 0.60 ms for the revised source. A longer actual Worker comparison used disposable D1, the same input, real local RSA verification, 100 warm-ups and 500 measured invocations per operation. Deployed/revised whole-workerd mean CPU was 7.24/6.76 ms for scheduled checks and 7.58/7.02 ms for manual checks. Local D1 and wrapper CPU are included; these are warm means, not Cloudflare metering or individual-event guarantees. A shorter earlier process sample was noisy and did not demonstrate improvement; the repeated parser and longer fixed-input results provide the narrower evidence above.

The final local candidate also records a SHA-256 source fingerprint including parser version and timezone in the existing `meta` table, atomically with a successful check. Identical source at the reconciled domain revision can reuse the saved parse; the source is still fetched and size checked every time. Source changes, domain edits and parser-version changes force parsing/reconciliation. Current users, revision assertions, generation fences and replay behavior remain. No migration or public response change is required. With the same longer local measurement, the combined candidate used 5.52 ms scheduled and 6.92 ms manual mean process CPU. These local warm means do not establish deployed compliance.

Final validation passed: 280 functional tests, 45 synthetic native-browser checks, strict typechecks, stylesheet formatting, client build and tracked/private production-config dry runs. Coverage includes parser-version compatibility, identical-byte and semantically equivalent source, immutable interval merging, separate native respondent selections, concurrent human edits/mapping changes, revoked authority, superseded cached checks and transactional rollback. The attempted native stream-consumption optimization regressed measured CPU and was discarded; minification reduced bundle size but gave no material measured CPU improvement and remains unconfigured.

The operator requested broader optimization options and asked whether splitting work across invocations would help. The [CPU strategy proposal](../performance/worker-cpu-strategy.md) recommends a durable Queue pipeline with one stage per consumer invocation, compares Workflows, focused SQL/validation changes and Rust/Wasm, and records measurement caveats. No architectural rewrite or new cloud resource was implemented. Production remains on `48b0aa83-44eb-4007-a9c4-75c237e9f372`; deploying the follow-on candidate requires a new explicit approval. The CPU goal remains open.

### October 18 CPU acceptance and remaining role checks

The operator explicitly closed the CPU part of #6, citing Cloudflare's occasional-overrun flexibility and no errors observed in the dashboard. This supersedes the earlier CPU release-blocking statements and the historical nine-millisecond objective; neither threshold is claimed achieved. Existing CPU samples remain evidence of accepted operational risk. No further optimization or deferred production diagnostic is required for this release decision. The issue's CPU/quota checklist item is checked off; the earlier measured D1 daily usage remains below the recorded free allowances. See [Cloudflare's CPU guidance](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).

A fresh read-only deployment inspection identified main Worker `e642614c-2b32-436d-ac49-ed96cbf768d5` at 100% traffic, created `2026-10-18T03:10:48.41492Z`, with fetch/scheduled/queue handlers. This is the actual current deployment identity, superseding historical deployment IDs above; this resume performed no deployment. A fresh synchronization-status read showed attempt/success together at `2026-10-18T07:31:01.625Z`, outcome `unchanged`, counts 8/7/1.

The operator completed administrator Google sign-in. Same-origin browser checks succeeded for the published schedule (70 rows), Availability sync (recent success and 8/7/1 counts), Center proposals (three rows), Insights, return navigation and explicit Reload view on schedule and synchronization status. No application error alert appeared. These checks were read-only; no manual synchronization, proposal save, assignment operation or notification ran.

Fresh native Worker/local-D1 authentication and role-isolation checks passed (14 tests across two files). They include real local signature verification, volunteer denial of administrator synchronization/Insights reads, center-contact scoping and current-account revocation. A focused run of existing public API authorization/ownership/freshness workflows also passed (64 tests; 67 unrelated cases skipped). They exercise the checked-out source and synthetic runtime; they do not establish live Google sign-in as those isolated roles on the deployed version.

The available enrolled account still has combined administrator/center-contact roles and no volunteer link; neither operator-controlled Gmail account is enrolled. The operator requested a [temporary test-account plan](6-role-validation-plan.md), rather than accepting the remaining live gap. That plan is prepared and requires explicit approval for temporary production access, fixture writes, revision advances and cleanup. No user or role was changed. The role-specific checklist and final closeout remain open until these checks and cleanup are complete, or the operator explicitly changes that acceptance scope.
