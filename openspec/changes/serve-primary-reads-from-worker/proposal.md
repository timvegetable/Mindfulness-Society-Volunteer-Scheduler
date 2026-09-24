## Why

Schedule and Insights remain unusable when response delivery fails after successful Apps Script execution. Migrating their data requests without identity bootstrap would leave sign-in dependent on the same failing transport.

## What Changes

- Serve `session.me`, `admin.schedule.read`, and `admin.insights.read` through direct Worker JSON responses with real Google ID-token verification and fresh Users authorization.
- Preserve envelopes, optional `expectedRevision`, projections, error codes, workbook time semantics, and revision-aware Insights cache behavior.
- Add explicit operation routing to the client and deployment configuration, retaining legacy writes and deliberate configuration rollback without automatic fallback.
- Measure production browser reliability independently from the unchanged 2000 ms p95 objective.

## Capabilities

### New Capabilities

- `worker-primary-reads`: Authorized, consistent primary reads and controlled mixed-backend routing.

### Modified Capabilities

None. The existing `responsive-application-navigation` and `availability-insights` requirements in active changes remain authoritative; this change adds transport acceptance and preserves their behavior.

## Impact

Worker transport/composition, shared integration policy, workbook snapshot access, derived cache, client API/config schemas/rendering/checks, release workflows, probes and operational documentation. Depends on `validate-worker-backend-feasibility` and `make-workbook-state-portable`. Does not move preview, refresh, or publication operations implicitly.
