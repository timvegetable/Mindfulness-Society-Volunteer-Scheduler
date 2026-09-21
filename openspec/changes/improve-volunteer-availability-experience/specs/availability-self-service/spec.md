## ADDED Requirements

### Requirement: Calendar-based availability editing
The volunteer interface SHALL present recurring availability and dated exceptions in one accessible Monday–Friday week calendar whose interval position and length are proportional to their times. Every editing action SHALL remain available without relying on pointer drag, color, or a visually distant native-control icon.

#### Scenario: Volunteer reviews a weekday
- **WHEN** a volunteer opens their availability calendar
- **THEN** recurring intervals and dated exceptions appear in the corresponding weekday and time positions with readable text labels and keyboard-reachable details

#### Scenario: Volunteer edits without dragging
- **WHEN** a volunteer uses the keyboard or explicit form controls to add or change an interval
- **THEN** the system provides the same valid interval editing outcome as pointer interaction

### Requirement: Stable self-service mutation feedback
After a successful self-service mutation, the client SHALL refresh from the authoritative server response while keeping a visible success confirmation and restoring the volunteer's semantic interaction position when that position still exists. Draft-list rendering SHALL not move the action being used before that interaction completes.

#### Scenario: Recurring availability save refreshes the route
- **WHEN** a recurring availability save succeeds and the route reloads authoritative data
- **THEN** the volunteer sees a save confirmation and remains at the corresponding calendar day or control

#### Scenario: Edited control no longer exists
- **WHEN** normalization or removal means the prior control is absent after refresh
- **THEN** focus moves to a stable calendar heading and the success confirmation remains visible

## MODIFIED Requirements

### Requirement: One-off availability exceptions
An authorized volunteer SHALL be able to record a dated absence or dated availability override and withdraw one of their own existing future exceptions. A dated exception SHALL take precedence over recurring availability for that date and SHALL affect assignment and backup eligibility only for overlapping occurrences. Creation and withdrawal SHALL use current revisions, audit the actor and time, and update scheduling staleness consistently.

#### Scenario: Volunteer reports Thursday absence
- **WHEN** a volunteer records an unavailable interval for a specific Thursday
- **THEN** the system preserves the volunteer's normal recurring Thursday availability and treats the volunteer as unavailable for overlapping sessions on that date

#### Scenario: Exception does not overlap a session
- **WHEN** a volunteer records a dated exception outside a session's time range
- **THEN** that exception does not change eligibility for the non-overlapping session

#### Scenario: Volunteer withdraws their future exception
- **WHEN** a volunteer withdraws one of their own future dated exceptions using the current revision
- **THEN** the system removes that exception, audits the withdrawal, advances the scheduling-input revision, and marks an affected current schedule stale

#### Scenario: Volunteer attempts to withdraw another person's exception
- **WHEN** a volunteer supplies an exception identifier that is not owned by them
- **THEN** the system refuses the mutation without revealing or changing the other volunteer's exception

### Requirement: Assigned-session cancellation
An authorized volunteer SHALL be able to cancel one of their own future assignments with an optional reason only after confirming the action. A successful cancellation SHALL persist before triggering ranked backup promotion and administrator notification. A failure response after the request is sent SHALL distinguish a known pre-commit refusal from an outcome whose cancellation may already have committed and SHALL direct the volunteer to reload before retrying when commit state is uncertain.

#### Scenario: Volunteer confirms cancellation
- **WHEN** a volunteer confirms cancellation of a future assigned session
- **THEN** the system records a dated unavailability exception, removes the assignment, invokes backup promotion, and emails administrators the cancellation and promotion or shortfall result

#### Scenario: Volunteer declines confirmation
- **WHEN** a volunteer starts cancellation but does not confirm it
- **THEN** the client sends no cancellation request and the assignment remains unchanged

#### Scenario: Downstream cancellation step fails after persistence
- **WHEN** cancellation persistence succeeds but backup promotion or administrator notification fails
- **THEN** the response and interface explain that the cancellation may already be applied and instruct the volunteer to reload before retrying
