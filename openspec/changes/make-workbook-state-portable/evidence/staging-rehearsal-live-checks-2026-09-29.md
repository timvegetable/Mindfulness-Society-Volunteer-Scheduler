# Staging rehearsal — live reader checks, 2026-09-29 (batch 3)

Tasks 4.1/4.2, the deployed half. The operator supplied a fresh ID token
(`tcai5958@terpmail.umd.edu`, staging audience, verified before use) through the
local capture page, and the checks ran against the deployed gateway → Durable
Object host → Sheets topology, which serves the representative synthetic workbook
whose record the earlier batches wrote.

Deployments, each individually approved and recorded in private reports:

| Step | Action | Report |
| --- | --- | --- |
| D1 | host redeploy with `STAGING_CONTROL_AUTHORITY=workbook-control` | `deployment-rehearsal-host-1.json` |
| D1′ | host redeploy after the pending-refusal fix (same target and binding, new artifact) | `deployment-rehearsal-host-2.json` |
| D1″ | host redeploy after the Worker revision fix | `deployment-rehearsal-host-3.json` |
| D2 | host redeploy with the binding removed | `deployment-rehearsal-host-off.json` |

Each redeploy was followed by the documented version-lag wait (95 s) before
measuring, because a new script version does not restart an existing Durable
Object instance immediately. The binding was added to and removed from
`wrangler.jsonc` for the rehearsal; the file is byte-identical to its committed
state afterwards, and `git status` is clean.

## Measured results

| Check | Expectation | Measured |
| --- | --- | --- |
| Identity read (`session.me`), bracket active | served | ok, **1 read**, 860 ms, correlation id and host marker present |
| Domain read (`admin.schedule.read`), bracket active | served, four reads | ok, **4 reads**, 1,101 ms — authorization + control, control, plan, control |
| Pending mutation | `UNAVAILABLE` / `control-pending` | refused, **4 reads** (first run), then **2 reads** after the fix |
| Authority mismatch (record `script-properties`, reader activated) | `UNAVAILABLE` / `control-authority_mismatch` | refused, **2 reads** |
| Legacy deployment after D2 | served, pre-rehearsal counts | ok, **2 reads** |
| Served read reports the record's counters | the record's tuple | **revision 46, inputRevision 6** after the fix (was 42/5 before it) |

Every refusal carried the bounded envelope with a `control-*` reason and no row
values, and every served read carried the correlation id and the host deployment
marker.

## What the live run found

1. **The Worker reported revisions from the staging properties, not the record.**
   With the record at `dataRevision` 46 the served read still said 42 — the
   Worker composed its runtime without a session, so the accessors fell back to
   counters that stop advancing once the repositories commit to the record. Fixed
   by building a read-only session over the rows the bracketed read fetched and
   sourcing both the runtime's and the dispatcher's revisions from it; the
   authorization table and the control record travel in one validated batch, so a
   served domain read stays at four reads. Re-verified live: 46/6.
2. **A pending mutation was refused only after hydration**, costing four reads
   where the read plan prices the rejection at one. The bracket now decides from
   its first control read, and a marker this request published itself is the
   writer's own, so a mutation in progress keeps reading its own rows. Measured
   after the fix: two reads (authorization plus one control read).
3. **The authorization read was being bracketed.** `Users` is deliberately outside
   the completed-snapshot bracket, so a pending record surfaced as a
   `users-read` failure instead of a control failure; it no longer anchors or
   registers a read.

Two of these were found only because the rehearsal measured the live service
rather than trusting the unit tests, which is what task 4.1 is for.

## The generation-moved straddle: attempted, inconclusive

The plan's fourth check expects `STALE_REVISION` / `control-generation_changed`
when a mutation completes *between* the two control reads of a served read. Three
attempts were made: the read was started, then a begin and a complete transition
were issued 250 ms later. All three reads were served — the writes did not land
inside the bracket's window, because each transition runs in its own `vite-node`
process whose startup alone exceeds it.

This is a limitation of the attempt, not a pass: the check is **not** established
live. The same path is covered deterministically in the worker contract test
(`staging.test.ts`, "refuses a read whose generation moved between the two control
reads"), where the fixture mutates the record on the bracket's first control read
and the response is `STALE_REVISION`. The pending-refusal check above is the live
evidence that the same comparison rejects a mid-read change.

## Not covered

- The larger synthetic workbook was not served: the deployed host pins the
  representative workbook, and switching fixtures is a further deployment that the
  approved manifest does not cover.
- The Worker's preview path was not exercised: the benchmark route is disabled and
  no deployment to enable it was requested.
- Read latency was recorded per check but not as a distribution: three served
  reads is not a p99 population, and the archived campaign's latency evidence
  stands unchanged.
- The read plan's table counts rejection paths as control reads only. The measured
  paths include the authorization read that the Worker performs before any control
  check, so the pending and authority-mismatch rejections cost two reads rather
  than one; the plan's quota projections should be read with that included.
