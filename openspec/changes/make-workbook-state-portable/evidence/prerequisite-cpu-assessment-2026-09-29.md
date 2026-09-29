# Prerequisite: CPU acceptance for the gateway/Durable Object topology (task 1.4)

Date: 2026-09-29. Scope: resolve CPU acceptance for the gateway → Durable
Object topology against the **unchanged** read/preview thresholds of the
amended experiment contract
([experiment-contract.md](../../archive/2026-09-29-validate-worker-backend-feasibility/evidence/experiment-contract.md),
amendment 2026-09-27), quoted verbatim:

> | Object read CPU | Warm p99 ≤ 500 ms; **every** measured request including cold
> ≤ 1,000 ms … Attributed to the host script / object namespace. |
> | Object preview CPU | Warm p99 ≤ 3,000 ms; **every** measured request
> including cold ≤ 5,000 ms. Same attribution. |

Task 1.4 records as a measured gap that both archived verdicts
([verdict-2026-09-28.md](../../archive/2026-09-29-validate-worker-backend-feasibility/evidence/verdict-2026-09-28.md),
[verdict-2026-09-29.md](../../archive/2026-09-29-accelerate-schedule-preview/evidence/verdict-2026-09-29.md))
state "**DO per-request CPU quantiles** are not published" and evaluate object CPU
from per-minute aggregate sums plus wall bounds. **That statement is wrong for
the dataset the collector actually queried.**
`durableObjectsInvocationsAdaptiveGroups` publishes per-invocation CPU
quantiles (`cpuTimeP25…cpuTimeP999`), per-invocation wall quantiles and exact
per-bucket maxima (`max { wallTime responseBodySize }`). The archived collector
selected only `sum { requests errors }` and `dimensions { datetime namespaceId }`
from it (`scripts/staging/collect-metrics.mjs`). This assessment reads the full
field shape and computes the gate statistics from attributed per-invocation
records.

Dispositions, one line each, with the population each rests on:

| Gate | Disposition | Statistic (population) |
| --- | --- | --- |
| Object read CPU warm p99 ≤ 500 ms | **met** | max bucket p99 **124.5 ms** as the conservative pooled-p99 upper bound, over 1,241 success read requests / 523 buckets (2026-09-28 window) |
| Every measured read request incl. cold ≤ 1,000 ms | **met** | largest exact single-request read CPU **124.5 ms**; per-bucket `min(cpuTimeP999, max wall)` bound **124.5 ms** over the same 1,241 requests; 4 served cold reads ≤ 98.5 ms |
| Object preview CPU warm p99 ≤ 3,000 ms | **met** (9.2% headroom) | max bucket p99 **2,724.4 ms** as the upper bound, over 490 success **optimized** preview requests / 321 buckets (2026-09-29 window) |
| Every measured preview request incl. cold ≤ 5,000 ms | **met** | per-bucket CPU bound **2,724.4 ms**; quantile-free wall bound **4,085.4 ms**; 10 genuine optimized cold previews 84.9–891.9 ms (exact) |

Two caveats carry the dispositions, and both are stated again in
[Not established](#not-established): the **direct** campaign p99 is not
derivable for either operation (exact single-request coverage is 10.2% for
reads and 51.4% for optimized previews, below the archived collector's 90%
derivation rule), and the preview gate passes on an **upper bound** that is only
9.2% below the threshold, not on a measured campaign percentile.

## Measurement sources and reproduction

Read-only Cloudflare GraphQL Analytics (`POST /client/v4/graphql`), filtered by
the staging Durable Object namespace recorded in the private staging manifest
and by an explicit window. The analytics API refuses a selection of more than
30 fields per account, so the statistics query is split into two selections over
the same window and joined on `(datetime, objectId, scriptVersion, status)`.

```graphql
# (A) sums and exact per-bucket extremes
durableObjectsInvocationsAdaptiveGroups(
  limit: 1000,
  filter: {datetime_geq: "<since>", datetime_leq: "<until>", namespaceId_in: ["<namespace>"]}
) {
  sum { requests errors wallTime responseBodySize }
  max { wallTime responseBodySize datetime }
  min { wallTime responseBodySize }
  dimensions { datetime objectId scriptVersion status type }
}

# (B) per-invocation quantiles, same filter
durableObjectsInvocationsAdaptiveGroups(
  limit: 1000,
  filter: {datetime_geq: "<since>", datetime_leq: "<until>", namespaceId_in: ["<namespace>"]}
) {
  quantiles {
    cpuTimeP25 cpuTimeP50 cpuTimeP75 cpuTimeP90 cpuTimeP95 cpuTimeP99 cpuTimeP999
    responseBodySizeP50 responseBodySizeP99
    wallTimeP50 wallTimeP90 wallTimeP99 wallTimeP999
  }
  dimensions { datetime objectId scriptVersion status type }
}

# (C) truncation check: hourly slices, full dimensions
durableObjectsInvocationsAdaptiveGroups(
  limit: 1000,
  filter: {datetime_geq: "<slice since>", datetime_leq: "<slice until>", namespaceId_in: ["<namespace>"]}
) {
  sum { requests errors wallTime responseBodySize }
  quantiles { cpuTimeP25 cpuTimeP50 cpuTimeP75 cpuTimeP90 cpuTimeP95 cpuTimeP99 cpuTimeP999
              responseBodySizeP50 wallTimeP50 wallTimeP90 wallTimeP99 }
  dimensions { datetime namespaceId objectId scriptName scriptVersion status type }
}

# (D) unit cross-check and dataset inventory
durableObjectsPeriodicGroups(
  limit: 1000,
  filter: {datetime_geq: "<since>", datetime_leq: "<until>", namespaceId_in: ["<namespace>"]}
) { sum { cpuTime duration activeTime } quantiles { memoryUsageBytesP50 memoryUsageBytesP99 }
    dimensions { datetime namespaceId } }
```

Schema facts verified by introspection on 2026-09-29 (`__type` on
`AccountDurableObjectsInvocationsAdaptiveGroups*`): the group exposes
`sum`, `max`, `min`, `quantiles`, `dimensions`; `sum` is exactly
`{errors, requests, responseBodySize, wallTime}` (no CPU — CPU is quantile-only);
`max` is exactly `{datetime, responseBodySize, wallTime}`; the filter input
supports `namespaceId_in`, `objectId_in`, `scriptName_in`, `status_in` and
`datetime_geq/leq`. `dimensions.datetime` is a **one-second** bucket.

Windows, slices and populations:

| Window | Slices (limit 1000 each) | Rows | Requests | Role |
| --- | --- | ---: | ---: | --- |
| 2026-09-28T04:00:00Z–07:00:00Z | 3 hourly | 629 | 1,503 | read campaign + pre-optimization preview |
| 2026-09-29T07:00:00Z–19:00:00Z | 12 hourly | 336 | 571 | optimized-preview campaign |

Private raw captures (gitignored, never committed): the two dumps named in the
task (`staging-local/raw-do-invocations-{do-campaign,preview-campaign}-2026-09-29T20-1*.json`),
the fresh full-shape capture `staging-local/raw-do-invocations-rich-2026-09-29T20-25-00Z.json`
(queries A+B), the fresh hourly-slice capture
`staging-local/raw-do-invocations-fullslice-2026-09-29T20-18-29-687Z.json`
(query C, plus D and the introspection dump), the analysis script
`staging-local/cpu-assessment/analyze-cpu-assessment.py`, and its output
`staging-local/cpu-assessment/analysis-output.json`. A verifier re-runs the
script against the captures, or re-issues A–D with the window table above; no
result below depends on a query that was not re-issued on 2026-09-29.

### Units

Both datasets report **microseconds**, established from the data rather than
assumed:

* The 70-second interval 2026-09-29T17:37:50Z–17:39:00Z contains exactly the 30
  retained attempts of the `gateway #4` run (20 burst + 10 sustained; the
  platform invocation records match 30↔30). `durableObjectsPeriodicGroups`
  reports `sum.cpuTime` 9,758,886 µs = 9.759 s for that interval — the same
  9.759 s the archived preview verdict records for it. (The verdict divided it
  by 20, the burst size; the interval holds 30 requests, so its "≈488 ms per
  larger burst preview" overstates the per-request average, which is ≈325 ms
  over the 30. Neither figure is a p99, and no disposition below uses either.)
* `wallTime` values reach 37,260,840 µs = 37.26 s in the killed-preview buckets,
  matching the ~37 s platform per-request wall cap the 2026-09-28 verdict
  records; millisecond units would put a single invocation at 10.4 hours.
* Periodic `duration` (GB-s) and `activeTime` (µs) are the task 1.5 dimension
  and are not analysed here beyond this cross-check.

## Attribution and coverage

**Attribution is clean in both windows.** Every row names
`volunteer-scheduling-staging-host`, one namespace (the staging namespace in the
private manifest), `type: http`, and one of **two** object ids — the two
configured synthetic workbooks. There are zero `__unknown__` script rows, zero
foreign-namespace rows and zero foreign-object rows, so no gate is
"ambiguously attributed" in the contract's sense. Window 1: 629 rows, 1,503
requests, 10 errors, 8 script versions, statuses `success` 1,493 requests (623
rows) + `exceededResources` 10 requests (6 rows). Window 2: 336 rows, 571
requests, 0 errors, 10 script versions, all `success`.

The two object ids do **not** map one-to-one onto fixtures across a workbook
switch: the 41 requests of the first larger-fixture run (07:55:49–07:57:49Z)
were served by the object that had been serving the representative fixture,
before the newly configured object took over at 07:59:39Z — the same
version/config lag the archived verdicts record for the object. Attribution here
is therefore by script + namespace + window and by body signature, never by
object id alone.

**Truncation.** No slice returned its 1,000-row limit: window 1 slices returned
308 / 319 / 2 rows, window 2 slices 64 / 138 / 0×8 / 128 / 6 rows; zero slices
were full, so no slice was split and no record set was silently truncated.
Re-querying reproduces the earlier captures exactly: window 1 = 629 rows /
1,503 requests / 10 errors, identical to
`raw-do-invocations-do-campaign-2026-09-29T20-14-21-130Z.json`; window 2 over
the wider 07:00–19:00 window = 336 rows / 571 requests, exactly one row more
than the 335 / 570 of `raw-do-invocations-preview-campaign-2026-09-29T20-15-00-154Z.json`
(whose window was 07:20–18:15). The extra row is **not** part of the campaign:
2026-09-29T07:17:05Z, 1 request, 70-byte body, 3.672 ms wall, 1.809 ms exact
CPU, on the object serving the previous configuration — it precedes the first
2026-09-29 deployment (07:31:51Z) and is excluded from every population below
and reported here instead of dropped.

**Attempt-population coverage.** The runner writes one attempt log per workload
file name, so an earlier run of the same workload overwrites its predecessor —
the same class of bookkeeping loss the 2026-09-29 verdict discloses for its
first larger-fixture run. Retained attempt records therefore cover less than the
platform window:

| Window | Platform requests | Retained attempts in window | Requests inside retained run/cold windows | Requests with no retained attempt record |
| --- | ---: | ---: | ---: | ---: |
| 2026-09-28 | 1,503 | 930 (920 workload + 7 cold + 3 denial-probe) | 932 | 571 |
| 2026-09-29 | 571 | 450 (440 workload + 10 cold) | 408 | 163 |

Where a retained run exists, the join is close to exact: the four
representative-fixture read runs hold exactly 140 platform requests for 140
attempts, and the two representative-fixture preview runs exactly 40 for 40.
Larger-fixture read runs hold 141–144 for 140 attempts (probes and adjacent
requests share the run window), and larger-preview runs hold 39–41 for 40
attempts (the cold attempt and second-boundary effects fall just inside or
outside the window). The 70-second `gateway #4` burst interval holds exactly its
30 attempts. The unmatched requests are not foreign traffic:
they carry campaign body signatures (below) and the pacing of the campaign's
read limiter, and they are **included** in the gate populations rather than
dropped. The 2026-09-28 unmatched set is read-shaped 413 (18,788×142,
12,028×134, 32,518×134, 100×2, 235,472×1), preview-shaped 28, denial-shaped 62
and mixed 68; the 2026-09-29 unmatched set is larger-preview 82 (two 41-request
runs: the overwritten first larger run at 07:55:49–07:57:49, and a
version-lag run at 08:07:50–08:09:15 that the previous object served after the
`host #3` redeploy), 41 expired-credential denials and 40 mixed/other.

**Coverage limits.** Attribution is to the host script and the staging
namespace; it is *not* a per-operation attribution from the platform, which has
no operation dimension. Operation identity rests on the classifier below, and
the campaign's own attempt accounting is not complete (above).

## Classifier: separating reads from previews in one namespace

The dataset has no operation-name dimension. Three independent signals were
used and reconciled.

**Signal 1 — per-request response-body size (primary).** Every retained run
window maps one operation to one body size, and the size is constant for every
request of that operation within a fixture:

| Operation | Representative fixture | Larger fixture |
| --- | ---: | ---: |
| `session.me` | 100 B | 100 B |
| `admin.schedule.read` | 12,028 B | 235,472 B |
| `admin.insights.read` | 18,788 B | 32,518 B |
| `admin.schedule.preview` | 14,096 B | 589,235 B |

A bucket is attributed only when `min.responseBodySize == max.responseBodySize`
(all requests in the one-second bucket returned the same size). A bucket whose
extremes disagree is classified **mixed** and excluded from gate populations but
reported (below). Error and denial envelopes are a separate class and are never
treated as reads: 0 B (killed), 70 B (`NOT_FOUND` — the 404s the verdicts
record for the disabled benchmark route), 104 B (`FORBIDDEN` — matches the three
retained denial probes at 05:39:44/46/47Z), 177 B (`UNAUTHORIZED` — matches the
expired-credential cold and probe traffic), plus 127/150/158/160/265 B that
appear only in denial/verification traffic.

**Signal 2 — wall time against the attempt records.** For every single-request
bucket with exactly one attempt starting in the same second (287 such pairs
across both windows), the platform `max.wallTime` and the harness `durationMs`
agree: median difference −100.0 ms (the harness measures end-to-end, the
platform the invocation), p95 |difference| 245 ms, max |difference| 1,439 ms
after excluding two pairs whose buckets fall in the kill window (05:30:15Z and
05:32:44Z), where a killed preview shares its second with an unrelated attempt.
The two signals therefore identify the same requests, not merely the same
totals.

**Signal 3 — deployment windows.** The `POST /benchmark/schedule-preview` route
was enabled only between the approved host redeployments recorded in
`staging-local/deployment-preview-host-*.json` (07:31:51Z–18:02:02Z on
2026-09-29) and `staging-local/deployment-staging-host-*.json` (04:11:06Z–
05:44:34Z on 2026-09-28). Every bucket the classifier calls a preview lies
inside an enabled interval; no preview-shaped body appears outside one, and no
read-shaped body appears inside a preview-only run window except two
32,518-byte larger-insights reads in the single 05:30:14Z bucket, interleaved
with the 05:30:15Z preview burst.

**Classifier error rate.** Over the 1,387 requests inside retained run windows,
1,345 (97.0%) carry the run's operation signature, 2 do not, 29 are in mixed
buckets and 11 are non-operation bodies (the 10 kills and one denial). The
single read-into-preview-run interleave above is the only class contradiction
in either window: **2 of 1,387 in-window requests (0.14%)**, and both are
correctly read-shaped requests rather than misclassifications. The residual risk
is not misclassification but *unclassifiable* records, counted next.

**Rows not classified (never dropped):**

* **Mixed buckets — 15 rows / 88 requests (2026-09-28) and 4 rows / 29 requests
  (2026-09-29).** The only preview-bearing row is 05:30:15Z (4 requests: three
  589,235-byte previews plus one 32,518-byte insights read, `cpuTimeP99` 32.5 s).
  The other 2026-09-28 rows mix a denial or verification body with a read body
  (104..116, 100..235,472, 141..12,028, 150..32,518, 70..177 and similar); the
  2026-09-29 rows are the pre/post-campaign verification and denial buckets at
  07:20:57Z and 18:01:27–18:02:12Z. Their requests are excluded from both gate
  populations; their per-bucket statistics are recorded in
  `analysis-output.json`.
* **Non-operation bodies — 39 rows / 78 requests (2026-09-28: 177×45, 104×17,
  0×10, 70×5, 158×1) and 9 rows / 48 requests (2026-09-29: 177×41, 127×4,
  70×2, 160×1).** These are denials, disabled-route 404s and killed requests.
  They are CPU-cheap (the 177-byte UNAUTHORIZED cold is 8.9 ms) but they are not
  attributed to a read or preview population.
* **Non-success rows — 6 rows / 10 requests, all `exceededResources`, all
  2026-09-28T05:30:15Z–05:32:44Z, all zero-length bodies, walls 0.258 ms–37.26 s,
  `cpuTimeP99` up to 32.5 s in the 3-request bucket at 05:30:53Z.** These are
  the recorded larger-preview wall-cap kills (the 2026-09-28 verdict: "10
  requests killed at ~37 s, gateway 503, no correlation id, zero reads"). Their
  zero-length bodies are exactly why the classifier must exclude non-success
  rows explicitly: a size-only classifier would file them as identity reads and
  then report a 32.5 s "read". They are excluded from both gate populations and
  reported here as the attributed kills they are.

## Read CPU (gates 1 and 2)

Population: the 1,241 `success` read requests of the 2026-09-28 window (523
buckets) — larger fixture 403 (235,472×137 + 32,518×266), representative fixture
556 (12,028×274 + 18,788×282), `session.me` 282 (100 B, both fixtures) — plus
the 4 verification reads of the 2026-09-29 window.

| Statistic | Value | Basis |
| --- | ---: | --- |
| Exact single-request samples | 127 of 1,241 (**10.2%** coverage) | `sum.requests == 1`, all quantiles equal |
| Exact-sample p50 / p90 / p99 / max | 10.7 / 50.7 / **102.9** / **124.5 ms** | nearest-rank over the 127 samples |
| Campaign percentile derivable? | **No** | sample count 127 ≥ 30, but coverage 10.2% < 90%: the archived collector's rule withholds it |
| Max bucket p99 (pooled-p99 upper bound) | **124.5 ms** @05:06:11Z | 396 multi-request buckets carry 1,114 requests |
| Max bucket p999 | 124.5 ms | same bucket |
| Per-bucket `min(cpuTimeP999, max wall)` bound | **124.5 ms** | rigorous for every request in the population |
| Max exact wall in the population | 1,096.8 ms @05:46:13Z | single-request bucket → exact CPU 38.5 ms |

Per fixture the upper bound is 124.5 ms (larger), 56.4 ms (representative) and
18.8 ms (`session.me`); the 2026-09-29 verification reads bound at 110.1 ms.
Removing the mapped cold seconds leaves the warm statistics unchanged
(1,239 requests, same 124.5 ms bound).

**The pooled-p99 upper bound is the defensible statistic here, not a campaign
p99.** Justification, in one paragraph: a published bucket p99 is by definition
a value that at most 1% of *that bucket's* samples exceed, and bucket quantiles
are never rescaled by request counts. Therefore the number of pooled requests
exceeding `max_b(p99_b)` is at most `Σ_b 0.01·n_b = 0.01·N`, so the pooled p99 —
the smallest value at or below which 99% of the pooled population lies — cannot
exceed the maximum of the bucket p99s. That makes 124.5 ms an upper bound on the
pooled read p99, not the pooled read p99 itself; it is labelled as an upper
bound everywhere in this file and must not be quoted as the campaign percentile.
The bound assumes each published bucket p99 is an upper bound on 99% of its own
samples, per its published definition; the quantile-free alternative is the wall
bound, reported separately.

**Disposition, gate 1 (warm p99 ≤ 500 ms): met.** Every candidate statistic —
the exact-sample p99 (102.9 ms), the exact-sample max (124.5 ms) and the
conservative pooled-p99 upper bound (124.5 ms) — is at least 4× under the
threshold, on a 1,241-request attributed population. This is an upper bound
argument, not a measured campaign p99.

**Disposition, gate 2 (every measured request including cold ≤ 1,000 ms):
met on the CPU records.** The largest exact single-request read CPU is 124.5 ms
and the per-bucket `min(cpuTimeP999, max wall)` bound over all 1,241 requests is
the same 124.5 ms. The strongest quantile-free bound — CPU cannot exceed a
request's own wall time — is the population's maximum wall, 1,096.8 ms, which
taken alone would **not** establish a 1,000 ms CPU gate; it is reported only as
a bound, and the request carrying it is a single-request bucket whose exact CPU
is 38.5 ms. Cold reads are covered separately below.

## Preview CPU (gates 3 and 4)

**The gate population is the optimized computation only.** The optimization
under test landed before the 2026-09-29 campaign; every 2026-09-28 preview is
the pre-optimization build, and the two are never pooled. The era assignment is
confirmed by the data itself: the larger-fixture exact preview samples have
p50 8,476 ms / max 9,457 ms on 2026-09-28 and p50 456 ms / max 2,137 ms on
2026-09-29.

Population: the 490 `success` preview requests of the 2026-09-29 window (321
buckets) — larger fixture 409 (589,235 B), representative fixture 81 (14,096 B)
— including the 82 requests of the two runs with no retained attempt log.

| Statistic | Value | Basis |
| --- | ---: | --- |
| Exact single-request samples | 252 of 490 (**51.4%** coverage) | larger 249, representative 3 |
| Exact-sample p50 / p90 / p99 / max | 454.0 / 599.1 / **1,229.6** / **2,137.1 ms** | nearest-rank over the 252 samples |
| Campaign percentile derivable? | **No** | coverage 51.4% < 90% |
| Max bucket p99 (pooled-p99 upper bound) | **2,724.4 ms** @17:48:07Z | 69 multi-request buckets carry 238 requests |
| Max bucket p999 | 2,724.4 ms | same bucket |
| Per-bucket `min(cpuTimeP999, max wall)` bound | **2,724.4 ms** | rigorous for every request in the population |
| Max exact wall in the population | **4,085.4 ms** @17:48:02Z | quantile-free bound; CPU ≤ wall for each request |

Per fixture the upper bound is 2,724.4 ms (larger, 409 requests) and 146.5 ms
(representative, 81 requests). Removing the ten mapped cold seconds leaves the
warm statistics unchanged (480 requests, same 2,724.4 ms bound).

**Disposition, gate 3 (warm p99 ≤ 3,000 ms): met, with 9.2% headroom, on the
upper bound.** The same one-paragraph argument as for reads applies: at most 1%
of each bucket exceeds its own p99, so at most 1% of the pooled population
exceeds 2,724.4 ms, which is therefore an upper bound on the pooled p99. It is
labelled an upper bound, not the campaign p99; the direct p99 is not derivable
at 51.4% exact coverage. Because the margin is only 9.2%, this gate is the
sensitive one: a reviewer should treat it as "met on the strongest available
bound", not as a comfortable pass.

**Disposition, gate 4 (every measured request including cold ≤ 5,000 ms):
met.** The per-bucket CPU bound is 2,724.4 ms; independently, the quantile-free
wall bound is 4,085.4 ms, and since CPU ≤ wall for every request the largest
measured optimized preview cannot have exceeded 4,085.4 ms CPU even if it used
its whole wall time. Cold previews are exact and separately below.

**Historical (pre-optimization) preview population — reported, not pooled, not
used for any disposition.** 2026-09-28: 96 success preview requests (52
buckets; larger 28, representative 68), 28 exact samples (29.2%), exact-sample
p99 9,457.2 ms, max bucket p99 **32,500 ms**, per-bucket CPU bound 32,500 ms,
max wall 37,140 ms — plus 3 further larger previews inside the 05:30:15Z mixed
bucket and the 10 killed requests of the previous section. On this population
the pre-optimization build fails both preview CPU gates, which is what the
2026-09-28 verdict records as no-go and the 2026-09-29 campaign supersedes.

## Cold observations

Every cold attempt was mapped to its individually approved deployment report
(field `deployedAt`, plus `target` and `benchmarkEnabled`; the reports are
`staging-local/deployment-*.json`) and to the platform bucket at its start
second. Where a bucket holds one request, all quantiles are equal and the CPU
figure is that request's **exact** CPU.

2026-09-28 (seven approved redeploy cycles; `staging-local/do-cold-attempts.jsonl`):

| Cycle | Deployment report (`deployedAt`) | Operation | Result | Exact CPU | Platform wall |
| --- | --- | --- | --- | ---: | ---: |
| 1 | `deployment-staging-host.json` 04:09:22.585Z + `…-gateway.json` 04:09:29.128Z | `session.me` | 200 `UNAUTHORIZED`, 0 reads | **8.9 ms** | 62.1 ms |
| 2 | `deployment-staging-gateway-c1.json` 04:10:31.662Z | `admin.schedule.preview` | 404 benchmark disabled | **2.4 ms** | 3.9 ms |
| 3 | `deployment-staging-gateway-c2.json` 04:11:14.949Z (+ `…-host-benchmark.json` 04:11:06.602Z) | `admin.schedule.preview` | 404, object still on the previous version | **0.6 ms** | 2.0 ms |
| 4 | `deployment-staging-host-fix.json` 04:39:50.027Z + `…-gateway-fix.json` 04:39:53.876Z | `session.me` | 200, 1 read | **14.8 ms** | 553.0 ms |
| 5 | `deployment-staging-host-larger.json` 04:59:31.949Z + `…-gateway-larger.json` 04:59:35.629Z | `admin.schedule.read` | 200, 2 reads (larger fixture first activation) | **98.5 ms** (see note) | 645.7 ms |
| 6 | `deployment-staging-host-cold6.json` 05:40:17.029Z + `…-gateway-cold6.json` 05:40:20.809Z | `admin.insights.read` | 200, 2 reads | **36.7 ms** | 723.1 ms |
| 7 | `deployment-staging-host-cold7.json` 05:42:20.731Z + `…-gateway-cold7.json` 05:42:23.885Z | `admin.schedule.preview` | 200, 2 reads | **9,457.2 ms** | 11,637.4 ms |
| final | `deployment-staging-host-final.json` 05:44:34.574Z + `…-gateway-final.json` 05:44:38.014Z | `admin.schedule.read` | 200, first request after the redeploy | **38.5 ms** | 1,096.8 ms |

Note on cycle 5: its recorded `startedAt` is exactly 05:00:30.000Z (a rounded,
backfilled timestamp), so no bucket exists in that second and the join fails on
time. The candidate identified by ordering — the only larger-fixture
`admin.schedule.read` between that deployment and the next run — is the
single-request bucket at 05:01:53Z, wall 645.7 ms, exact CPU 98.5 ms. The
verdict's 878 ms attempt wall is the end-to-end measurement, consistent with the
platform's 645.7 ms invocation wall. This is an identified join gap, not a
silent substitution.

2026-09-29 (ten genuine colds, each the first attempt after its approved
redeployment, matching the archived verdict table row for row):

| # | Deployment report (`deployedAt`) | Operation | Exact CPU | Platform wall | Archived attempt wall |
| --- | --- | --- | ---: | ---: | ---: |
| 1 | `deployment-preview-host-1.json` 07:31:51.592Z | preview, representative | **84.9 ms** | 1,037.4 ms | 1,339 ms |
| 2 | `deployment-preview-host-2.json` 07:55:35.347Z | preview, larger | **567.1 ms** | 2,417.7 ms | 2,653 ms (attempt log overwritten) |
| 3 | `deployment-preview-gateway-1.json` 07:59:20.104Z | preview, larger | **537.8 ms** | 1,171.0 ms | 1,523 ms |
| 4 | `deployment-preview-gateway-2.json` 08:02:52.481Z | preview, larger | **491.8 ms** | 1,370.7 ms | 1,653 ms |
| 5 | `deployment-preview-gateway-3.json` 08:05:14.662Z | preview, larger | **390.0 ms** | 904.6 ms | 1,110 ms |
| 6 | `deployment-preview-host-3.json` 08:07:43.746Z | preview, larger | **471.4 ms** | 1,124.7 ms | 1,290 ms (after a 41-request version-lag run) |
| 7 | `deployment-preview-gateway-4.json` 17:33:45.205Z | preview, larger | **891.9 ms** | 1,547.9 ms | 2,562 ms (after 41 expired-credential attempts) |
| 8 | `deployment-preview-gateway-5.json` 17:41:44.356Z | preview, larger | **524.0 ms** | 1,183.2 ms | 1,462 ms |
| 9 | `deployment-preview-host-4.json` 17:44:45.563Z | preview, larger | **589.1 ms** | 1,282.6 ms | 2,223 ms |
| 10 | `deployment-preview-host-5.json` 17:47:50.265Z | preview, larger | **677.9 ms** | 1,422.4 ms | 1,637 ms |

Cold coverage by operation:

* **Preview: 10 genuine optimized colds (≥ 5), all exact, 84.9–891.9 ms** →
  cold preview CPU is evaluated and passes the 5,000 ms absolute limit with
  ≥ 5.6× headroom. The 2026-09-28 cycle-7 cold preview (9,457.2 ms, exact)
  belongs to the pre-optimization build, fails the same limit, and is part of
  the historical population only.
* **Read: 4 served cold-path reads (≥ 1 per read operation, but < 5).**
  `session.me` 14.8 ms (cycle 4), `admin.schedule.read` 98.5 ms (cycle 5),
  `admin.insights.read` 36.7 ms (cycle 6), plus the first request after the
  final redeployment 38.5 ms; the cycle-1 cold `session.me` is a denied
  (`UNAUTHORIZED`) cold path at 8.9 ms. Every measured cold read is ≤ 98.5 ms,
  so the absolute cold read limit is satisfied by every observation — but the
  population is below the contract's ≥ 5 cold observations, so **cold read CPU
  is not evaluated as a distribution** and no cold read percentile exists.
* The archived campaigns' ≥ 5 counts are per topology (5 host + 6 gateway
  colds on 2026-09-28; 5 + 5 on 2026-09-29), not per operation. Reads have
  cold coverage; they do not have a cold *population*.

## Not established

1. **Direct campaign p99 for reads and for optimized previews.** Exact
   single-request coverage is 10.2% and 51.4%, below the archived collector's
   90% rule, so no percentile of the pooled population is computed. What would
   establish it: a campaign protocol that spaces requests so each one-second
   bucket holds a single invocation (the amendment already prescribes this for
   cold sequences), or a per-invocation CPU export; either would raise exact
   coverage above 90% and make a genuine pooled p99 computable.
2. **Cold read CPU as a distribution.** Four served cold reads (three
   operations, one repeat) are below the ≥ 5 requirement. What would establish
   it: five individually approved read redeployments, or a mixed cold sequence
   covering reads five times.
3. **Per-request CPU inside multi-request buckets.** 1,114 of 1,241 read
   requests and 238 of 490 optimized preview requests share their second with
   another request; their CPU is bounded, never exact.
4. **Operation identity for 571 (2026-09-28) and 163 (2026-09-29) platform
   requests with no retained attempt record**, and for the 117 mixed-bucket
   requests. Identity rests on the body-size signature and the deployment
   windows; the classifier's in-window contradiction rate is 2/1,387 (0.14%),
   which bounds but does not eliminate this risk.
5. **The 126 non-operation-body requests** (denials, disabled-route 404s) and
   the 10 killed requests have no operation population; their CPU is reported
   only where a bucket holds a single request.
6. **The archived verdicts' CPU figures are not reproduced as such.** "≈488 ms
   per larger burst preview" is an aggregate average over a 30-request interval
   (not 20) and is not a p99; the 2026-09-28 "≈7.5 s CPU each" is likewise an
   aggregate. This assessment does not rely on either.
7. Out of scope here: billable duration (task 1.5), the attributed 503/JWKS
   condition (task 1.6), wall-time gates, memory, quota and correctness.

## What a reviewer can and cannot conclude

**Can conclude.** (a) The dataset that the archived collector under-read does
publish per-invocation CPU, so the "no per-request CPU quantiles" gap in both
verdicts is closed by re-querying, with clean attribution to the host script and
the staging namespace and no truncation. (b) On 1,241 attributed read requests,
the conservative pooled-p99 upper bound is 124.5 ms and the largest exact read
CPU is 124.5 ms — the read CPU gates pass with wide margin, and every measured
cold read (≤ 98.5 ms) passes the absolute limit. (c) On 490 attributed optimized
preview requests, the pooled-p99 upper bound is 2,724.4 ms and the quantile-free
wall bound is 4,085.4 ms — both preview CPU gates pass, the warm one with only
9.2% headroom. (d) The pre-optimization preview population fails both preview
gates by a wide margin and is the historical no-go the 2026-09-29 campaign
supersedes.

**Cannot conclude.** (a) That the campaign p99 was measured: it was not; the
gates pass on a max-bucket-p99 upper bound (and, for the absolute limits, on
per-bucket CPU and wall bounds), which is conservative but not a percentile
estimate. (b) That cold read CPU is a resolved distribution: four observations
is below the contract minimum. (c) That every request in the window is
attributed to an operation: 571 + 163 requests have no retained attempt record
and 117 more are in mixed buckets, all reported rather than dropped. (d) That
these numbers transfer to any other fixture, topology, region, concurrency or
workload mix: they describe these two windows, two synthetic fixtures and the
recorded campaign protocols only. (e) That tasks 1.1, 1.5 or 1.6 are resolved
by this file; each has its own evidence.

## Sanitization

This file contains no account id, namespace id, object id, spreadsheet id,
credential, correlation id, email address or raw response body. Identifiers live
in the private staging manifest and in ignored `staging-local/` storage; the
only resource names used are the Cloudflare script names the archived verdicts
already publish (`volunteer-scheduling-staging-host`,
`volunteer-scheduling-staging-gateway`).
