# Prerequisite assessment — 2026-09-29 (task 1.1)

Task 1.1 requires the archived gateway/Durable Object read evidence and the
optimized-preview evidence to be reviewed together, acceptance resolved through
tasks 1.4–1.6, and every Script Property, revision consumer, API writer and
maintenance/loader/direct-write path inventoried. This assessment records the
selected topology, each predeclared gate's evidence and disposition, and points
at the inventory.

**Method.** The predeclared threshold table in the amended
[experiment contract](../archive/2026-09-29-validate-worker-backend-feasibility/evidence/experiment-contract.md)
was treated as the acceptance contract. Each gate's statistic was re-derived
from retained telemetry and from platform data rather than taken from a verdict
label, because both archived verdicts label some gates "met" on weaker evidence
than the threshold names — the labels under review are exactly the ones this
change's design section calls out. Where a statistic is not published, the
disposition says so. Nothing here re-runs a workload, changes a threshold, or
authorizes a deployment.

## Selected topology

Browser → thin gateway Worker → Durable Object host (Google credentials on the
host) → Sheets, as measured on 2026-09-28 and re-measured on 2026-09-29. This is
the topology the portable-state reader rehearsal targets.

The 2026-09-27 single-Worker no-go stands as the historical verdict for that
topology only. Its inference that a decoded-snapshot cache is a prerequisite is
withdrawn by the 2026-09-29 measurement: the optimized preview meets the
unchanged envelope without a cross-request cache. What the topology choice does
**not** authorize: production deployment, cross-request caching, or skipping the
fresh `Users` authorization and completed-generation checks this change adds.

## Predeclared gates

| Gate (predeclared threshold) | Evidence | Disposition |
| --- | --- | --- |
| Gateway CPU — warm p99 ≤ 5 ms, every warm ≤ 8 ms, cold ≤ 10 ms | Retained platform report: 1,504 gateway invocations in the read-campaign window, unambiguous script attribution, 172 exact single-request samples with maximum 2.43 ms, worst bucket p99 2.689 ms (2-request bucket). The verdict text says 170 exact samples; the retained report says 172. | **Met** |
| Object read CPU — warm p99 ≤ 500 ms, every request incl. cold ≤ 1,000 ms | Task 1.4 assessment below. | **Met** |
| Object preview CPU — warm p99 ≤ 3,000 ms, every request incl. cold ≤ 5,000 ms | Task 1.4 assessment below, on the optimized computation. | **Met** |
| Wall time — reads warm p99 ≤ 1,500 ms per operation per fixture; preview end-to-end warm p99 ≤ 5,000 ms | Read campaign: sustained p99 535/627/614 ms and larger 535/900/1,015 ms. Preview campaign: burst p99 2,553–4,191 ms, sustained 1,161–1,635 ms, cold 1,110–2,653 ms across the eight retained runs. | **Met** |
| Reliability — zero unexpected failures, zero quota errors, zero resource-limit errors | One 5xx in 529 campaign attempts (a burst member, zero reads, 11.9 s after an approved host deployment); 41 retained expired-credential attempts (operator clock, attributed); zero 429 in every retained log; zero resource-limit errors in the optimized campaign. Classification in the task 1.6 assessment. | **Met under the predeclared attribution rules**, with one retained attributed failure |
| Correctness — semantic parity, fresh authorization, workbook and revisions unchanged | Fixed-clock differential parity over 20 cases byte-equal; every retained run reports the same larger-fixture snapshot digest; workbook digests unchanged before, between and after the campaigns. | **Met** |
| Sheets budget — 1 identity read, 2 domain/preview reads, ≤ 40 reads/60 s, zero 429 | Every retained preview attempt reports 2 reads including cold; the shared rolling ledger paced harness and browser probes; zero 429. | **Met** |
| Memory — isolate p99 ≤ 64 MiB where published | Preview campaign 44.88 MiB p99 (44 periodic samples); read campaign 55.05 MiB p99 (92 samples). | **Met** |
| Free-tier consumption — campaign ≤ 1,000 attempts; daily consumption and 100/500/1,000-per-day projections ≤ 50% of allowances; no paid plan | Task 1.5 assessment: platform-published billable duration, 0.37–0.73% of the 13,000 GB-s/day allowance on the two campaign days, 1.5% and 0.57% of the 100,000 requests/day allowance, projections ≤ 0.64%. | **Met** |
| Cold coverage — ≥ 5 genuine gateway and ≥ 5 genuine host colds, version-lag-checked | Five gateway and five host cold observations, each marker-verified against its approved deployment. Eight survive in the attempt logs (1,523 / 1,653 / 1,110 / 2,562 / 1,462 ms gateway; 1,290 / 2,223 / 1,637 ms host); the two earliest were overwritten by a follow-up run, a lapse the verdict discloses, and their numbers are corroborated by platform telemetry. | **Met**, with the disclosed bookkeeping lapse |

## Task 1.4 — object CPU acceptance

Both archived verdicts recorded per-request CPU quantiles as unavailable and
evaluated object CPU from periodic aggregate sums plus wall bounds. That gap is
closeable: Cloudflare's `durableObjectsInvocationsAdaptiveGroups` dataset
publishes per-invocation CPU statistics per one-second bucket —
`quantiles { cpuTimeP25 … cpuTimeP999 }` alongside `sum { requests, errors,
wallTime, responseBodySize }` and `dimensions { datetime, namespaceId, objectId,
scriptName, scriptVersion, status, type }`. The archived collector selected only
`sum { cpuTime }` from the *periodic* dataset, so the series existed and was
never read. This assessment re-derives the object CPU gates from that dataset
over the same campaign windows, attributed to the staging host script and the
single staging Durable Object namespace (identifiers in the private staging
manifest). Raw rows are retained in ignored `staging-local/`.

Statistic rules applied, following the contract: bucket quantiles are used only
for their own population and are never rescaled by request counts; a
single-request bucket yields that request's exact CPU; the campaign-level
statistic is bounded, not invented.

- **Populations.** Operations are separated by per-operation, per-fixture
  response-body size (a bucket with more than one body size is "mixed" and is
  excluded from a gate population, never silently assigned), cross-checked
  against the harness attempt records and the benchmark-enabled deployment
  windows. Read population: 1,241 success read requests over 523 buckets in the
  2026-09-28 window. Optimized preview population: 490 success preview requests
  over 321 buckets in the 2026-09-29 window. Both counts are larger than the
  retained attempt logs, because the harness overwrites one attempt log per
  workload name; the extra requests carry campaign signatures and are kept in the
  population rather than dropped.
- **Exact samples.** A bucket holding one request has every quantile equal to
  that request's CPU. Reads: 127 exact samples (10.2% coverage) with p99
  102.9 ms and maximum 124.5 ms. Optimized previews: 252 exact samples (51.4%)
  with p99 1,229.6 ms and maximum 2,137.1 ms.
- **Warm p99 upper bound.** For each bucket, at most 1% of its population exceeds
  its own p99, so at most 1% of the pooled population exceeds the largest bucket
  p99; that maximum is therefore an upper bound on the pooled p99. Reads:
  **124.5 ms** against the 500 ms gate. Optimized previews: **2,724.4 ms**
  against the 3,000 ms gate — the sensitive figure in this assessment. These are
  bounds, not measured pooled percentiles, and are labelled as such.
- **Every-request limit.** For populations of at most 1,000 requests per bucket,
  the nearest-rank p999 of a bucket *is* its maximum, so the largest per-bucket
  bound is the largest measured per-request CPU in the population: 124.5 ms for
  reads and 2,724.4 ms for previews, against the 1,000 ms and 5,000 ms limits.
  The preview campaign's exact-sample maximum, 2,137.1 ms, is consistent.
- **Cold.** Ten genuine optimized cold observations have platform rows, each a
  single-request bucket, so their CPU is exact: 84.9–891.9 ms, including the
  host cold whose attempt log was overwritten and which the platform data
  identifies. All are far under the 5,000 ms limit, with cold walls of
  1,110–2,562 ms. Cold *read* CPU has only four served observations, fewer than
  the five the contract's cold rule requires, so cold read CPU is not evaluated
  as a distribution and no cold read percentile is claimed.

Three classification traps were handled explicitly rather than absorbed:

1. The 2026-09-28 window contains 10 requests that hit the platform wall cap
   (`status` = `exceededResources`, walls ≈ 37.06 s, six rows between
   05:30:15Z and 05:32:44Z). They are the recorded larger-preview burst kills,
   they returned zero-length bodies, and a size-based classifier files them as
   identity reads and then reports a 32.5 s "read" CPU. Gate populations take
   `status` = `success` rows only, so they cannot enter a read population.
2. The same window contains the *unoptimized* larger-preview population (exact
   p99 9,457 ms, largest bound 32,500 ms). It is the historical population the
   2026-09-29 optimization supersedes and is never pooled with the optimized
   gate population.
3. The representative-fixture preview body (14,096 B) is larger than several
   read bodies but far smaller than the larger-fixture preview body (589,235 B).
   A single size threshold above the read bodies files those previews as reads;
   the read gate here rests on the per-operation body table instead, and the
   representative previews are counted in the preview population.

Not established: a measured pooled percentile for either population (exact
coverage 10.2% and 51.4%, below the archived collector's 90% derivation
requirement, which is why the labelled bound is used); per-request CPU inside
multi-request buckets (bounded only); operation identity for the 117 mixed-bucket
requests and the denials, which are reported and excluded rather than assigned;
and cold read CPU as a distribution.

## Task 1.5 — free-tier duration acceptance

See [the duration assessment](prerequisite-duration-assessment-2026-09-29.md).
Disposition: met. The platform publishes billable duration; both campaign days
sit at 0.37% and 0.73% of the daily duration allowance.

## Task 1.6 — the attributed 503 and the JWKS failed-load window

Verified timeline: one burst attempt at 2026-09-29T17:48:02.150Z returned 503
with the `UNAVAILABLE` code, 609 ms, zero Sheets reads, four attempts in flight;
the approved host deployment marker for that cycle is 17:47:50.265Z, a gap of
11.885 s, so the recorded "12 seconds after a host redeploy" is accurate. The
same run's cold attempt at 17:47:57.693Z succeeded, so the failure is not the
cold request and not a cold-path failure.

The recorded mechanism does not survive review. A key-set failure is
object-served and returns HTTP 200 with an envelope, the host deployment marker
and a correlation id; the recorded response has neither header, and the object
namespace records four requests against the five gateway dispatches at that
second. A read-only platform capture attributes the failing request to the
gateway script's cross-script object dispatch, inside the post-redeploy
propagation window (the approved host deployment 11.885 s earlier, and the
deploy procedure's two secret uploads 0.5 s and 4.5 s before the two attempts).
Disposition under the predeclared rules: **a retained, attributed platform
failure** — the contract's own category for a retained `5xx` — with the corrected
mechanism and the unretained platform error message both recorded. No repair is
required for this event. Details and the raw query are in the
[classification](prerequisite-503-classification-2026-09-29.md) and its
[attribution capture](prerequisite-503-attribution-capture-2026-09-29.md).

## Inventory

The complete source-linked inventory is
[the inventory evidence](prerequisite-inventory-2026-09-29.md): fourteen Script
Property keys or patterns (thirteen in tracked source plus one that exists only
in gitignored private procedure material), sixteen API operations with their
declared and enforced revision behaviour, nineteen maintenance/loader/direct-write
path rows, and the revision consumer/producer sites grouped into ten comparison
checks. What it establishes for this change: the revision authority today is
three Script Property keys plus the schedule-output revision carried in
scheduling rows; the only production writers of those keys are the dispatcher
commit and the per-tab repository commit; the only production script lock is the
dispatcher's; and the paths that can change rows or metadata outside the ordinary
API are the initializer, the migration loader, migration validation and the
reviewed direct-write reconciliation procedure. Two recorded defects are
confirmed in source rather than inherited: import preview persists a staged run
while the policy marks it non-mutating (so it takes no lock and advances no
global revision), and a client-supplied `expectedRevision` never reaches a
tab-level check.

## Disposition

Gateway CPU, object read CPU, object preview CPU, wall time, correctness, the
Sheets budget, memory, free-tier consumption and cold coverage are **met**; the
reliability gate is met under the predeclared attribution rules with one
retained attributed platform failure whose recorded mechanism has been corrected.
No gate is failed, none is silently downgraded to an average or a wall bound, and
each figure that is an upper bound rather than a measured percentile is labelled
as one.

Every prerequisite condition that task 1.1 gates implementation on is therefore
resolved rather than conditional-go: 1.4 on attributed per-request CPU
populations and bounds, 1.5 on platform-published billable duration, and 1.6 on a
corrected, attributed classification with no repair required. Nothing here
authorizes a deployment, a push, a production mutation, or the reopening of a
write gate, and the production activation steps in the change remain separately
approved actions.
