## Why

The administrator schedule currently labels rows with stored session lifecycle values such as `locked` and `confirmed` beside staffing outcomes such as `Understaffed by 2`. Those concepts answer different questions, so the table can mislead a reviewer during scheduling preview and publication.

## What Changes

- Present session kind or origin separately from staffing state.
- Translate stored lifecycle enums into reader-facing labels rather than displaying raw values.
- Derive staffing state from assignment and shortfall results, including fully staffed and understaffed cases.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ranked-session-scheduling`: Clarify the reviewable schedule contract so session classification and staffing outcome are displayed as separate concepts. This capability is introduced by the active `volunteer-session-scheduling` change and must be synced to the main specs before this delta is archived.

## Impact

- Affects administrator schedule and preview rendering in `src/client/`.
- May add an explicit presentation field to the schedule projection if the client cannot derive a safe label from existing typed data.
- Requires rendering tests for locked center sessions, confirmed classes, full staffing, and shortfalls.
