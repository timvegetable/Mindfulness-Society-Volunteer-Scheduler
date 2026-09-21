## 1. Baseline and Attribution

- [ ] 1.1 Pin the deployed-client fresh-read sampling rules, nearest-rank p95 calculation, and cold-start/upstream/failure classification in a repeatable probe
- [ ] 1.2 Add lightweight request-local phase timing for credential verification, authorization, workbook hydration, derivation, and response construction without logging credentials or private rows
- [ ] 1.3 Capture a production-shaped baseline and identify the controlling latency components for Schedule and Insights

## 2. Scoped Workbook Hydration

- [ ] 2.1 Define explicit required-tab/range plans for Schedule and Insights reads, including fresh authorization and revision inputs
- [ ] 2.2 Implement request-local scoped hydration and memoization inside the workbook boundary without caching rows across executions
- [ ] 2.3 Add parity and read-count contract tests proving projections match existing behavior and each required range is read only as planned

## 3. Batched Reads

- [ ] 3.1 Use the phase evidence to decide whether advanced-service batch reads are required and record the decision and operational prerequisites
- [ ] 3.2 If required, implement a workbook-layer batch adapter with configured-workbook range allowlisting, consistent decoding, and fail-fast configuration validation
- [ ] 3.3 Add adapter, fallback or failure, snapshot-consistency, authorization, and revision regression tests

## 4. Measurement Decision

- [ ] 4.1 Run `npm test` and `npm run check`, then deploy only under the documented snapshot, write-disable, approval, and rollback procedure
- [ ] 4.2 Collect at least 40 successful fresh warm measurements for each route and report min, median, nearest-rank p95, max, exclusions, failures, and dated environment details
- [ ] 4.3 If both routes meet 2000 ms p95, record passing evidence; otherwise present the measured platform floor and architecture or target alternatives for explicit administrator decision
- [ ] 4.4 Update architecture, operations, deployment, testing, and responsive-navigation documentation for the selected read strategy and final approved objective
