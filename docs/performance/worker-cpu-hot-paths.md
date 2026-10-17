# Worker CPU hot paths — October 17, 2026

This is an undeployed optimization candidate on `codex/worker-cpu-hot-paths`, continuing the [Queue production trial](queue-production-trial.json). Production remains Worker `423ec4f6-f100-4637-9d74-d674461d19fa` from `5a6e188`. The 10 ms CPU goal and issue #6 remain open.

## Changes and checkpoints

- `64f93dd`: validate HTTP boundaries without copying entire responses; project SQL rows directly into domain-shaped JSON. The fast validator compiles only a conservative subset of the existing schema AST and runs its original filters; unsupported codecs use the original decoder. Strict JSON validation prevents SQLite's JSON5 extensions from silently admitting previously rejected stored values. A regression test caught that difference before the fix. Request authentication and fresh D1 authorization remain mandatory. Operation-only logs allow production timings to be attributed without logging identities, credentials or payloads.
- `610b04f`: remove unnecessary Effect setup from Queue fetching and unchanged-status preparation; serialize comparison rows once; index participant matching while preserving identity precedence and ambiguity handling. Compare the parsed source with the durable head before loading the full reconciliation snapshot, including cosmetic fingerprint misses. Jobs still pass only references, preserve revision/version/actor fences, and apply domain changes only at the atomic final commit.
- `79c4c27`: initialize pure Temporal timezone machinery during Worker startup instead of its first request; avoid exact conversions for valid New York dates conservatively more than one UTC day from now. Nearby dates, malformed values and other zones retain the original Temporal conversion. Differential tests cover spring gaps, both repeated autumn hours, UTC midnight and calendar year 0000. No custom timezone algorithm, identity/session cache, runtime dependency or migration was added.

The original Queue branch `codex/worker-cpu-budget` remains at `373e8f6`. Each optimization batch is separately committed for reversal. New source remains compatible with the currently deployed job schema and Queue protocol.

## Measurement method and limits

A disposable native workerd/D1 harness replayed a fixed private source and a disposable copy of the private backup. No production database writes, source edits or role changes were made. HTTP checks verified real synthetic RSA-signed JWTs against synthetic signing keys; role checks read D1. The all-read run added a synthetic volunteer account only to the disposable database.

CPU came from the owned workerd process's OS accounting, in 10 ms ticks. It includes local D1 work and a diagnostic HTTP wrapper, whereas production D1 execution is external to Worker CPU. Values below are warm means over 120–250 invocations, not percentiles or production CPU guarantees. A first-use sample is one quantized event per operation in a fresh runtime, after preceding operations, not a controlled cold-isolate distribution. Zero means a tick was not observed, not zero CPU. Profiled runs were excluded from comparisons because profiling inflated cost. Complete sanitized results are in [the measurement file](worker-cpu-hot-paths.json).

| Warm local mean, ms | Baseline | Candidate |
| --- | ---: | ---: |
| Unchanged Queue fetch | 4.701 | 4.582 |
| Unchanged Queue prepare | 4.600 | 3.984 |
| Changed Queue fetch | 8.259 | 7.960 |
| Changed Queue parse | 6.070 | 5.323 |
| Changed Queue reconcile | 7.811 | 7.313 |
| Changed Queue commit | 6.169 | 6.318 |
| HTTP session.me | 2.920 | 2.880 |
| HTTP admin.schedule.read | 7.080 | 6.200 |
| HTTP admin.sync.read | 6.480 | 5.800 |

The changed candidate adds a head-comparison prepare invocation (3.234 ms mean); more stages add total work. Changed runs reset synchronization revisions correctly and asserted that real reconciliation happened. Unchanged jobs asserted successful completion and skipped reconciliation. These measurements support targeted improvements, not a claim that every stage is now safe.

The all-read check exposed a first volunteer-dashboard read at 50 ms locally. Conservative date filtering alone produced 40 ms. Moving deterministic timezone initialization into startup produced 10 ms on each of two runs. Warm dashboard means stayed 5.583–5.750 ms. Other final warm reads were session 2.583–2.833, schedule 5.667–6.083, sync 5.333–6.250, insights 6.667–6.833 and center candidate 4.667–4.833 ms. The first session read still measured 20 ms. The local CPU gate therefore remains red; neither warm means nor a successful invocation establish the hard production constraint.

Wrangler's final local startup profile reported a 198.5 ms window, 179.6 ms sampled and 134.7 ms active. These are local profile measures, not deployed startup time. Cloudflare allows [one second for global-scope startup](https://developers.cloudflare.com/changelog/post/2025-10-10-increased-startup-time/) and documents the separate [invocation CPU limit](https://developers.cloudflare.com/workers/platform/limits/#cpu-time). Deployment must confirm actual startup time and first-use behavior.

Profiles pointed to D1 record conversion, schema traversal, source-body processing and repeated matching/serialization. Native stream/text alternatives did not improve fetch cost and were discarded. The source supplied no ETag or Last-Modified header for a conditional-fetch shortcut. Rust/Wasm is not justified by the measured hot paths; it would still require transporting and decoding the same records. If production remains over budget, isolate remaining read computations or propose moving computations to the browser before undertaking an architectural rewrite.

## Validation and release gate

Final validation against the corrected source in `79c4c27`: 321 functional tests across 16 files, 45 native Chromium checks across three viewports, both TypeScript checks, CSS formatting, client build, tracked and private production-config deployment dry runs, and `git diff --check` passed. The first browser attempt could not launch because its default cache lacked Chromium 1248; rerunning with the existing matching `/tmp/issue6-playwright` cache passed all 45 checks. This was a runtime setup failure, not an application assertion failure.

Permanent coverage includes malformed schema differential checks across every operation, stored JSON5 rejection, native authenticated role revocation/deactivation, cosmetic source changes, matching collisions and existing Queue failure/idempotency/revision workflows. Throwaway diagnostic drivers, generated bundles and profiles were removed after saving sanitized measurements. Private source, roster, backup and configuration are not committed.

No new migration or Queue resources are needed. Before an explicitly approved deployment, export a fresh private backup and review the existing private configuration with both batch-one consumers and the 30-minute cron. Deploy the exact reviewed commit, record its Worker version and startup time, and collect operation-attributed CPU for available authenticated reads, one separately approved manual check and a natural cron. Include first-use and warm requests; inspect errors, final job state, artifact/outbox cleanup, revisions and unchanged history. Stop tail collection afterward. Do not manufacture changed production source data. A genuinely changed production run and live volunteer-only/contact-only account isolation remain unverified.

Rollback for this candidate is the existing Worker version `423ec4f6-f100-4637-9d74-d674461d19fa`, preserving both Queue consumers and cron. Code rollback does not restore data. Rolling back farther to pre-Queue code requires the separate consumer-detachment procedure in the [Queue release record](../releases/6-queue-pipeline.md). No rollback or deployment was performed during this continuation.
