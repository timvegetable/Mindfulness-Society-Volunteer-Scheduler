# Compact sync-status projection and production diagnosis

Status: candidate `3ad9f87` on `codex/compact-sync-read` completed its specifically approved production diagnostic. Both production Workers were restored to the `2ecbe19` baseline afterward. The latest strict trial measured sync status at 12 ms combined CPU and rolled back. The full nine-millisecond goal remains active. The [frozen diagnostic manifest](compact-sync-diagnostic-manifest.json) identifies exact source/bundle hashes, inserted early stops, native authorization checks and successful dry runs.

## What changes

The existing UI displays history date/status/participant/matched counts and uses roster ID/name/email for participant linking. It never displays the historical interval blobs, full volunteer attributes or mapping records returned by `admin.sync.read`.

The read now returns complete history **summaries**, complete pending-participant details, current status/job/revisions, and the complete roster's ID/name/email. It does not truncate history, pending records, conflicting submissions or roster choices. Full import history remains stored and the import/promotion workflows retain their full records. History summaries also retain actor IDs for operational evidence.

A dedicated six-statement D1 batch reads the current account and these projections transactionally, including the latest job using the existing query/summary owner. It omits synchronization `participants`, avoids historical availability blobs when participant counts are already stored, omits unused mappings, and selects only the roster fields this view exposes. Current account ID/email/activity/role checks and complete output validation remain.

Legacy history with missing participant counts is a deliberate compatibility path: it reads the legacy staged JSON and uses the existing `restoreLegacyParticipants` grouping rule before counting participants. Raw interval count is not equivalent. The pure history-summary rule is shared with ordinary snapshot reads; there is no second identity-grouping algorithm in SQL. Large legacy blobs on this fallback remain a CPU risk requiring measurement or a separately approved backfill if necessary.

The response change is explicit. New clients send `X-Sync-Read-Protocol: 2`; enabled servers cheaply reject older status clients with a reload message instead of returning an over-budget legacy response. This header selects a response contract, not authentication. The same R2 credential and current administrator checks are required. Rollback requires reloading the restored client; it never restores database contents.

## Evidence and limitations

The native API contract test failed before the change because history still included `stagedAvailability`. Corrected native checks compare compact and generic reads, cover legacy interval grouping when counts are missing, retain stored legacy data, reject corrupt exposed fields and forged tickets, and preserve revoked/replaced-account rejection. The change intentionally stops validating unused volunteer attributes in this read; the relevant read/write owners still validate those attributes when used.

A private-backup size probe measured the response dropping from 36,353 to 7,469 bytes. Serialized D1 row data in the local adapter dropped from 82,806 to 8,140 bytes, with all three history rows, counts 0/6/8, and 74 roster choices retained. These are structural size measurements, **not CPU estimates**, native D1 wire measurements or production performance proof. No new local timing comparison is used to choose the next deployment.

All 368 functional tests across 20 files, 51 browser tests, type checks, stylesheet formatting and both Worker/client builds pass. Browser coverage explicitly checks history counts and roster choices through the compact contract. The normal and diagnostic configurations pass deployment dry runs. The specifically approved production diagnostic below has now completed; the candidate is not left deployed.

## Is this fixing observed outages?

The current [issue #6](https://github.com/timvegetable/Mindfulness-Society-Volunteer-Scheduler/issues/6) records a release window with 53 scheduled successes and zero failures despite 24–59 ms CPU. Later 53–66 ms observations also reported `ok`. The documented user-facing `INTERNAL_ERROR` came from legacy import shape incompatibility and was fixed separately. This record does not demonstrate CPU-limit outages; neither does it establish their absence for all account traffic or future workloads. Previous subscription inspection returned 403, so the actual billing plan was not independently verified. The user's explicit <=9 ms objective remains the acceptance criterion unless changed by the user.

## Proposed controlled production diagnostic

Use actual Cloudflare tail CPU instead of another local performance prediction. Four frozen variants share this candidate's source, client, authentication, queries and configuration:

| Variant | Work completed before response |
| --- | --- |
| snapshot | Read verified principal and raw D1 batch, validate current administrator authority, then return a typed diagnostic error |
| view | Above plus compact view/JSON conversion and payload validation, then return a typed diagnostic error |
| validation | Above plus complete shared output validation, then return a typed diagnostic error |
| full | Normal successful compact response, including serialization and normal response construction |

Only the three diagnostic copies contain temporary early stops. Production application source has no diagnostic route, environment switch, new secret or validation bypass. The existing `admin.sync.read` interface is used. Snapshot diagnostics move the same account authorization just before the early stop so non-administrators cannot run an authorized diagnostic. View/validation variants use the normal authorization sequence. The native disposable runtime checks all four variants with both administrator and volunteer credentials: eight checks pass and metadata remains unchanged.

A diagnostic error is intentional, contains no data, and is distinguishable from an unexpected application failure. Error construction/handling has a cost, so do not subtract samples as exact phase CPU; compare repeated patterns and account for first-use noise. These variants narrow which prefix retains cost, rather than producing a perfect profiler decomposition.

This is a different approval from the previous release trials: collect up to five sequential explicit status reads per variant even if successful/intentional-error invocations exceed 9 ms. Allow one identical redeploy of the full variant for first-observed comparison: at most five main deployments and one compatible private reader deployment. Unexpected auth/application/resource errors stop the diagnostic. Restore **both baseline Workers at the end regardless of measurements**. No new resources, migration, secrets, domain writes, source edits, manual synchronization or notifications are included. Existing cron/Queue behavior stays in place. Keep credentials and raw tails private; preserve only operation/version/CPU/status aggregates. Remove temporary variants after evidence is saved.

Deployment/diagnostic approval must name the committed candidate and frozen manifest. Roll back main to `7bb1b7b4-daa4-4923-847a-3586c7e29cd6`, then reader to `d679ba8e-64d3-4546-8fdf-055960777e67`. Production qualification is a later decision requiring repeated successful normal requests at <=9 ms and the remaining endpoint/input gates in `nine-ms-goal.md`; diagnostic tolerance never relaxes the release gate.


## Production diagnostic result

The [sanitized measurement record](compact-sync-production-diagnostic.json) contains all 25 paired status measurements and deployed version IDs. Main and private-reader CPU were summed for each explicit external request. All requests reported `ok` with HTTP 200; the 15 early-stop responses were the intended typed diagnostic errors.

| Variant | Combined CPU in request order (ms) |
| --- | --- |
| Full compact response | 5, 3, 2, 1, 3 |
| Snapshot stop | 4, 2, 2, 2, 2 |
| View stop | 4, 3, 2, 2, 1 |
| Validation stop | 6, 4, 4, 2, 4 |
| Identical full redeploy | 5, 3, 3, 2, 2 |

The two normal first-observed reads were both 5 ms, with all ten normal reads at 1–5 ms. Sign-in negotiation was 1 ms, Google verification 5 ms, session issuance 4 ms and initial schedule loading 3 ms combined. No unexpected authentication/application/resource failures occurred. Output validation remains enabled. Removing validation is not justified by these results: the normal validated path meets the gate on this dataset, and diagnostic error-path differences/noise prevent treating prefix differences as an exact decomposition.

Compared with the prior thin-route trial's 12 ms first read, this supports the compact projection as an effective next candidate. It does not establish which individual conversion, parsing, validation or serialization routine caused the earlier overage: the projection intentionally reduces several costs together, and these are separate deployment samples. No local timing forecast is used as production proof.

The private diagnostic configurations initially pointed to `dist`; predeployment inspection corrected them to the existing built client directory `dist/client`, then the full configuration passed another dry run. Frozen source/bundle hashes were unchanged. Temporary diagnostic source copies were removed after collecting the evidence. Raw tails and operator recovery files remain private.

Main was restored first to `7bb1b7b4-daa4-4923-847a-3586c7e29cd6`, then reader to `d679ba8e-64d3-4546-8fdf-055960777e67`; Wrangler verified each at 100% traffic. The restored client was reloaded and showed the signed-out welcome screen. This diagnostic approval required restoration regardless of success and does not authorize leaving the compact candidate deployed.

Remaining qualification includes other authenticated reads, largest supported inputs/growth bounds, renewal/error paths and the broader Queue/writer ledger. Two first-observed samples are not a guarantee about every cold isolate or future request. The overall <=9 ms goal stays active.
