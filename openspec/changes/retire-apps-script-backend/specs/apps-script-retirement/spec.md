## ADDED Requirements

### Requirement: Measured retirement window
Retirement SHALL require all migration predecessors accepted, at least seven consecutive stable days after writer cutover, coverage of every operation family and maintenance workflow, notification delivery/retry and restart recovery evidence. A material migration defect SHALL require renewed affected evidence and a new stable observation window after its fix.

#### Scenario: Seven quiet days without workflow coverage
- **WHEN** the minimum time passes but imports, publication or cancellation delivery remain unexercised
- **THEN** retirement remains pending until the workflow acceptance matrix is complete

### Requirement: Operational independence from Apps Script
Initialization, schema validation, snapshot/reconciliation, migration loading, diagnostics, exceptional-write recovery, authentication, authorization, imports, notifications, locking and idempotency SHALL have verified active paths independent of Apps Script before retirement. Historical references SHALL be distinguishable from active operational requirements.

#### Scenario: Browser migration complete but recovery needs editor
- **WHEN** all browser operations use Worker but a required recovery procedure still invokes an Apps Script editor function
- **THEN** retirement is blocked until the replacement procedure is implemented and rehearsed

### Requirement: Explicit rollback closure and scoped decommission
The legacy deployment SHALL remain disabled but recoverable during observation. Closing rollback, deleting/retiring deployments, removing active configuration and revoking access SHALL require their specific approvals and the applicable snapshot/live-gate procedures. Revocation SHALL affect only credentials/resources verified unused by surviving services.

#### Scenario: Shared Google access remains necessary
- **WHEN** a credential or permission is still required for Sheets or identity integration
- **THEN** decommission excludes it and records the surviving dependency

#### Scenario: Pending mutation during closure
- **WHEN** a mutation, replay reconciliation or mail outcome remains unresolved
- **THEN** rollback closure does not proceed until the state has been reconciled

### Requirement: Clean active backend and retained evidence
After retirement, active client/server configuration and operational tooling SHALL contain no Apps Script request, Script Property, mail or locking dependency. Obsolete adapters/build targets SHALL be removed without deleting shared domain code or sanitized historical evidence. Documentation SHALL describe implemented behavior and leave unrelated backlog tasks open.

#### Scenario: Final verification
- **WHEN** authenticated browser flows and reviewed maintenance procedures run after decommission
- **THEN** their active traces/configuration show no /exec or /echo dependency and all required behavior succeeds through Worker-era paths
