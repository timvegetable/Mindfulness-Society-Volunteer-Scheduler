## ADDED Requirements

### Requirement: Leftover volunteer population
The system SHALL derive the leftover population from active, rank-eligible volunteers who have no current session assignment, excluding graduated, inactive, and unranked volunteers. The analysis SHALL use recurring weekly availability for planning repeat opportunities and clearly identify the schedule revision on which the population is based.

#### Scenario: Volunteer has no current assignment
- **WHEN** an active ranked volunteer is available but has no assignment in the selected schedule revision
- **THEN** the volunteer contributes to overlapping-availability analysis

#### Scenario: Volunteer is already assigned
- **WHEN** an active ranked volunteer has at least one assignment in the selected schedule revision
- **THEN** the volunteer is excluded from the leftover population for that revision

### Requirement: Weekly overlap calculation
The system SHALL calculate, in the configured scheduling time zone and fixed display increments, how many distinct leftover volunteers are available for each Monday–Friday interval. Adjacent intervals with the same volunteer set SHALL be groupable into human-readable windows such as “3 volunteers can do Tuesdays 2–4 PM.”

#### Scenario: Three volunteers share adjacent intervals
- **WHEN** the same three leftover volunteers are available for every increment from Tuesday 2:00 PM through 4:00 PM
- **THEN** the system may present one Tuesday 2:00–4:00 PM window with a count of three and those three volunteers in its detail

#### Scenario: Availability changes within a window
- **WHEN** the available volunteer set changes at 3:00 PM
- **THEN** the system does not present a single 2:00–4:00 PM window as though the same volunteers cover it completely

### Requirement: Table and calendar heatmap
The administrator interface SHALL display the overlap result in both a sortable table and a weekly calendar grid. Calendar cells SHALL use an accessible green intensity scale based on volunteer count, include the numeric count in text, and expose the contributing volunteer names to authorized administrators.

#### Scenario: Counts vary across time slots
- **WHEN** displayed intervals have different available-volunteer counts
- **THEN** higher counts use stronger green intensity while every interval remains distinguishable by a visible numeric count without relying on color alone

#### Scenario: Administrator selects a heatmap cell
- **WHEN** an administrator selects an interval with available volunteers
- **THEN** the interface shows the interval, count, and contributing volunteer names from the same analysis revision

### Requirement: Insight freshness
The system SHALL mark availability insights stale when volunteer eligibility, recurring availability, or the current assignment revision changes and SHALL regenerate them from one consistent data revision before presenting them as current.

#### Scenario: Scheduling changes the leftover population
- **WHEN** a new scheduling revision assigns or unassigns volunteers
- **THEN** previously generated insights are marked stale until recalculated against that scheduling revision
