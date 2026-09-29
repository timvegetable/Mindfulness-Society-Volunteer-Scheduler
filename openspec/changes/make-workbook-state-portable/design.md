## Context

`src/server/runtime.ts`, `main.ts`, and workbook repositories currently read global, scheduling-input and tab revisions from Script Properties. Schedule-output revisions remain in scheduling rows and are a different concept. Reads check counters around batch hydration, but equal counters alone cannot prove that a multi-step mutation is complete. Import preview saves runs despite a read-only policy. Initializer defects are already recorded as original tasks 10.24 and 10.25.

Depends on accepted feasibility evidence with resolved conditions. Read [architecture](../../../docs/architecture.md) and [operations](../../../docs/operations.md) before changing these boundaries.

### Prerequisite assessment (2026-09-29)

The [2026-09-27 single-Worker no-go](../archive/2026-09-29-validate-worker-backend-feasibility/evidence/verdict.md) remains historical evidence for that topology. The [2026-09-28 gateway/Durable Object campaign](../archive/2026-09-29-validate-worker-backend-feasibility/evidence/verdict-2026-09-28.md) measured primary-read wall p99 at or below 1,015 ms on both fixtures and demonstrated request-local decoding on the free topology; its larger preview still failed CPU, wall and burst gates. The [2026-09-29 preview campaign](../archive/2026-09-29-accelerate-schedule-preview/evidence/verdict-2026-09-29.md) subsequently measured larger-preview burst p99 of 2,553–4,191 ms, cold wall at or below 2,653 ms, zero wall-cap kills and zero quota errors. Its [parity evidence](../archive/2026-09-29-accelerate-schedule-preview/evidence/baseline-parity-2026-09-29.md) records exact equality in 20 differential cases. These results support designing portable state for the gateway/Durable Object topology.

Acceptance remains a prerequisite task, despite the preview report's unconditional go label. Aggregate CPU divided by request count is an average, not the required CPU p99; the 4,191 ms maximum wall bound does not prove the 3,000 ms warm CPU p99 gate. Billable duration is unavailable from the recorded datasets, and its estimates must be reconciled with the contract's consumption projections. The report attributes one 503 to a redeploy-adjacent restart/JWKS failed-load window, but that attribution and its reliability disposition still need review. Under the [experiment contract](../archive/2026-09-29-validate-worker-backend-feasibility/evidence/experiment-contract.md), an unevaluated threshold caps acceptance at conditional-go. Tasks 1.4–1.6 require measured evidence or an explicit unresolved disposition; planning does not satisfy the implementation or production gates.

## Goals / Non-Goals

**Goals:** One portable revision authority, a fail-closed consistency protocol shared by both readers, a sole legacy writer during coexistence, and a recoverable metadata migration.

**Non-Goals:** Worker production writes, concurrent legacy/Worker writers, automatic repair of manual edits, moving secrets into cells, or fixing unrelated scheduling rules.

## Decisions

### Gateway/Durable Object baseline and read budget

Use the measured gateway/Durable Object topology as the candidate for the portable-state reader rehearsal, subject to task 1.1 acceptance. The gateway forwards bounded requests; the host keeps credentials and creates request-local services, principals and snapshots. A cache of decoded snapshots across requests is no longer a prerequisite inferred from the rejected single-Worker topology. If later proposed, it needs separate consistency evidence, fresh Users authorization and completed-generation validation. Preview continues to compute from its own request snapshot under the archived schedule-preview-performance requirements.

The staging campaigns observed one Sheets read for identity and two for domain reads or preview. Those counts did not include this change's control checks. Task 1.7 defines the complete control/Users/domain read sequence, including rejection paths; task 4.1 measures that plan and updates quota and latency projections before accepting the portable reader. Preserve the campaign's shared read ledger for harness and browser probes; do not carry the staging two-read count into production claims without measurement.

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

First resolve task 1.1 using the archived evidence and tasks 1.4–1.6, and pin the schema, writer inventory, recovery bounds and read plan through tasks 1.1–1.3 and 1.7. Design work may proceed while measurement gaps are identified; implementation and production activation retain the accepted-feasibility prerequisite. After this change's activation and acceptance, `serve-primary-reads-from-worker` owns identity/Schedule/Insights routing and production browser evidence; `serve-remaining-reads-from-worker` then owns scoped reads and preview routing, reusing the archived preview evidence through its own gates.

First rehearse against synthetic staging: initialization twice, controlled migration, interrupted writes and forward recovery. Implement compatible legacy readers/writers while dormant, update client preview handling, and validate all tests/builds/specs. Before each approved production server deployment or Sheet mutation, export a snapshot, inspect live WRITE_ENABLED, disable it as authorized, drain active writers, capture counters and validate workbook schema/protections. Seed and verify control state, activate the compatible implementation, verify semantic parity and monotonic counters, then separately authorize any write reopening. Do not infer live state from local config or a deployment report.

Rollback before activation restores the old implementation without metadata authority changes. After activation, prefer the protocol-compatible legacy release. Reverting authority to Script Properties requires a separately approved stopped-writer reconciliation from then-current counters and pending journals; copying old numbers is forbidden.

## Open Questions

- Exact physical control schema and recovery journal layout must be pinned with byte/row bounds before implementation commits; the protocol above is the acceptance contract.
- Which existing maintenance entrypoints can be adapted directly, and which should be retired during the final change? The inventory must identify all before activation.
