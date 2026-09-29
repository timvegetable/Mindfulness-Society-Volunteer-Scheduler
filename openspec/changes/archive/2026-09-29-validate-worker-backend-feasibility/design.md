## Context

This proposal follows investigation of `master` at `01c735c` and `codex/read-api-prototype` at `a47b274` on 2026-09-24. The latter is a loopback Node experiment with synthetic identity/storage, not a Worker backend. Existing shared schemas, domain services, workbook codecs, batching and tests are reusable. The synchronous dispatcher rejects promises and cannot simply receive an async REST implementation.

See [architecture](../../../docs/architecture.md), [testing](../../../docs/testing.md), and the [latency evidence](../meet-read-latency-objective/tasks.md). Those files describe existing behavior; proposed behavior stays here until implemented.

## Goals / Non-Goals

**Goals:** Establish an executable staging slice, a production-shaped resource envelope, and a dated go/no-go decision for retaining GitHub Pages and Sheets while replacing Apps Script. Produce evidence useful to subsequent changes rather than a disposable benchmark-only rewrite.

**Non-Goals:** Production cutover, production roster fixtures, live revision migration, writes, paid hosting, domain-rule redesign, or treating local timings as deployed results.

## Decisions

### Sequence and ownership

The default implementation/release order is:

```text
validate-worker-backend-feasibility
  → make-workbook-state-portable
  → serve-primary-reads-from-worker
  → serve-remaining-reads-from-worker
  → move-workbook-writes-to-worker
  → retire-apps-script-backend
```

Each change has its own proposal, design, capability specs and unchecked tasks. CLI artifact readiness is not deployment permission or evidence that prerequisite changes passed. Later designs are conditional on the feasibility verdict; update them if the measured execution topology changes. Keep only the current change actively implementing by default; do not maintain six divergent long-lived implementation branches.

`meet-read-latency-objective` owns the existing 2000 ms p95 requirement and final latency verdict. Do not close it from staging evidence or a transport-only pass. The original `volunteer-session-scheduling` change retains roster/rank/import and browser acceptance work; tasks 10.24/10.25 are prerequisites for trustworthy portable metadata, and 10.26/10.27 link to notification work. UI changes remain independent. No existing checkbox is completed or transferred merely by creating this roadmap.

### Reuse the implementation boundaries

Begin from master and selectively reuse the prototype's fixtures, parity cases, and probe; retain its branch as evidence. Keep domain code in existing server subsystems and raw Sheets access under `src/server/workbook/`. Add a Worker entry/composition layer, asynchronous I/O orchestration, and reusable integration validation/role policy without making legacy Apps Script entrypoints async. Do not emulate all Apps Script globals or move the domain tree just to fit a sample layout.

### Real security and I/O in staging

Serve only `session.me`, `admin.schedule.read`, and `admin.insights.read` through a bounded 64 KiB POST boundary with direct JSON, exact origin allowlisting, no-store, and no redirects. Preserve text/plain JSON and the shared envelope, including optional expectedRevision. Use Google-issued ID tokens with signature, issuer, audience, expiry, verified-email and subject checks. Load Users fresh before domain reads; synthetic verifier tokens must not work in deployed staging. Cache public signing keys and service-account access tokens only as expiring optimizations. Never use origin as identity.

Use a dedicated synthetic workbook with known revisions/configuration; a read-only service account shared only to that workbook; and actual Sheets REST reads. No domain-wide delegation. Separate staging secrets from production; keep local private artifacts in ignored in-tree directories. Reuse schema-derived ranges and existing serial-date/blank normalization. Pin the workbook time zone independently of scheduling time zone. A static fixture revision is valid only for this immutable staging experiment.

### Measure the actual execution topology

Pin fixture sizes, expected projections and a workload growth case before running. Include multi-role users, empty data, cancelled/graduated volunteers, stale/cache cases, timezone/DST edges and malformed rows. Measure Worker CPU separately from wall time for cold/warm key/token caches, decoding, Zod, Temporal, derivation and serialization. Exercise scheduling-preview computation as a non-production test even though it is not a public operation in this slice. Record Google calls per request and paced concurrent browser load.

As checked on 2026-09-24, Workers Free documents 10 ms CPU/request, 100,000 requests/day and 50 subrequests/request; SQLite Durable Objects are available on Free. Recheck actual account limits before a release: [Worker limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/). Do not equate network wall time with CPU. If representative work does not fit with measured headroom, profile first; evaluate a free Durable Object compute path and remeasure, or record no-go. Do not silently upgrade billing or assume a tiny fixture proves feasibility.

Google documents 60 reads/minute/user/project and 300/project, with a service account counting as one account; its current page also notes planned over-quota charging later in 2026. Record current billing/quota policy and cap planned load rather than treating free operation as permanent: [Sheets limits](https://developers.google.com/workspace/sheets/api/limits). ID-token verification follows [Google production guidance](https://developers.google.com/identity/openid-connect/openid-connect); Sheets credentials use a distinct [server-to-server OAuth flow](https://developers.google.com/identity/protocols/oauth2/service-account).

### Release discipline from the first slice

Use pinned Wrangler configuration/runtime types and Worker-native tests, without nodejs_compat unless justified. Inspect the Pages workflow before any push: the current workflow deploys on every push. Separate validation from manually authorized environment releases; no proposal or branch push implicitly authorizes deployment. Run focused tests, npm test, npm run check, build and strict OpenSpec validation. The existing Node harness remains a local test tool only.

## Risks / Trade-offs

- [Staging understates load] → Publish fixture dimensions and larger-case results, not private rows, and repeat against actual platform CPU metrics.
- [Too much portability refactoring before feasibility] → Extract only the validation/snapshot/projection seams needed for this slice; keep remaining operation ports in later changes.
- [Quota errors distort reliability samples] → Define pacing/load in advance, retain every failure, and report quota consumption and retry time.
- [Public staging exposes fixture identities] → Use synthetic workbook data and deliberately authorized test accounts, with no roster exports committed.

## Migration Plan

Implement and validate locally, provision synthetic staging after its specific authorization, deploy the read-only slice after deployment approval, then run real browser and runtime probes. Record a go, conditional-go with measured topology, or no-go verdict with unresolved risks. A conditional-go does not unlock production until its conditions are resolved. Rollback disables/removes the staging endpoint; production stays unchanged.

## Amendment 2026-09-27: Durable Object staging topology (task 3.5)

The measured verdict (no-go for the single Worker topology) requires evaluating a free Durable Object computation path under the same acceptance thresholds. Decisions:

- **Topology.** Browser → thin gateway Worker → Durable Object → Sheets. The gateway keeps handling limited to transport admission and forwarding, streams the returned response without parsing or reserializing it, and maps binding failures to the existing JSON error envelope. It must not import the production runtime, Zod, or Temporal. Inside the object, the existing bounded transport and staging service are reused unchanged: Google verification, fresh Users lookup, role checks, schema-derived Sheets ranges, synchronous domain runtime, JSON serialization. The object creates request-local services, snapshots, counters and principals, retains only the existing expiring Google key/token caches, and writes no application state into its storage.
- **Bundles.** Separate gateway and Durable Object host bundles, deployed as separate scripts. The host has no public route or workers.dev endpoint; the gateway connects through a cross-script Durable Object binding. The class is registered with a SQLite migration (`new_sqlite_classes`); a new version migration keeps the staging namespace reusable. Requests route to one stable object per configured synthetic workbook, chosen from deployment configuration, never browser input. Google credentials stay on the host only. The existing staging Worker remains the baseline.
- **CORS, limits, errors.** Exact CORS allowlisting, the 64 KiB request cap, no-store responses and current error semantics are preserved end-to-end because the host reuses the existing bounded transport; the gateway adds no headers of its own to forwarded responses.
- **Staging preview endpoint.** `POST /benchmark/schedule-preview`, controlled by `STAGING_PREVIEW_BENCHMARK_ENABLED` (false by default; disabled requests return 404). It accepts the existing authenticated envelope with operation `admin.schedule.preview` and an empty payload, requires a freshly authorized administrator, invokes the real preview handler with the authenticated principal (not the local benchmark's fabricated actor), fetches Users first and then one schema-derived batch containing SchedulingRuns, Volunteers, RecurringAvailability, AvailabilityExceptions, Sessions, Assignments, and Centers, and returns the existing preview envelope. Neither previews nor rejected requests may modify Sheets, audit rows, or revisions. `/exec` and its three-operation allowlist are preserved; preview is rejected through `/exec`.
- **Separate CPU budgets.** Gateway CPU and object CPU are measured and gated separately. Predeclared targets (contract amendment 2026-09-27): gateway warm p99 ≤5 ms and every warm request ≤8 ms; object read CPU p99 ≤500 ms with every request including cold ≤1,000 ms; object preview CPU p99 ≤3,000 ms with every request including cold ≤5,000 ms; wall-clock latency thresholds unchanged. Cloudflare's documented Durable Object CPU allowance (30 s default per request, SQLite-backed objects available on Free) is rechecked at deployment time and archived in `evidence/platform-limits-*.md`.
- **Measurement.** Platform metrics are attributed explicitly to the gateway script, the host script, its DO namespace, deployment and time window; coverage gaps cannot pass a gate. Gateway CPU, object CPU, object memory and billable duration are collected separately. Cold observations come from individually approved redeployments: the first request after each upload is a genuine cold path, and object activation is recorded separately from isolate cold starts.

## Open Questions

- Which staging Google/Cloudflare resources and authorized test identities will be supplied? Resolve before remote setup; local work is independent.
- Does ordinary Worker Free execution have sufficient CPU headroom, or does measured computation require a free Durable Object path? This experiment owns that decision.
- What actual quota/billing limits apply at deployment time? Record dated verification, including Google over-quota policy.
