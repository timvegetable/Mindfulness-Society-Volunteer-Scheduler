## Context

Volunteer operations currently span WhenIsGood, a roster/tracking Sheet, a separate ranking document, email, and manual assignment. Approximately 70 active volunteers plus new joiners must cover four recurring centers with fixed sessions through December and a growing set of UNIV100 classes. Center times are inputs, not windows to optimize; proposed classes must remain unconfirmed until staffing exists.

The user interface must be hostable on GitHub Pages and Google Sheets must remain the operational system of record. A public static bundle cannot safely contain Google service-account credentials, write arbitrary Sheet ranges, or send administrator email. The design therefore keeps the application static while using a minimal Google Apps Script web application as the privileged integration boundary; there is no separately hosted application server or database.

Stakeholders are volunteers, faculty interviewers, administrators/coordinators, and—in a later phase—authorized center contacts.

## Goals / Non-Goals

**Goals:**
- Consolidate roster state, rankings, availability, sessions, assignments, backups, and audit history in a documented Google Sheets schema.
- Produce deterministic ranked assignments and automatic cancellation backfills while never assigning more than two volunteers to a session.
- Support safe volunteer self-service and administrator-triggered recomputation.
- Expose unused recurring volunteer capacity for planning additional centers or classes.
- Keep the UI deployable as static assets on GitHub Pages without publishing credentials or private Sheet data.
- Add center-entered candidate schedules only after the volunteer workflow is stable.

**Non-Goals:**
- Optimizing or moving the locked center session calendar.
- Automatically promising, confirming, or publishing new classes solely because a candidate time was entered.
- Replacing Google Sheets with an application database.
- Building payroll, attendance, interview, or general volunteer-management systems.
- Supporting weekend center schedule entry in the later center phase.

## Decisions

### Static client with a Google Apps Script integration boundary

The GitHub Pages application will contain only public configuration such as the OAuth client identifier and Apps Script deployment URL. Google Identity Services will authenticate users. The Apps Script endpoint will validate identity tokens, map verified email addresses to Sheet records and roles, authorize every operation, perform narrow Sheet reads/writes under a lock, and send email through Google services. The endpoint URL is not treated as a secret.

Requests will use an explicit operation allowlist and validated payload schemas rather than accepting Sheet names, ranges, formulas, or arbitrary queries from the browser. Volunteer responses will be scoped to the caller; aggregate names and administrative controls require the administrator role. State-changing requests will carry an idempotency key and expected data revision.

Alternative considered: call the Google Sheets API directly from the static client. Rejected because every volunteer would need broad Sheet permissions or the site would need to expose privileged credentials; either choice leaks unrelated volunteer data and write authority. Alternative considered: a conventional API and database. Rejected because it conflicts with the requested hosting footprint and duplicates the required Sheet source of truth.

### Versioned workbook schema

Use separate protected tabs for `Volunteers`, `RecurringAvailability`, `AvailabilityExceptions`, `Sessions`, `Assignments`, `Backups`, `SchedulingRuns`, `Imports`, `Users`, `Settings`, and append-only `AuditLog`. Stable opaque IDs link rows; display names are never join keys. Timestamps use ISO 8601 instants, session and availability intervals carry the configured IANA time zone, and weekday recurring intervals are normalized into non-overlapping ranges.

`Volunteers` owns lifecycle status, interview status, and numeric rank. Text labels may be retained for display/import audit, but scheduling reads only numeric values 1–3. Protected ranges and Apps Script validation prevent volunteers from modifying role, rank, or lifecycle fields.

Alternative considered: one denormalized tab. Rejected because recurring ranges, dated exceptions, assignments, and audit events have different lifecycles and would create duplicate mutable facts.

### Staged, idempotent WhenIsGood import

An administrator supplies the configured results identifier/code to Apps Script. Server-side fetch avoids browser cross-origin restrictions. The importer extracts and parses the embedded availability payload using the referenced scraper technique, converts slots to normalized intervals, and stages the complete result before changing current availability. Matching uses stable email when available, then an administrator-maintained source mapping; ambiguous names remain unmatched. A content hash makes repeated imports idempotent. Only a completely parsed, validated import replaces imported recurring availability.

The WhenIsGood page structure is undocumented and may change, so parser failures become visible import-run records and never erase the last good dataset.

Alternative considered: scrape in the browser. Rejected because cross-origin restrictions and exposure of result access information make it less reliable and less secure.

### Pure scheduling engine with revisioned commits

Implement scheduling as a pure function over a normalized snapshot: active ranked volunteers, effective availability, locked/confirmed sessions, and current assignments. Rank ascending is the primary ordering. Same-rank ties use a documented stable key based on current non-conflicting assignment continuity, then deterministic volunteer ID; this minimizes needless churn while preserving reproducibility. A volunteer cannot hold overlapping assignments. No weekly assignment cap is invented; if policy later requires one, it must be an explicit scheduling input.

Each session has `requiredStaffCount` constrained to 0–2. The engine emits assignments, ordered backups, and shortfalls. It evaluates proposed UNIV100 or center times for coverage but only confirmed sessions enter the committed schedule. A successful run writes all output under a script lock to a new revision, then flips the current revision pointer. Failures leave the previous revision current.

Alternative considered: mutate assignment rows while iterating. Rejected because partial failures could publish an internally inconsistent schedule and make reruns nondeterministic.

### Exceptions, cancellations, and reruns

Effective availability is recurring availability overlaid by dated exceptions, with exceptions taking precedence only on their date and overlapping interval. A broad recurring-availability change marks future schedules stale, sends administrators a post-commit email, and waits for an explicit administrator rerun. A cancellation of a specific assigned occurrence is narrower: it records the exception and atomically promotes the first still-eligible backup under the same ranking rules. If none exists, the session becomes understaffed and administrators are alerted.

This split satisfies immediate cancellation replacement without allowing every profile edit to silently reshuffle the entire schedule.

### Leftover availability as a derived projection

A leftover volunteer is active, ranked, and has no assignment in the selected current schedule revision. The analysis intersects their recurring weekly intervals into configurable increments from `Settings`, groups adjacent cells only when the contributing volunteer set is identical, and stores or returns the source revision. The table and heatmap are two views over the same derived cells. Numeric counts and details accompany green intensity so color is not the only signal.

### Phased center workflow

Center schedule entry is implemented after roster import, volunteer updates, scheduling, and insights are operating. Center contacts can maintain only their own Monday–Friday candidate intervals. Comparison is advisory. An administrator must confirm a candidate against current coverage before it becomes session input; locked occurrences remain immutable through the center interface.

## Risks / Trade-offs

- [WhenIsGood changes its undocumented page payload] → Isolate parsing behind fixtures, store import diagnostics and a content hash, and preserve the last successful import on any parse failure.
- [Apps Script quotas or concurrent writes delay operations] → Batch Sheet reads/writes, cache read-only configuration briefly, serialize scheduling/import commits with `LockService`, and surface retryable failures without claiming success.
- [A publicly reachable Apps Script URL is abused] → Validate Google identity tokens and audience, authorize against the `Users`/`Volunteers` tabs on every request, use operation allowlists and payload limits, rate-limit sensitive actions, and never trust client-supplied roles or row identifiers alone.
- [Static hosting complicates cross-origin calls to Apps Script] → Use simple, documented request envelopes that avoid unnecessary preflight, verify the deployed redirect/CORS behavior in a browser spike before feature work, and keep transport behind one client adapter.
- [Google Sheets is not a transactional database] → Use revision numbers, expected-revision checks, staging tabs/ranges, and script locks; publish only complete scheduling and import revisions.
- [Deterministic rank priority repeatedly favors the same volunteer] → Preserve the requested rank-first policy and make the same-rank tie-breaker explicit; do not add unrequested workload balancing without an approved requirement.
- [Email can fail after a successful Sheet write] → Record notification status and expose failed notifications for administrator retry; never roll back valid availability merely because email delivery failed.
- [Private volunteer data appears in browser or repository] → Return least-privilege response shapes, keep secrets and data out of the GitHub Pages bundle and repository, and restrict aggregate identities to administrators.

## Migration Plan

1. Create a non-production workbook from the versioned schema, configure roles/settings, and load a scrubbed sample for end-to-end development.
2. Implement and browser-verify authentication and the narrow Apps Script transport before any private data UI.
3. Import the existing roster, mark the approximately ten graduates, add new joiners, and reconcile duplicate/unmatched identities without deleting source data.
4. Copy interview rankings from the document into the protected rank columns; after interviews are complete, validate and normalize labels to numeric ranks.
5. Import WhenIsGood availability into staging, reconcile unmatched participants, and compare totals and representative intervals with the source before promotion.
6. Enter locked center sessions and confirmed classes, run scheduling in preview, and have administrators compare assignments and shortfalls with the current manual plan.
7. Enable the current revision, volunteer self-service, alerts, cancellation promotion, and administrator reruns. Retain exported snapshots of prior Sheets and the previous static deployment for rollback.
8. Enable leftover-availability insights after assignment revisions are trusted.
9. Pilot center candidate entry with one center, then expand after confirming it cannot mutate locked sessions or bypass administrator confirmation.

Rollback consists of disabling writes in Apps Script, restoring the prior GitHub Pages deployment, switching the current schedule pointer to the last accepted revision, and restoring exported Sheet tabs if schema migration must be reversed.

## Open Questions

- Which Google accounts or domains volunteers and center contacts use, and whether every participant can complete Google sign-in.
- The canonical scheduling time zone, heatmap increment, operating-hour bounds, and administrator email recipients.
- The exact WhenIsGood result identifiers/codes and whether participant emails are available for stable matching.
- The required staffing count for each existing center and UNIV100 session when it is less than the maximum of two.
- Whether current recurring-primary assignments must receive stronger continuity than the general same-rank tie-breaker.
- Whether administrators want email retry handled manually from an audit view or automatically within Apps Script quota limits.
