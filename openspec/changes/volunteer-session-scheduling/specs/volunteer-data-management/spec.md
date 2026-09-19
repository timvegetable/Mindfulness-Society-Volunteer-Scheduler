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

### Requirement: Authoritative promoted availability
Promoting a validated import SHALL replace the recurring availability dataset consumed by scheduling, availability self-service, center coverage comparison, and availability insights, while staged import records remain provenance only. Promotion SHALL write the authoritative recurring rows and the provenance records before the run is marked promoted and SHALL restore both previous sets if either write fails. Import preview SHALL compare staged intervals with the authoritative recurring rows, including self-service changes made since any earlier import.

#### Scenario: Promotion changes scheduling and insight eligibility
- **WHEN** a staged, matched interval is promoted for an eligible volunteer
- **THEN** subsequent scheduling candidate evaluation and availability insights use the promoted recurring interval immediately

#### Scenario: Failed promotion preserves prior availability
- **WHEN** either the authoritative rows or the provenance records cannot be written during promotion
- **THEN** the previous authoritative availability and provenance records remain unchanged and the run is not marked promoted

#### Scenario: Preview reflects authoritative changes since the last import
- **WHEN** a volunteer changed recurring availability after the last import and the same source result is imported again
- **THEN** the preview compares the staged intervals with the current authoritative rows instead of the previous import records

### Requirement: Administrator reconciliation of unmatched imports
Administrators SHALL resolve unmatched or ambiguous import participants through strict, audited mapping operations that require the expected global revision and at least one source identity. An unchanged staged import with unmatched participants SHALL be re-matched after the mapping revision changes without duplicating availability rows and without hand-edited mapping rows.

#### Scenario: Administrator maps an unmatched participant
- **WHEN** an administrator submits a source identity and a target volunteer for an unmatched participant
- **THEN** the system stores or updates the mapping, audits the change, and re-runs matching for the staged import

#### Scenario: Unchanged import is re-matched without duplication
- **WHEN** the same source result is re-imported after a mapping change reconciled the previously unmatched participants
- **THEN** the staged run is updated in place and the promoted availability contains no duplicate volunteer intervals

### Requirement: Normalized workbook temporal values
The integration boundary SHALL normalize Sheet date and clock cells using the configured IANA time zone into canonical `YYYY-MM-DD` date, `HH:mm` clock, and ISO 8601 instant values before schema validation, SHALL accept canonical strings and numeric time-of-day fractions, and SHALL leave unrecognized text unchanged so validation fails loudly. Session presentations SHALL use a human-readable center or class name resolved from the workbook together with a readable local date and time range.

#### Scenario: Sheet date cells are normalized
- **WHEN** a Spreadsheet date cell containing 2026-09-04 and clock cells containing 09:32 and 17:00 are read in the configured time zone
- **THEN** the codecs decode 2026-09-04, 09:32, and 17:00 as canonical values

#### Scenario: Session label is readable
- **WHEN** a session is presented to a volunteer or administrator
- **THEN** the label uses the resolved center or class name and a readable local date and time range
