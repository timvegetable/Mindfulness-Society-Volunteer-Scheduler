# Import preview reclassification evidence — 2026-09-29 (task 3.3)

Task 3.3: reclassify import preview staging as a mutation, require
`expectedRevision`, adapt its authenticated client revision source, and test the
write-disabled, read-only, missing and stale paths with zero persistence.

## The defect this closes

`admin.import.whenIsGood.preview` was registered as non-mutating and read-only
while its handler stages a run through `WorkbookImportRepository` (recorded in
the change's 2026-09-24 implementation gaps and confirmed in source by the task
1.1 inventory). The dispatcher derives the write lock and the global revision
from the policy, so a staging write ran unlocked, outside the live write gate,
without advancing `DATA_REVISION`, and the client never sent a revision for it.
Nothing about the staged run was serialized against other writers.

## What changed

- **Policy.** `adminImportPreview` is now `mutating: true, expectedRevision:
  true, readOnly: false` (`src/server/integration/request-policy.ts`). The
  dispatcher therefore takes the script lock, requires the live write gate and
  compares the caller's revision before invoking the handler.
- **Requirement, not a hint.** `policy.expectedRevision` is now enforced:
  `src/server/integration/dispatcher.ts` refuses a request that omits the
  revision with `INVALID_REQUEST` before any state is touched. The architecture
  document recorded this as a gap ("do not treat `OperationPolicy.expectedRevision`
  as enforcement until the dispatcher has a regression-tested presence check");
  the check and its regression now exist. Every other mutating operation already
  declared and sent a revision, so no other client path changes.
- **Read-only dispatch.** Because the policy is no longer `readOnly`, the
  envelope validator's existing rule rejects it through a read-only request with
  `FORBIDDEN` before the handler is reached.
- **Client revision source.** `ApiClient.importPreview(resultsCode,
  expectedRevision, credential)` now carries the revision, the import view's
  `onPreview` action receives the revision it already renders with the run, and
  the import controller refuses to preview when that revision is unavailable and
  tells the operator to reload. The mapping-refresh fallback preview reuses the
  same revision.

## Tests

`src/server/integration/dispatcher.contract.test.ts`, six new cases. "Zero
persistence" is asserted by a handler spy that records every invocation plus the
revision source's value:

| Request | Result | Persistence |
| --- | --- | --- |
| Policy classification | `mutating: true, expectedRevision: true, readOnly: false` | — |
| `expectedRevision` omitted | `INVALID_REQUEST` | handler not called; revision unchanged |
| stale `expectedRevision` | `STALE_REVISION` (`currentRevision` in details) | handler not called; revision unchanged |
| no revision source or write lock (live gate closed) | `UNAVAILABLE` | handler not called |
| through `dispatchReadOnly` | `FORBIDDEN` | handler not called |
| current revision, writes enabled | `ok: true`, `revision` advanced | handler called once |

`src/client/api.test.ts`, two new cases: the preview envelope carries the
authenticated revision (12), and a padded string revision normalizes the way the
other mutations' revisions do.

## Boundary

This is the dispatch and client contract, not the full writer protocol. Preview
staging still writes through the existing repository path and still advances
`TAB_REVISION_Imports`; moving repository commits onto the portable control
record is task 3.2, and until it lands the global revision for a preview comes
from `DATA_REVISION` as it does for every other mutation. Nothing in this change
touches the live deployment: `WRITE_ENABLED` remains the operational gate, and a
preview against a write-disabled deployment is now refused like any other
mutation instead of staging a run.

Verification at this commit: `pnpm test` 44 files / 323 tests passed;
`pnpm run check` exit 0.
