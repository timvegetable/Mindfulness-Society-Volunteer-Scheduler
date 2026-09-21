# Self-service subsystem

## Ownership

`availability.ts` owns volunteer recurring availability and dated exceptions. `cancellation.ts` owns assigned-occurrence cancellation and backup promotion. `notifications.ts` owns administrator mail attempts/retry records. `types.ts` provides repository, transaction, audit, staleness, and result contracts.

## Authorization and revisions

Every operation derives the volunteer from the authenticated caller. A payload may not redirect a mutation to another volunteer. The volunteer must remain active. Mutations require an expected revision, write audit data, and return a classified `ServiceResult`; the integration layer converts it without broadening access.

Recurring updates normalize intervals, replace only that volunteer's authoritative rows, preserve IDs for semantically unchanged intervals when possible, advance the repository revision, and mark the schedule stale. Exceptions validate real dates, valid/configured time zones, and interval shape before append.

## Cancellation and notification

Cancellation persists the assigned-occurrence change before backup handling, then promotes the first still-eligible backup using scheduling rules and reorders remaining backups. If none is eligible, the result is explicitly understaffed. Multi-step changes run through the provided transaction/lock boundary where available.

Administrator notification happens after a valid data change. Mail failure must not roll back saved availability or cancellation. Record delivery status and expose retry separately. User-facing failure copy must account for ambiguous network outcomes: the write may have committed even if the browser did not receive the response.

Current OpenSpec follow-ups include withdrawing an exception and improving cancellation confirmation/copy; do not document them as implemented until their tasks carry evidence.

