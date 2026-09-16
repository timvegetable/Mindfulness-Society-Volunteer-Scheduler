## ADDED Requirements

### Requirement: Canonical volunteer records
The system SHALL store each volunteer in Google Sheets under a stable unique identifier with name, contact email, lifecycle status, interview status, readiness rank, and recurring availability. Lifecycle status SHALL distinguish active, newly joined, and graduated volunteers, and graduated volunteers SHALL be excluded from all scheduling and availability analysis without deleting their history.

#### Scenario: Graduated volunteer is retained but excluded
- **WHEN** an administrator changes an existing volunteer's lifecycle status to graduated
- **THEN** the system retains the volunteer's historical data and excludes the volunteer from subsequent assignments, backup lists, and leftover-availability counts

#### Scenario: Newly joined volunteer is imported
- **WHEN** an import contains a person who does not match an existing stable identifier
- **THEN** the system creates one newly joined volunteer record without marking that person schedulable before required roster and interview data are complete

### Requirement: WhenIsGood availability import
The system SHALL provide an administrator-only import that retrieves a configured WhenIsGood results page, parses its embedded availability data using the referenced scraper approach, normalizes the source time slots into the scheduling time zone, and upserts matching volunteer availability into Google Sheets. The import SHALL report unmatched people and malformed or unavailable source data without partially replacing previously valid availability.

#### Scenario: Successful idempotent import
- **WHEN** an administrator imports the same unchanged WhenIsGood results more than once
- **THEN** the Sheet contains one current availability record per volunteer and time slot with no duplicate volunteers or intervals

#### Scenario: Imported name cannot be matched safely
- **WHEN** a source participant cannot be matched uniquely to a volunteer record
- **THEN** the import leaves that participant unlinked, reports the participant for administrator resolution, and does not guess a match

#### Scenario: Source parsing fails
- **WHEN** the WhenIsGood page is unavailable or its embedded data does not match the supported format
- **THEN** the import records a failed run with a diagnostic summary and preserves the last successfully imported availability

### Requirement: Numeric readiness rankings
The system SHALL store interview rankings in Google Sheets and SHALL normalize completed rankings as Primary or recurring Primary = 1, Secondary = 2, and Tertiary = 3. Only administrators SHALL be able to edit readiness ranking fields, and a volunteer without a completed numeric rank SHALL not be eligible for ranked assignment.

#### Scenario: Rankings are normalized after interviews
- **WHEN** an administrator finalizes the interview rankings
- **THEN** each completed textual ranking is stored as its corresponding numeric value and recurring Primary is stored as rank 1

#### Scenario: Volunteer lacks a completed interview
- **WHEN** scheduling evaluates an active volunteer whose interview is incomplete or whose numeric rank is absent
- **THEN** the volunteer is omitted from candidate and backup lists and is identified to administrators as not yet rank-eligible

### Requirement: Auditable Sheet updates
The system SHALL record the source, actor, and timestamp of roster, ranking, availability, assignment, and status mutations while keeping Google Sheets as the system of record.

#### Scenario: Administrator corrects an imported record
- **WHEN** an administrator changes a volunteer's status, rank, or imported availability
- **THEN** the updated value is used by future scheduling runs and the audit data identifies the administrator and update time
