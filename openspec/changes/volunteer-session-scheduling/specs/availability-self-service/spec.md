## ADDED Requirements

### Requirement: Authorized volunteer self-service
The system SHALL authenticate each volunteer and authorize access only to that volunteer's own recurring availability, dated exceptions, and assignments. Administrator-only data and actions, including other volunteers' details and scheduling reruns, SHALL not be exposed to volunteers.

#### Scenario: Volunteer opens their availability
- **WHEN** an active authenticated volunteer opens the self-service site
- **THEN** the system shows that volunteer's current recurring availability, dated exceptions, and assignments without exposing another volunteer's private data

#### Scenario: Unknown identity attempts access
- **WHEN** an authenticated identity is not linked to an active volunteer record
- **THEN** the system denies volunteer data access and records the rejected attempt without revealing roster contents

### Requirement: Recurring availability updates
An authorized volunteer SHALL be able to replace their own weekly recurring availability. The system SHALL validate time intervals and time zone, persist the change to Google Sheets, mark affected future schedules stale, and notify configured administrators only after persistence succeeds.

#### Scenario: Volunteer changes weekly availability
- **WHEN** a volunteer submits valid recurring availability different from the stored value
- **THEN** the system stores the new intervals, records the actor and time, marks affected future schedules stale, and emails administrators a summary of the change

#### Scenario: Sheet update fails
- **WHEN** the system cannot persist a recurring availability change
- **THEN** it reports the failure to the volunteer, does not show the change as saved, and does not send a success notification

### Requirement: One-off availability exceptions
An authorized volunteer SHALL be able to record a dated absence or dated availability override. A dated exception SHALL take precedence over recurring availability for that date and SHALL affect assignment and backup eligibility only for overlapping occurrences.

#### Scenario: Volunteer reports Thursday absence
- **WHEN** a volunteer records an unavailable interval for a specific Thursday
- **THEN** the system preserves the volunteer's normal recurring Thursday availability and treats the volunteer as unavailable for overlapping sessions on that date

#### Scenario: Exception does not overlap a session
- **WHEN** a volunteer records a dated exception outside a session's time range
- **THEN** that exception does not change eligibility for the non-overlapping session

### Requirement: Assigned-session cancellation
An authorized volunteer SHALL be able to cancel one of their own future assignments with an optional reason. A successful cancellation SHALL persist before triggering ranked backup promotion and SHALL notify administrators of the cancellation and resulting staffing state.

#### Scenario: Volunteer cancels an assigned occurrence
- **WHEN** a volunteer confirms cancellation of a future assigned session
- **THEN** the system records a dated unavailability exception, removes the assignment, invokes backup promotion, and emails administrators the cancellation and promotion or shortfall result

### Requirement: Explicit administrator rerun
The administrator interface SHALL show when a current schedule is stale and SHALL provide an authorized, deliberate action to rerun the scheduling algorithm against the latest Sheet data. It SHALL prevent concurrent reruns and show the resulting revision or failure without discarding the prior completed revision. Stale state SHALL be derived by comparing the latest completed run's scheduling-input revision with the current scheduling-input revision.

#### Scenario: Administrator reruns after an availability update
- **WHEN** an authorized administrator invokes rerun while the schedule is stale
- **THEN** the system runs scheduling once against a consistent input revision and shows the completed new revision and any understaffed sessions

#### Scenario: Another rerun is in progress
- **WHEN** an administrator invokes rerun while a scheduling run already holds the scheduling lock
- **THEN** the system does not start a competing run and reports that scheduling is already in progress

### Requirement: Reviewed scheduling publication
The administrator interface SHALL require a fresh read-only preview before publication: the administrator previews assignments, backups, shortfalls, and proposed-session exclusions, then publishes the approved preview using the global revision returned by that preview. Publication SHALL be rejected when any intervening mutation changed the global revision, forcing a new preview. Every client mutation, including volunteer self-service writes, SHALL carry the read response's global revision for concurrency control.

#### Scenario: Publish after a reviewed preview
- **WHEN** an administrator publishes the preview they just reviewed without any intervening mutation
- **THEN** the system publishes the deterministic schedule for the previewed inputs and reports the new completed output revision

#### Scenario: Intervening mutation requires a new preview
- **WHEN** any mutation occurs between preview and publication
- **THEN** the publication is rejected with the current global revision and the administrator must preview again before publishing
