## 1. Exception Withdrawal Contract

- [ ] 1.1 Add shared request/response validation and an allowlisted self-service operation for withdrawing a dated exception with an expected global revision
- [ ] 1.2 Implement caller-ownership validation, future/withdrawable-state checks, repository deletion, audit recording, and scheduling-input revision advancement
- [ ] 1.3 Add contract tests for successful withdrawal, stale revision, foreign exception refusal, missing exception handling, audit evidence, and schedule staleness

## 2. Shared Availability Calendar

- [ ] 2.1 Extract reusable week-grid geometry, proportional interval layout, readable labels, and keyboard focus primitives from the insights calendar without sharing administrator data
- [ ] 2.2 Replace the volunteer recurring and dated-exception lists with the Monday–Friday calendar and explicit non-drag editing controls
- [ ] 2.3 Add volunteer controls for withdrawing an owned dated exception and refresh the calendar from the authoritative response
- [ ] 2.4 Add component tests for proportional interval placement, interval boundaries, keyboard operation, non-color labels, and narrow-screen control affordances

## 3. Mutation Interaction State

- [ ] 3.1 Carry an in-memory success notice and semantic interaction anchor across recurring-availability and exception route invalidation
- [ ] 3.2 Restore focus and scroll after authoritative refresh, with a stable heading fallback when normalization removes the edited control
- [ ] 3.3 Prevent draft rerenders from moving an active Remove control before its interaction completes and add regression coverage. Observed in the authenticated production browser on 2026-09-21: after a successful recurring save the draft list still held the window that had just been saved, so the same window was rendered twice — once in the saved summary and once as a pending interval with a Remove control — instead of the draft being cleared on success

## 4. Cancellation Safety

- [ ] 4.1 Add an accessible confirmation step before sending an assigned-occurrence cancellation. Observed in the authenticated production browser on 2026-09-21: cancelling an assigned occurrence sent the request immediately with no confirmation step, so a single click committed the cancellation
- [ ] 4.2 Preserve or map server outcome details so the client distinguishes known pre-commit refusal from a cancellation that may have committed before promotion or notification failure
- [ ] 4.3 Add regression tests proving declined confirmation sends no request and uncertain outcomes instruct the volunteer to reload before retrying

## 5. Verification and Documentation

- [ ] 5.1 Update the self-service subsystem, operation, and testing documentation for exception withdrawal, calendar editing, refresh handoff, and cancellation semantics
- [ ] 5.2 Run focused client, integration, workbook, and accessibility tests, then run `npm test` and `npm run check`
- [ ] 5.3 Browser-verify own-data isolation, keyboard editing, save feedback and position retention, exception withdrawal, cancellation confirmation, successful backup promotion, and no-backup or downstream-failure messaging. Partially exercised in the authenticated production browser on 2026-09-21 against tagged Task 5.7 fixtures, and the results split cleanly into what works and what is missing. Working: the dashboard exposed only the caller's own rows, the saved weekly availability coalesced two adjacent Thursday intervals (09:00-11:00 and 11:00-12:00) into a single 09:00-12:00 window, a dated exception was stored date-scoped without altering recurring coverage, and both cancellations persisted — the exported workbook shows the eligible backup promoted to `assigned` with a new assignment at the published output revision, and the no-backup session left understaffed with 0 of 1 staffed, recorded in the audit trail as `cancel`, `promote` and `understaffed` entries. Missing: neither outcome was surfaced to the volunteer, who saw no promotion or understaffed result at all, and no confirmation step preceded either cancellation. Keyboard editing and exception withdrawal were not exercised
