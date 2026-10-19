# Schedule compatibility repair

The official-icon UI release deployed from `0a9f92e`, which did not include the already-released application candidate `9831a30`. The private schedule reader still returned the newer `centers` field. The older client's strict response schema rejected it as `centers: UnexpectedKey`, leaving administrators with the generic reload error despite HTTP 200 reads.

This repair merges the previously deployed notification release (`85ad449`, including candidate `9831a30`) into the UI branch. Worker/shared source matches that release; the approved redesign remains. Canonical session names, weekly grouping, volunteer assignment details, sorted roster pickers and readable notification messages are restored together. The reader and database need no changes.

## Evidence

A private local replay reproduced the schema rejection after adding the reader's appended field to the prepared core. After integration, both the real client test and native browser replay passed: 18 rows, six weekly groups and all 70 represented session dates, with no error. The operator explicitly authorized the temporary private copy. That copy and the diagnostic probes were deleted; no private records became fixtures.

The integrated synthetic workflows cover center labels, published/preview grouping, volunteer assignments and the actual response decoder. The administrator publication workflow also asserts that loading the newer response produces no alert. All 408 functional tests and 60 Chromium checks passed, along with both TypeScript checks, CSS formatting, client build, both tracked Worker dry runs and the exact private main-config dry run.

## Release discipline

Before deploying another branch, identify the latest chronological production deployment and its recorded source candidate. Verify that the candidate is an ancestor of the release branch, or explicitly reconcile the deployed changes first. Check the main and reader response contract together. Passing an older branch's fixtures cannot establish compatibility with a newer deployed reader.

The prior functional main version is `1faaae3d-b1cc-44e3-b303-d97f649e5920`; the failed UI version is `4fc6da9e-3a14-4466-a20a-898c62992f03`. The private reader remains `996e8110-fb8c-4c4a-869c-be9fbd30db12`. Retain the functional main version for recovery. This release performs no roster, scheduling or notification mutation.

## Deployed repair

Application candidate `bc7dbd8` is published on `codex/schedule-read-cpu`. Main Worker version `20096e96-886a-4e27-87c2-5a985d6a97ce` receives 100% of traffic, confirmed from the latest deployment at 2026-10-19T02:21:41Z (October 18 at 10:21 p.m. America/New_York). Production HTML, JavaScript, CSS and the official SVG match the tested build byte for byte. The refreshed browser loaded the repaired script. The operator completed sign-in after the refresh. Authenticated Schedule loaded with no alert: 18 rows, six weekly groups and all 70 represented dates. Explicit Reload view completed successfully. Availability sync loaded its two tables; navigating back to Schedule also completed without an error. These were read-only live checks, with no manual synchronization or publication.
