# Schedule preview comparison release

Candidate `f60cf93` adds Published, Preview, and Changes views without discarding the reviewed preview. Changes compares dated staffing before weekly grouping, shows published and proposed assignments, backup order and per-date shortfalls, and collapses unchanged sessions. Its layout follows the supplied reference, including date chips and an integrated disclosure footer.

## Deployment

Main Worker version `43c8e519-5ea1-4a44-98b3-237e2b46e3fa` receives 100% of production traffic, confirmed from the deployment created at 2026-10-19T03:23:17Z (October 18 at 11:23 p.m. America/New_York). The previous version, `20096e96-886a-4e27-87c2-5a985d6a97ce`, remains available for rollback.

The candidate descends from the repaired production baseline `bc7dbd8`. The private schedule reader was not redeployed. The release used the enabled-reader production configuration with plain-text variables copied from the previous deployed version, preserving its configuration rather than including the pending private admin-email edit. Post-deployment version inspection confirmed every plain-text variable remained equal. Existing D1, reader, Queue and Cron bindings were retained. No migration, manual synchronization or schedule publication was performed.

Issues 13–15 were actively being implemented in separate `/tmp/scheduler-issues-13-15/` worktrees and were excluded. Their later integration must retain this comparison UI and its tests.

## Evidence

All 412 functional tests and 66 Chromium checks passed on the final candidate, together with both TypeScript checks, CSS formatting, the client build, tracked Worker dry runs and the exact release-config dry run. Browser coverage includes desktop, tablet and mobile, empty comparisons, changed weekly groups, date disclosure and publication after switching views.

Production HTML, JavaScript, CSS and the official SVG matched the tested build byte for byte. The live browser loaded the production sign-in screen. An authenticated production comparison workflow remains unverified; the smoke check did not establish an authenticated session. Synthetic browser coverage does not substitute for that live check.
