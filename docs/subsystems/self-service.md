# Self-service subsystem

## Ownership

`availability.ts` owns volunteer recurring availability and dated exceptions. `cancellation.ts` owns assigned-occurrence cancellation and backup promotion. `notifications.ts` owns administrator mail attempts/retry records. `types.ts` provides repository, transaction, audit, staleness, and result contracts.

## Authorization and revisions

Every operation derives the volunteer from the authenticated caller. A payload may not redirect a mutation to another volunteer. The volunteer must remain active. Domain mutations check expected tab revisions, write audit data, and return a classified `ServiceResult`. Runtime handlers supply those tab revisions; the API's incomplete global-revision presence enforcement is documented in [integration](integration.md#request-contract).

Recurring updates normalize intervals, replace only that volunteer's authoritative rows, preserve IDs for semantically unchanged intervals when possible, advance the repository revision, and mark the schedule stale. Exceptions validate real dates, valid/configured time zones, and interval shape before append.

## Cancellation and notification

Cancellation persists the assigned-occurrence change before backup handling, then promotes the first still-eligible backup using scheduling rules and reorders remaining backups. If none is eligible, the result is explicitly understaffed. Multi-step changes run through the provided transaction/lock boundary where available.

Administrator notification is attempted after recurring-availability updates, dated exceptions and assignment cancellation; controlled tests need an active linked volunteer caller. Mail failure does not roll back the saved change. `NotificationService` supports status/retry repositories, but the production runtime supplies no durable repository and exposes no administrator notification status/retry API or view. Status is currently request-local; durable status and a reachable retry action remain task 10.26, not implemented features. Delivery evidence and recipient diagnostics belong in [operations](../operations.md#notification-operations). User-facing failure copy must account for ambiguous network outcomes: the write may have committed even if the browser did not receive the response.

Current OpenSpec follow-ups include withdrawing an exception and improving cancellation confirmation/copy; do not document them as implemented until their tasks carry evidence.

