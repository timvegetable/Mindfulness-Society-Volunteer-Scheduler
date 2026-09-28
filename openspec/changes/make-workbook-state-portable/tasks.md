## 1. Prerequisites and State Inventory

- [ ] 1.1 Verify the accepted feasibility topology and resolved go conditions; inventory every Script Property, revision consumer, API writer and maintenance/loader/direct-write path.
  - Measured input from the feasibility experiment (2026-09-27, `validate-worker-backend-feasibility/evidence/verdict.md`): the free Worker as built is **no-go on CPU headroom**, and the cost that does not fit is **per-request decoding**, not transport. The decisive exact sample is 110.0 ms of CPU on the second request after a deploy — `admin.schedule.read` against a 2,158-row fixture, an already-warm isolate running its decode path for the first time — against a 10 ms limit; warm medians are 2.1–3.2 ms and the tail p99 is 83.6 ms. A read-through design that decodes every tab on every request is therefore the thing to replace, and a revision-keyed cache of the decoded snapshot is the leading candidate: filled only after authorization, never covering the `Users` read, invalidated by the revision tuple this change already has to make portable. The other measured constraint is the Sheets quota: each request costs at least one read as one service account, so 60 reads/minute/user caps sustained throughput near 20–30 requests/minute regardless of Worker CPU. Both findings bear on the authority/revision design in section 1.2 rather than on any worker runtime choice.
- [ ] 1.2 Pin the versioned control schema, authority epoch, mutation generation, pending/completed record, recovery journal bounds and exact counter advancement rules; specify failures for missing/unsupported metadata.
- [ ] 1.3 Define the configuration/secret/gate separation and protocol-compatible legacy rollback boundary; enumerate obsolete tools/deployments that must stay disabled.

## 2. Workbook Foundation

- [ ] 2.1 Fix effective schema-version resolution and repeated initialization with a regression demonstrated to fail before the fix; link evidence to original task 10.24.
- [ ] 2.2 Fix declared protected data-column ranges and test control-tab/service-identity access; demonstrate the regression against the header-only behavior and link original task 10.25.
- [ ] 2.3 Implement control metadata codecs/revision provider and idempotent initialization with tests for malformed, missing, duplicate and unsupported records.
- [ ] 2.4 Extend snapshot/schema validation and private recovery manifests to include control state without committing private exports or journal contents.

## 3. Legacy Writer and Reader Protocol

- [ ] 3.1 Implement script-lock plus live gate/authority checks and durable pending/completed generation transitions; test failure before rows, mid-write and before final completion.
- [ ] 3.2 Adapt repository commits, scheduling publication/compensation, availability/cancellation, candidates, imports and refresh to the protocol; verify global/tab/input/output revisions remain distinct.
- [ ] 3.3 Reclassify import preview staging as a mutation, require expectedRevision, and adapt its authenticated client revision source; test write-disabled/read-only/missing/stale requests with zero persistence.
- [ ] 3.4 Adapt initializer, loader, diagnostics that can initialize, and direct-write reconciliation to fenced maintenance procedures; confirm the inventory has no unaccounted writer.
- [ ] 3.5 Implement completed-generation checks around read hydration and reject pending/changed state; test concurrent completion, abort and recovery between reads.
- [ ] 3.6 Implement reviewed recovery for interrupted legacy mutations preserving audit and monotonic counters; test repeated recovery and failure during recovery.

## 4. Migration Rehearsal and Validation

- [ ] 4.1 Rehearse capture/seed/activation on synthetic staging with writes drained, repeated initialization, both reader adapters, and counter equality/monotonicity evidence.
- [ ] 4.2 Rehearse rollback before activation and protocol-compatible forward recovery after activation; demonstrate that old Property-only writers cannot be reopened accidentally.
- [ ] 4.3 Run focused regressions, npm test, npm run check, npm run build and strict validation; update architecture, security, operations, deployment and testing for implemented boundaries.

## 5. Controlled Production Activation

- [ ] 5.1 Prepare exact server/client release and workbook migration manifests, compatible rollback version and recovery procedure; obtain each specific production authorization only after preparation is reviewable.
- [ ] 5.2 For each approved server deployment or Sheet mutation export a snapshot, inspect live WRITE_ENABLED, drain writers, perform the approved action, and verify the live gate afterwards; do not use local config as proof.
- [ ] 5.3 Verify both readers' semantic outputs/counters, actual protections and interrupted-state handling; record sanitized evidence and separately authorize any write reopening.
- [ ] 5.4 Link measured prerequisite evidence to original tasks 10.24/10.25 and keep any unfulfilled original acceptance checkboxes open.

## Recorded implementation gaps (2026-09-24)

Read-only source review confirmed that `OPERATION_POLICIES` marks import preview non-mutating/read-only while `runtime.ts` calls `stageFromFetcher`, which saves import runs through `WorkbookImportRepository`. Tasks 3.2–3.3 own the repair. `validateMigrationWorkbook()` calls `applyMigrationPayload` with `apply: false`, but `loader.ts` invokes `initializeWorkbook` before checking that option; the command can change schema/protections/Settings. Task 3.4 owns the maintenance boundary. These are measured code-path findings, not completed fixes or live production tests.
