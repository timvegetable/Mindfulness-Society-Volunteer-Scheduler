## 1. Baseline and Read Plans

- [ ] 1.1 Verify primary-read acceptance and portable-state compatibility; pin unchanged domain/projection baselines independently of the pending UI changes.
- [ ] 1.2 Define exact workbook read plans and fixed-clock fixtures for volunteer dashboard, center candidate read and schedule preview, including denied identities and larger preview workloads.

## 2. Scoped Handler Ports

- [ ] 2.1 Port volunteer.dashboard through the existing Worker boundaries; test linked ownership, missing/inactive volunteers, cancelled assignments and unauthorized fields.
- [ ] 2.2 Port center.candidate.read; test current center scope, multiple centers, administrator access and role revocation between requests.
- [ ] 2.3 Port admin.schedule.preview using the accepted compute topology; prove baseline output/revision parity and zero assignment/backup/run/audit/revision persistence.
- [ ] 2.4 Test preview followed by concurrent edits and stale publication rejection through the existing writer; preserve interval, rank, eligibility and time-zone semantics.
- [ ] 2.5 Add explicit routing for only these three operations; test that import staging and Insights refresh remain on the mutation path.

## 3. Acceptance and Release

- [ ] 3.1 Measure representative/larger preview CPU, deadlines and Google call counts; resolve any resource failure before enabling its production route.
- [ ] 3.2 Run role-scoped browser acceptance on synthetic staging and differential/negative/read-count contracts; record each operation's evidence.
- [ ] 3.3 Run focused tests, npm test, npm run check, all builds and openspec validate serve-remaining-reads-from-worker --strict.
- [ ] 3.4 Prepare operation-scoped release/rollback manifests, then perform only specifically approved deployments with required snapshot/live-gate checks and record volunteer/center/admin production browser results.
- [ ] 3.5 Update implemented operation routing and subsystem/testing/deployment documentation; leave unrelated UI and original production-data acceptance tasks open.
