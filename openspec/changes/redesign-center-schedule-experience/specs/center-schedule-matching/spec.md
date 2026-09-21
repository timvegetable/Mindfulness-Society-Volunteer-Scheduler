## ADDED Requirements

### Requirement: Role-sensitive center schedule projection
The center schedule read SHALL provide a center contact's authorized center identity and display name independently of candidate rows and SHALL return only that center's candidates and sessions. An administrator SHALL receive cross-center attribution for every returned candidate and session.

#### Scenario: Center has no candidates
- **WHEN** a center contact opens the center route before any candidate exists
- **THEN** the heading names the caller's authorized center and no redundant Center column is shown

#### Scenario: Administrator reviews multiple centers
- **WHEN** an administrator opens a result containing more than one center
- **THEN** every candidate and session remains attributable to its center under a generic administrator heading

#### Scenario: Center contact attempts cross-center read
- **WHEN** a center contact requests center schedule data
- **THEN** the server excludes every candidate and session outside the caller's authorized center scope

### Requirement: Weekly and monthly center calendar
The center interface SHALL provide weekly and monthly calendar views of relevant sessions and unresolved candidate intervals. Weekly intervals SHALL be positioned and sized according to their time and duration, and both views SHALL expose equivalent readable, keyboard-accessible entity details without relying on color alone.

#### Scenario: Center contact opens weekly view
- **WHEN** a center contact opens the weekly calendar
- **THEN** that center's sessions and unresolved candidates appear at proportional weekday and time positions with accessible labels

#### Scenario: User changes to monthly view
- **WHEN** an authorized user selects the monthly view
- **THEN** the same authorized sessions and unresolved candidates appear on their calendar dates with a path to full details

### Requirement: Candidate state presentation and actions
An unresolved candidate SHALL be labelled as either candidate coverage or coverage shortfall using readable text and accessible green or red styling. A resolved candidate SHALL expose its outcome without edit or confirmation controls, and a confirmed occurrence SHALL appear in the session calendar while retaining its source-candidate audit link. A shortfall presentation SHALL expose the reason confirmation cannot currently succeed even when its confirmation control is disabled.

#### Scenario: Candidate has sufficient coverage
- **WHEN** current eligible coverage meets the candidate's requested staffing count
- **THEN** the candidate is labelled Candidate coverage with accessible positive styling and authorized unresolved-candidate actions

#### Scenario: Candidate has a shortfall
- **WHEN** current eligible coverage is below the requested staffing count
- **THEN** the candidate is labelled Coverage shortfall with accessible negative styling and the current refusal reason remains visible

#### Scenario: Candidate was confirmed
- **WHEN** a candidate has already produced confirmed session occurrences
- **THEN** it offers no edit or confirmation action and the resulting sessions appear in the calendar with their source linkage preserved
