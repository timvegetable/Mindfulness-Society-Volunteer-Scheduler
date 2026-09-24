## Context

Depends on portable state and accepted Worker read releases. Production currently uses a script lock, synchronous repositories and request-local dispatcher duplicate tracking. These do not provide durable cross-request replay. Writes also include import-preview staging, derived refresh and cancellation email. Workbook operations can fail after partial persistence today; notification status defaults to memory (original task 10.26).

## Goals / Non-Goals

**Goals:** One durable writer authority, recoverable revisions/audit/domain commits, enforced optimistic concurrency, portable imports, and observable notifications.

**Non-Goals:** Two independently locked writers, replacing Sheets, guaranteeing exactly-once email, silently enabling billing, or treating old local configuration as live write authorization.

## Decisions

### One coordinator and an explicit admission boundary

Use one SQLite Durable Object per configured workbook, with immutable workbook binding and durable pending-operation state. Worker verifies identity; coordinator revalidates fresh Users authorization, write gate, writer epoch and payload before mutation admission. Check durable replay after authorization but before rejecting the original expectedRevision as stale; a committed identical request must remain replayable after revisions advance. Require expectedRevision for new mutating requests. Stale, missing, unauthorized, disabled, or wrong-authority requests have no domain effects.

Serialize across the whole external read/validate/commit/reconcile lifecycle, including await/fetch boundaries. A durable busy/pending state survives eviction and crashes; in-memory queueing alone is insufficient. Do not assume ordinary Durable Object execution serializes external awaits. Bound any concurrency-blocking section and design long I/O recovery explicitly; [Cloudflare state APIs](https://developers.cloudflare.com/durable-objects/api/state/) document interleaving and timeout considerations.

### Commit and replay protocol

Bind requests to authenticated user ID, operation, idempotency key, canonical payload and expectedRevision fingerprint. Persist prepared intent before dispatching a commit, with deterministic entity IDs and immutable response reconstruction data. Use a single Sheets batchUpdate where possible to apply domain row replacements/updates, audit entries, counters, notification outbox entries and an operation commit marker. Keep the receipt and revision changes in the same workbook commit, with deterministic cell targets to avoid append duplication during safe retries. Google atomic batching does not form a transaction with coordinator storage or mail.

After a lost response, reconcile the workbook marker before marking the durable record committed. Marker absence immediately after a timeout is not proof that the original request cannot still commit. Keep the operation unresolved and block conflicting work until the prior attempt is conclusively resolved or a proved replay-safe deterministic commit is used. A stuck or ambiguous operation needs reviewed recovery, not automatic clearing. Persisted outcomes/markers must allow recovery after coordinator loss; Sheets remains authoritative for domain commit truth.

Retain replayable results for at least 24 hours; retain compact non-reexecution tombstones thereafter until a separately specified archival policy is established. An expired result returns a controlled conflict/reconciliation instruction rather than running the old key again. Persist only data needed for replay, protect any private response data, and return it only after current authorization. Changed fingerprint returns CONFLICT. The client retains the original key for a retry of the same user intent and reconciles ambiguous failures before issuing a new mutation intent.

### Port all mutation families before writer handover

The coordinated operation set is:

- volunteer.availability.recurring.update
- volunteer.availability.exception.create
- volunteer.assignment.cancel
- admin.schedule.rerun
- admin.import.whenIsGood.preview
- admin.import.whenIsGood.promote
- admin.import.mapping.upsert
- admin.insights.refresh
- center.candidate.update
- admin.center.candidate.confirm

Preserve semantic interval coverage, ownership, current eligibility, cancellation backup selection, reviewed preview revisions, import matching/provenance, center restrictions and assignment publication. WhenIsGood I/O uses the configured server endpoint and bounded fetches; do not accept arbitrary URLs. Bind persisted staging/mapping results to the validated snapshot. Insights refresh advances its global/refresh generations consistently, while cached derived output remains disposable.

Use separate Viewer read credentials and Editor write credentials by default; the read service must not gain mutation capability incidentally. Domain writes remain behind workbook adapters. Maintenance writes must obey the same authority/epoch or a stopped-service recovery procedure.

### Durable notification outbox

Preserve all three existing notification triggers: recurring-availability update, dated exception and cancellation. Commit each notification intent with its corresponding mutation result and audit, not as an untracked post-response send. Persist attempts and delivered/failed/unknown status durably and expose administrator-only inspection and retry operations with strict payloads and expected revisions where state changes. Select a Worker-compatible mail provider or delegated sender after checking zero-cost limits and credential scope; a Sheets service account does not confer the owner's mailbox authority. Provider selection is a gate before implementing that adapter and before cancellation cutover, not permission to omit notifications.

Use a stable message key when the provider supports deduplication. If send outcome is unknown, record it as unknown and reconcile before automatic resend; do not claim exactly-once external delivery. No Apps Script mail relay counts as full migration. Link durable status/retry evidence to original 10.26, and an actually observed application email to 10.27; do not close either from a mocked mailer.

### Writer cutover and rollback

Build each family behind disabled routing, but switch authority once. Neither per-operation production migration nor a frontend URL edit prevents an old tab from submitting to the legacy endpoint. Legacy server must reject writes after authority changes, independently of client routing. Fence authority with a monotonically increasing epoch and live platform gates.

Rollback after Worker writes requires disabling/draining the coordinator, resolving every pending operation, preserving updated counters and durable replay/notification records, then selecting exactly one compatible writer at a new epoch. Legacy rollback is writable only if it can enforce the commit/replay protocol; otherwise rollback is read-only maintenance until a forward fix. A stale historical deployment is not a valid writer rollback. Replaying pre-cutover requests across authority transfer must be tested.

## Risks / Trade-offs

- [Distributed uncertainty] → Commit receipts, deterministic writes, persistent pending state and tested recovery; no exactly-once claim beyond proved workbook effects.
- [Coordinator bottleneck or quota exhaustion] → Bound queue/admission and retry budgets, expose safe unavailable/conflict outcomes, measure free-plan capacity.
- [Email provider cost/scope unsuitable] → Resolve before adapter work; keep production cancellation on legacy until the whole handover gate passes.
- [Long-lived replay data contains private values] → Minimize retained fields, restrict access, and define retention/tombstone policy with safe non-reexecution.

## Migration Plan

Rehearse multi-client concurrency, stale/missing revisions, duplicate keys across restarts, ambiguous commits, partial legacy recovery and notification failures on synthetic staging. Validate full tests/checks/builds/specs. Prepare exact release and rollback manifests with all mutations accounted for. Each production deployment/mutation requires its specific approval, snapshot and live WRITE_ENABLED verification per operations.md. In the approved handover window disable and drain legacy writes, reconcile pending work, capture state, advance writer epoch, enable Worker authority, route mutations, verify then separately approve reopening. Record browser outcomes and commit/audit/revision counts. Retain a compatible rollback route throughout the later observation period.

## Open Questions

- Select and validate the actual no-cost mail transport and sender identity before its adapter is implemented.
- Pin batch-size bounds, operation deadline and ambiguous-commit recovery timing against Google behavior before write staging acceptance.
- Decide whether maintaining a fully replay-compatible legacy writer is worthwhile; default rollback posture is stopped writes plus a forward fix until that compatibility is proven.
