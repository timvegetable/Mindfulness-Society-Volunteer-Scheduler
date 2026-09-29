# Design

## Context

The 2026-09-28 campaign verdict (`openspec/changes/validate-worker-backend-feasibility/evidence/verdict-2026-09-28.md`) records the preview's failure shape: ≈7.5–12 s isolate CPU per larger-fixture request against ≤3 s warm / ≤5 s absolute, ≈11 s wall against ≤5 s, and ten burst requests killed at the platform's ~37 s wall cap — all with correct results. The prior single-Worker run (2026-09-27) measured the same computation at ≈6.9 s on larger vCPUs, so the cost is the computation, not the runtime. Statically, `scheduleSessions` (`src/server/scheduling/scheduler.ts`) evaluates every committed session against every eligible volunteer, and each (session, volunteer) pair re-scans whole tables: the exceptions array per volunteer (`candidateRows`), the recurring-availability and exceptions arrays again inside `effectiveIntervalsForDate` (`src/shared/time.ts`), and the assignments array once per session — on the production-scale fixture that is millions of row inspections per request. Working constraints carried from the feasibility change: the experiment contract's thresholds and campaign protocol are immutable evidence, the pinned fixture generator and the repaired measurement harness are reusable, and the isolated staging topology remained deployed (benchmark endpoint re-404'd after the campaign).

## Goals / Non-Goals

**Goals:**

- Measure, before optimizing, the per-phase CPU split of a preview request (Sheets decode, scheduler, projection assembly, envelope/serialization) on both pinned fixtures, and let that split choose which optimizations are worth doing.
- Remove the quadratic nested re-scans via request-local indexes while keeping the computation pure, synchronous, deterministic, and its outputs byte-identical.
- Prove semantic preservation by differential testing, and pass the unchanged campaign envelope on the staging Durable Object topology with a dated verdict.

**Non-Goals:**

- No cross-request caching, staleness rules, or derived-data persistence between requests.
- No native/WASM reimplementation and no whitespace subdivision of the computation across runtimes: one environment-neutral TypeScript computation stays authoritative for both the Apps Script backend and the Worker read path.
- No asynchronous preview redesign, no client changes, no scheduling-semantics changes, no threshold or protocol edits, and no production deployment.

## Decisions

1. **Profile first, with predeclared interpretation.** The static analysis predicts the scan-elimination wins; the change does not assume it. The profile task records a measured split per phase on both fixtures and a written rule: implement scan-elimination where scheduler time dominates; switch to assembly memoization (per-session projection reuse) where assembly dominates; do both where the split is mixed. Alternative considered — optimizing directly from static analysis, skipping the profile — rejected because the feasibility change repeatedly learned that evaluated assumptions (bundle cost, cold starts) differed from intuition, and the repo's contract culture requires evidence before claims.

2. **Index-elimination inside the existing pure functions, not a rewrite.** Request-local grouped structures: exceptions indexed by volunteer id; recurring availability grouped by (weekday, time zone); assignments indexed by session id; per-volunteer occupancy rows maintained individually so evaluating a session does not rebuild the whole occupancy map; per-(volunteer, date) effective-interval results memoized within the request. Iteration order and tie-breaks (rank → continuity → volunteer id, backup numbering) are untouched, so identical output holds by construction and is verified by testing, not assumed. Alternatives considered: a native/WASM port of the hot loop (dropped — dual implementation across runtimes during the whole migration transition, cross-language DST-parity risk, new toolchain against repo convention, wrong workload shape for Wasm); intra-request worker parallelism (unavailable across runtimes, nondeterminism risk); a workbook-persisted derived cache (cross-request staleness — a product decision, explicitly out of scope).

3. **Byte-identical output is the acceptance bar, proven differentially.** The original and optimized computations run side by side in tests over the pinned fixtures plus seeded randomized workbooks, comparing entire envelopes (ids, revisions, ordering, digests). The parity suite is a permanent regression guard; it is not evidence of speed — only the re-measurement is.

4. **Re-measurement reuses the campaign protocol with the ledgers it lacked.** Preview-only workloads per fixture (sequential warm and four-way bursts, genuine cold isolates per the freeze-then-first-use protocol, DO version-lag checked before counting colds), every attempt retained, ≤1,000-attempt budget, workbook digests verified before and after, and this change's browser probes paced through the shared read ledger — closing the carried-forward pacing gap that caused the attributed 429s last campaign. Staging host benchmark enablement remains a separately approved redeploy cycle.

5. **The no-go exit is predeclared.** If any dimension misses after optimization, the change records the plateau against unchanged thresholds and stops; a separate product-decision change (for example, an asynchronous preview flow) is the named successor. Nothing in this change relaxes, reinterprets, or re-fixtures a threshold after results exist.

## Risks / Trade-offs

- [Subtle output coupling] The scheduler's determinism depends on iteration order and tie-breaks that the index structures must not disturb → differential tests across pinned and seeded-randomized fixtures, all existing Node and Worker suites green, no test edit to make an old expectation pass.
- [Profile disproves the scan hypothesis] If assembly or serialization dominates, the scheduler refactor yields little → the profile split (decision 1) is measured first, and the task plan records which branch was taken with numbers.
- [Temporal polyfill in the hot path] Remaining Temporal use (session instants, a per-session-pair cost) could still crowd the budget → the profile's decode/scheduler/assembly split will show it; per-date instant computation can be memoized within the request without touching semantics.
- [Staging environment drift since the campaign] Deployments, digests, or endpoint state may not match the campaign record → pre-measurement verification task restores/verifies the staging record before any approved redeploy.
- [Speedup insufficient after both branches] The plateau becomes a recorded no-go → the predeclared product-decision change is the exit; this change still leaves the faster code in place, since preview also serves production today.

## Migration Plan

All-internal refactor with no state to migrate: merge to master behind existing tests, production Apps Script behavior changes only in speed. Staging re-measurement uses the existing per-deployment approval chain (benchmark enable, cold redeploy cycles, campaign run, benchmark disable), and its rollback is the host redeploy that restores the benchmark-404 state, with workbook digests verified before and after.

## Open Questions

None. The profile split is deliberately an evidence deliverable, not an open question: both branches (scheduler-dominant, assembly-dominant) are pre-declared with their respective optimization paths.
