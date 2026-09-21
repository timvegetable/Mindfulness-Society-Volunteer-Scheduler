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

### Measure before choosing the read strategy

Add request-local phase timing and preserve client end-to-end timing. Use a production-shaped non-production workbook first, then the approved deployed probe. Measurements must identify sample eligibility and route independently.

Alternative considered: immediately adopt the advanced Sheets service. Rejected because it adds deployment configuration and may not address authentication or transport costs.

### Define operation-specific workbook hydration plans

Schedule and Insights reads declare the tabs/ranges they require rather than constructing an all-purpose store. Shared request-local memoization prevents duplicate reads. Authorization remains a required fresh input on every execution.

Alternative considered: globally cache decoded workbook rows. Rejected because it can serve stale authorization or revision state and violates the architecture.

### Batch independent reads behind the workbook boundary when justified

If measurements show sequential Sheet calls dominate, add a batch-read adapter inside `src/server/workbook/`, preferably through the advanced Sheets service, while keeping codecs and repositories unaware of the external API shape. Validate that all ranges belong to the configured workbook and decode them as one request snapshot.

Alternative considered: issue direct Sheets calls from services. Rejected because raw Sheet access must remain in the workbook layer.

### Treat renegotiation as a requirements decision

After reasonable scoped and batched-read work, rerun the specified sample set. If the p95 remains above 2000 ms because of the platform floor, present timings and architectural alternatives to administrators. Change the requirement only through an explicit spec amendment.

## Risks / Trade-offs

- [Instrumentation changes measured latency] → Keep timers lightweight and compare instrumented versus uninstrumented samples.
- [Advanced service configuration complicates deployment] → Add fail-fast configuration checks and document enablement and rollback.
- [Scoped reads omit a hidden dependency] → Pin each operation plan with contract tests and compare projections against the current implementation.
- [Batch reads weaken consistency assumptions] → Fetch related ranges in one batch and retain revision checks before using or mutating the snapshot.

## Migration Plan

1. Capture repeatable baseline and phase timings without changing behavior.
2. Introduce operation-specific read plans with parity tests.
3. Add batching only if evidence identifies Sheet round trips as the controlling cost.
4. Deploy with write-disable and collect at least 40 successful warm samples per route.
5. Keep the optimized path only if correctness and latency evidence pass; otherwise roll it back and take the objective decision to administrators.

## Open Questions

- Whether the advanced Sheets service is already enabled in the production Apps Script project.
- What bound constitutes a reasonable optimization attempt before administrators decide on architecture or objective changes.
