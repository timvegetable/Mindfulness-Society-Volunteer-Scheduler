## Context

Depends on accepted primary-read release. Existing policies identify volunteer.dashboard, center.candidate.read and admin.schedule.preview as the remaining genuinely read-only operations. Import preview persists runs and remains with writes; Insights refresh advances mutation state. Separate UI changes must not alter the parity baseline during this port.

## Goals / Non-Goals

**Goals:** Port the three named reads with identical scoped projections and validated scheduling-preview performance.

**Non-Goals:** Import staging, mutation routing, center/availability UI redesign, or changing scheduling eligibility/ranking/tie-breaking.

## Decisions

Use the shared Worker authentication, current Users lookup, control snapshot protocol and exact operation routing introduced by primary reads. Define schema-derived read plans from actual handler dependencies rather than eagerly loading the entire workbook. Keep raw REST values inside workbook codecs. Verify volunteers see only their own permitted data, center contacts only authorized centers, and multi-role projection/authorization remains unchanged.

Scheduling preview computes over a completed snapshot and publishes no assignments, backups, run, audit or revision writes. Its result carries the global revision for a later reviewed publish; any intervening edit must make that publish stale. Use the execution topology accepted by feasibility, measuring representative and larger rosters. If a compute Durable Object is needed, it has no writer authority and uses the same snapshot/policy contract. Do not lower coverage or change algorithms to fit CPU limits.

Classify acceptance per operation. Differential fixtures include no linked volunteer, inactive/revoked identities, multiple centers, candidates and confirmed sessions, cancelled occurrences, unranked/graduated volunteers, interval coverage and timezone boundaries. Scope-denied calls must not hydrate unauthorized domain data or populate caches with it.

## Risks / Trade-offs

- [Preview is heavier than published reads] → Require CPU headroom and controlled timeout evidence before enabling it.
- [Broad eager hydration increases exposure/quota] → Test explicit read plans and filtered response fields for each role.
- [Concurrent UI changes obscure parity] → Pin baseline commit/fixtures and keep presentation changes in their existing proposals.

## Migration Plan

Port and validate one handler at a time in staging. Run focused tests, full suite, checks/builds and strict spec validation. Deploy reviewed artifacts under per-action approval and required snapshot/live-gate procedures. Route these three reads after staging evidence, verify actual volunteer/center/admin browser flows, and record per-operation outcomes and CPU/call counts. Rollback only these routes to the protocol-compatible legacy backend, preserving primary-read routing and the one legacy writer.

## Open Questions

- What representative larger preview fixture fits the expected operating horizon? Pin its dimensions before performance acceptance.
- Which authorized test accounts cover volunteer and center scopes? Synthetic fixtures cover automated tests; release accounts must be supplied separately.
