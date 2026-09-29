# Durable Object topology — deployment chain and campaign plan (2026-09-27)

Prepared per task 3.5 before any deployment, per the amendment in
[experiment-contract.md](experiment-contract.md). Every deployment below is its
own approved release action; none has happened yet. The baseline staging Worker
(`volunteer-scheduling-staging`) stays deployed and unchanged throughout.

## 1. Deployment chain (each step separately approved)

| # | Action | Command | Effect |
| --- | --- | --- | --- |
| 0 | Export workbook snapshots | loader read of both fixtures into `staging-local/` | rollback + digest baseline; digests recorded before the campaign |
| 1 | Deploy the Durable Object host | `node scripts/staging/deploy-staging.mjs --target host --confirm-deploy` | creates `volunteer-scheduling-staging-host` with the `v1` SQLite migration (`new_sqlite_classes: StagingWorkbookHost`); sets the two Google secrets **on the host only**; no public route, no workers.dev endpoint |
| 2 | Deploy the gateway | `node scripts/staging/deploy-staging.mjs --target gateway --confirm-deploy` | creates `volunteer-scheduling-staging-gateway` with the cross-script binding; sets no credentials; publishes `https://volunteer-scheduling-staging-gateway.<subdomain>.workers.dev` |
| 3 | Gateway cold + endpoint verification | first POST to the gateway, then `verify-staging.mjs` against the gateway URL | the first request is gateway cold observation #1 and host cold observation #1 (fresh isolates on first deployment) |
| 4 | Enable the benchmark route | `node scripts/staging/deploy-staging.mjs --target host --benchmark-enabled --confirm-deploy` | flips `STAGING_PREVIEW_BENCHMARK_ENABLED` to `true` on the host; **also redeploys the gateway's binding target version, so a gateway redeploy (`--target gateway --confirm-deploy`) follows to re-establish cold isolates for the preview observations** |
| 5..n | Cold-start redeployments | `--target gateway --confirm-deploy` and `--target host --confirm-deploy`, alternating, each approved on its own | each produces 1–2 genuine cold observations; see the protocol below |
| n+1 | Run the campaign | manifests in section 2 | ≤1,000 total attempts |
| n+2 | Disable the benchmark route | `node scripts/staging/deploy-staging.mjs --target host --confirm-deploy` (no `--benchmark-enabled`) | benchmark off again; verification: `POST /benchmark/schedule-preview` returns 404 and a read still works |
| n+3 | Optional teardown | `wrangler delete --env staging-host` / `--env staging-gateway` | removes the topology; the baseline staging Worker remains |

Rollback at any point: redeploy the previous version of the affected script
(`wrangler rollback --env <env>` or a redeploy of the pinned commit) or delete
the topology with step n+3. Production is untouched by every step.

## 2. Measurement manifests (per fixture, sanitized)

The gateway is deployed once per fixture with `--workbook <id>` so object
selection (one stable object per workbook) points at that fixture. Both
fixtures: `representative` (the loaded smaller workbook) and `larger`.
Credential paths live in `staging-local/credential-<id>.txt`.

Per fixture and per read operation (`session.me`, `admin.schedule.read`,
`admin.insights.read`), one manifest:

```json
{
  "workerUrl": "https://volunteer-scheduling-staging-gateway.<subdomain>.workers.dev/exec",
  "origins": ["https://<staging-origin>"],
  "operations": ["<operation>"],
  "cold": { "requests": 1 },
  "burst": { "requests": 40, "concurrency": 4 },
  "sustained": { "requests": 100, "concurrency": 1 },
  "reportPath": "staging-local/do-measure-<fixture>-<operation>.json",
  "credentialPath": "staging-local/credential-<id>.txt",
  "fixtureDigest": "<from loaded-<size>.json>"
}
```

Per fixture, the preview workload (only while the benchmark is enabled):

```json
{
  "workerUrl": "https://volunteer-scheduling-staging-gateway.<subdomain>.workers.dev/benchmark/schedule-preview",
  "operations": ["admin.schedule.preview"],
  "burst": { "requests": 20, "concurrency": 4 },
  "sustained": { "requests": 20, "concurrency": 1 },
  "reportPath": "staging-local/do-measure-<fixture>-preview.json",
  "credentialPath": "staging-local/credential-<admin-id>.txt"
}
```

Invocation pattern: `--plan` first (no requests), then
`node scripts/staging/measure-worker.mjs --manifest <path> [--cold] --confirm-staging`.
Every attempt is appended to `<report>.attempts.jsonl` with its server
correlation id; no retries; the limiter holds ≤40 reads per rolling 60 s window.

## 3. Cold-isolate protocol (replaces the single-deploy cold sequence)

* A cold observation is the first request to a script after an individually
  approved deployment (version activation), verified later against platform
  telemetry (a fresh isolate/activation in the metrics window at that second).
* Gateway colds: one per approved gateway redeploy. Host colds: the first
  request to each object in a fresh host isolate — with two fixtures deployed
  serially, one host redeploy yields up to two host cold observations.
* Coverage plan: at least **five** gateway colds and **five** host colds, with
  every operation (`session.me`, `admin.schedule.read`, `admin.insights.read`,
  and — while enabled — the preview route) covered as a first-use path at least
  once. Operation rotation is fixed in advance: cycles run the operations in
  order `[me, schedule, insights, preview, me, …]`.
* **Object activation is recorded separately**: the first request to a newly
  named object inside an existing isolate is object activation, not an isolate
  cold start; the host's first-use telemetry (`staging host object first use`)
  plus the deployment telemetry distinguish the two in the verdict.
* Cold requests run through the same manifests with `--cold` immediately after
  each approved redeploy.

## 4. Workload and quota budget (predeclared)

| Item | Count |
| --- | --- |
| Read workloads | 3 ops × (100 sequential + 40 burst) × 2 fixtures = **840** attempts |
| Preview workloads | 2 × (20 sequential + 20 burst) = **80** attempts |
| Cold observations | ≤ **24** attempts (≤ 6 gateway + ≤ 6 host redeploy cycles, 1–2 requests each) |
| Browser probe (transport verification per fixture) | **15** attempts × 2 = **30** |
| **Total** | ≤ **974** ≤ 1,000 (the predeclared cap) |

Sheets reads: reads = 140×1 + 140×2 + 140×2 = 700 per fixture for the read
workloads, 80 for preview, ~20 for colds → ≈ 1,500 total across both fixtures,
paced at ≤ 40 reads per rolling 60-second window by the harness limiter.
No retries anywhere; every attempt is retained.

Wall-time evidence: the four-way bursts provide ≥ 30 qualifying observations at
≥ 3 in flight for every read operation and fixture (40 per phase); the browser
probe run per fixture verifies transport facts (CORS, no redirect, `no-store`,
JSON content type) and supplies independent browser wall-time samples.

## 5. Coverage and cross-checks

* Before each fixture campaign: record the fixture digest from
  `loaded-<size>.json` and the revision tuple.
* After each fixture campaign: re-verify the workbook digests and that no
  Sheets read counter advanced beyond the attempts' `X-Staging-Sheets-Reads`
  sum; the workbook must be unchanged.
* `collect-metrics.mjs` is run per script with explicit `--script` attribution
  (`--role gateway` / `--role host --namespace <id>`), windowed to the campaign,
  with `--expected-requests` from the attempt logs; coverage below the expected
  count, truncation, or `__unknown__` attribution marks the affected dimension
  unresolved (never passing).
* Free-tier consumption: report measured request + duration consumption from
  the campaign and project 100/500/1,000 requests/day against the documented
  allowances (100k requests/day, 13k GB-s/day on Free — see
  `platform-limits-2026-09-24.md`), requiring ≤ 50% headroom use.

## 6. Verdict bookkeeping

After the campaign: the new dated verdict (`evidence/verdict-<date>.md`)
records gateway/object CPU against the predeclared thresholds, wall time,
reliability, Sheets budget, memory (or its unresolved status), cold coverage,
quota envelope and projections, plus every unresolved condition. The 2026-09-27
verdict stands as history; its percentile corrections live in
[verdict-addendum-2026-09-27.md](verdict-addendum-2026-09-27.md).
