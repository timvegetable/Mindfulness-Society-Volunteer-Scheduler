# Staging verification — pre-measurement record (2026-09-29)

Evidence for `accelerate-schedule-preview` task 1.3. Executed before any
campaign measurement; nothing was deployed, written or reconfigured. Raw
outputs in ignored `staging-local/verification-pre-campaign-2026-09-29.json`
and `staging-local/reader-verification-2026-09-29.json`.

## Verified against the 2026-09-28 campaign record

| Item | Campaign record | Verified now | Result |
| --- | --- | --- | --- |
| Topology | `volunteer-scheduling-staging-gateway` (public `/exec`, cross-script binding) → `volunteer-scheduling-staging-host` (DO `StagingWorkbookHost`, no public route, holds the Google secrets); baseline Worker unchanged | Gateway live on `https://volunteer-scheduling-staging-gateway.timothyc2371.workers.dev/exec`; all 12 transport refusal-path checks pass (envelopes, no redirects, no-store, 405/413/404 as predeclared) | **matches** |
| Benchmark endpoint | 404 `NOT_FOUND` after the campaign's final approved redeploy, zero subsequent Sheets reads | `POST /benchmark/schedule-preview` → **404 `NOT_FOUND`**, answered at the route gate before any body read, authorization or workbook access | **matches** (benchmark disabled, pre-campaign state) |
| Representative workbook | `1QPRWcAhsyy1s032Sj4_kS4hVra9rajph21AKkNu_D0w`, 305 rows, digest `aedfec2ba60623013a0427df0f084020ab3e84118e0b4f1370e602e0db3372a9` | same row count, workbook zone `America/New_York`, digest **identical** | **matches** |
| Larger workbook | `1nRq-njNjwNnmZWV49A5Yl74w1vplf3UOfAVfPghp5XI`, 2,158 rows, digest `fc05ff654fff5304b8cf9af200413f2eab03692674182132d4150f2690fcb517` | same row count, digest **identical** | **matches** |
| Workbook mutations | none expected | read-only verification: no write of any kind was issued | **clean** |

The workbook reads were performed directly through the read-only service
account (`scripts/staging/verify-staging.mjs`, one metadata read and one
`values:batchGet` per workbook), the same decode path the Worker uses; they do
not count against the campaign's read ledger but stayed far inside Google's
per-minute quota (4 API calls total).

## Re-pinned thresholds and protocol (unchanged, from the feasibility evidence)

The preview targets this change's campaign must meet are the amended
experiment contract's Durable Object topology thresholds
(`openspec/changes/archive/2026-09-29-validate-worker-backend-feasibility/evidence/experiment-contract.md`,
amendment 2026-09-27), unmodified:

| Dimension | Threshold |
| --- | --- |
| Object preview CPU | warm p99 ≤ 3,000 ms; **every** measured request including cold ≤ 5,000 ms |
| Preview wall time | end-to-end warm p99 ≤ 5,000 ms |
| Four-way bursts | completed within the platform's per-request wall cap (~37 s) |
| Reliability | zero unexpected failures, quota errors, resource-limit errors |
| Correctness | semantic parity at fixed clocks; workbook and revisions unchanged |
| Sheets budget | 2 reads per served preview; ≤ 40 reads in any rolling 60-second window; zero 429 in budgeted runs |
| Memory | isolate p99 ≤ 64 MiB where the platform publishes it |
| Free-tier consumption | campaign ≤ 1,000 attempts; no paid plan |

Protocol unchanged: per fixture, sequential warm and four-way burst preview
workloads; genuine cold isolates per the freeze-then-first-use redeploy
protocol with a Durable Object version-lag check before counting cold
observations; every attempt retained, no retries; ≤ 1,000-attempt budget;
workbook digests cross-checked before and after each fixture; this change's
browser probes paced through the shared read ledger.

## Carried-forward constraint recorded for the campaign

The campaign's authorized preview attempts require a fresh administrator ID
token for the staging audience. The credentials the 2026-09-28 campaign used
(`staging-local/credential-tcai5958.txt`, `credential-manbob928.txt`) carry
`exp` timestamps of 2026-09-28T06:23Z and are expired, so the campaign cannot
start until a new administrator credential is minted through the browser probe
sign-in, and every benchmark-host redeploy needs its own per-deployment
approval. Both are recorded as the campaign's open prerequisites.
