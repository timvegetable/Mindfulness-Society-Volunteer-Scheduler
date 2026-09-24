## Context

Depends on every migration predecessor and accepted writer handover. Legacy entrypoints also support initialization, schema checks, migration loading, diagnostics and exceptional-write reconciliation. Browser network traces alone cannot establish retirement readiness.

## Goals / Non-Goals

**Goals:** Remove all active Apps Script runtime/operational dependencies after a measured observation window and explicit rollback closure.

**Non-Goals:** Delete historical evidence, remove the workbook or Google sign-in, close unrelated original acceptance tasks, or revoke shared credentials without dependency checks.

## Decisions

Observe at least seven consecutive days after the accepted writer cutover, and cover every operation family, one scheduling publication/import workflow, cancellation delivery/retry, coordinator restart recovery and maintenance rehearsal. Quiet elapsed time without exercised workflows is insufficient. A material migration defect resets the affected acceptance evidence and starts a new seven-day stable observation window after its fix.

Inventory every Apps Script global, entrypoint, deployment/config reference, timer/trigger, mail path and maintenance tool. Replace active schema initialization/checking, snapshot/reconciliation, import/migration and recovery workflows with reviewed platform-independent or Worker-era tools. Historical archive references are allowed and labelled; active scripts must not use /exec, /echo or Script Properties. Do not remove pure shared domain code just because it originally shipped in an Apps Script bundle.

Keep the legacy deployment disabled but intact throughout observation. Close rollback deliberately only after outstanding pending mutations, idempotency records and mail outcomes are reconciled. Remove active URLs/config schema compatibility and obsolete source/build/test adapters in reviewed commits. Preserve sanitized release identifiers and recovery history in documentation/Git; private exports remain ignored. Credential/access revocation is separately approved and limited to resources proved unused by the surviving Google Sheets and identity integrations.

## Risks / Trade-offs

- [Rare maintenance workflow still uses editor tools] → Rehearse its replacement before retirement rather than discovering it during an incident.
- [Deleting legacy code obscures history] → Preserve versioned history and sanitized operational evidence.
- [Shared Google permissions revoked accidentally] → Dependency inventory and individually reviewed revocation list.

## Migration Plan

Record observation start/end, tested workflow matrix, unresolved incidents and rollback recommendation. Complete replacement-tool tests and all normal checks/builds/spec validation. Obtain explicit approval to close rollback and for each deployment/access mutation. Before approved production changes follow snapshot and live-gate verification, including the Worker coordinator's actual gate/authority state. Remove legacy production config, confirm fresh and previously loaded clients fail safely if using obsolete endpoints, then revoke only unused access. Verify current browser and maintenance traces contain no Apps Script dependency. Update architecture, development, testing, deployment, security and operations to describe the implemented system, retaining dated history where useful.

## Open Questions

- Which actual operation schedule supplies sufficient observation coverage? Seven days is the minimum; extend until the matrix is complete.
- Which Google resources are shared with other tools? Resolve before approving any revocation.
