# Preview re-measurement campaign — runbook (2026-09-29)

Evidence for `accelerate-schedule-preview` task 4.2 (prepared per tasks 4.1–4.4
before any campaign request). Every deployment below is its own approved
release action; none of them has happened yet in this campaign. The topology
was verified in its pre-campaign state on 2026-09-29
([staging-verification-2026-09-29.md](staging-verification-2026-09-29.md)).

## What changed since the 2026-09-28 campaign

The preview computation was optimized (≈13× on the larger fixture locally,
byte-identical outputs, see
[profile-2026-09-29.md](profile-2026-09-29.md)). The campaign re-measures the
SAME computation on the SAME topology against the SAME predeclared thresholds.
The measurement harness gained the ledgers the last campaign lacked:

* **Attempt budget ledger** (`staging-local/.attempt-budget-ledger.json`): every
  issued request counts toward the ≤1,000-attempt campaign cap across harness
  restarts; a run that reaches the cap stops issuing and reports what was
  deferred.
* **Durable Object version-lag check**: the host echoes its deployment marker
  (`X-Staging-Host-Deployed-At`, stamped by the deploy script) on every
  response; a cold attempt counts as a genuine cold observation only when the
  marker matches the approved deployment's, so a lagging object is retained as
  evidence but never counted as a cold start.
* **Shared-ledger browser probes** (`/__reserve` on the loopback probe host):
  the browser probe reserves each attempt's Sheets reads in the same rolling
  40-reads-per-60-seconds ledger the harness uses — closing the pacing gap that
  caused the attributed 429s last campaign.

## Open prerequisites (both require the operator)

1. **Fresh administrator ID token.** The 2026-09-28 credentials are expired
   (`exp` 2026-09-28T06:23Z). Mint a new one: run
   `node scripts/staging/serve-probe.mjs`, open `http://localhost:8788/` in a
   browser, sign in as the administrator account, and let the page capture
   `staging-local/credential-<label>.txt`. The token lives about an hour.
2. **Per-deployment approvals** for every redeploy below. Each is its own
   approval; none touches production.

## Deployment chain (each step separately approved)

| # | Action | Command | Effect |
| --- | --- | --- | --- |
| 1 | Deploy the optimized host, benchmark enabled, representative workbook | `node scripts/staging/deploy-staging.mjs --target host --benchmark-enabled --workbook 1QPRWcAhsyy1s032Sj4_kS4hVra9rajph21AKkNu_D0w --report staging-local/deployment-preview-host-1.json --confirm-deploy` | optimized host on the staging host script; `STAGING_PREVIEW_BENCHMARK_ENABLED=true`; fresh `STAGING_DEPLOYED_AT` marker; sets the Google secrets on the host |
| 2 | Cold observation (host) | `node scripts/staging/measure-worker.mjs --manifest staging-local/preview-campaign-representative.json --cold --confirm-staging` | first preview against the fresh version; counts only if the marker matches the deployment report |
| 3 | Representative workload | same manifest without `--cold` | burst 20×4 + sustained 20 |
| 4 | Digest cross-check | `node scripts/staging/verify-staging.mjs --spreadsheet 1QPRWcAhsyy1s032Sj4_kS4hVra9rajph21AKkNu_D0w` | digest must still be `aedfec2b…` |
| 5 | Switch the host to the larger workbook (benchmark stays enabled) | `... --target host --benchmark-enabled --workbook 1nRq-njNjwNnmZWV49A5Yl74w1vplf3UOfAVfPghp5XI --report staging-local/deployment-preview-host-2.json --confirm-deploy` | also host cold observation #2 for the larger object |
| 6 | Gateway cold + workload for the larger fixture | gateway redeploy per the 2026-09-28 chain (`--target gateway --workbook <id> --confirm-deploy`) then the same manifest flow | gateway colds recorded per approved redeploy |
| 7 | Additional cold cycles as needed for ≥5 genuine host and ≥5 genuine gateway colds | alternate host/gateway redeploys, each approved | the version-lag check distinguishes genuine colds |
| 8 | Disable the benchmark route | `node scripts/staging/deploy-staging.mjs --target host --confirm-deploy` (no `--benchmark-enabled`) | restore the pre-campaign state |
| 9 | Post-campaign verification | `node scripts/staging/verify-worker.mjs --url <gateway>/exec` + workbook digests | 404 on the benchmark route, reads still serve, digests unchanged |

Cold-coverage budget: ≤ 12 cold attempts + 80 workload attempts (2 fixtures ×
40) + ~30 browser-probe attempts + verification probes ≈ **≤ 100 of the
1,000-attempt cap**.

## Attempt budgets per fixture (predeclared, matching the campaign protocol)

| Phase | Requests | Concurrency | Sheets reads |
| --- | --- | --- | --- |
| cold (per approved redeploy) | 1–2 | 1 | ≤ 4 |
| burst | 20 | 4 | 40 per run |
| sustained | 20 | 1 | 40 per run |

No retries anywhere; every attempt retained in `<report>.attempts.jsonl` with
its correlation id and host marker; the shared read ledger paces both harness
attempts and browser probes.

## After the campaign

`collect-metrics.mjs` (unchanged) attributes gateway/host/object metrics to the
explicit scripts, namespaces and deployment over the campaign window; the
verdict (`evidence/verdict-<date>.md`) records each dimension against the
unchanged thresholds, with the no-go exit predeclared.
