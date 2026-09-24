## Why

Moving browser operations does not remove dependence on Apps Script if maintenance, notifications, revision recovery, or rollback still require it. Retirement must follow verified operation and maintenance parity and an explicit end to the rollback period.

## What Changes

- Verify an observation window covering all operation families, notifications, restart/retry recovery, and maintenance flows with no Apps Script runtime dependency.
- Replace remaining editor-only initialization, schema checks, snapshots/reconciliation, migration and recovery procedures with reviewed Worker-era tools.
- Remove legacy production routing/configuration and obsolete build/deployment adapters after rollback closure, retaining sanitized historical evidence.
- Revoke only confirmed-unused deployment access and credentials through separately approved actions.
- **BREAKING**: legacy Apps Script runtime/deployment configuration ceases to be supported after retirement.

## Capabilities

### New Capabilities

- `apps-script-retirement`: Evidence-based decommissioning of runtime and operational dependencies.

### Modified Capabilities

None in the main spec tree. Business requirements remain unchanged.

## Impact

Legacy server entrypoints/adapters, Apps Script build and deployment scripts, client/config compatibility, tests and operational documentation. Depends on all previous migration changes, especially accepted `move-workbook-writes-to-worker` handover and rollback rehearsal. No deployment is deleted as part of proposal creation.
