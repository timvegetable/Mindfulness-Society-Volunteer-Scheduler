# Prerequisite: free-tier duration and daily consumption (task 1.5)

Date: 2026-09-29. Scope: resolve the free-tier consumption gate for the
gateway/Durable Object topology under the **unchanged** contract thresholds
(amended experiment contract, `archive/2026-09-29-validate-worker-backend-feasibility/evidence/experiment-contract.md`,
amendment 2026-09-27):

> Free-tier consumption: campaign ≤ 1,000 browser/API attempts; measured daily
> consumption plus 100/500/1,000-per-day projections stay ≤ 50% of current
> request and duration allowances; no paid plan.

This assessment corrects one recorded gap. Both archived verdicts state that
billable duration (GB-s) "is not published by the DO datasets" and left the
duration gate evaluated by wall-clock estimates only. The field **is**
published: `durableObjectsPeriodicGroups.sum.duration`, in the same dataset the
archived collector already queried for object CPU and memory. The collector
selected only `sum { cpuTime }` and the memory quantiles, so the duration series
was never read. The measurements below are platform-published, not derived from
wall-clock estimates.

## Measurement sources and units

Read-only Cloudflare GraphQL Analytics queries, namespace- and window-filtered:

```graphql
durableObjectsPeriodicGroups(
  filter: {datetime_geq: $since, datetime_leq: $until, namespaceId_in: [$namespace]}
) { sum { duration activeTime cpuTime subrequests } }
durableObjectsInvocationsAdaptiveGroups(
  filter: {datetime_geq: $since, datetime_leq: $until, namespaceId_in: [$namespace]}
) { sum { requests } }
```

Raw responses are retained in ignored private storage
(`staging-local/raw-do-periodic-*-2026-09-29T20-1*.json`,
`staging-local/raw-do-invocations-*-2026-09-29T20-1*.json`). The namespace and
account identifiers are recorded in the private staging manifest, not here.

Unit determination, from the data itself rather than from an assumption:

- Every periodic row in both campaign windows reports
  `duration / (activeTime / 1e6) = 0.128000` exactly (142 rows, minimum equals
  maximum). The documented billing conversion is "each billed duration counts
  128 MB of resident memory"
  (`archive/2026-09-29-validate-worker-backend-feasibility/evidence/platform-limits-2026-09-24.md`,
  quoting the Durable Objects pricing page fetched 2026-09-27). 0.128 GB per
  active second is that conversion, so `sum.duration` is the billed duration in
  GB-s and `sum.activeTime` is active wall-clock microseconds.
- `sum.cpuTime` is microseconds on the same basis the archived collector
  documented: the burst window 2026-09-29T17:37:50Z–17:39:00Z reports
  9,758,886 µs, the same 9.759 s the archived preview verdict recorded for that
  window's 20 preview requests.

## Measured consumption

| Population | Window (UTC) | DO requests | Duration (GB-s) | Active time (s) | CPU time (s) |
| --- | --- | ---: | ---: | ---: | ---: |
| Durable Object read campaign | 2026-09-28T04:00–07:00 | 1,503 | 95.144 | 743.3 | 340.1 |
| Optimized-preview campaign | 2026-09-29T07:20–18:15 | 570 | 47.622 | 372.0 | 192.7 |
| Whole UTC day 2026-09-28 | 00:00–24:00 | 1,503 | 95.144 | 743.3 | 340.1 |
| Whole UTC day 2026-09-29 | 00:00–24:00 | 571 | 47.622 | 372.0 | 192.7 |

The whole-day figures include the campaign windows: all Durable Object activity
on those days was campaign activity. Gateway invocations recorded by the Workers
dataset are 1,502 (2026-09-28) and 564 (2026-09-29) for the same days, matching
the object request counts within edge-timing noise; the staging account carries
only the staging scripts.

Against the Workers Free allowances (100,000 requests/day; 13,000 GB-s/day):

| Day | DO requests | Share of request allowance | Duration | Share of duration allowance |
| --- | ---: | ---: | ---: | ---: |
| 2026-09-28 | 1,503 | 1.50% | 95.144 GB-s | 0.732% |
| 2026-09-29 | 571 | 0.571% | 47.622 GB-s | 0.366% |

No paid plan was used at any point, and the topology's storage usage is
unbilled: it performs no Durable Object storage writes.

## Daily projections

Measured duration cost per request: 0.06330 GB-s (2026-09-28, read-only
workload) and 0.08340 GB-s (2026-09-29, preview-heavy workload). The table uses
the larger preview-day figure, so the request projections below are the
conservative pair for a workload matching the heaviest measured mix.

| Requests/day | Duration (GB-s/day) | Share of 13,000 GB-s | Requests | Share of 100,000 requests |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 8.34 | 0.064% | 100 | 0.10% |
| 500 | 41.70 | 0.321% | 500 | 0.50% |
| 1,000 | 83.40 | 0.642% | 1,000 | 1.00% |

Using the read-day figure instead gives 6.33 / 31.65 / 63.30 GB-s per day
(0.049% / 0.243% / 0.487%). Both sets are two orders of magnitude under the
contract's ≤ 50% projection ceiling.

Campaign attempt consumption against the predeclared ≤ 1,000-attempt cap is
unchanged from the archived records: 1,503 object requests in the read campaign
(the recorded ~120-attempt overage deviation stands) and 570 in the preview
campaign.

## Disposition

**Met**, with the following scope stated so a reviewer can judge it:

- Measured, platform-published: request counts, billable duration, active time,
  CPU time, per day and per campaign window, attributed to the staging Durable
  Object namespace and bounded to explicit UTC windows.
- Measured: no paid plan, no storage-write billing surface.
- Derived by arithmetic from measured values: the per-request duration cost and
  the 100/500/1,000-per-day projections. The arithmetic and its inputs are in
  the tables above.
- Not claimed: the Workers script duration series is not part of this
  measurement (Workers Free does not meter script duration in GB-s), and no
  account-usage export was consulted.

## Not established

- Consumption outside the two measured days is not estimated, because neither
  campaign produced it. The 100/500/1,000-per-day projections are the contract's
  stated substitute.
- The Worker-hours/GB-s accounting of a production deployment that keeps objects
  active outside request windows is not measured; the staging objects were
  idle-evicted between campaigns, which is why active time tracks request
  activity in the tables above.
