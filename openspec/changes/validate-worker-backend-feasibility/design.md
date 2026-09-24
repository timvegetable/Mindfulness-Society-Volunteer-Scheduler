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

## Open Questions

- Which staging Google/Cloudflare resources and authorized test identities will be supplied? Resolve before remote setup; local work is independent.
- Does ordinary Worker Free execution have sufficient CPU headroom, or does measured computation require a free Durable Object path? This experiment owns that decision.
- What actual quota/billing limits apply at deployment time? Record dated verification, including Google over-quota policy.
