# Production operations

Production is not a normal development target. Do not mutate the workbook, Script Properties, Apps Script deployment, GitHub Pages deployment, or repository remote without explicit approval for that specific action.

## Live write gate

State-changing API operations are available only when the Apps Script Script Property `WRITE_ENABLED` is exactly `true`. When false, the runtime omits the write lock; the dispatcher returns `UNAVAILABLE` for mutations.

The `writeEnabled` field in `production.local.json` is a deployment-check input, not a remote control and not evidence of the live property. Deployment reports repeat that local assumption. They cannot read or set the live Script Property.

The last recorded live check, on 2026-09-19, found `WRITE_ENABLED=true` while the local production config said false. Treat that as a hazard, not as current state. Before any production mutation or server deployment:

1. Export a workbook snapshot.
2. Open the bound Apps Script project with the administrator-owned account.
3. Inspect the live Script Property and set it false if the approved procedure requires a write-disabled posture.
4. Run `describeSignIn` in the editor and inspect its logged `writeEnabled` value.
5. Stop if the live result differs from the intended posture.

After the approved action, verify the property again. Re-enabling writes is a separate production mutation and requires separate review.

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

Do not improvise revision numbers. If there is no reviewed reconciliation procedure, stop and add one before the mutation.

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

