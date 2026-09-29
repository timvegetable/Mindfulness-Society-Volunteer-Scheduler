# Task 1.6 attribution capture — 2026-09-29

This completes the classification in
[the 503 classification](prerequisite-503-classification-2026-09-29.md) by
executing the read-only attribution capture that assessment names as its
first closing option: the platform's own invocation records for the failing
window. It is a collection, not a deployment: one namespace- and
script-filtered Cloudflare GraphQL Analytics query, no `wrangler` command, no
mutation, no Google access.

## Query and result

```graphql
workersInvocationsAdaptive(
  filter: {datetime_geq: "2026-09-29T17:47:40Z", datetime_leq: "2026-09-29T17:48:20Z",
           scriptName_in: ["volunteer-scheduling-staging-gateway"]},
  orderBy: [datetime_ASC]
) { sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 }
    dimensions { datetime status scriptName } }
```

Raw response retained in ignored private storage
(`staging-local/gateway-attribution-window-*.json`).

| Second (UTC) | Gateway requests | Errors | Subrequests | Status |
| --- | ---: | ---: | ---: | --- |
| 17:47:57 | 1 | 0 | 1 | success |
| 17:47:59 | 4 | 0 | 4 | success |
| **17:48:02** | **5** | **0** | **5** | **success** |
| 17:48:05 | 1 | 0 | 1 | success |
| 17:48:06 | 3 | 0 | 3 | success |
| 17:48:08, 17:48:10, 17:48:11, 17:48:13 | 1, 3, 1, 1 | 0 | same | success |

The same query filtered to the host script returns **no rows** for the window,
because the host's object traffic is recorded in the Durable Object namespace
dataset, not in the script's own invocation series.

The object namespace dataset for the same second records **4** requests
(CPU p99 2,360,140 µs, wall p99 4,085,382 µs), against the five gateway
dispatches.

## What this establishes

1. **The failing request was served by the gateway script.** Five gateway
   invocations are recorded at 17:48:02Z, matching the run's five in-flight
   attempts at that second, each with exactly one attempted subrequest and a
   successful invocation outcome.
2. **The object never served it.** Five dispatches, four object requests. The
   shortfall is the failing attempt, and it is a lower bound: unrecorded
   traffic would widen the gap, not close it.
3. **The response came from the gateway's own failure path.** A host- or
   object-produced `UNAVAILABLE` envelope would have carried the
   `X-Staging-Correlation-Id` header the gateway adds to every response it
   forwards, and the host marker it sets on every response it serves. The
   retained attempt record has neither, while 40 of the run's 41 attempts carry
   both, so the absence is a property of that response.
4. **The mechanism named by the archived verdict is not supported.** A key-set
   failure is an object-served path that returns HTTP 200 with an envelope,
   the host marker and a correlation id; it cannot produce this response shape.
   The recorded event is a platform-level failure of the cross-script object
   dispatch, inside the post-redeploy propagation window: the approved host
   deployment was 11.885 s earlier, and the deploy procedure's two
   `wrangler secret put` operations at 17:47:55.9Z and 17:47:57.6Z each upload
   a further script version, 0.5 s before the cold attempt and 4.5 s before the
   failure.

## What remains open

- **The thrown error message.** The gateway logs it, but Workers Logs are not
  exposed by the GraphQL schema this account can query (only account-level
  audit datasets are), and no log capture was retained from the campaign. The
  dashboard's Workers Logs view, if enabled and still inside retention, is the
  only route to it. This does not change the attribution above; it would name
  the platform error.
- **Whether the object was invoked and its record dropped, or the dispatch was
  refused before delivery.** The record shows only that no object request was
  served.
- **The rate.** One occurrence in the campaign's larger-workload burst
  attempts, with no recurrence in the later retained traffic. That is not a
  rate estimate.

## Classification and disposition

Under the predeclared failure rules, the event is a retained `5xx`, counted in
the `5xx` category, never retried, and not a submitted negative-path probe. It
is now **attributed to the platform's cross-script dispatch seam during a
version-propagation window**, with the failing script (gateway), the
deployment, the bounded window and the exclusion of the object each supported
by platform records. The specific platform error is not retained.

That makes the reliability row **met under the predeclared attribution rules**
with one retained, attributed failure — the same disposition the archived
verdict recorded, but on a corrected and now-supported mechanism rather than
the JWKS failed-load window, which the record refutes.

No repair is required for this event: the contract requires a retained `5xx` to
be attributed and never silently retried into a success, and it forces no-go
only for an unmet threshold that is not repairable. Two hardening items are
recorded as backlog rather than as acceptance conditions, because neither would
have prevented this event:

1. Give the gateway's dispatch failure a distinct `reason` (and keep the log
   line) so the next occurrence is attributable without dashboard access.
2. Narrow the JWKS failed-load window if burst resilience during a Google
   outage is ever required — with the anti-storm trade-off the classification
   file records.

The classification file's mechanism correction stands: the 2026-09-28
insights-burst failures cannot be re-attributed to the key-set path either,
since they recorded Sheets reads that the key-set path precedes.
