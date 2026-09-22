# Production operations

Production is not a normal development target. Do not mutate the workbook, Script Properties, Apps Script deployment, GitHub Pages deployment, or repository remote without explicit approval for that specific action.

## Live write gate

State-changing API operations are available only when the Apps Script Script Property `WRITE_ENABLED` is exactly `true`. When false, the runtime omits the write lock; the dispatcher returns `UNAVAILABLE` for mutations.

The `writeEnabled` field in `production.local.json` is a deployment-check input, not a remote control and not evidence of the live property. Deployment reports repeat that local assumption. They cannot read or set the live Script Property.

The same caution applies to every other Script Property, because the local file is only a deployment input. On 2026-09-21 the live `WRITE_ENABLED` was `true` while the local config said `false`, and the live `ADMINISTRATOR_RECIPIENTS` held a single address where the local config lists two — so a notification flow can be configured differently in production than the repository implies. Read the live property before reasoning about production behaviour; do not infer it from the local file.

Write `ADMINISTRATOR_RECIPIENTS` as a JSON array of addresses, or as a comma-separated list. `listField` in `src/server/runtime.ts` accepts both, but it only treats a JSON *array* as structured: any other valid JSON falls through to the comma split, so a property holding `null` or `{"a":1}` resolves to the literal recipient `"null"` or `'{"a":1}'`. The application then hands that to `GmailApp`, which throws, and the failure is recorded only in memory. A malformed recipient property therefore looks identical to a working one from outside.

Notification email has not delivered since the notification path was deployed, for a reason independent of the recipient property: the runtime read a mail service the manifest does not authorize, so every send threw regardless of the recipient list. Observed 2026-09-22, when a reviewed editor probe in the bound project reported a correctly-resolved recipient, an available mailer, and `sent: false` with a permission error. The scope rule and which service is authorized belong to [security.md](security.md); the defect and its fix are task 10.27. Because the delivery status is written only to an in-memory record, that throw left no log line, no sheet row, and no audit entry, so a correct-looking `ADMINISTRATOR_RECIPIENTS` value proves nothing about delivery. Verify delivery by observing the message arrive, never by reading the property. The fix is implemented and undeployed, so delivery stays blocked until the next server deployment, and this note is an observation of the deployed version rather than of the repository.

The last recorded live check, on 2026-09-19, found `WRITE_ENABLED=true` while the local production config said false. Treat that as a hazard, not as current state. Before any production mutation or server deployment:

1. Export a workbook snapshot.
2. Open the bound Apps Script project with the administrator-owned account.
3. Inspect the live Script Property and set it false if the approved procedure requires a write-disabled posture.
4. Run `describeSignIn` in the editor and inspect its logged `writeEnabled` value.
5. Stop if the live result differs from the intended posture.

After the approved action, verify the property again. Re-enabling writes is a separate production mutation and requires separate review.

Editor procedures must expose a no-argument entry point. The Apps Script editor's Run menu invokes a function with no arguments, so a helper declared as `fn(mode)` cannot be run from the dropdown at all and needs one wrapper per mode — the Task 5.7 procedures pair `fixtureGate_5_7(mode)` with `fixtureGateOpen_5_7()` and `fixtureGateClose_5_7()` for exactly this reason. Observed on 2026-09-22, when a reviewed procedure offered only a parameterised entry point, could not be run, and had to be rewritten before the step could proceed. Any procedure described here as run from the editor is assumed to have a no-argument wrapper.

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
- No read-only API exposes `TAB_REVISION_*`. The authenticated API reports `DATA_REVISION` as `revision`, `SCHEDULING_INPUT_REVISION` as `inputRevision`, and the latest completed run's output revision as `scheduleRevision`. `describeSignIn` reports only `WRITE_ENABLED`. The remaining values are read by the owner in the Apps Script editor under Project Settings → Script Properties.

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
2. `TAB_REVISION_Volunteers`, `TAB_REVISION_RecurringAvailability`, and `TAB_REVISION_Assignments` compose the insight cache key. Bumping them does not regenerate insights: the stored dataset is marked stale with the changed-revision reasons, and the next `admin.insights.read` serves that dataset labelled stale instead of deriving a new one. That state is short-lived. The dataset is an accelerator cached for `CACHE_TTL_SECONDS` (300 seconds) in `src/server/insights/cache-repository.ts`, and a read whose entry has expired returns nothing stored and regenerates from the current rows, so an explicit `admin.insights.refresh` is only needed to correct a dataset inside that five-minute window. Read the view and confirm rather than assuming either way.

This procedure was exercised end to end on 2026-09-21 against the production workbook: a tagged fixture set was inserted, the counters advanced by exactly one per batch, the acceptance flow ran, and the fixtures were removed again. The restored workbook compared with the pre-insert baseline as zero difference across every operational tab by stable identifier, the append-only audit rows were preserved, every counter had moved only upward with untouched tabs unchanged, and the published schedule kept the same `stale` verdict it had before the window.

## Snapshot parsing and reconciliation

A reviewed direct-write procedure needs two things the Sheet export alone cannot give: a structural check that the snapshot is a trustworthy restoration reference, and a later comparison that proves the workbook returned to its starting state.

The tooling lives in `scripts/snapshot/`. It reads a snapshot through `pandas.read_excel(..., sheet_name=None, engine="calamine")` and never writes cell contents into the repository. Commands below use `<snapshot-python>` for the interpreter of the `phamily-env` conda environment, which is the only environment guaranteed to provide pandas and python-calamine; another interpreter or another Excel parser is not an acceptable substitute. `<baseline.json>`, `<snapshot.xlsx>`, and `<restored.xlsx>` must stay out of version control with restricted permissions.

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
4. `Settings` is compared as a multiset, because its `key` is not unique. `initializeWorkbook` appends a `workbookSchemaVersion` row whenever the first matching row's value differs from the current schema version, so the tab can hold repeated keys; the effective version is the first matching row.
5. `--fixture-tag` drops every row containing the tag from both sides, so uniquely tagged acceptance fixtures do not have to be restored byte-for-byte.

The tool ships with its own check, which needs no snapshot and touches no production data:

```sh
<snapshot-python> scripts/snapshot/selftest.py
```

Before believing a zero-difference result, confirm the machinery itself is sound: two consecutive exports of an unchanged workbook must compare as zero difference even though the two files have different digests.

## Diagnostics

Safe/read-only tools include:

- `describeSignIn()` in the Apps Script editor: logs resolved audience, write gate, scheduling settings, workbook/configured time zones, and readable Users rows. Its output contains private account information; do not paste it into committed files.
- `checkWorkbookSchema()` in the editor: checks schema shape without loading migration data.
- `validateMigrationWorkbook()` in the editor: validates the embedded migration payload without applying it.
- `node scripts/probe-service.mjs --config production.local.json`: sends an unauthenticated, non-mutating request to distinguish public reachability, platform sign-in interception, script errors, and old/current bundle behavior.
- `node scripts/deployment-check.mjs ...`: examines local config and artifacts only; it does not verify live properties or deployed behavior.

The Apps Script endpoint must be published as `Anyone`; `Anyone with Google account` is not sufficient for the cookieless cross-origin transport. A healthy unauthenticated probe reaches the application and returns its JSON `UNAUTHORIZED`/`FORBIDDEN` envelope.

## Current performance observation

OpenSpec tasks 9.9 and 10.23 own the read-latency issue. Measurements on 2026-09-20 used 42 warm samples per route:

| Route | warm p95 | minimum | median | objective |
| --- | ---: | ---: | ---: | ---: |
| Schedule | 6966 ms | 4520 ms | 6027 ms | 2000 ms |
| Insights | 6239 ms | 3162 ms | 4948 ms | 2000 ms |

Every sample exceeded the objective and no read failed. The observed floor comes from rebuilding the production runtime and reading roughly eight required tabs sequentially through `SpreadsheetApp`; each repository decodes a tab only once per request, but the reads are not batched across tabs. The manifest currently has `spreadsheets.currentonly`, not the Advanced Sheets service. Scope changes, operation-specific repository loading, or `batchGet` are architecture/security changes and need an approved design. Do not quietly rewrite the objective.

## Availability diagnostics

Recurring availability is normalized by weekday and coalesces adjacent or overlapping intervals. A save may replace row IDs and reduce row count without removing a minute of coverage. Compare normalized coverage by volunteer/day/time zone, not row IDs or raw counts.

Raw Sheet date/time cells are decoded in the workbook's own time zone. `describeSignIn` reports both workbook and configured scheduling zones; a mismatch is supported but must remain visible because decoding in the scheduling zone can shift historical time-only cells.

