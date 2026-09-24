# Dated platform limits — excerpts fetched 2026-09-24

Sanitized excerpts recorded so the figures quoted in
[the experiment contract](experiment-contract.md) can be re-checked without
network access. Only short factual statements are reproduced; each is attributed
to its source page and fetch date. These are *limits and policy statements*, not
measurements of this application.

## Cloudflare Workers

Source: <https://developers.cloudflare.com/workers/platform/limits/> — page states
"Last updated Sep 5, 2026". Fetched 2026-09-24.

Section **Account plan limits** (Workers Free column): 100,000 requests/day;
CPU time 10 ms; memory 128 MB; subrequests 50/request; 6 simultaneous outgoing
connections/request; environment variables 64/Worker at 5 KB each; Worker size
64 MiB; Worker startup time 1 second; 100 Workers per account.

Section **CPU time**: "CPU time measures how long the CPU spends executing your
Worker code. Waiting on network requests (such as `fetch()` calls, KV reads, or
database queries) does **not** count toward CPU time." Exceeding the limit returns
"Error 1102 … `Worker exceeded resource limits`"; in analytics the invocation
outcome is `exceededCpu`. CPU limit increases require the Workers Paid plan.

Section **Memory**: 128 MB per isolate, not per invocation. The section adds:
"If your Worker uses Zod, use version 4.5.0 or later. Earlier versions use
substantially more memory per schema." Exceeding memory also returns error 1102,
with outcome `exceededMemory`.

Section **Duration**: HTTP-triggered Workers have no hard duration limit while the
client stays connected.

Section **Daily requests**: 100,000 requests/day on Free, resetting at midnight
UTC; exceeding it returns error 1027.

Section **Subrequests**: 50 per invocation on Free, counting every `fetch()` and
Cloudflare service call.

Section **Simultaneous open connections**: six connections may be waiting for
response headers at once; a seventh is queued.

Section **Worker size**: 64 MiB uncompressed; `wrangler deploy --outdir bundled/
--dry-run` reports the uncompressed upload size.

Section **Worker startup time**: global scope must parse and execute within one
second; deployment is rejected with error 10021 otherwise.

Related page used for the alternative topology:
<https://developers.cloudflare.com/durable-objects/platform/limits/>.

## Cloudflare Workers observability (measurement sources)

Source: <https://developers.cloudflare.com/workers/observability/metrics-and-analytics/>
— page states "Last updated Jul 1, 2026". Fetched 2026-09-24.

Section **CPU Time per execution**: "The CPU Time per execution chart shows historical
CPU time data broken down into relevant quantiles using reservoir sampling." It adds
that higher quantiles may appear to exceed the CPU limit without an invocation error
because the runtime allows rollover CPU time for requests below the limit.

Section **Wall time per execution**: quantile series for the elapsed time between
invocation start and the runtime determining no more JavaScript needs to run,
including time waiting on I/O.

Section **Memory usage**: "shows how much V8 isolate memory your Worker uses at the
time of each invocation, broken down into P50, P90, P99, and P999 percentiles".

Section **Invocation statuses**: `Success`; `Worker threw exception` (1101);
`Exceeded resources` (1102, 1027, GraphQL field `exceededResources`) — "The most
common cause is excessive CPU time, but is also caused by a Worker exceeding startup
time or free tier limits."; `Internal error`.

Section **Metrics retention**: up to three months, in increments of at most one week.

Section **GraphQL**: "Worker metrics are powered by GraphQL", so the same series are
queryable programmatically rather than only through the dashboard.

Important limitation recorded for the experiment: these pages document **aggregate
quantile series**, not a per-invocation CPU field exposed to real-time logs. Per
invocation CPU/wall time is documented as root-span attributes on Workers traces
(`cloudflare.cpu_time_ms`, `cloudflare.wall_time_ms`) on
<https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/>;
whether a Free-plan staging Worker can export them was **not** verified here, so the
experiment treats per-invocation records as an optional secondary source and does not
make a threshold depend on them.

## Google Sheets API

Source: <https://developers.google.com/workspace/sheets/api/limits>. No last-updated
date is published; fetched 2026-09-24.

Section **Quota limits**: read requests 300 per minute per project and 60 per
minute per user per project; write requests the same. "While Sheets API has no hard
size limits for an API request, users might experience limits from different
processing components not controlled by Google Sheets. To speed up requests, we
recommend a 2 MB maximum payload." Over-quota requests receive `429: Too many
requests` and should use exponential backoff; quotas refill every minute.

Section **Behavior and limitations**: "Each batch request, including any
subrequest, is counted as one API request toward your usage limit." There is no
daily request cap while under the per-minute quotas, and a single API request
times out after 180 seconds.

Section **Pricing**: "All standard use of the Google Sheets API is available at no
additional cost. Exceeding the quota request limits is planned to incur charges to
your Google Cloud billing account later in 2026."

Design references for the identity flows:
<https://developers.google.com/identity/openid-connect/openid-connect> (ID-token
verification) and
<https://developers.google.com/identity/protocols/oauth2/service-account>
(server-to-server OAuth). See also
<https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGet>
for the request/response shape the slice reuses.
