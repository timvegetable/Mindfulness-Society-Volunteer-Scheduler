# Production operations

Production is not a normal development target. Do not mutate the workbook, Script Properties, Apps Script deployment, GitHub Pages deployment, or repository remote without explicit approval for that specific action.

## Live write gate

Operations classified as mutating by the dispatcher are available only when the live Apps Script `WRITE_ENABLED` property is exactly `true`; otherwise they return `UNAVAILABLE`. This is not a blanket guarantee for every side effect: import preview is currently misclassified as read-only despite persisting staged runs, and migration validation invokes initialization. See [integration limitations](subsystems/integration.md#request-contract) and [diagnostics](#diagnostics) before treating an operation as safe.

`production.local.json` and deployment reports describe local inputs, not live Script Properties. Historical checks found local/live disagreement. The latest recorded check in the [read-latency evidence](../openspec/changes/meet-read-latency-objective/tasks.md) was `WRITE_ENABLED=false` during the 2026-09-24 version-28 release; that dated observation is not proof of the present gate. Before any production mutation or server deployment:

1. Export a workbook snapshot.
2. Open the bound Apps Script project with the administrator-owned account.
3. Inspect the live Script Property and set it false if the approved procedure requires a write-disabled posture.
4. Run `describeSignIn` in the editor and inspect its logged `writeEnabled` value.
5. Stop if the live result differs from the intended posture.

After the approved action, verify the property again. Re-enabling writes is a separate production mutation and requires separate review.

Editor-run procedures need no-argument entrypoints; provide a separate wrapper for each mode rather than expecting the Run menu to supply arguments.

## Notification operations

The runtime uses `MailApp`; its scope boundary is documented in [security](security.md#deployment-surface). The fix was deployed in Apps Script version 26 on 2026-09-22. A direct mail probe delivered successfully, but application-flow delivery remains unobserved in [task 10.27](../openspec/changes/volunteer-session-scheduling/tasks.md#10-follow-ups-recorded-during-production-verification), where the transport failure blocked the controlled test. Do not describe the fix as undeployed or treat a probe as end-to-end acceptance.

Notification triggers, in-memory status and the missing administrator retry surface are documented in [self-service](subsystems/self-service.md#cancellation-and-notification). Observe actual delivery; recipient configuration alone proves nothing. `ADMINISTRATOR_RECIPIENTS` accepts a JSON array or comma-separated addresses. Other valid JSON values fall through to comma splitting, so validate the resolved addresses before a controlled test.

The controlled test's fixture rows and recipient override were restored on 2026-09-22, with zero operational difference against the baseline (task 10.28). This is historical restoration evidence, not a fresh inspection of production.

## Revision bookkeeping

Script Properties hold `TAB_REVISION_<TabName>`, `SCHEDULING_INPUT_REVISION`, and `DATA_REVISION`. `clasp` and the Sheets API do not update them. A direct Sheet write can therefore change rows while the application believes no data changed.

Prefer application operations. If a direct write is unavoidable and explicitly approved:

1. disable and verify the live write gate;
2. export a snapshot and record relevant application revisions;
3. constrain the edit to exact reviewed rows/cells;
4. validate resulting rows through the workbook codecs/schema where possible;
5. reconcile affected Script Property revisions through a reviewed Apps Script-side procedure;
6. regenerate or republish affected schedule/insight outputs;
7. re-read through the application and compare semantic results;
8. record the mutation and evidence without copying private rows into the repository.

Do not improvise revision numbers. If there is no reviewed reconciliation procedure, stop and add one before the mutation. The reviewed procedure for the direct-write path is below.

## Reviewed direct-write reconciliation

This is the reviewed procedure that satisfies step 5 above. Use it only for rows the application cannot create itself: prefer the application's own operations, so the volunteer sets their own availability through `volunteer.availability.recurring.update` and a cancellation runs through `volunteer.assignment.cancel`. Direct writes exist for the remaining rows — a `Users` identity row, or a fixture session — which no allowlisted operation can create.

What the counters are, so the arithmetic is not improvised:

- `TAB_REVISION_<Tab>` is an optimistic-concurrency counter. Every repository write reads it, requires exact equality with its expected value, then stores `current + 1`; a mismatch raises `STALE_REVISION`. Nothing derives state from its magnitude. See `src/server/workbook/repository.ts`.
- Writing any of the four scheduling-input tabs (`Volunteers`, `RecurringAvailability`, `AvailabilityExceptions`, `Sessions`) also increments `SCHEDULING_INPUT_REVISION` by one. See `src/server/runtime.ts`.
- `DATA_REVISION` increments by exactly one per mutating operation that the dispatcher admits. See `src/server/main.ts` and `src/server/integration/dispatcher.ts`.
- `changedAt` and `changedBy` are synthesised when the property is read, so they are not durable state and need no reconciliation.
- No read-only API exposes `TAB_REVISION_*`. The authenticated API reports `DATA_REVISION` as `revision`, `SCHEDULING_INPUT_REVISION` as `inputRevision`, and the latest completed run's output revision as `scheduleRevision`. Of these gate/revision values, `describeSignIn` reports only `WRITE_ENABLED`. The remaining values are read by the owner in the Apps Script editor under Project Settings → Script Properties.

For each direct-write batch:

1. Disable and verify the live write gate, export a snapshot, and build the baseline as described in the next section.
2. Record the exact current values of `DATA_REVISION`, `SCHEDULING_INPUT_REVISION`, and `TAB_REVISION_<Tab>` for every tab the batch touches, in the private manifest. Read them; never guess one.
3. Apply the edit, constrained to exact reviewed rows and cells.
4. Advance counters monotonically, by exactly one per batch and never to a snapshot value:
   - `TAB_REVISION_<Tab>` := recorded + 1 for every touched tab;
   - `SCHEDULING_INPUT_REVISION` := recorded + 1 when any touched tab is a scheduling input;
   - `DATA_REVISION` := recorded + 1.
   Adding exactly one mirrors what a single application commit would have done, so every client and cached derivation holding the pre-edit value is invalidated exactly once.
5. Re-read through the application and confirm the changed rows are visible, then continue with the acceptance flow.
6. Restore by repeating steps 2 to 5 from the then-current values. Counters only ever increase.

Two consequences are intended, and acceptance evidence must state them rather than claim the projections are unchanged:

1. The published schedule reports `stale` when the latest completed run's input revision differs from `SCHEDULING_INPUT_REVISION`. Record that verdict, and the run's own input revision, before the batch, and compare it afterwards. A monotonic bump can only make the schedule stale, never current, so a schedule that was already stale is restored to the identical verdict; a schedule that was current is left stale and that difference must be disclosed, or cleared by an approved publish, which creates a new schedule output revision.
2. The latest completed schedule output plus `TAB_REVISION_Volunteers`, `TAB_REVISION_RecurringAvailability`, and `TAB_REVISION_Assignments` form the Insights source revision tuple. Bumping them does not regenerate insights: the stored dataset is marked stale with the changed-revision reasons, and the next `admin.insights.read` serves that dataset labelled stale instead of deriving a new one. That state is short-lived. The dataset is an accelerator cached for `CACHE_TTL_SECONDS` (300 seconds) in `src/server/insights/cache-repository.ts`, and a read whose entry has expired returns nothing stored and regenerates from the current rows, so an explicit `admin.insights.refresh` is only needed to correct a dataset inside that five-minute window. Read the view and confirm rather than assuming either way.

This procedure was exercised end to end on 2026-09-21 against the production workbook: a tagged fixture set was inserted, the counters advanced by exactly one per batch, the acceptance flow ran, and the fixtures were removed again. The restored workbook compared with the pre-insert baseline as zero difference across every operational tab by stable identifier, the append-only audit rows were preserved, every counter had moved only upward with untouched tabs unchanged, and the published schedule kept the same `stale` verdict it had before the window.

## Snapshot parsing and reconciliation

A reviewed direct-write procedure needs two things the Sheet export alone cannot give: a structural check that the snapshot is a trustworthy restoration reference, and a later comparison that proves the workbook returned to its starting state.

The tooling lives in `scripts/snapshot/`. It reads a snapshot through `pandas.read_excel(..., sheet_name=None, engine="calamine")` and never writes cell contents into the repository. Commands below use `<snapshot-python>` for the interpreter of the `phamily-env` conda environment, which is the only environment guaranteed to provide pandas and python-calamine; another interpreter or another Excel parser is not an acceptable substitute. `<baseline.json>`, `<snapshot.xlsx>`, and `<restored.xlsx>` must stay in gitignored directories inside the working tree (for example `migration-output/`) with restricted permissions.

Record the starting structure and build the private baseline before any mutation:

```sh
<snapshot-python> scripts/snapshot/describe_snapshot.py <snapshot.xlsx>
<snapshot-python> scripts/snapshot/build_baseline.py <snapshot.xlsx> <baseline.json>
```

`describe_snapshot.py` prints worksheet names, row counts, and whether each header matches `src/server/workbook/schema.ts`; it exits non-zero when a required worksheet is missing or its header differs. `build_baseline.py` additionally records typed, canonicalized values keyed by stable identifier, and refuses to write a baseline when a worksheet is missing, a header differs, or a keyed tab has a duplicate or blank identifier. A worksheet outside the workbook schema is reported and ignored.

Compare the restored workbook against that baseline:

```sh
<snapshot-python> scripts/snapshot/compare_snapshot.py <baseline.json> <restored.xlsx> [--fixture-tag <tag>] [--strict-bookkeeping]
```

The comparison is by stable identifier, never by row order, and normalizes blank cells, dates, times, booleans, numbers, and JSON-valued cells. It fails on a missing, extra, or changed operational row and prints only truncated identifier digests and column names, never cell contents.

Deliberate behaviour, and why:

1. `revision`, `scheduleRevision`, `inputRevision`, and `outputRevision` are ignored. Restoration advances revisions monotonically and never resets a counter to a snapshot value.
2. Bookkeeping columns (`createdAt`, `updatedAt`, `startedAt`, `completedAt`, `promotedAt`, `importedAt`, `timestamp`, `cancelledAt`, and provenance such as `source`, `actorId`, `promotedBy`, `updatedBy`, `createdBy`) are reported as notes rather than failures, because a restore rewrites them. `--strict-bookkeeping` promotes those notes to failures.
3. `AuditLog` is append-only: its growth is reported but its contents are never diffed.
4. `Settings` is compared as a multiset, because its `key` is not unique. `initializeWorkbook` appends a `workbookSchemaVersion` row whenever the first matching row's value differs from the current schema version, so the tab can hold repeated keys; the current reader uses the first matching row. This is the defect tracked by original task 10.24, not a recommended version-resolution rule.
5. `--fixture-tag` drops every row containing the tag from both sides, so uniquely tagged acceptance fixtures do not have to be restored byte-for-byte.

The tool ships with its own check, which needs no snapshot and touches no production data:

```sh
<snapshot-python> scripts/snapshot/selftest.py
```

Before believing a zero-difference result, confirm the machinery itself is sound: two consecutive exports of an unchanged workbook must compare as zero difference even though the two files have different digests.

## Diagnostics

Safe/read-only tools include:

- `describeSignIn()` in the Apps Script editor: logs resolved audience, write gate, scheduling settings, workbook/configured time zones, and readable Users rows. Its output contains private account information; do not paste it into committed files.
- `checkWorkbookSchema()` in the editor: compares the first matching Settings version with the expected version; it does not validate all tab headers or protections. See [workbook limitations](subsystems/workbook.md#schema).
- `node scripts/probe-service.mjs --config production.local.json`: sends an unauthenticated, non-mutating request to distinguish public reachability, platform sign-in interception, script errors, and old/current bundle behavior.
- `node scripts/deployment-check.mjs ...`: examines local config and artifacts only; it does not verify live properties or deployed behavior.

`validateMigrationWorkbook()` is **not read-only**: `applyMigrationPayload(..., { apply: false })` still invokes `initializeWorkbook`, which can create tabs, change headers/protections and append Settings rows before payload validation. Use the production-mutation procedure for this editor command; the payload-only dry-run label does not authorize initialization.

The Apps Script endpoint must be published as `Anyone`; `Anyone with Google account` is not sufficient for the cookieless cross-origin transport. A healthy unauthenticated probe reaches the application and returns its JSON `UNAUTHORIZED`/`FORBIDDEN` envelope.

## Performance and transport evidence

The [read-latency task record](../openspec/changes/meet-read-latency-objective/tasks.md) is the canonical dated release/measurement history. The 2000 ms warm nearest-rank p95 objective remains unmet pending qualifying post-batch browser evidence; successful server execution is not browser success.

| Recorded milestone | Outcome |
| --- | --- |
| 2026-09-20 baseline | Both routes exceeded the objective; detailed distributions remain in the task record. |
| 2026-09-22 scoped reads, version 27 | Schedule/Insights p95 7283/15472 ms; 18/6 measured failures while collecting 40 successes per route. Failures included 404 HTML echo handoffs. |
| 2026-09-24 batched reads, version 28 | Live editor parity and stable revisions passed with writes disabled; a browser POST/echo/bodyless-GET redirect loop still ended in `INVALID_REQUEST`. No qualifying post-batch 40-success-per-route measurement is recorded. |

The later bodyless GET explains the missing-envelope error; it does not show that the original POST was malformed. The exact Google-side cause remains unproven. Retain no one-time echo URLs/keys or private response bodies. Architecture describes the implemented batch path; [deployment](deployment.md) owns its release/consent procedure.

### Browser probes

On a signed-in administrator client, paste `scripts/browser-signed-in-read-probe.js` into DevTools and call `runSignedInReadProbe()`. It uses the application's `route-load` entries, runs two warmups, and seeks 40 successful fresh reads per route while preserving failures and recording only durations/outcomes. For direct response classification, `scripts/browser-read-probe.js` accepts an in-memory credential through `runReadLatencyProbe({ appsScriptUrl, credential })`. Do not save credentials or response bodies.

Correlate the measurement window and direct probe IDs with sanitized `read-phases` lines using read-only `npx clasp logs`; inspect the pinned version with `npx clasp deployments`. Logs require the linked GCP project ID in ignored `.clasp.json`. Exclude the two warmups, keep slow successful reads unless independent evidence establishes an allowed cold-start/upstream exclusion, and report every exclusion and failure. The existing probe seeks 40 successes; the proposed Worker acceptance window is a separate future contract.

### Local experiment and proposed migration

The `codex/read-api-prototype` branch at `a47b274` records a synthetic localhost Node experiment: two warmups and 40/40 successes per route, zero redirects, Schedule/Insights p95 6.2/5.9 ms. Its evidence lives in that branch's read-latency tasks, not master's production evidence. It does not test real Google identity verification, live Sheets, WAN behavior or Worker CPU. The [six-change roadmap](../openspec/changes/validate-worker-backend-feasibility/design.md#sequence-and-ownership) is proposed work; production remains Apps Script until separately approved releases establish otherwise.

## Availability diagnostics

Recurring availability is normalized by weekday and coalesces adjacent or overlapping intervals. A save may replace row IDs and reduce row count without removing a minute of coverage. Compare normalized coverage by volunteer/day/time zone, not row IDs or raw counts.

Raw Sheet date/time cells are decoded in the workbook's own time zone. `describeSignIn` reports both workbook and configured scheduling zones; a mismatch is supported but must remain visible because decoding in the scheduling zone can shift historical time-only cells.
