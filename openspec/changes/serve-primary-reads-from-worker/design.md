## Context

Depends on accepted feasibility and activated portable metadata. The browser currently has one appsScriptUrl, cookieless text/plain POST, automatic redirect following, and Apps-Script-specific configuration/error messages. Shared request schemas already include expectedRevision. The production Insights cache may return a labelled stale dataset until refresh/expiry; dropping the cache changes observable behavior.

## Goals / Non-Goals

**Goals:** Reliable direct responses for identity bootstrap, published Schedule and Insights, with unchanged domain/auth contracts and deliberate mixed-backend routing.

**Non-Goals:** Worker writes, automatic fallback, GET redesign, scheduling algorithm changes, lowering the latency target, or making cached Users authoritative.

## Decisions

### Async composition with shared policy

Use the feasibility slice's Worker transport and extract common envelope/payload/error/role policy from the synchronous dispatcher. Validate byte limits while reading the body, operation/payload allowlists and nested dangerous keys before executing. Verify ID-token signature/claims, freshly decode Users, then authorize before fetching domain ranges. Keep actor and workbook snapshots request-local; cache only appropriately scoped expiring keys/tokens and revision-keyed derivations. Test inactive users, role changes and wrong-owner/center boundaries.

Keep POST text/plain JSON with credentials omitted and direct application/json responses; `/api` is the Worker endpoint, distinct from the retained legacy URL. Apply exact GitHub Pages origin (without repository path), Vary: Origin and no-store to success and allowed-origin errors. Preflight, method/path rejection, body overflow, malformed JSON and unexpected exceptions have bounded handling. Do not claim that application code can turn a platform CPU/quota termination into JSON: client diagnostics must also handle non-JSON platform failures. Use redirect:error for Worker fetches so an unexpected redirect is a failure; legacy fetch behavior stays compatible.

### Sheets snapshot and identity boundaries

Use a Viewer service account with read-only scope, fixed workbook ID and schema-derived ranges. Preserve fresh Users lookup before domain hydration, portable control checks around reads, and workbook-zone versus scheduling-zone decoding. Reuse the existing batch normalization and read plans through an async adapter. A revoked/inactive user is denied even if a derived cache entry exists. Bound retries for transient upstream reads and token acquisition with an overall deadline; log aggregate phases/request IDs, never raw tokens, rows, full requests, or Google error bodies.

### Insights cache semantics

Use a shared workbook-scoped derived-cache adapter (SQLite Durable Object on Free by default if compatible with the accepted feasibility topology). It is disposable derived storage, not revision or authorization authority. Retain the current 300-second TTL, source revision tuple, stale reasons and reuse behavior: cache hits with changed sources are labelled stale; misses/expiry regenerate from a consistent snapshot. Freshness changes while computing are rejected before publishing a current result. Concurrent computations cannot overwrite a newer cached generation with an older one.

Coexistence must include legacy `admin.insights.refresh`: until writer handover, that operation must invalidate/update the same cache through a restricted server-to-server bridge or a portable refresh generation that Worker readers honor. The selected refresh-generation approach adds a monotonic cache-invalidation field to the portable control protocol and advances it on legacy refresh; the Worker treats a changed generation as a miss. This avoids a legacy refresh that leaves Worker reads serving the old stale entry. Legacy cache contents need not be imported; initial Worker cache miss is permitted and tested. Cache state alone does not establish data consistency.

### Explicit routing and release evidence

Allow configuration to route exactly the three operations to Worker while all others stay legacy. Update public/private schemas, renderer, deployment checks and backend-aware error text together. No fallback on failure and no arbitrary browser-selected endpoint/operation map. Environments use explicit allowlisted configuration. A rollback switches all three routes together to the protocol-compatible legacy deployment.

Record two warmups and a fixed, predeclared 40-attempt warm browser window for each data route, retaining all failures and slow successes. A reliability pass requires 40/40 successes, no redirects/echo/HTML/bodyless replays, and semantic parity. Record min, median, nearest-rank p95 and max; report warmups, cold/key-cache misses, upstream incidents and failures separately under the existing latency sampling rules. Do not reclassify an ordinary slow success after observing its duration. Additional diagnostic attempts do not turn a failed window into 40/40. Run session.me sign-in/bootstrap separately. The 2000 ms objective remains unmet unless both routes pass; any amended threshold needs its own explicit specification decision in `meet-read-latency-objective`.

## Risks / Trade-offs

- [Shared cache increases infrastructure] → Preserve existing observable reuse/staleness rather than silently regenerate every request; keep it discardable and test outages as bounded failures or safe recomputation.
- [Mixed refresh/read backends diverge] → Portable refresh generation and cross-backend tests before production routing.
- [Authorization/consistency calls dominate latency] → Report phases and quota costs; no stale authorization shortcut.
- [Old client misdiagnoses Worker errors] → Backend-specific diagnostics and schema/config validation released before routing.

## Migration Plan

Harden staging, run differential snapshots with fixed clocks, and exercise revocation plus concurrent legacy writes. Validate focused/full tests, checks, both bundles and strict specs. Deploy the Worker without client routing only after its specific approval and required snapshot/live-gate checks. Verify direct authenticated responses and sanitized metrics. Separately approve the Pages configuration release, inspect its push-trigger behavior, and collect production browser evidence. Keep rollback metadata and compatible legacy version. Update latency tasks 4.3/4.4 only when their own decision/evidence requirements are satisfied.

## Open Questions

- Confirm the selected cache/compute topology against feasibility CPU and free-plan results before implementation.
- Determine current configured origins, workbook identity and OAuth audience during release preparation without committing private configuration.
