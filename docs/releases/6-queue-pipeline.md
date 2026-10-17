# Queue synchronization candidate — October 16, 2026

## Status and behavior

This candidate implements the Queue experiment approved by the operator. The operator approved the concrete rollout and candidate `5a6e188` was deployed at approximately 2026-10-17 02:26 UTC as Worker version `423ec4f6-f100-4637-9d74-d674461d19fa`. Both Queues and consumers are active, and migration `0003_synchronization_jobs.sql` has been applied to production. The production trial failed the strict 10 ms CPU gate; the goal remains unresolved. The original [prototype checkpoint](../performance/queue-pipeline-checkpoint.md) records the 0–2 ms minimal deployed consumer baseline.

Cron now sends only a scheduled intent and a maintenance reference. It performs no D1 reads, source fetch, Google verification or reconciliation. Each Queue delivery processes one stage. Both consumers are configured for batch size one, concurrency one, three retries and a 30-second retry delay.

- `start` creates a deduplicated scheduled job and its outbox entry with SQL projections.
- `fetch` bounds the source, computes its parser/timezone fingerprint and compares saved metadata. A cache hit stores a small marker and skips HTML storage and parsing.
- `parse` validates a fixed source snapshot and stores parsed participants. No remote source scripts execute.
- `prepare` handles unchanged-source or source-failure status using a small synchronization head. An intervening domain edit routes it to `reconcile`.
- `reconcile` reads the relevant domain tables and prepares the existing shared matching/availability/history rules.
- `commit` atomically applies the prepared SQL and completes the job, checking the stage version, current administrator authority, domain revision and synchronization generation. No earlier stage writes availability.
- `recover` expires stalled jobs, cleans retained artifacts and retries one eligible outbox entry per invocation. Further recovery work continues through another reference message.

Queue messages contain only a job ID, phase and version. Consumers do not verify JWTs or construct authentication/email services. Stage logs contain only the phase, allowing CPU telemetry to be attributed without exposing source data or identities. Manual requests still verify Google credentials and current administrator permissions before accepting a durable intent; the commit transaction checks current permissions again.

Sync now returns a queued job promptly. Availability sync displays queued/running/completed/failed state and directs the user to Reload view. There is no periodic or visibility-triggered browser polling. The shared synchronization/domain rules still preserve dated exceptions, assignments, cancellations, missing participants and unrelated records.

## Durability and retention

Job progress, intermediate artifacts and next-stage outbox references commit together. Delivery-attempt timestamps are recorded before sending, rather than treating D1 and Queue publication as atomic. A failed send after a committed transition causes redelivery of the preceding message to publish the current durable stage. Maintenance retries references whose last attempt is older than five minutes; maintenance itself runs from the 30-minute cron, so recovery can wait until the next scheduled check.

The dead-letter consumer marks only the matching failed stage version terminal and removes its artifacts. A stale dead-letter message cannot fail an advanced or completed job. Jobs still unfinished after one hour expire during maintenance, including jobs that encountered an uncatchable CPU failure or lost terminal delivery. Terminal job records retain a 24-hour window and are purged in bounded groups. Intermediate artifacts are removed at success/failure; permanent import/provenance history is preserved. Already-completed scheduled keys from the previous direct implementation remain deduplicated during cutover. Expired manual intent keys can be reused after the existing replay window without conflicting with old jobs.

Conflicting human writes trigger at most three full reconciliation attempts. An older queued source cannot overwrite a newer completed check. A second stage/version guard also prevents applying a plan after its job was deleted between reading and committing.

## Evidence and remaining CPU gate

A permanent native local workerd integration test completes changed and unchanged synthetic native-format source checks against disposable D1, with real Queue bindings and automatic consumer delivery. It also exercises the actual HTTP entry, real RSA/JWT verification against synthetic keys, manual durable acceptance, current job status, administrator-only operation rejection and volunteer reads. No authentication bypass is added to the application. The already-locked esbuild version is now an explicit development dependency for this test; no runtime library version changed. Existing public workflows exercise shared rules; dedicated queued workflows exercise authorization, durable acceptance, replay, duplicate/concurrent deliveries, stale edits, supersession, role revocation, final transaction rollback, outbox transport failures, dead-lettering, expiry, retention, migration preservation and a valid 2 MiB Unicode source snapshot.

Local timing uses the fixed private source capture (8 participants, 7 matched, 1 pending) and an isolated disposable copy of the operator backup. Inputs remain private. The driver captures outgoing reference messages and invokes the actual Worker queue handler in separate local HTTP wrapper calls. This timing harness does not measure native Queue transport; the separate smoke flow verifies native delivery. CPU is the entire owned workerd process, including local D1 and the wrapper, with 10 ms OS tick resolution aggregated over 250 invocations per phase after 100 warm-up jobs. These means are neither Cloudflare metered CPU nor a cold/per-event distribution.

Before batching stage reads and removing redundant publication bookkeeping, unchanged preparation averaged 7.80 ms locally. The revised implementation averaged 5.56 ms preparation and 6.04 ms fetch in the same style of harness. The changed-source exercise forces all represented volunteers' weekly availability to require repair while keeping history size fixed: parse averaged 5.88 ms, reconcile 8.44 ms, and commit 5.88 ms. These measurements preceded the addition of the small phase-only production log. The changed reconciliation result needs particular attention in production; do not infer adequate 10 ms headroom from these local numbers.

Before declaring success, capture actual deployed cron, authenticated reads, manual enqueue, unchanged stages and changed reconciliation/commit CPU, including first use. Require margin below 10 ms. Keep issue #6 open until those measurements and the outstanding live role checks are complete. A 2 MiB storage/functional test does not establish 2 MiB parsing/reconciliation CPU fit. If a stage fails the deployed headroom gate, split or reduce its measured work before accepting the architecture as a solution.

## Final validation and production preflight

- 301 functional tests passed across 16 files, including 18 durable-job workflows, six scheduled-boundary cases and the native authenticated Queue test.
- 45 native Chromium checks passed at desktop/tablet/mobile sizes, including queued status, preserved roster-link drafts and explicit Reload view without background reads.
- Both TypeScript checks, CSS formatting, client build, tracked Worker dry run, private candidate-config dry run and `git diff --check` passed.
- The additive job migration was applied twice to disposable D1 without changing the existing roster or staged imports. A valid 2 MiB Unicode source completed through the pipeline. These checks do not measure deployed CPU.
- Read-only deployment inspection confirmed Worker `48b0aa83-44eb-4007-a9c4-75c237e9f372` is still at 100% (deployment `778cc091-5aa8-4e99-ae15-be5207cd1b33`). No production resources were created or changed during this continuation.

The attempted fresh private production backup export failed with Cloudflare authentication error `10000`. Wrangler also reports missing OAuth scopes `k2.read` and `k2.write`. The current token still permits deployment inspection; that does not establish D1 access. Refresh Cloudflare authorization and successfully export/review a fresh backup before any production migration. No new backup file was produced. Prior private backups remain untouched, and the database's current contents have not been re-audited in this continuation.

## Concrete production trial and rollback

The operator granted the separate production approval required by README for this application release, including a fresh backup, Queue creation, migration, exact candidate deployment, one manual check and natural cron observation. Reload the application after deployment to load the queued-status client; an already-open older bundle can retain its former immediate-result wording until refreshed. The reviewable actions are:

1. Export a fresh private D1 backup and verify access to the currently deployed Worker version. Last recorded production version is `48b0aa83-44eb-4007-a9c4-75c237e9f372`; recheck it before rollout.
2. Create `mindfulness-scheduler-sync-dead`, then `mindfulness-scheduler-sync`. They carry only internal references.
3. Apply only the additive `migrations/0003_synchronization_jobs.sql` to the existing production database. It creates three job/artifact/outbox tables and indexes; it does not alter existing domain tables or seed data. Never use `schema.sql` remotely.
4. Deploy this exact reviewed candidate with the two consumer definitions, `SYNC_QUEUE` producer, `SYNC_DEAD_LETTER_QUEUE` variable and existing `*/30 * * * *` trigger. A private candidate configuration has been prepared separately; the original private production configuration remains unchanged.
5. Observe natural scheduled processing and, if approved, perform one manual Sync now check. Collect phase-only tail CPU and verify durable revisions/history/status through the authenticated UI. Stop tail after collection. Deployment enables unattended production availability updates.

For rollback, detach both Queue consumers first, then restore the verified prior Worker version. Retain the queues until in-flight work is accounted for. The additive tables may remain; the previous Worker ignores them. Under the rollout's rollback authorization, mark unfinished jobs failed and remove only their intermediate artifacts/outbox rows if abandoning this candidate. Do not drop/reset existing tables or restore a full database backup over concurrent human edits. Completed availability changes are data changes and are not undone by code rollback; review them separately if needed. The previous application was already observed above the CPU target, so rollback restores prior behavior without resolving this goal.

Current source references: [Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), [Queue batching/retries](https://developers.cloudflare.com/queues/configuration/batching-retries/), [dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), and [Wrangler Queue configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#queues). The configured batch size is deliberate: multiple messages in one invocation would share its CPU work.


## Approved rollout observations — October 17 UTC

The fresh private backup `production-backup-queue-20261017T-refresh.local.sql` was exported with mode 0600 and restored into an in-memory SQLite database. `PRAGMA quick_check` returned `ok`. It contained 74 volunteers, three users, 54 assignments, three imports, 180 imported-availability records and no availability exceptions or job tables. Domain/scheduling revisions remained 1/1. The prior Worker version was rechecked before writes and remained `48b0aa83-44eb-4007-a9c4-75c237e9f372` at 100%.

Both named Queues were created, then the five-statement additive migration succeeded. A subsequent remote read confirmed all three job tables, unchanged revisions and unchanged import/provenance counts. The candidate deployment succeeded with both consumers, the producer and the existing cron. Its reported startup time was 29 ms; startup time is separate from per-invocation CPU.

The first OAuth refresh reported a missing CSRF session cookie. A subsequent default Wrangler consent requested 30 permissions; automatic approval review rejected accepting that broad grant. The login attempt was canceled. Existing CLI credentials successfully exported D1 and completed the approved deployment, so no additional consent was necessary.

Phase-only production tail collection began before the first observed scheduled check. The operator completed Google sign-in in a fresh app tab. One manual Sync now and the natural 02:30 UTC scheduled check completed. Tail collection was stopped after the final audit.


### Metered production CPU

| Invocation | CPU ms |
| --- | ---: |
| Cron | 0 |
| Scheduled start | 5 |
| Maintenance recovery | 3 |
| Manual enqueue | 6 |
| Manual fetch, initial fingerprint miss | 12 |
| Parse | 8 |
| Reconcile | 15 |
| Manual commit | 1 |
| Scheduled fetch, fingerprint hit | 11 |
| Unchanged prepare | 13 |
| Scheduled commit | 2 |

Initial authenticated HTTP calls measured 17 and 13 ms; later observed HTTP calls measured 10, 6 and 6 ms before a final explicit reload. These requests were observed sequentially through the signed-in UI; raw tail data does not identify operation names, and the sanitized artifact does not guess them. The manual enqueue measurement is correlated with the single agent-initiated Sync now action. See [sanitized invocation evidence](../performance/queue-production-trial.json) for all captured events, including final reads. Integer 0 ms telemetry does not mean zero work. Every captured invocation reported `ok` with no exceptions, including those above the operator's strict design constraint; successful execution does not establish CPU compliance.

This is a small first-use sample, not a p95/p99 or controlled cold/warm experiment. The source was semantically unchanged. The first fetch lacked the new source fingerprint and therefore exercised parse/reconcile, but it did not create new import history or change availability. A real changed-domain reconciliation remains unmeasured.

The final remote audit found two completed jobs, zero intermediate artifacts and zero outbox entries. Data and scheduling revisions stayed 1/1; imports/provenance stayed 3/180. The UI displayed a successful check (10:30 PM manual, then 10:31 PM scheduled) and 8/7/1 participant counts. No rollback was performed: the candidate is functionally working, and the prior version was also over budget. The additive migration and both Queues remain active in production.

### Next optimization boundary

The subsequent candidate and its approved deployment are recorded in [Worker CPU hot paths](../performance/worker-cpu-hot-paths.md), with separate rollback commits on `codex/worker-cpu-hot-paths`, native local measurements and final functional/browser validation. Worker `8e14fcd6-94ac-4a7d-95f0-99ced8df0cbc` supersedes the trial above. One complete unchanged scheduled pipeline measured 1–7 ms per invocation; authenticated reads and changed-source production costs remain unverified, so the full 10 ms production gate remains open.

Keep the experiment reversible on `codex/worker-cpu-budget`, with implementation checkpoint `5a6e188` and this measurement record in a separate commit. Preserve the recorded prior Worker version for deployment rollback; reverting source alone does not detach consumers or undo the additive migration.

The measured priorities are fetch (11–12 ms), unchanged preparation (13 ms), reconciliation (15 ms) and initial authenticated reads (13–17 ms). Further stage splitting alone does not establish a solution: measure fixed setup, D1 decoding/serialization and shared runtime/response validation costs before choosing the next seam. A lighter dedicated consumer/runtime is a possible architectural change to propose and prototype, rather than silently replacing the application. Preserve final transactional authorization/revision fences and source deduplication. Do not close issue #6 or declare the 10 ms goal achieved.

The subsequently approved [prepared schedule reader trial](6-prepared-schedule-reader.md) measured schedule reads at 3–5 ms summed caller/reader CPU, including the first observed read after both Workers were redeployed. This closes the measured schedule-read goal only; the broader issue #6 gate and changed-source/write CPU gaps remain open.
