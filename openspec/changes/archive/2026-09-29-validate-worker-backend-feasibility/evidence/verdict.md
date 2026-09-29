# Feasibility verdict — 2026-09-27

Task 4.2 evidence. Dated **go / conditional-go / no-go** decision for replacing
the Apps Script read backend with a Cloudflare Worker, taken from measurements of
the deployed staging slice under the thresholds predeclared in
[the experiment contract](experiment-contract.md). The thresholds were fixed
before any measurement and none was adjusted afterwards.

## Verdict

**No-go for the Worker topology as built.** Production migration stays blocked:
the measured CPU does not fit the free runtime's limit with the headroom the
contract requires, and the failure is in the tail — the first execution of each
decode path and occasional spikes — not in the median.

This is a verdict on *this implementation*, not on Cloudflare Workers in general.
An optimized build and the free Durable Object path were **not** evaluated (task
3.5 is unchecked and any alternative deployment needs its own approval), so a
later experiment with a smaller cold start is not ruled out.

## Topology and versions measured

| Item | Value |
| --- | --- |
| Worker | `volunteer-scheduling-staging`, `usage_model: standard`, Workers **Free** (operator-confirmed), no route, no custom domain |
| Endpoint | `https://volunteer-scheduling-staging.timothyc2371.workers.dev/exec` |
| Runtime | `compatibility_date` 2026-03-10; wrangler 4.141.0; bundle 1304 KiB uncompressed / 237.4 KiB gzip; 13 bindings (2 secrets) |
| Identity | Real Google ID tokens verified against Google's published keys; a read-only service account for Sheets |
| Fixtures | representative: 4 centers / 40 volunteers / 200 availability / 12 exceptions / 20 sessions / 20 assignments / 4 backups / 1 run, 305 rows, digest `aedfec2b…`; larger: 10 / 200 / 1000 / 60 / 400 / 400 / 80 / 4, 2158 rows, digest `fc05ff65…` |
| Workloads | per fixture: 5 cold, 20 at four-way concurrency, 100 sequential — 250 measured requests over 2026-09-27T23:31–23:44Z |

## Measured results against the predeclared thresholds

| Dimension | Threshold | Measured (larger fixture) | Result |
| --- | --- | --- | --- |
| Correctness | parity, negative authorization, unchanged workbook | 38 local test files / 229 tests including the fixed-clock differential; deployed matrix exact (below); snapshot digests stable across repeat reads | **met** |
| CPU headroom | warm p99 ≤ 5.0 ms, warm max ≤ 8.0 ms | warm p50 3.2 ms, p95 16.5 ms, p99 83.6 ms, max 83.6 ms | **not met** |
| Cold CPU | ≤ 10 ms over ≥ **5** observations | **2** genuine cold observations (30.4 ms and 18.5 ms, both exact); the run issued five sequential requests after one deploy, so the rest were already warm | **not evaluated** |
| Runtime-limit outcomes | zero `exceededResources` | zero; every invocation reported `success` | met |
| Wall time | warm p99 ≤ 1500 ms at ≥ 3 in flight | 4 in flight: p95 925 ms, p99 1074 ms; sequential p99 755 ms | **met** |
| Failure rate | zero unexpected failures | 250/250 requests succeeded, zero 429, zero 5xx | **met** |
| Sheets quota | ≤ 2 reads per operation, ≤ 40 reads/min, zero 429 | 1 (`session.me`), 2 (`admin.schedule.read`), 2 (`admin.insights.read`); limiter held the budget; zero 429 | **met** |
| Other headroom | zero `exceededMemory`, ≤ 3 warm / ≤ 5 cold subrequests, ≤ 1000 requests | zero memory errors; 216 subrequests over 125 requests; 250 requests against a 100 000/day cap | **met** |
| Cost | no paid plan enabled | Free plan confirmed by the operator | **met** |

## What passed

* **Behavioral parity.** The three operations return the same projections as the
  existing Apps Script runtime for the same snapshot at a fixed clock, and the
  deployed service returns the designed envelope: `session.me` 1 Sheets read,
  `admin.schedule.read` and `admin.insights.read` 2 each, exactly as the contract
  budgeted.
* **Authorization before hydration, against the deployed service.** An
  administrator gets all three operations; a volunteer gets `session.me` and is
  refused `FORBIDDEN` on both administrator operations **after only the
  authorization-table read** — no domain range is fetched for a denied caller. A
  forged credential is `UNAUTHORIZED` with **zero** Sheets reads.
* **Transport.** Both browser probes report CORS-readable responses, no redirect,
  the response URL equal to the request URL, JSON content type and `no-store`,
  with four requests in flight and 15 attempts each.
* **Direct JSON without the redirect handoff** that motivated the experiment.
* **Zero failures** across every measured request, including 250 paced requests.

## Why the CPU verdict is no-go, and its limits

Warm medians are comfortable: 2.1 ms (representative) and 3.2 ms (larger), both
inside the 5 ms threshold. The distribution has a heavy tail — p95 16.5 ms, p99
83.6 ms on the larger fixture — and the exact single-request samples are the
strongest evidence, because they need no estimation:

| Fixture | Position after the deploy | Operation | CPU (exact) | Wall |
| --- | --- | --- | --- | --- |
| representative | 1st request | `session.me` | 30.4 ms | 950 ms |
| representative | 4th request | `session.me` | 4.1 ms | 301 ms |
| larger | 1st request | `session.me` | 18.5 ms | 1124 ms |
| larger | **2nd request** | `admin.schedule.read` | **110.0 ms** | 605 ms |
| larger | 3rd request | `admin.insights.read` | 18.1 ms | 542 ms |

The 110 ms sample is the decisive one and it is **not** a cold start: the runtime
was already serving the second request of the sequence. It is the first execution
of the full decode path on the larger fixture — 400 sessions, 400 assignments, 200
volunteers, 80 backups and 10 centers through Zod and Temporal — before the JIT has
warmed that path. The decay across the representative sequence (30.4 → 15.6 → 4.1
ms) is the same effect amortising. So the cost that does not fit is **per-request
decode work**, not the transport, not the identity check, and not the isolate's
first evaluation of the bundle alone.

The predeclared rule reads: a workload that misses the CPU threshold is profiled,
then an optimized or free Durable Object topology is evaluated against the same
thresholds, and only then may the verdict be anything other than no-go. Profiling
was done (below); neither alternative was built, because the diagnosis points at
caching decoded state rather than at a different compute topology, and a cache
design belongs to `make-workbook-state-portable`, which owns revisions and
portable state. Task 3.5 stays open and unevaluated.

Two limitations must travel with this verdict:

1. **The per-request CPU attribution is partly estimated.** The analytics dataset
   buckets by second, so a bucket holding one request yields that request's exact
   CPU while a bucket holding several yields a quantile across them; for those the
   value cited is the bucket quantile divided by its request count. Every figure in
   the table above is exact; the burst and sustained tails are estimates and are
   labelled as such wherever they appear.
2. **The cold threshold is not evaluated, not failed.** The contract requires five
   genuine cold observations from successive uploads; this run produced two, so by
   the contract's own rule the dimension is *not evaluated* and the verdict cannot
   be an unconditional go. A future run can settle it by uploading a version per
   observation, as the contract prescribes.
3. **Measured CPU exceeded the documented 10 ms free-plan limit while every
   invocation reported `success`.** That is consistent with the runtime's
   documented rollover allowance for occasional overruns, but it was not
   reconciled from outside the platform, so the tail should be read as "the
   predeclared headroom is absent", not as "requests were failing".

## Profile (where the CPU goes)

Per-operation, larger fixture, from the metric buckets joined to the attempt log:

| Operation | n | CPU p50 | CPU max | Wall p50 | Wall max |
| --- | --- | --- | --- | --- | --- |
| `session.me` | 43 | 1.8 ms | 19.7 ms | 304 ms | 1124 ms |
| `admin.schedule.read` | 42 | 4.6 ms | 127.5 ms | 511 ms | 1074 ms |
| `admin.insights.read` | 38 | 4.6 ms | 30.9 ms | 495 ms | 925 ms |

The two domain reads cost roughly the same in the median and both carry the tail;
`session.me`, which only reads the authorization table, is the cheapest but still
shows a 19.7 ms cold-start maximum. The bundle is 1304 KiB uncompressed, evaluated
in every fresh isolate, which is the most likely single cause of the cold figure
and the first thing an optimization should attack (for example trimming the
imported surface so the scheduling and insights trees, and the Temporal polyfill,
are not all evaluated for a read that needs neither).

## Non-CPU constraints worth carrying forward

* **The Sheets quota, not the Worker, is the throughput ceiling.** Every request
  costs at least one Sheets read as the *same* service account, so the
  60 reads/minute/user limit caps the slice at ~30 requests/minute with no margin
  and ~20/minute with the contract's 2/3 headroom. The measured runs held 41
  reads/minute and never saw a 429, which confirms the derived ceiling rather than
  refuting it. Any production design needs either a cache in front of the reads or
  a different identity model.
* Long-lived staging evidence does not exist yet for the *larger* workload in a
  browser; the transport evidence was captured against the pre-rename deployment
  (same code path, different Worker name).

## What would change the verdict

1. **A revision-keyed cache of the decoded snapshot**, filled only after
   authorization and never covering the `Users` read. This is the change the
   measurements point at: it removes the repeated decode that produced the 110 ms
   sample rather than moving it somewhere else. Falsifiable prediction: warm p50
   stays 2-4 ms while the p99 tail collapses toward the projection cost.
2. **A smaller cold footprint**, if the genuine cold start still matters after
   that. The Worker imports the whole runtime — scheduling, self-service, imports
   and centers included — to serve three read operations.
3. The free Durable Object path remains the task's named alternative, but the
   measurements give it no independent motivation: a Durable Object relocates
   state, it does not make decoding cheaper, and the same cache would be needed
   inside it. Build it only if 1 and 2 fail.

Each needs its own deployment approval, and 1 and 2 are design work that
`make-workbook-state-portable` owns. The finding is recorded there as a design
input.

Until one of those passes, `make-workbook-state-portable` and the four changes
behind it must not proceed on the strength of this experiment.
