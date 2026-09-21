## Why

The center candidate table exposes workbook-oriented records after a center's scheduling decision is already made and does not provide the weekly or monthly calendar view requested by center users. Its headings, columns, state styling, and actions also fail to adapt cleanly to the reader's role and candidate state.

## What Changes

- Present center sessions and unresolved candidate intervals in calendar-oriented weekly and monthly views rather than treating the raw candidate table as the primary experience.
- Distinguish candidate coverage and coverage shortfall visually and textually while preserving accessible, non-color meaning.
- Make confirmation affordances reflect short coverage deliberately without hiding the server's refusal reason.
- Show a center contact's own center name independently of whether candidate rows exist, omit their redundant Center column, and retain cross-center attribution for administrators.
- Remove edit and confirmation actions from resolved candidates and place confirmed occurrences in the session calendar while preserving audit linkage to the original candidate.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `center-schedule-matching`: Extend the center workflow with role-sensitive calendar presentation, explicit candidate-state styling and actions, and an independent caller-center projection. This capability is introduced by the active `volunteer-session-scheduling` change and must be synced to the main specs before this delta is archived.

## Impact

- Affects center and administrator rendering in `src/client/` and the center route projection in `src/server/`.
- Changes a read response to supply the caller's authorized center identity independently of candidate rows; authorization remains server-owned.
- Requires responsive, keyboard-accessible calendar behavior and role/tenant isolation tests.
