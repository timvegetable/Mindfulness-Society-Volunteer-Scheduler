## Why

Volunteer staffing is currently spread across WhenIsGood, a tracking sheet, a ranking document, email, and manual scheduling. With roughly 70 active volunteers plus new joiners, fixed weekly center sessions, and additional UNIV100 demand, coordinators need one reliable workflow that assigns qualified available volunteers without overpromising coverage and exposes unused capacity for expansion.

Production-shaped browser use has exposed completion gaps in that workflow: scheduling reruns compare incompatible revision domains, Sheet date/time cells leak runtime representations into the interface, promoted availability is not consumed consistently by scheduling and insights, and routine navigation repeats expensive authentication, Sheet reads, and insight derivation. These are correctness and operability gaps in the same end-to-end scheduling change, not a separate feature.

## What Changes

- Import volunteer identities and availability from WhenIsGood into an authoritative current-availability dataset in Google Sheets that is consumed consistently by scheduling, volunteer views, and availability insights, while excluding graduated volunteers from scheduling.
- Move interview readiness rankings into Google Sheets and normalize completed rankings to numeric priority values: Primary/recurring Primary = 1, Secondary = 2, and Tertiary = 3.
- Generate assignments for fixed center sessions and confirmed UNIV100 classes, with no more than two volunteers per session and higher-ranked available volunteers selected first.
- Maintain ranked automatic backups so a cancellation removes the assigned volunteer and promotes the next-highest-ranked available eligible volunteer.
- Let volunteers update recurring availability and report dated, one-off absences; persist each change to Google Sheets and notify administrators by email.
- Give administrators an explicit control to rerun scheduling after availability changes, using the current global data revision for concurrency control while recording the separate scheduling-input revision, without silently promising or publishing a newly proposed class before staffing exists.
- Analyze unassigned volunteers' overlapping availability and provide a table/calendar heatmap that administrators can use to propose new centers or classes.
- In a later delivery phase, let centers enter weekday schedules and compare those schedules against volunteer availability automatically.
- Host the user interface as a static GitHub Pages site, using Google Sheets as the system of record and a credential-safe Google integration for controlled reads, writes, and email notifications.
- Normalize Sheet date and time values at the integration boundary and present each session with a human-readable center or class name, local time range, and date.
- Serve each operation from one consistent workbook snapshot, reading each required tab at most once and reusing revision-bound derived insights when their sources have not changed.
- Make authenticated navigation responsive through bounded verified-claim caching and immediate display of previously loaded valid route data while freshness is checked. Under normal warm-service conditions, target fresh read-only section loads within two seconds at the 95th percentile; Apps Script cold starts and upstream Google service delays are not a hard latency guarantee.

## Capabilities

### New Capabilities

- `volunteer-data-management`: Import and maintain the active volunteer roster, authoritative current availability, graduation status, and numeric readiness rankings in Google Sheets.
- `ranked-session-scheduling`: Assign and backfill at most two qualified available volunteers per locked center or confirmed class session according to deterministic rank and tie-breaking rules, with explicit global and scheduling-input revision semantics.
- `availability-self-service`: Allow volunteers to change recurring availability or report one-off absences, persist those changes, alert administrators, and expose an administrator scheduling rerun action.
- `availability-insights`: Compute and display revision-bound overlapping free time among currently unassigned volunteers as counts, details, and a green intensity heatmap without regenerating an unchanged projection.
- `center-schedule-matching`: Allow centers to submit Monday–Friday schedules and compare candidate times with volunteer availability after the volunteer workflow is operational.
- `responsive-application-navigation`: Display previously loaded valid section data immediately, refresh it safely against current revisions, and keep normal warm read-only loads within the defined two-second performance objective.

### Modified Capabilities

None.

## Impact

- Introduces a GitHub Pages web application for volunteer and administrator workflows.
- Establishes Google Sheets as the source of truth for volunteers, rankings, sessions, availability exceptions, assignments, backups, and scheduling runs.
- Adds a WhenIsGood import workflow based on the referenced scraper approach and a Google integration boundary for authorized Sheet access and administrator email notifications.
- Requires access control that prevents public clients from reading private volunteer data or writing arbitrary Sheet rows; secrets cannot be embedded in the static site.
- Replaces manual ranking lookup, assignment, cancellation backfill, and leftover-availability analysis while preserving fixed center session times and staff-before-promise handling for UNIV100 classes.
- Adds request-local workbook snapshots, revision-keyed derived-data reuse, and bounded server-side verification caching without trusting client caches for authorization or mutation validation.
- Establishes a two-second 95th-percentile objective for warm authenticated read-only section loads while explicitly excluding uncontrollable Apps Script cold-start and upstream-service latency from a hard guarantee.
