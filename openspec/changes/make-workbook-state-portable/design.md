## Context

`src/server/runtime.ts`, `main.ts`, and workbook repositories currently read global, scheduling-input and tab revisions from Script Properties. Schedule-output revisions remain in scheduling rows and are a different concept. Reads check counters around batch hydration, but equal counters alone cannot prove that a multi-step mutation is complete. Import preview saves runs despite a read-only policy. Initializer defects are already recorded as original tasks 10.24 and 10.25.

Depends on an accepted [feasibility decision](../validate-worker-backend-feasibility/design.md). Read [architecture](../../../docs/architecture.md) and [operations](../../../docs/operations.md) before changing these boundaries.

## Goals / Non-Goals

**Goals:** One portable revision authority, a fail-closed consistency protocol shared by both readers, a sole legacy writer during coexistence, and a recoverable metadata migration.

**Non-Goals:** Worker production writes, concurrent legacy/Worker writers, automatic repair of manual edits, moving secrets into cells, or fixing unrelated scheduling rules.

## Decisions

### Dedicated versioned control metadata

Add a schema-defined control tab rather than overloading the defective append-only Settings behavior. Store protocol version, writer authority/epoch, global revision, scheduling-input revision, per-tab counters and operation state in one validated control record or atomic logical unit. A monotonic generation changes for every mutation lifecycle transition, including aborted/recovered work; it is distinct from successful-operation DATA_REVISION. Preserve schedule-output revisions in their existing rows. Missing, malformed or unsupported control state fails closed after activation, never defaults to zero.

Migrate captured counters without decreasing them. Switch authority once under a maintenance gate; do not maintain two independent writable sources of truth. Old Properties can be retained as an explicitly non-authoritative rollback artifact. Both adapters use the same provider interface. Inventory each Script Property as portable domain policy, deployment identity/configuration, secret, cache or operational gate. Workbook-derived policy stays versioned; service-account keys and signing material stay in secrets. Keep live WRITE_ENABLED and portable writer fencing as separate checks, both required for mutation admission.

### Writer protocol and consistent reads

Apps Script remains the only writer and holds its script lock for the entire operation. Before changing any rows, it persists an in-progress marker and a new generation with operation identity and affected tabs. Completion publishes final counters and a completed generation only after domain/audit persistence succeeds. Where legacy operations cannot be atomically committed, store enough protected recovery evidence to restore/reconcile; a crash leaves the marker pending. Ordinary traffic must not clear a pending marker or report partial rows as current.

Readers fetch completed control state, hydrate named ranges, then re-read control state. They accept only the same supported, completed generation and revision tuple. A concurrent transition, pending operation, unknown epoch, or malformed metadata returns a controlled stale/unavailable response. Protocol protection assumes all writers participate; manual Sheet edits cannot be made transactional by metadata and remain governed by the exceptional-write procedure.

### Audit every mutation path

Cover repository commits, scheduling publication/compensation, imports, cancellation, availability, candidates, Insights refresh, initializer/loader and direct-write reconciliation. Revision accounting must distinguish tab commits, scheduling-input changes and successful global operations; record permitted recovery increments, never reset counters to backup values. Fresh Users reads remain mandatory and administrative identity maintenance participates in the maintenance protocol.

Reclassify import preview staging as mutating; reject it when WRITE_ENABLED is false or through read-only dispatch. Add required revision handling to its client flow, sourcing the revision from an authenticated current-state read rather than fabricating it. If identity bootstrap needs a revision field, add it compatibly and test old clients failing safely. Do not attempt an incidental redesign into ephemeral staging.

### Repair prerequisites, preserve backlog ownership

Fix effective schema-version resolution/idempotent initialization and actual protected data columns with tests that fail against current code. Control-tab protection must allow the intended service identities without granting volunteer edit access. Link measurements to original 10.24/10.25; leave their checkboxes open until their own required evidence is recorded. Extend snapshot validation to include control state while keeping exports/private journals ignored in-tree.

## Risks / Trade-offs

- [Additional control reads increase latency and quota use] → Measure exact call counts in primary reads; correctness precedes a one-call target.
- [Legacy multi-step write dies midway] → Pending marker blocks acceptance; reviewed recovery preserves audit and monotonic counters.
- [Historical deployment bypasses new protocol] → Do not use it as a writable rollback endpoint; require a protocol-compatible legacy release.
- [Manual edits bypass the application] → Correct protections and update the exceptional operations procedure; do not claim protection from the workbook owner.

## Migration Plan

First rehearse against synthetic staging: initialization twice, controlled migration, interrupted writes and forward recovery. Implement compatible legacy readers/writers while dormant, update client preview handling, and validate all tests/builds/specs. Before each approved production server deployment or Sheet mutation, export a snapshot, inspect live WRITE_ENABLED, disable it as authorized, drain active writers, capture counters and validate workbook schema/protections. Seed and verify control state, activate the compatible implementation, verify semantic parity and monotonic counters, then separately authorize any write reopening. Do not infer live state from local config or a deployment report.

Rollback before activation restores the old implementation without metadata authority changes. After activation, prefer the protocol-compatible legacy release. Reverting authority to Script Properties requires a separately approved stopped-writer reconciliation from then-current counters and pending journals; copying old numbers is forbidden.

## Open Questions

- Exact physical control schema and recovery journal layout must be pinned with byte/row bounds before implementation commits; the protocol above is the acceptance contract.
- Which existing maintenance entrypoints can be adapted directly, and which should be retired during the final change? The inventory must identify all before activation.
