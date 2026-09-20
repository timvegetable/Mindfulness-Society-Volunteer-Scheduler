## 1. Project and Data Foundations

- [x] 1.1 Scaffold the TypeScript GitHub Pages application and Google Apps Script workspace with shared build, lint, and deployment commands
- [x] 1.2 Define shared domain types and validators for volunteers, ranks, intervals, exceptions, sessions, assignments, backups, revisions, and roles
- [x] 1.3 Implement time-zone-aware interval normalization, overlap, containment, and dated-exception precedence helpers
- [x] 1.4 Define the versioned workbook schema for all designed tabs, protected columns, stable IDs, settings, and revision metadata
- [x] 1.5 Implement an idempotent Apps Script workbook initializer and schema-version check against a non-production Sheet
- [x] 1.6 Add batched Sheet repositories with optimistic revision checks, script locking, and append-only audit records

## 2. Secure Static-Site Integration

- [x] 2.1 Prove the GitHub Pages-to-Apps-Script request and redirect/CORS flow in a deployed browser spike before building feature screens
- [x] 2.2 Integrate Google Identity Services in the static client and exchange verified identity claims with the Apps Script endpoint
- [x] 2.3 Implement server-side token audience validation and email-to-role authorization for volunteer, administrator, and center-contact roles
- [x] 2.4 Implement the allowlisted API dispatcher with payload limits, schema validation, idempotency keys, consistent error envelopes, and no arbitrary Sheet access
- [x] 2.5 Implement least-privilege response projections so volunteers receive only their own records and aggregate identities require administrator access
- [x] 2.6 Exercise unauthorized, wrong-role, stale-revision, duplicate-request, and concurrent-write scenarios against the deployed integration

## 3. Roster, Rankings, and WhenIsGood Import

- [x] 3.1 Build administrator roster management for active, newly joined, inactive, and graduated lifecycle states without deleting history
- [x] 3.2 Build protected interview-status and ranking management with Primary and recurring Primary normalized to 1, Secondary to 2, and Tertiary to 3
- [x] 3.3 Implement the server-side WhenIsGood fetcher and isolated embedded-data parser using captured representative fixtures
- [x] 3.4 Implement staged import validation, content-hash idempotency, time-zone normalization, and preservation of the last successful import on failure
- [x] 3.5 Implement stable identity matching with an administrator-managed source mapping and an explicit unmatched or ambiguous participant queue
- [x] 3.6 Build the administrator import screen with run status, diagnostics, participant reconciliation, preview, and promotion of a valid staged import
- [x] 3.7 Verify repeated imports, parser failure, ambiguous names, newly joined volunteers, and graduated-volunteer exclusion with a scrubbed Sheet

## 4. Ranked Scheduling and Backups

- [x] 4.1 Implement the pure effective-availability calculation over recurring intervals and dated exceptions
- [x] 4.2 Implement the pure rank-first scheduling engine with required staff counts capped at two, overlap prevention, assignment continuity, and stable ID tie-breaking
- [x] 4.3 Generate uniquely ordered backup lists and explicit understaffed results from the same eligibility and ordering rules
- [x] 4.4 Add focused scheduler contract tests for rank precedence, stable ties, full-session coverage, overlapping sessions, unranked and graduated exclusions, shortfalls, and deterministic reruns
- [x] 4.5 Implement locked center-session and confirmed UNIV100 inputs while keeping proposed classes outside committed scheduling
- [x] 4.6 Implement advisory coverage evaluation that blocks UNIV100 confirmation when current eligible staffing is insufficient
- [x] 4.7 Implement locked, staged scheduling runs that atomically publish a complete revision and preserve the prior current revision on failure
- [x] 4.8 Build the administrator schedule view for assignments, ordered backups, unranked volunteers, shortfalls, stale state, and run revision details
- [x] 4.9 Add the administrator rerun control with mutual exclusion, current input revision display, success results, and failure diagnostics
- [x] 4.10 Verify a representative fixed-center and UNIV100 schedule produces no overstaffing, double-booking, unstaffed promises, or partial published revisions

## 5. Volunteer Availability and Cancellation Workflow

- [x] 5.1 Build the authenticated volunteer dashboard for the caller's recurring availability, dated exceptions, and future assignments
- [x] 5.2 Implement recurring availability editing with interval validation, expected revisions, audit data, stale-schedule marking, and post-commit administrator email
- [x] 5.3 Implement dated absence and availability-override editing with correct occurrence-scoped precedence
- [x] 5.4 Implement assigned-occurrence cancellation with an optional reason and atomic persistence before backup handling
- [x] 5.5 Implement first-eligible-backup promotion, backup reordering, understaffed fallback, and administrator cancellation-result email
- [x] 5.6 Record email delivery status and provide administrators a retry action for failed notifications without rolling back saved changes
- [ ] 5.7 Browser-verify own-data isolation, a recurring update, a one-off Thursday absence, successful backup promotion, and no-backup alert behavior

## 6. Leftover Availability Insights

- [x] 6.1 Implement revision-bound derivation of active ranked volunteers with no current assignment
- [x] 6.2 Implement weekday overlap counts in configured increments and merge adjacent increments only when their volunteer sets are identical
- [x] 6.3 Build the sortable overlap table with readable weekly windows, counts, and administrator-only volunteer details
- [x] 6.4 Build the accessible weekly calendar heatmap with green intensity, visible numeric counts, keyboard interaction, and non-color detail
- [x] 6.5 Mark insights stale on eligibility, recurring-availability, or assignment revision changes and regenerate from one consistent revision
- [ ] 6.6 Browser-verify table and heatmap agreement, interval-boundary splitting, stale-state handling, and exclusion of assigned or graduated volunteers

## 7. Production Migration and Deployment

- [x] 7.1 Configure production time zone, display increment, operating hours, administrator recipients, OAuth audience, and protected Sheet ownership outside the public bundle
- [ ] 7.2 Import and reconcile the current roster, new joiners, and graduated volunteers with row counts and unmatched identities reviewed by administrators
- [ ] 7.3 Migrate faculty interview rankings from the Google Doc, validate interview completion, and normalize finalized ranks to numeric values
- [ ] 7.4 Import the live WhenIsGood results and compare participant totals and representative availability intervals before promotion
- [x] 7.5 Load and lock center sessions through December plus confirmed UNIV100 classes, including each session's required staffing count
- [ ] 7.6 Run a production scheduling preview and obtain administrator review of assignments, backups, shortfalls, and proposed-class exclusions before publishing
- [x] 7.7 Deploy the Apps Script integration and GitHub Pages client with write-disable, prior-revision, Sheet-export, and static-deployment rollback procedures
- [ ] 7.8 Complete end-to-end browser verification as volunteer and administrator against production configuration without exposing private data or credentials

## 8. Later Center Schedule Phase

- [x] 8.1 Extend the workbook and authorization model for centers, center contacts, and Monday–Friday candidate intervals
- [x] 8.2 Build center-contact schedule entry scoped to the caller's center and blocked from mutating locked occurrences
- [x] 8.3 Implement full-interval candidate coverage comparison with ranked volunteer counts and advisory, non-promissory labeling
- [x] 8.4 Build administrator confirmation that rechecks current coverage, enforces the two-volunteer maximum, and creates auditable session occurrences
- [x] 8.5 Pilot the center workflow with one center and browser-verify tenant isolation, locked-session protection, changed-coverage rejection, and administrator-only confirmation: all four observed against the deployed app with OPAL Senior Center. A Friday 09:00-09:45 candidate was refused as overlapping a locked occurrence with all 16 locked OPAL Fridays left untouched; a zero-coverage confirmation was refused with its shortfall counts and wrote nothing; confirmation succeeded only in the administrator session, creating a locked occurrence whose sourceCandidateId links back to the submission; and the OPAL contact's list excluded a seeded Pasadena candidate while the administrator saw all four rows and the heading dropped its single-center name. Isolation additionally pinned by three contract tests covering the list scope, the read refusal and the edit refusal

## 9. Production Correctness and Responsiveness

- [x] 9.1 Normalize Sheet temporal values and insight operating hours
- [x] 9.2 Make promoted availability authoritative for every consumer
- [x] 9.3 Separate revisions and add reviewed scheduling preview
- [x] 9.4 Read each required Sheet tab once per operation
- [x] 9.5 Reuse insights by correct source and schedule revisions
- [x] 9.6 Cache verified claims within credential expiry
- [x] 9.7 Cache identity-scoped routes and format session labels
- [x] 9.8 Reject duplicate locked center confirmation
- [ ] 9.9 Verify warm read p95 and corrected deployed flows — the corrected deployed flows are verified (the 10.4 preview notice, the 10.2 import preview, promoted availability as authoritative, and workbook-zone decoding). The latency half FAILS as measured on 2026-09-20 from the deployed client as fresh route-load measures: Schedule p95 6966 ms and Insights p95 6239 ms over 42 warm samples each (min 4520 / 3162, median 6027 / 4948, max 7520 / 11259), with every sample above the 2000 ms objective. Sampling requirements were met and no read failed. Left open pending 10.23
- [x] 9.10 Decode workbook date and time cells in the workbook's own zone and report it in the sign-in diagnostic

## 10. Follow-Ups Recorded During Production Verification

- [x] 10.1 Scope scheduling to occurrences that have not already started: choose the cut-off (already started versus earlier than the run day) and express it in the ranked-session-scheduling delta spec, filter the run inputs, and add a scheduler contract test, so a preview cannot assign or list backups for a session in the past
- [x] 10.2 Load the WhenIsGood result inside the Apps Script runtime: the fetch path calls `TextEncoder`, which V8 does not define, so every import preview fails with "TextEncoder is not defined" and the run is stored as failed while the Node contract tests pass; count UTF-8 bytes with the dispatcher's guarded helper instead, and add a regression that runs the import preview with `TextEncoder` removed from the global scope
- [x] 10.3 Audit the rest of the server bundle for Node-only globals and pin the audit with a test, so `TextDecoder`, `Buffer`, `process`, `structuredClone`, or an unguarded `crypto` cannot reach the deployed runtime unnoticed
- [x] 10.4 Make a scheduling preview unmistakable: show the computed-at time, input and output revisions, and assignment, backup, and shortfall counts including zeros; keep the saved or failed confirmation visible after the view re-renders; and label the disabled publish control with the preview it requires
- [ ] 10.5 Re-run the deployed flows that 10.2 and 10.4 unblock and close 7.4, 7.6, 7.8, 8.5, and 9.9 against the corrected behavior
- [ ] 10.6 Keep a promotion result visible after the import rerenders: promoting invalidates and reloads the import route, which has no fresh read, so the administrator sees an empty form with no confirmation even though the run is already promoted; persist a notice the way the schedule preview does and read back the promoted run instead of painting an empty import payload
- [ ] 10.7 Replace the long availability lists with one interactive week-calendar view used for both reading and editing recurring availability and dated exceptions, so a volunteer no longer scans dozens of lines; include the field-affordance problems this surfaced, where dropdown and clock icons sit at the far edge of a full-width control and are easy to miss. The insights heatmap already renders exactly this Monday–Friday week grid, so reuse it rather than building a second calendar, and give its cells a length and position proportional to the interval they represent the way a calendar does, instead of uniform equal-sized boxes
- [ ] 10.8 Keep the volunteer dashboard's save confirmation and scroll position across the post-save rerender: a successful recurring-availability save reloads the whole route, so "Saved." is never seen and the page jumps, and rebuilding the draft list mid-interaction moves the Remove control away from where the volunteer just clicked
- [ ] 10.9 Label each schedule row by what it is rather than by its stored status: the schedule table's Status column prints the raw session enum, so "locked" (a fixed center session loaded as immutable input) and "confirmed" (a UNIV100 class confirmed as schedulable) read as staffing states beside "Understaffed by 2"
- [ ] 10.10 Let a volunteer withdraw a dated availability exception: the self-service surface can create one but no operation removes it, so a mistaken or obsolete exception can only be cleared by editing the Sheet directly
- [ ] 10.11 Confirm and reassure on cancellation: ask "Confirm cancellation?" before cancelling an assigned occurrence, and when the request fails make the copy say the change may already have been applied and to reload before retrying. The cancellation commits before the backup promotion and the administrator notification are attempted, so a failure after the commit is reported today as a bare "The scheduling service is temporarily unavailable." while the cancellation has in fact been applied
- [x] 10.12 Keep every other session's backups when a promotion runs: BackupPromotionService listed only the cancelled session's backups and then replaced the whole Backups tab with that subset, so a single cancellation destroyed the backups for the entire published schedule. Verified against the audit trail, which records the tab-wide replace shrinking 55 -> 1 rows on the Monday cancellation and 54 -> 0 on the Friday one, with the promotion payload naming only the cancelled session. Fixed by carrying the other sessions' rows through the replacement, with a two-session regression test that fails with the other session's backups reduced to [] when the fix is reverted
- [x] 10.13 Render audit instants in a zone the reader can interpret: formatInstant defaulted to UTC, so the schedule preview's "Computed at" and the insights "Generated" stamps showed a wall clock four hours ahead of Eastern in September with no zone named (a run computed at 19:16 EDT displayed 11:16 PM). The scheduling zone is now projected into the public configuration and validated against the private one, and an absent or unusable zone falls back to the reader's own zone instead of silently returning to UTC
- [x] 10.14 Let a center contact create its first candidate interval: the center form sends no id for a new interval, but the runtime handler required one and threw "candidateId is required", so the create half of 8.2 was unreachable through the API and a center could never enter a candidate. Id-less payloads now route to the schedule service's create() path, with a regression test that drives the exact form payload and fails when the guard is restored
- [x] 10.15 Protect locked occurrences on candidate entry, not only on edit: the locked-occurrence guard lived on update() and remove() but not create(), so a center contact could enter a brand-new interval straight onto a locked session — the same attempt to change one that editing into it is refused for. create() now applies the identical refusal without storing anything, and the regression test also proves a same-time slot for a different center is still accepted
- [x] 10.16 Surface center-workflow refusals by name: the centers package throws CenterWorkflowError and nothing mapped it, so mapUnknownError reduced every refusal to "The scheduling service could not complete the request." and dropped the code, reason and details. That hid the locked-occurrence message, the insufficient-coverage message and its shortfall counts, and every week-day or argument error in the center workflow. The runtime now translates CenterWorkflowError into IntegrationError with code, message and details intact, covered by tests that fail without the mapping
- [x] 10.17 Show whether a candidate interval is actually covered: the candidate table's State column echoed the stored status, and since every unconfirmed interval stores "candidate" — a value the label map did not know — neither "Candidate coverage" nor "Coverage shortfall" was reachable, so a candidate no volunteer could cover looked identical to a covered one. A pending interval is now labelled by its coverage and a resolved one keeps its state, covered by a test that fails showing 'Candidate' for every row when the old expression returns
- [x] 10.18 Stop offering actions that can only fail: a resolved candidate kept "Edit candidate" and "Confirm for scheduling" even though the server refuses both writes, so the row now reports its outcome ("Confirmed for scheduling") and offers no controls, verified by a test that fails showing 'Edit candidateConfirm for scheduling' on a resolved row once the guard is removed
- [ ] 10.19 Polish the candidate table: colour "Candidate coverage" green and "Coverage shortfall" red rather than leaving both as plain text, give the note beside the Edit button more breathing room, and decide deliberately whether to grey out "Confirm for scheduling" when coverage is short (disabling it also removes the only place the server's refusal message is seen)
- [ ] 10.20 Reconsider what the candidate table is for once an interval is confirmed: a confirmed candidate keeps its row among the proposals on both the centre contact's and the administrator's view even though the decision is made and its occurrence now lives in the schedule. The user asked for a calendar-style view of sessions with monthly and weekly options for the centre user rather than a flat list tied to the workbook's raw fields
- [ ] 10.22 Follow the reader's role in the candidate table's heading and columns, superseding 10.21's single rule: a centre contact manages exactly one centre, so name that centre in the heading and drop the Center column for them, while an administrator keeps the generic heading and the per-row Center column. Note that the client currently holds only per-candidate centre names, so a centre contact with no candidates yet has nothing to name the heading with — the runtime will need to supply the caller's own centre name independently of the rows
- [ ] 10.23 Meet or renegotiate the warm read latency objective: the deployed Schedule and Insights routes read at roughly 6 s p95 against a 2000 ms requirement, and the slowest observed sample is still 4520 ms, so this is a floor rather than tail latency. Every route read rebuilds the whole workbook store through sequential Sheets calls, so the options are to scope each read to the tabs that operation actually needs, batch the tab reads (for example the advanced Sheets service batchGet), or revise the objective itself — the last being a spec change the administrators must decide rather than something to adjust quietly
- [x] 10.21 Make each candidate row attributable to its centre: the client received no centre per row, only a single shared centerName that goes undefined exactly when the rows span more than one centre, so an administrator's cross-centre table was unattributable in the one case that needed attribution. The runtime now names each candidate's centre and the table shows a Center column whenever rows span more than one centre, with the caption reworded to "Proposed candidate intervals and current advisory coverage" so it reads correctly for both roles

