## Why

Production reads depend on revisions stored in Apps Script Properties, which a direct Sheets client cannot retrieve. Independent Worker reads cannot safely coexist with legacy writes until both backends share a revision and interrupted-mutation protocol.

## What Changes

- Reassess feasibility using the archived gateway/Durable Object read campaign and optimized-preview campaign; resolve their acceptance conditions before implementation proceeds through the prerequisite gate.
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

Workbook schema/repositories/initializer, runtime and dispatcher, import preview client requests, snapshot/reconciliation tools, and architecture/security/operations/deployment documentation. Prerequisite review combines the archived [Durable Object read-path evidence](../archive/2026-09-29-validate-worker-backend-feasibility/evidence/verdict-2026-09-28.md) and [optimized-preview verdict](../archive/2026-09-29-accelerate-schedule-preview/evidence/verdict-2026-09-29.md), with unresolved conditions tracked in this change's tasks. Enables `serve-primary-reads-from-worker`, followed by `serve-remaining-reads-from-worker`; each retains its own acceptance gates. Apps Script remains the only writer.
