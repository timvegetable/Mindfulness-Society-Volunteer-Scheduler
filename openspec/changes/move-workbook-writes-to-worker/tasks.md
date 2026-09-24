## 1. Preconditions and Protocol

- [ ] 1.1 Verify portable-state and both read-release evidence; reconcile the mutation inventory including import preview, Insights refresh, maintenance paths and notification operations to add.
- [ ] 1.2 Pin coordinator states, admission/deadline/queue bounds, authority epoch, durable request schema, 24-hour replay retention/tombstones and authenticated result reconciliation contract.
- [ ] 1.3 Pin workbook batch/receipt layout, deterministic IDs/cell targets, affected revision increments, audit/outbox schema and recovery procedure for uncertain or oversized commits.
- [ ] 1.4 Select and validate a Worker-compatible mail provider/sender with acceptable free-tier limits, scope, delivery observation and deduplication/unknown-outcome behavior before implementing its adapter.

## 2. Coordinator and Workbook Commit Boundary

- [ ] 2.1 Implement workbook-scoped SQLite Durable Object configuration, separate read/write credentials and live gate/epoch admission; test missing/malformed/disabled configuration.
- [ ] 2.2 Implement fresh authorization and expectedRevision enforcement for new mutations with identity-bound durable fingerprints; test missing/stale revisions and changed payloads.
- [ ] 2.3 Implement replay-before-current-revision checking, durable result reconstruction and expired-result tombstones; test revocation, restart and same-key replay without extra effects.
- [ ] 2.4 Implement durable serialization across external awaits and eviction, with bounded busy responses and no independent legacy writer; test two concurrent callers around each await boundary.
- [ ] 2.5 Implement prepared intents and atomic Sheets domain/audit/revision/outbox/receipt batches through workbook adapters; test invalid batches and deterministic duplicate safety.
- [ ] 2.6 Implement ambiguous-commit reconciliation that distinguishes absent receipt from conclusive non-commit; inject delayed original commits, lost responses, coordinator crash and recovery crash.
- [ ] 2.7 Implement client retry/result reconciliation preserving the same key for the same intent, with no automatic new-key retry or legacy fallback.

## 3. Mutation Families

- [ ] 3.1 Port recurring availability update and exception creation; verify semantic interval coverage, ownership, expected revisions and audit effects.
- [ ] 3.2 Port assignment cancellation and backup selection with atomic notification intent; verify cancelled/unavailable cases and duplicate/recovery outcomes.
- [ ] 3.3 Port schedule publication from the reviewed global revision with assignments/backups/run committed consistently; inject failures and verify no partial published output.
- [ ] 3.4 Port configured WhenIsGood fetch/parse and coordinated preview staging; verify bounded fetch errors, failed-run diagnostics and no arbitrary URL access.
- [ ] 3.5 Port import promotion and identity mapping/restaging; verify authoritative rows/provenance/run atomicity and unchanged-source idempotence after mappings change.
- [ ] 3.6 Port Insights refresh with global/refresh generation consistency and safe derived-cache replacement.
- [ ] 3.7 Port candidate updates and administrator confirmation; test center ownership and rejection of center-contact confirmation attempts.
- [ ] 3.8 Adapt remaining maintenance mutations to coordinator authority or an explicitly stopped-service recovery mode; close the writer inventory with evidence.

## 4. Notification Persistence and Delivery

- [ ] 4.1 Implement durable intents for all three existing triggers (recurring availability, dated exceptions and cancellations), outbox dispatch and bounded retry scheduling with persisted failed/delivered/unknown states; test restart before send and after provider acceptance.
- [ ] 4.2 Add administrator status/retry policies, strict payloads, revision-aware handlers and reachable client controls; test authorization, duplicate retry and unchanged cancellation state.
- [ ] 4.3 Observe an actual application notification at the intended staging test recipient and rehearse known-failure retry/unknown-outcome reconciliation; link durable evidence to original 10.26/10.27 without claiming production observation prematurely.

## 5. Full Rehearsal and Validation

- [ ] 5.1 Run the all-family concurrency/failure matrix, including prior successful replay after revision changes, across restart and authority transfer; record exact row/audit/revision/outbox counts.
- [ ] 5.2 Measure coordinator CPU, Sheets quotas/batch sizes, queue bounds and mail limits on the selected free plan; resolve resource failures without changing billing implicitly.
- [ ] 5.3 Rehearse handover and rollback with old client tabs and pending operations; prove legacy write rejection and document whether writable legacy rollback is actually compatible or maintenance-only.
- [ ] 5.4 Run focused regressions, npm test, npm run check, all builds and strict OpenSpec validation; update architecture/security/operations/testing/deployment and subsystem documentation.

## 6. One Production Writer Handover

- [ ] 6.1 Prepare exact release, authority-transfer, snapshot/recovery and rollback manifests with all prerequisites and notification readiness reviewed; obtain each specific deployment/mutation approval separately.
- [ ] 6.2 In the approved window export a workbook snapshot, inspect live WRITE_ENABLED and coordinator gates, disable/drain legacy writes and reconcile all pending state before advancing authority epoch.
- [ ] 6.3 Deploy/activate/reroute only as individually approved, verify old endpoints reject writes, and separately authorize write reopening with exactly one writer.
- [ ] 6.4 Verify production mutation-family results, durable replay and observed notification delivery using approved bounded procedures; record restoration/audit/counter evidence and outstanding original acceptance work accurately.
- [ ] 6.5 Record handover evidence and the retirement observation-window start while retaining the verified rollback posture.
