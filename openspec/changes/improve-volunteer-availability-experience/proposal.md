## Why

Production-shaped use shows that volunteer availability is functionally editable but unnecessarily difficult to understand and recover from. The self-service workflow needs a calendar-shaped editor, stable post-save feedback, reversible dated exceptions, and cancellation messaging that reflects the operation's commit boundary.

## What Changes

- Replace separate long interval lists with one accessible Monday–Friday calendar used to read and edit recurring availability and dated exceptions.
- Preserve save confirmation, scroll position, and the user's interaction context across the required post-mutation refresh.
- Let a volunteer withdraw one of their own dated availability exceptions through an authorized, revision-checked operation.
- Require confirmation before an assigned-occurrence cancellation and explain that a reported downstream failure may follow a successfully committed cancellation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `availability-self-service`: Extend the self-service contract with calendar-based editing, durable interaction feedback, exception withdrawal, and commit-aware cancellation confirmation and failure messaging. This capability is introduced by the active `volunteer-session-scheduling` change and must be synced to the main specs before this delta is archived.

## Impact

- Affects volunteer dashboard rendering and client route-refresh behavior in `src/client/`.
- Adds a narrow self-service mutation and corresponding validation, authorization, revision, workbook, and audit handling in `src/server/` and `src/shared/`.
- Requires browser coverage for keyboard access, calendar interval editing, post-save state, exception withdrawal, and cancellation outcomes.
