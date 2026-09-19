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
- [ ] 8.5 Pilot the center workflow with one center and browser-verify tenant isolation, locked-session protection, changed-coverage rejection, and administrator-only confirmation

## 9. Production Correctness and Responsiveness

- [x] 9.1 Normalize Sheet temporal values and insight operating hours
- [x] 9.2 Make promoted availability authoritative for every consumer
- [x] 9.3 Separate revisions and add reviewed scheduling preview
- [x] 9.4 Read each required Sheet tab once per operation
- [x] 9.5 Reuse insights by correct source and schedule revisions
- [x] 9.6 Cache verified claims within credential expiry
- [x] 9.7 Cache identity-scoped routes and format session labels
- [x] 9.8 Reject duplicate locked center confirmation
- [ ] 9.9 Verify warm read p95 and corrected deployed flows
- [x] 9.10 Decode workbook date and time cells in the workbook's own zone and report it in the sign-in diagnostic

## 10. Follow-Ups Recorded During Production Verification

- [x] 10.1 Scope scheduling to occurrences that have not already started: choose the cut-off (already started versus earlier than the run day) and express it in the ranked-session-scheduling delta spec, filter the run inputs, and add a scheduler contract test, so a preview cannot assign or list backups for a session in the past
- [x] 10.2 Load the WhenIsGood result inside the Apps Script runtime: the fetch path calls `TextEncoder`, which V8 does not define, so every import preview fails with "TextEncoder is not defined" and the run is stored as failed while the Node contract tests pass; count UTF-8 bytes with the dispatcher's guarded helper instead, and add a regression that runs the import preview with `TextEncoder` removed from the global scope
- [x] 10.3 Audit the rest of the server bundle for Node-only globals and pin the audit with a test, so `TextDecoder`, `Buffer`, `process`, `structuredClone`, or an unguarded `crypto` cannot reach the deployed runtime unnoticed
- [x] 10.4 Make a scheduling preview unmistakable: show the computed-at time, input and output revisions, and assignment, backup, and shortfall counts including zeros; keep the saved or failed confirmation visible after the view re-renders; and label the disabled publish control with the preview it requires
- [ ] 10.5 Re-run the deployed flows that 10.2 and 10.4 unblock and close 7.4, 7.6, 7.8, 8.5, and 9.9 against the corrected behavior
