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

## Rollback

Following explicit rollback approval, use Wrangler's rollback command with the private production config to restore Worker version `65b315ee-294e-45d3-9801-76473bed47d2`. Verify deployed handlers and Cron Trigger state; stop scheduled updates explicitly if necessary and authorized. Leave the additive table intact unless separately reviewed. Code rollback does not restore availability or any other database records: data restoration requires separate authorization and the reviewed private backup. No rollback was performed.
