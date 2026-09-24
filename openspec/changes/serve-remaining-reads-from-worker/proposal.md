## Why

After primary reads move, volunteer dashboards, center reads, and scheduling previews would still depend on Apps Script response delivery. These reads also exercise ownership projections and heavier calculation absent from the first production slice.

## What Changes

- Move `volunteer.dashboard`, `center.candidate.read`, and `admin.schedule.preview` to the established Worker read boundary.
- Preserve volunteer ownership, center scope, administrator permissions, scheduling semantics, and snapshot revisions.
- Validate scheduling preview at representative and larger workloads on the selected free execution topology.
- Exclude import preview and Insights refresh: their effects belong to the coordinated write migration.

## Capabilities

### New Capabilities

- `worker-scoped-reads`: Remaining side-effect-free reads with scope enforcement and preview resource gates.

### Modified Capabilities

None. Existing domain requirements and separately proposed UI changes remain unchanged.

## Impact

Worker handlers and read plans, scoped projections, client routing, runtime/browser tests, and deployment documentation. Depends on accepted `serve-primary-reads-from-worker` evidence; production writer authority remains Apps Script.
