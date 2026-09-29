# Proposal

## Why

The 2026-09-28 Durable Object campaign recorded **no-go as built** for `admin.schedule.preview`: on the larger fixture it costs ≈7.5–12 s of isolate CPU per request against the predeclared ≤3 s warm / ≤5 s absolute budget and ≈11 s end-to-end against ≤5 s, and its four-way burst was killed at the platform's per-request wall cap — while the same campaign proved the primary read path feasible. `serve-remaining-reads-from-worker` explicitly moves `admin.schedule.preview` and must validate it at representative and larger workloads on the selected free topology, so the migration chain is blocked on exactly the exit condition the verdict names: a demonstrably faster computation re-measured against the same predeclared targets. The identical computation already serves production preview on Apps Script, so the same optimization benefits today's users without any behavior or deployment change.

## What Changes

- Profile the preview computation on the pinned representative and larger fixtures — a measured CPU split across Sheets decode, `scheduleSessions`, `scheduleProjection` assembly, and response serialization — before optimizing anything.
- Eliminate the nested full-array re-scans uncovered by analysis (`src/server/scheduling/scheduler.ts`, `src/shared/time.ts`) with request-local indexes and derived structures (exceptions by volunteer, recurring availability by weekday/time zone, per-session assignment lookup, per-volunteer occupancy maintenance), keeping the computation synchronous, single-pass deterministic, environment-neutral, and free of new dependencies.
- Prove output equivalence: differential parity against the unchanged implementation across the pinned fixtures and edge cases (DST-spanning larger fixture, cutoff boundary, malformed/blank cells, stable rank/continuity/ID tie-breaks), with regression tests that fail without the optimization.
- Re-measure the preview on the isolated staging Durable Object topology using the unchanged experiment-contract thresholds and campaign protocol (sequential and four-way preview workloads per fixture, genuine cold isolates, ≤1,000-attempt budget, browser probes paced through the shared read ledger), then record a dated go/no-go verdict for the computation.
- Explicitly out of scope: cross-request caching or staleness behaviors, alternative-language or native/WASM reimplementation, and any asynchronous preview redesign. If the optimized computation still fails its thresholds, the change records the measured plateau and hands the decision to a separate product-decision change; thresholds are never adjusted to meet a result.

## Capabilities

### New Capabilities

- `schedule-preview-performance`: Byte-identical deterministic preview output with a measured, campaign-verified resource envelope on the selected free execution topology.

### Modified Capabilities

None. This change alters no externally observable behavior — envelopes, projections, error codes, revision semantics, and scheduling rules are unchanged by proof, not by negotiation. The existing scheduling availability semantics (`docs/subsystems/scheduling.md`) remain authoritative.

## Impact

- `src/server/scheduling/` and `src/shared/time.ts` receive internal indexing/memoization only; `src/server/runtime.ts` preview wiring and the Apps Script entrypoints stay as they are. No client, schema, or shared-contract changes.
- Differential and parity tests in the existing Node suites; Worker-native suites cover the unchanged staging composition.
- The staging measurement harness (`scripts/staging/measure-worker.mjs`, `collect-metrics.mjs`) is reused for the preview-only re-measurement; staging host redeployments to enable/disable `POST /benchmark/schedule-preview` remain per-deployment approvals, and no production resource is referenced.
- Independent of `make-workbook-state-portable`; accepted evidence unblocks the preview acceptance tasks of `serve-remaining-reads-from-worker`.
