## Why

Production reads depend on revisions stored in Apps Script Properties, which a direct Sheets client cannot retrieve. Independent Worker reads cannot safely coexist with legacy writes until both backends share a revision and interrupted-mutation protocol.

## What Changes

- Introduce versioned, protected workbook control metadata for global/tab/input revisions, writer authority, and completed/in-progress mutations.
- Migrate revision authority monotonically from Script Properties under a write-disabled maintenance procedure; separate portable policy configuration from secrets and operational gates.
- Adapt the sole legacy writer and all maintenance paths to the protocol and reject incomplete snapshots.
- Correct the read-only classification of import preview, which persists staged runs, and require the matching revision-aware client request.
- Resolve the existing schema-version/protection defects needed to trust the control tab, linking evidence back to original tasks 10.24 and 10.25.
- **BREAKING**: old deployments and write tools that only update Script Properties cannot safely remain writable after metadata migration.

## Capabilities

### New Capabilities

- `portable-workbook-state`: Shared revision authority, mutation fencing, configuration separation, and recoverable migration.

### Modified Capabilities

None in the main spec tree (not yet present). This adds infrastructure requirements alongside the active scheduling specifications; its intentional import-preview policy change is explicit above.

## Impact

Workbook schema/repositories/initializer, runtime and dispatcher, import preview client requests, snapshot/reconciliation tools, and architecture/security/operations/deployment documentation. Depends on an accepted `validate-worker-backend-feasibility` verdict. Enables `serve-primary-reads-from-worker`; Apps Script remains the only writer.
