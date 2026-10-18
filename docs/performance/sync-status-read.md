# Sync-status read: isolate fixed dispatch cost

Status: local candidate on `codex/thin-status-read`, based on `dbaafbf`. Production remains the restored `2ecbe19` baseline. No new deployment or domain mutation is part of this investigation.

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

Corrected validation passes all 367 tests across 20 files, type checks, stylesheet formatting and both Worker/client builds. The focused native/authentication/dispatch group passes 26 tests across three files. Both production configurations pass dry runs. Current deployment reads confirm the baseline versions below remain at 100% traffic. No production trial of this candidate has occurred.

The next separately approved trial must deploy the compatible private reader first and main/client second. Capture both Workers, measure protocol negotiation, both sign-in stages, first/repeat sync-status and schedule reads, then the remaining approved read-only views. One identical redeploy of each Worker is allowed only if all preceding gates pass. Every external request, including expected typed negotiation failures, must report at most 9 ms combined caller/private CPU. Immediately roll back main to `7bb1b7b4-daa4-4923-847a-3586c7e29cd6`, then reader to `d679ba8e-64d3-4546-8fdf-055960777e67`, on correctness or CPU failure. No migration, new secret, resource creation, domain mutation or notification is needed.

This is an experiment for one identified breach, not completion of the broad CPU goal. Other reads may still trigger the generic runtime's first-use cost. Larger inputs and unbounded history growth require a separate bounded-data design if current full responses cannot retain headroom; do not silently truncate history or return partial mappings.
