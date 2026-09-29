# Verdict addendum — 2026-09-27 (later on the same day)

This dated addendum corrects unsupported percentile claims in
[verdict.md](verdict.md) of the same date. The verdict itself remains the
historical verdict of the single-Worker topology and is not rewritten; the
[experiment contract](experiment-contract.md) amendment of 2026-09-27 carries
the predeclared targets for the Durable Object topology that this verdict left
to its own approval.

## What is unsupported

The verdict's summary table reports, against the predeclared CPU threshold:

> warm p50 3.2 ms, p95 16.5 ms, p99 83.6 ms, max 83.6 ms — **not met**

The first three figures came from the analytics dataset's per-second buckets
joined to the attempt log. As the verdict's own limitation 1 records, a bucket
holding several requests yields only a quantile across that bucket's
population, and the run's collector divided those bucket quantiles by the
bucket's request count. A quantile divided by a population size is not a
percentile of the campaign population, and neither is a maximum bucket
quantile. The p50/p95/p99 row values therefore are **estimates with no defined
population** and are retracted as percentile claims:

* "warm p50 3.2 ms" — supported only as *bucket medians divided by request
  counts*, which is not a median. Valid statement: exact single-request samples
  and per-bucket quantiles on the larger fixture ranged up to 127.5 ms.
* "warm p95 16.5 ms" — same defect; retracted as a campaign percentile.
* "warm p99 83.6 ms" — same defect; retracted as a campaign percentile. The
  true campaign p99 could be lower or higher; this run cannot say.

The profile table's per-operation CPU p50 values are derived the same way and
are retracted as percentiles for the same reason. They remain diagnostic
pointers to where CPU is spent.

## What still stands (valid single-request evidence)

The threshold decision **not met** does not depend on the retracted
percentiles:

* The predeclared warm-max gate was "every measured warm request ≤ 8 ms". Exact
  single-request samples exist (second-quantiles for buckets that held exactly
  one invocation) and two of them exceed the gate on the larger fixture:
  **18.5 ms** and **83.6 ms**, both exact. A single exact warm request at
  18.5 ms is sufficient to fail the "every warm request ≤ 8 ms" gate; the
  retracted p95/p99 are not needed for that conclusion.
* The `session.me` warm median claim ("2.1 ms representative") is likewise an
  estimate and is no longer cited as a measured median; the representative
  fixture's valid statement is that every single-request sample there stayed
  inside the threshold.
* The cold-CPU table (30.4 ms and 18.5 ms, both exact) is single-request
  evidence and stands; the cold dimension's own status ("not evaluated", two
  observations instead of five) is unchanged and correctly recorded in the
  verdict body.
* All non-CPU rows of the measured table (correctness, wall time, failure rate,
  Sheets quota, subrequests, consumption, cost) rest on browser/per-request
  evidence and platform counters and are unaffected.

## Consequence carried forward

The single-Worker topology's CPU verdict stands as **not met** on exact
evidence; the estimated percentiles were never the deciding evidence. The
amendment of 2026-09-27 in the experiment contract governs how the Durable
Object topology's CPU evidence is collected: explicit per-script attribution,
per-bucket quantiles reported only for their actual population, campaign
percentiles labelled estimated whenever the population mixes bucket sizes, and
cold thresholds settled by individually approved uploads.
