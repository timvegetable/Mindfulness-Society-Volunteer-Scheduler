## Why

Apps Script locking, Script Properties, request-local duplicate tracking, external imports, and MailApp cannot be replaced by mechanically translating Sheet writes. Safe migration needs one writer authority and durable recovery when Sheets commits but the response is lost.

## What Changes

- Add one workbook-scoped durable coordinator, explicit write gating, authenticated revision checks, durable request records, and recoverable workbook commit markers.
- Migrate all mutation families, including import preview staging and Insights refresh, with domain rows, audit and revisions committed consistently.
- Add durable cancellation notification outbox/status/retry and select a Worker-compatible mail transport before production cancellation cutover.
- Transfer all production writer authority in one rehearsed maintenance window; implement and test operation families incrementally beforehand.
- **BREAKING**: require expected revisions for state-changing requests and define durable successful replay rather than relying on instance-local `DUPLICATE_REQUEST` behavior. Legacy writers remain disabled after handover.

## Capabilities

### New Capabilities

- `worker-coordinated-writes`: Single-writer authority, durable idempotency, atomic workbook commits and recovery.
- `worker-notification-delivery`: Durable notification dispatch, status, retry, and delivery evidence independent of Apps Script.

### Modified Capabilities

None in the main spec tree. Existing scheduling/import/self-service requirements remain authoritative; durable replay and revision-presence enforcement are explicit improvements with regression coverage.

## Impact

Worker/Durable Object composition and storage, workbook commit adapter, mutation services, WhenIsGood fetch adapter, notification transport, client mutation handling, and operations/release tooling. Depends on portable state and accepted primary/remaining read releases. Links original notification tasks 10.26 and 10.27 without claiming completion.
