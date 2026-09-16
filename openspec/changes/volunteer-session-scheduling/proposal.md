## Why

Volunteer staffing is currently spread across WhenIsGood, a tracking sheet, a ranking document, email, and manual scheduling. With roughly 70 active volunteers plus new joiners, fixed weekly center sessions, and additional UNIV100 demand, coordinators need one reliable workflow that assigns qualified available volunteers without overpromising coverage and exposes unused capacity for expansion.

## What Changes

- Import volunteer identities and availability from WhenIsGood into Google Sheets, while excluding graduated volunteers from scheduling.
- Move interview readiness rankings into Google Sheets and normalize completed rankings to numeric priority values: Primary/recurring Primary = 1, Secondary = 2, and Tertiary = 3.
- Generate assignments for fixed center sessions and confirmed UNIV100 classes, with no more than two volunteers per session and higher-ranked available volunteers selected first.
- Maintain ranked automatic backups so a cancellation removes the assigned volunteer and promotes the next-highest-ranked available eligible volunteer.
- Let volunteers update recurring availability and report dated, one-off absences; persist each change to Google Sheets and notify administrators by email.
- Give administrators an explicit control to rerun scheduling after availability changes, without silently promising or publishing a newly proposed class before staffing exists.
- Analyze unassigned volunteers' overlapping availability and provide a table/calendar heatmap that administrators can use to propose new centers or classes.
- In a later delivery phase, let centers enter weekday schedules and compare those schedules against volunteer availability automatically.
- Host the user interface as a static GitHub Pages site, using Google Sheets as the system of record and a credential-safe Google integration for controlled reads, writes, and email notifications.

## Capabilities

### New Capabilities

- `volunteer-data-management`: Import and maintain the active volunteer roster, availability, graduation status, and numeric readiness rankings in Google Sheets.
- `ranked-session-scheduling`: Assign and backfill at most two qualified available volunteers per locked center or confirmed class session according to deterministic rank and tie-breaking rules.
- `availability-self-service`: Allow volunteers to change recurring availability or report one-off absences, persist those changes, alert administrators, and expose an administrator scheduling rerun action.
- `availability-insights`: Compute and display overlapping free time among currently unassigned volunteers as counts, details, and a green intensity heatmap.
- `center-schedule-matching`: Allow centers to submit Monday–Friday schedules and compare candidate times with volunteer availability after the volunteer workflow is operational.

### Modified Capabilities

None.

## Impact

- Introduces a GitHub Pages web application for volunteer and administrator workflows.
- Establishes Google Sheets as the source of truth for volunteers, rankings, sessions, availability exceptions, assignments, backups, and scheduling runs.
- Adds a WhenIsGood import workflow based on the referenced scraper approach and a Google integration boundary for authorized Sheet access and administrator email notifications.
- Requires access control that prevents public clients from reading private volunteer data or writing arbitrary Sheet rows; secrets cannot be embedded in the static site.
- Replaces manual ranking lookup, assignment, cancellation backfill, and leftover-availability analysis while preserving fixed center session times and staff-before-promise handling for UNIV100 classes.
