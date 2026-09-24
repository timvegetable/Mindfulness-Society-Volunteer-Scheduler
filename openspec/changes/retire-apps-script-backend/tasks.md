## 1. Readiness and Dependency Audit

- [ ] 1.1 Verify all predecessor acceptance and writer-handover evidence; record observation start, required workflow matrix, rollback posture and unresolved incidents.
- [ ] 1.2 Inventory all active Apps Script globals, entrypoints, /exec/config references, triggers, mail calls and maintenance dependencies; distinguish sanitized historical references.
- [ ] 1.3 Audit deployment permissions/credentials for surviving dependencies and prepare a narrowly scoped revocation list without touching shared Sheets/identity access.

## 2. Maintenance Independence

- [ ] 2.1 Implement and rehearse replacement initialization/schema diagnostics with idempotence and protection checks.
- [ ] 2.2 Implement and rehearse snapshot, revision reconciliation, migration loading and exceptional-write recovery paths without editor/Script Property access.
- [ ] 2.3 Exercise notification delivery/retry, coordinator restart and uncertain-commit recovery using the surviving tools; resolve every active dependency found by the audit.

## 3. Observation and Rollback Closure

- [ ] 3.1 Collect at least seven consecutive stable days and every required workflow outcome, including import/publication/cancellation and maintenance; restart the stable window after material migration fixes.
- [ ] 3.2 Reconcile pending mutations, replay records and unknown mail outcomes; prepare a concrete rollback-closure recommendation with the measured coverage matrix.
- [ ] 3.3 Obtain explicit rollback-closure approval only after evidence is complete; keep the legacy deployment disabled but intact until then.

## 4. Decommission and Verify

- [ ] 4.1 Remove obsolete legacy source/adapters/build targets and active configuration compatibility while retaining shared domain code and sanitized history; adapt affected tests.
- [ ] 4.2 Update architecture, development, testing, deployment, security and operations to the implemented Worker system and preserve outstanding unrelated backlog state.
- [ ] 4.3 Run focused tests, npm test, npm run check, all remaining builds and openspec validate retire-apps-script-backend --strict; scan active paths for Apps Script dependencies.
- [ ] 4.4 Prepare each final release/access change, then execute only its specific approval with snapshot and live-gate/authority verification; revoke only confirmed-unused resources.
- [ ] 4.5 Verify fresh/old-client behavior and maintenance traces after retirement, record no active /exec or /echo dependency, and retain final release/recovery evidence without private data.
