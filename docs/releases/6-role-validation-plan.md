# Issue 6: temporary live role validation

Status: prepared for operator approval on 2026-10-18. No accounts or fixture records have been created. This plan grants temporary production access and therefore requires explicit approval under README's production-write procedure. It requires no deployment, migration, new Google account, notification or WhenIsGood change.

## Account mapping and access

Use the two operator-controlled Gmail accounts already identified in the private chat. Account A receives only `volunteer`; account B receives only `center-contact`. Keep the email mapping in an ignored local execution manifest, not this public document. The existing terpmail administrator account and all existing users remain unchanged. Stop if either Gmail address is already enrolled at execution time; do not overwrite it.

Create exactly six marked records:

| Record | Fixed ID | Values and scope |
| --- | --- | --- |
| Volunteer-only user | `issue6-test-user-volunteer` | Account A; active user; role `volunteer`; linked only to the test volunteer; no centers |
| Contact-only user | `issue6-test-user-contact` | Account B; active user; role `center-contact`; linked only to the test center; no volunteer |
| Fictional volunteer | `issue6-test-volunteer` | Name `Issue 6 validation volunteer`; email `issue6-role-validation@example.invalid`; lifecycle `inactive`; interview `incomplete`; readiness null; source `issue6-validation` |
| Fictional weekly interval | `issue6-test-availability` | Test volunteer; Monday 00:00–00:30, `America/New_York`; source `issue6-validation` |
| Fictional center | `issue6-test-center` | Name `Issue 6 validation center`; inactive |
| Fictional proposal | `issue6-test-candidate` | Test center; Monday 00:00–00:30, `America/New_York`; requested staff 0; status `cancelled`; created by the test contact |

The inactive/incomplete volunteer is ineligible for scheduling. The inactive center disables proposal creation, and the cancelled proposal cannot be confirmed or scheduled. It gives the contact a recognizable own-center row while existing real-center proposals should remain absent. The volunteer's marker interval makes own-availability filtering observable without linking to a real person's record. Before insertion, verify the fixture IDs/email/name have no collisions, neither source participants nor import mappings identify this fixture, and the chosen proposal interval has no real eligible coverage. Stop on a failed precondition rather than adapting private records.

## Preparation and execution

1. Record the actual deployed main/private-reader versions. Take a fresh owner-only production D1 backup and verify its integrity offline. Save a private before snapshot of existing domain rows and revisions; raw identities remain local.
2. Prepare guarded setup and cleanup statements and validate them on a disposable restored copy first. Use transactional D1 batches with revision assertions. Do not execute a sequence of independent partial writes. Setup increments domain and scheduling-input revisions monotonically; cleanup increments them again. Never restore old revision values over concurrent changes.
3. Insert only the six records above after all guards pass. Verify the existing administrator account, real roster and source/history rows are unchanged. No source fetch, synchronization, proposal edit or assignment operation is triggered manually by this setup.
4. Sign out of the administrator UI. The operator signs into Account A through Google. Verify only the volunteer surface appears, its own marker availability and synchronization freshness load, real volunteers' availability/participant details are absent, and navigation plus **Reload view** succeed. Do not save exceptions or cancel assignments.
5. Sign out, then the operator signs into Account B. Verify only the center-contact surface appears, the cancelled marker proposal belongs to the test center, real-center proposals are absent, no active-center proposal can be created, and administrator/synchronization-participant views are absent. Exercise **Reload view** without saving or withdrawing anything. Existing native Worker tests supplement UI observations by asserting forbidden API operations and current-account checks.
6. Record only sanitized role/visibility/count/status evidence. Observe errors during these reads; CPU over the former threshold alone is no longer a stop condition. Unexpected authentication, application, resource or scope failures stop the checks and lead directly to cleanup.
7. Sign out and remove the six fixture records in dependency order, in a guarded transactional batch. Delete only exact fixture IDs whose values still match the manifest; abort cleanup on any unexpected reference or modification and report it. This cleanup is part of the requested approval. Do not reset the database from backup.
8. Confirm both test accounts are absent and current-account authorization therefore rejects their previously issued credentials. Compare all pre-existing domain rows, imports/provenance and assignments with the before snapshot, accounting separately for legitimate concurrent cron status/bookkeeping. Revisions may advance; never assert the whole database is byte-identical while cron is running. Restore the administrator sign-in for final read-only schedule/status checks and record the outcome on #6.

If a fixture cannot be created and removed safely under the deployed schema/current authority rules, stop before writes and revise this plan. No existing record is repurposed as a test identity. Keep the backup as recovery evidence; any broader restore needs separate approval.

## Approval scope

Approve temporary enrollment of the two specified Gmail accounts with the roles above, insertion and removal of the six fictional records, the two monotonic revision advances, Google sign-ins and read-only UI checks, private backup/read-only comparisons, and guarded cleanup. This approval does not cover another deployment, source changes, real roster/proposal/assignment edits, notifications, a billing change or continuing account access after validation.
