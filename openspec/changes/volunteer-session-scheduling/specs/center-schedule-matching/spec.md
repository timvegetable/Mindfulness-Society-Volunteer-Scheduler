## ADDED Requirements

### Requirement: Authorized center schedule entry
After the volunteer scheduling workflow is operational, an authorized center contact SHALL be able to create and edit that center's Monday–Friday candidate schedule without modifying another center or changing existing locked session occurrences.

#### Scenario: Center submits weekday hours
- **WHEN** an authorized center contact submits valid Monday–Friday candidate intervals for their center
- **THEN** the system stores the candidate schedule separately from locked and confirmed sessions and records the center, actor, and update time

#### Scenario: Center attempts to change a locked occurrence
- **WHEN** a center contact edits a candidate schedule that overlaps an already locked occurrence
- **THEN** the system leaves the locked occurrence unchanged and explains that an administrator must manage the existing session

### Requirement: Candidate schedule comparison
The system SHALL compare each center candidate interval with active, rank-eligible volunteers' recurring availability and SHALL show candidate counts and ranked volunteer details to authorized users without assigning volunteers or promising coverage.

#### Scenario: Candidate interval has matching volunteers
- **WHEN** a center submits an interval covered by eligible volunteer availability
- **THEN** the system displays the number and ranked order of matching volunteers for the full interval and labels the result as candidate coverage

#### Scenario: Candidate interval lacks required coverage
- **WHEN** fewer volunteers cover the full candidate interval than the center's requested staffing count
- **THEN** the system displays the shortfall and does not create a confirmed session or assignment

### Requirement: Administrator confirmation boundary
Only an authorized administrator SHALL be able to convert a center candidate interval into confirmed session occurrences. Confirmation SHALL require the requested staffing count to be no greater than two and current scheduling results to demonstrate sufficient eligible coverage.

#### Scenario: Administrator confirms covered candidate
- **WHEN** an administrator confirms a candidate with a staffing count of at most two and sufficient current coverage
- **THEN** the system creates the intended session occurrences for scheduling and preserves an audit link to the center submission

#### Scenario: Coverage changed before confirmation
- **WHEN** a candidate previously showed coverage but current availability no longer meets the requested staffing count
- **THEN** the system blocks confirmation and displays the current staffing shortfall

#### Scenario: Matching locked occurrence blocks confirmation
- **WHEN** an administrator attempts to confirm a candidate whose occurrence already exists as a locked session
- **THEN** the system rejects the confirmation as a conflict before writing any session or changing candidate state and creates no duplicate occurrence
