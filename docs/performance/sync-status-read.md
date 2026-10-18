# Sync-status read: isolate fixed dispatch cost

Status: candidate `bc8b315` on `codex/thin-status-read` was trialled with explicit approval and rolled back after the first sync-status read failed the CPU gate. Production is restored to the `2ecbe19` baseline. No domain mutation or notification was performed.

## Production result

The [sanitized trial](sync-status-production-trial.json) reports combined CPU of 1 ms for protocol negotiation, 5 ms for Google verification, 8 ms for session issuance, 4 ms for the prepared schedule and **12 ms for sync status** (11 main + 1 private verification). Responses were functionally successful; the expected negotiation response was HTTP 400. Both Workers were immediately rolled back, and Wrangler confirmed the baseline versions at 100% traffic. Repeat/identical-redeploy samples and the remaining reads were not collected after the failure.

The first observed sync-status sample is lower than the preceding generic-path sample (14 ms), but two separate deployment observations do not isolate an exact 2 ms saving. The small path remains insufficient. Next isolate data shaping and validation rather than treating generic orchestration as the sole cause. The current UI uses only history summary fields and roster ID/name/email, while this response loads and returns complete historical staged availability and full volunteer records. A versioned, compact read projection is a concrete next experiment; preserve history access, participant resolution, current authority and revision semantics rather than silently truncating records.

Cloudflare's [CPU-time documentation](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) excludes waiting for network requests and database queries. I/O waiting cannot explain these CPU breaches; processing returned data remains a candidate. No measured computation-heavy loop currently justifies a Rust/Wasm rewrite of this status read.

## Feedback and hypotheses

The saved Cloudflare trial reports 14 ms main + 0 ms private verification for `admin.sync.read`. The CPU gate was replayed and failed before this change:

```text
Captured production sync-status CPU: 14 ms; required <=9 ms
AssertionError: Sync-status CPU gate failed
```

Working hypotheses were first-use generic runtime/dispatch setup, D1 snapshot conversion, and large-response view/validation/serialization. The authoritative runtime measurement remains the [failed production trial](split-sign-in-production-trial.json); local timings cannot replace it.

The private backup produces a 36,353-byte status response: approximately 16.6 KB of import history and 18.7 KB of volunteer records. A warm Node probe averaged approximately 0.005 ms for the view, 0.399 ms for validation and 0.085 ms for serialization over 100 repetitions. These small warm costs do not prove equivalent first-use behavior.

A disposable Node comparison then exercised the actual main/private protocol after a real local session exchange and read-ticket verification prelude. It used locally signed synthetic credentials and the private backup in a disposable SQLite adapter. Sequential fresh processes compared the existing dispatcher with a small async implementation, keeping queries, authoritative rules and output constant. The final implementation comparison used a frozen baseline bundle and the actual candidate Worker. All responses were identical by SHA-256 and size. No private rows or credentials are retained in the [sanitized measurements](sync-status-read-measurements.json).

Generic first-read Node CPU outside separately measured SQLite engine work ranged 9.5–13.2 ms. Candidate first reads were 6.4–8.3 ms in seven runs, with one 13.1 ms outlier. A single instrumented candidate run attributed 2.8 ms to view/validation, 2.0 ms to principal verification, 1.9 ms to snapshot work including SQLite, and smaller costs elsewhere. Those are Node process measurements with diagnostic overhead, not Cloudflare phase CPU. The result supports removing fixed orchestration work; it does not prove sufficient production headroom or establish Effect as the sole cause.

## Change and invariants

Route enabled-mode `admin.sync.read` through a small async read implementation. It reuses the existing operation-specific transactional snapshot, current-account authorization, synchronization view, latest-job query, full shared response validation and existing JSON serialization. It does not construct mutation services, acquire the Effect runtime, build unused clock/idempotency data or run mutation-dispatch branches. Other operations retain the existing dispatcher.

Extract verified-principal fetching and current-account authorization into shared owners used by both paths. Every read still verifies the signed principal and reads current D1 authority; there is no identity/role cache, permission duplication, SQL reimplementation or materialized status representation. R1/R2/G1 scope separation and Google-only mutations remain. The existing latest-job query still follows the snapshot as before; this experiment does not claim stronger cross-query consistency.

Native integration compares the enabled small route against the ordinary Google-authenticated dispatcher on the same database. It covers empty and populated history/pending/job results, escaped/Unicode fields, complete schemas, malformed input, forged tickets, forbidden roles, malformed stored roles, replaced account IDs and corrupt volunteer data. Restoring the synthetic corrupt volunteer invalidates the prepared schedule via existing triggers; the test rebuilds that representation before asserting later schedule reads.

## Release gate

After corrected native/full checks, types and builds, dry-run both production configurations and preserve an exact implementation commit. Client code is unchanged from `7838e51`, whose 48 browser checks passed; this server-only change does not claim a new browser run.

Pretrial validation passed all 367 tests across 20 files, type checks, stylesheet formatting and both Worker/client builds. The focused native/authentication/dispatch group passed 26 tests across three files. Both production configurations passed dry runs. Deployment reads confirmed the baseline versions below before the trial; the approved trial and rollback are recorded above.

The next separately approved trial must deploy the compatible private reader first and main/client second. Capture both Workers, measure protocol negotiation, both sign-in stages, first/repeat sync-status and schedule reads, then the remaining approved read-only views. One identical redeploy of each Worker is allowed only if all preceding gates pass. Every external request, including expected typed negotiation failures, must report at most 9 ms combined caller/private CPU. Immediately roll back main to `7bb1b7b4-daa4-4923-847a-3586c7e29cd6`, then reader to `d679ba8e-64d3-4546-8fdf-055960777e67`, on correctness or CPU failure. No migration, new secret, resource creation, domain mutation or notification is needed.

This is an experiment for one identified breach, not completion of the broad CPU goal. Other reads may still trigger the generic runtime's first-use cost. Larger inputs and unbounded history growth require a separate bounded-data design if current full responses cannot retain headroom; do not silently truncate history or return partial mappings.
