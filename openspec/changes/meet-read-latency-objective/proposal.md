## Why

Measured deployed warm reads miss the existing two-second p95 objective by a wide margin: Schedule measured 6966 ms and Insights 6239 ms over 42 successful samples each on 2026-09-20. The result is a structural performance gap, not isolated tail latency, and needs an explicit architecture and stakeholder decision rather than remaining attached to production acceptance.

## What Changes

- Establish a reproducible baseline that separates warm successful requests from cold starts, upstream delays, and failures.
- Reduce Schedule and Insights read work by loading only required tabs and, where supported and justified, batching Sheet range reads without weakening request-local consistency or authorization.
- Re-measure both routes with at least 40 successful warm samples each against the existing nearest-rank p95 requirement.
- If the objective remains infeasible within the Apps Script and Google Sheets architecture, require an explicit administrator-approved spec amendment rather than silently lowering it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `responsive-application-navigation`: Preserve the warm-read measurement contract while making the implementation and any potential objective renegotiation an independently reviewable decision. This capability is introduced by the active `volunteer-session-scheduling` change and must be synced to the main specs before this delta is archived.

## Impact

- Affects operation-specific hydration in `src/server/runtime.ts`, workbook read abstractions in `src/server/workbook/`, and latency probes under `scripts/`.
- May require enabling and documenting the Apps Script advanced Sheets service if batched reads are selected.
- Must preserve least-privilege projections, one-snapshot semantics, revision correctness, and the rule that authorization data is freshly read for every execution.
