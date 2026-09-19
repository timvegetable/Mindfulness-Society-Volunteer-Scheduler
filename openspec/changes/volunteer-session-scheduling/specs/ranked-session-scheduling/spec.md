## ADDED Requirements

### Requirement: Schedulable session controls
The system SHALL schedule only active, fixed center sessions and confirmed UNIV100 sessions. Existing center dates and times through December SHALL be treated as locked input, and a proposed UNIV100 session SHALL not be confirmed or presented as staffed unless enough eligible available volunteers have been assigned for its required staffing count.

#### Scenario: Locked center session is scheduled
- **WHEN** the scheduler runs for a locked center session
- **THEN** it may change volunteer assignments but does not change the session's date, start time, end time, center, or required staffing count

#### Scenario: Proposed class lacks coverage
- **WHEN** a proposed UNIV100 session has fewer eligible available volunteers than its required staffing count
- **THEN** the system leaves the class unconfirmed, reports the staffing shortfall, and does not publish a staffing promise

### Requirement: Started-session cutoff
The system SHALL evaluate each scheduling run at a required `asOf` instant. It SHALL interpret every session's local date and start time in the configured scheduling time zone and SHALL schedule only occurrences whose start instant is strictly later than `asOf`.

#### Scenario: Past occurrence is excluded
- **WHEN** a committed session started before `asOf`
- **THEN** the scheduler produces no assignment, backup, shortfall, or occupancy for that occurrence and the preview/publication session projection omits it

#### Scenario: Exact-cutoff occurrence is excluded
- **WHEN** a committed session's start instant is exactly equal to `asOf`
- **THEN** the scheduler treats it as already started and produces no assignment, backup, shortfall, or occupancy for that occurrence

#### Scenario: Future occurrence is evaluated
- **WHEN** a committed session's start instant is strictly later than `asOf`
- **THEN** the scheduler evaluates it using the normal rank, availability, overlap, assignment, and backup rules

#### Scenario: Proposed exclusion remains distinct from cutoff exclusion
- **WHEN** a proposed UNIV100 session is present along with past and future committed sessions
- **THEN** the result reports the proposed session as a proposal exclusion separately from the time-based exclusions

### Requirement: Ranked deterministic assignment
For each schedulable session, the system SHALL assign no more than two active, rank-eligible volunteers who are available for the entire session and have no overlapping assignment. It SHALL prefer rank 1 over rank 2 over rank 3 and SHALL apply a documented stable tie-breaker among volunteers with the same rank so identical inputs produce identical assignments.

#### Scenario: More volunteers are available than needed
- **WHEN** a session needs two volunteers and eligible volunteers of ranks 1, 2, and 3 are available
- **THEN** the two volunteers selected are the highest-priority candidates according to rank and the stable tie-breaker

#### Scenario: Volunteer has an overlapping assignment
- **WHEN** a volunteer is available generally but is already assigned to another overlapping session
- **THEN** the scheduler excludes that volunteer from the overlapping session's assignment and backup candidates

#### Scenario: Fewer than two volunteers are available
- **WHEN** a session has fewer eligible available volunteers than its required staffing count
- **THEN** the system assigns only the eligible candidates, marks the session understaffed, and reports the unfilled count

### Requirement: Ordered backup lists
The system SHALL maintain an ordered backup list for every staffed or partially staffed session using the same availability, eligibility, rank, overlap, and tie-break rules as primary assignment, excluding volunteers already assigned to that session.

#### Scenario: Session has surplus eligible volunteers
- **WHEN** a scheduling run assigns the required volunteers and additional eligible volunteers remain
- **THEN** the system stores those additional volunteers as a uniquely ordered backup list for that session

### Requirement: Cancellation promotion
When an assigned volunteer cancels a specific session, the system SHALL remove that assignment and promote the first backup who remains active, eligible, available, and free of overlapping assignments. If no backup remains eligible, it SHALL mark the session understaffed and alert administrators.

#### Scenario: Highest backup remains eligible
- **WHEN** an assigned volunteer cancels and the first backup remains eligible and available
- **THEN** the system atomically removes the cancelling volunteer, assigns the first backup, recalculates the remaining ordered backups, and records the promotion

#### Scenario: First backup is no longer available
- **WHEN** an assigned volunteer cancels and the first backup is unavailable for that occurrence
- **THEN** the system skips that person and promotes the next eligible available backup

#### Scenario: No backup is available
- **WHEN** an assigned volunteer cancels and no backup remains eligible and available
- **THEN** the system leaves the position unfilled, marks the session understaffed, and sends an administrator alert

### Requirement: Reviewable scheduling runs
The system SHALL persist each scheduling run's input revision, assignments, backups, understaffed sessions, and completion status before making the result current. A failed run SHALL leave the last completed schedule current.

#### Scenario: Scheduling run succeeds
- **WHEN** all sessions are evaluated and the complete result is persisted
- **THEN** the new schedule becomes current as one revision and administrators can inspect its assignments, backups, and shortfalls

#### Scenario: Scheduling run fails midway
- **WHEN** an error prevents a scheduling run from completing
- **THEN** the incomplete result does not replace the current schedule and administrators receive a failure diagnostic

### Requirement: Separate global and scheduling-input revisions
Every read projection SHALL report the current global data revision as its revision and SHALL name the dedicated scheduling-input counter and the latest completed run's output revision separately. The scheduling-input counter SHALL advance exactly once whenever Volunteers, RecurringAvailability, AvailabilityExceptions, or Sessions commits, SHALL remain unchanged for reads and unrelated tabs, and schedule staleness SHALL be derived by comparing the latest completed run's recorded input revision with the current scheduling-input revision. Mutation requests SHALL carry the read response's global revision for concurrency control.

#### Scenario: Unrelated change does not make the schedule stale
- **WHEN** a tab outside the scheduling inputs changes
- **THEN** the scheduling-input revision is unchanged and a completed schedule is not marked stale by that change

#### Scenario: Scheduling-input change marks the schedule stale
- **WHEN** any scheduling-input tab changes, including a change whose tab revision is not the highest revision in the workbook
- **THEN** the scheduling-input revision advances and the completed run's recorded input revision no longer matches, so the schedule is stale

#### Scenario: Revisions are reported separately
- **WHEN** an administrator reads the schedule while the global, scheduling-input, and completed-run output revisions differ
- **THEN** the response reports the global revision as revision, the dedicated input counter as inputRevision, and the completed run's output revision as scheduleRevision

### Requirement: Read-only scheduling preview
The system SHALL provide an administrator-only read-only preview that hydrates the current workbook snapshot, runs the deterministic scheduler in memory, and returns the same assignments, backups, shortfalls, revision fields, and explicit proposed-session exclusions as a publication would, without writing any Sheet row, run record, audit entry, or revision. Publication SHALL recompute the schedule under the write lock and SHALL reject a publish whose expected global revision no longer matches.

#### Scenario: Preview has no side effects
- **WHEN** an administrator requests a scheduling preview
- **THEN** the response contains the projected assignments, backups, shortfalls, proposed-session exclusions, and revision fields, and no Sheet, run, audit, or revision state changes

#### Scenario: Approved preview is published
- **WHEN** an administrator publishes with the global revision returned by the reviewed preview and no intervening mutation occurred
- **THEN** the run completes against the unchanged inputs and its deterministic result becomes the current schedule

#### Scenario: Stale preview cannot publish
- **WHEN** a mutation changed the global revision after the preview was generated
- **THEN** publication is rejected with the current revision and a new preview is required before publishing
