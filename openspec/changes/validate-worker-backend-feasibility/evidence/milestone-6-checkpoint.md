# Milestone 6 checkpoint — awaiting provisioning and deployment approval

Written 2026-09-24 after milestone 5. Milestones 1–5 are implemented, reviewed
and committed locally; **no push and no deployment has happened**. Tasks 3.2–4.3
stay unchecked because they need resources and approvals this session does not
have, and the plan forbids substituting localhost timings or missing measurements
for a feasibility verdict.

## What is done

| Milestone | Tasks | State | Commit |
| --- | --- | --- | --- |
| 1. Experiment contract | 1.1–1.3 | complete, verified | `2791323` |
| 2. Worker boundary | 2.1–2.3 | complete, verified | `5dcd384` |
| 3. Authentication | 2.4 | complete, verified (mandatory gate) | `3dc8667` |
| 4. Workbook integration and parity | 2.5–2.6 | complete, verified | `591b76d` |
| 5. Release readiness | 3.1 | complete, verified (mandatory gate) | `c5eab07` |
| 6. Measurement and verdict | 3.2–4.3 | **blocked on approval** | — |

The local slice serves `session.me`, `admin.schedule.read` and
`admin.insights.read` over the bounded transport, verifies real Google ID tokens
against Google's published keys, acquires a service-account token, reads the
authorization table fresh before any domain range, and returns projections that
match the existing Apps Script runtime for the same snapshot. Everything else —
the other thirteen operations, writes, portable state, production routing — is
unchanged.

## What is not done, and why

Tasks 3.2–4.3 require resources that must be created on external accounts and a
deployment that needs its own approval:

* **3.2** provision the synthetic workbooks, the read-only service account, the
  test identities and the Worker, then deploy staging.
* **3.3** run authenticated real-browser probes and record the transport facts.
* **3.4** measure cold/warm CPU, wall time, Sheet calls, the larger preview and
  paced concurrency.
* **3.5** profile or evaluate a free Durable Object path only if the measurements
  require it.
* **4.1** run the final gate set including both builds.
* **4.2** publish the dated go / conditional-go / no-go verdict.
* **4.3** update the documentation and cross-link the evidence.

No threshold in the experiment contract has been evaluated, and no number in this
change is a measurement of the deployed topology.

## The approval request

Approving this means authorizing the resources and the deployment described in
[the staging manifest](staging-manifest.md), specifically:

1. A Cloudflare account on the Free plan with one Worker
   (`volunteer-scheduling-staging`, no route, no custom domain).
2. A Google Cloud project with the Sheets API enabled and an OAuth web client
   used as the ID-token audience.
3. One read-only service account shared on two synthetic workbooks, plus a
   one-time write-capable identity to load the fixture.
4. Two synthetic workbooks generated from the documented offsets, with the
   pinned revision tuple and recorded fixture digests.
5. Seven test Google accounts (administrator, volunteer, multi-role,
   center-contact, blank-`active`, `active=false`, and one outsider with no
   `Users` row).
6. `wrangler secret put` for the two service-account bindings, the
   `REPLACE_…` placeholders in `wrangler.jsonc` filled with the recorded staging
   values, and one `wrangler deploy --env staging`.

Provisioning, the deployment, and any push each remain separate approvals; this
checkpoint requests none of them implicitly.

## Resume instructions

1. Read `tasks.md` (completion authority) and this change's
   `execution-record.md` (decisions, evidence, review dispositions).
2. Confirm the working tree is clean and the five milestone commits above are
   present (plus `dae580f`, the pre-existing commit that stopped tracking
   `plan.md`, and `514d8fc`, which committed this checkpoint and the record
   corrections). If the tree is not clean, inspect it rather than discarding it.
3. Re-run `npm test`, `npm run test:worker`, `npm run check`, `npm run build` and
   `npm run build:worker` to confirm the local gates still hold at the resumed
   commit.
4. Work through the pre-deployment checklist in the staging manifest, export both
   workbook snapshots first, then provision and deploy under their own approvals.
5. Collect the measurements with `scripts/staging/measure-worker.mjs --cold`
   immediately after the first approved upload, and the browser probe from an
   allowlisted origin.
6. Evaluate the predeclared thresholds, then write the dated verdict for task 4.2
   and the documentation updates for 4.3.

## Known limitations carried into the verdict

* The `UNAUTHORIZED` envelope's `details.detail` includes the `Users` row count
  for a caller holding a valid token. Pre-existing shared behaviour, recorded as
  a follow-up under task 4.3.
* `@cloudflare/vitest-pool-workers` enables Node compatibility flags for its own
  runner, so the Worker-native test runtime is slightly more permissive than the
  deployed Worker; the isolated type program and the ESLint boundary rules are
  what close that gap.
* The Worker-native tests prove runtime behaviour in workerd, not on Cloudflare's
  network: cold-start behaviour, isolate reuse and the real CPU accounting can
  only be measured after deployment.
* Per-invocation CPU is not published for Free-plan Workers, so the CPU threshold
  statistic is the platform's p99 quantile rather than a per-request maximum.
