# worker-backend-feasibility Specification

## Purpose
TBD - created by archiving change validate-worker-backend-feasibility. Update Purpose after archive.

## Requirements

### Requirement: Isolated real-platform feasibility slice
The experiment SHALL serve only session.me, admin.schedule.read and admin.insights.read from a Worker using a synthetic staging workbook, real Google-issued identity credentials, and direct Sheets API access. It SHALL NOT invoke Apps Script, mutate production, accept synthetic verifier tokens in deployed staging, or enable a paid service without separate approval.

#### Scenario: Authorized staging read
- **WHEN** an active authorized staging user submits a valid primary read
- **THEN** the Worker verifies identity, reads Users freshly, authorizes the operation, obtains the permitted fixture ranges and returns the existing JSON envelope without redirects

#### Scenario: Attempted staging mutation
- **WHEN** a caller submits any mutation operation to the feasibility endpoint
- **THEN** the endpoint rejects it without writing workbook rows, audit data or revisions

### Requirement: Behavioral comparison uses shared contracts
The experiment SHALL compare semantic projections against the existing implementation using identical synthetic snapshots and fixed clocks, including revisions, staleness, authorization and workbook-zone normalization. It SHALL retain the request body limit and strict operation/payload allowlists.

#### Scenario: Serial dates and omitted blank cells
- **WHEN** a Sheets REST response contains serial dates, time fractions and omitted trailing cells
- **THEN** existing workbook codecs produce the same canonical data as the legacy fixture path in the workbook's time zone

#### Scenario: Revoked authorization
- **WHEN** an identity remains cryptographically valid but its Users row is inactive or unauthorized
- **THEN** the next request is denied before domain hydration regardless of token or derived-data caches

### Requirement: Measured free-runtime resource envelope
The experiment SHALL predeclare representative and larger fixture dimensions, measure actual Worker CPU separately from wall time, and report cold/warm authentication, Sheets-call counts, derivation, serialization, failure rates and quota consumption. It SHALL exercise scheduling-preview computation in a non-production test and verify current account limits and billing policy before accepting a zero-cost topology.

#### Scenario: CPU budget is insufficient
- **WHEN** representative or larger workloads lack measured headroom under the selected free runtime's CPU limit
- **THEN** the verdict blocks production migration until an optimized or alternative free topology passes the same workloads, or records no-go

#### Scenario: A fast local prototype exists
- **WHEN** reporting the experiment alongside the Node loopback benchmark
- **THEN** the report distinguishes local synthetic timings from deployed Worker/browser measurements and does not treat either as production latency acceptance

### Requirement: Explicit evidence verdict and release authorization
The experiment SHALL produce a dated go, conditional-go or no-go report with workload, revision/configuration assumptions, platform versions, sanitized metrics and unresolved conditions. Later production changes SHALL NOT proceed on unresolved conditional-go conditions. Every push or deployment SHALL retain the repository's per-action approval boundary.

#### Scenario: Staging is feasible
- **WHEN** parity, negative authorization, direct-response and resource tests pass
- **THEN** the report identifies the accepted topology and permits planning the portable-state implementation without claiming production acceptance or authorizing a release

#### Scenario: Evidence contains sensitive data
- **WHEN** raw traces include credentials, private rows, account identifiers or one-time response URLs
- **THEN** checked-in evidence contains only sanitized aggregate results and private artifacts remain in ignored in-tree storage

### Requirement: Isolated gateway and Durable Object staging topology (amendment 2026-09-27)
The experiment SHALL additionally evaluate a staging topology in which a thin gateway Worker forwards browser requests through a cross-script Durable Object binding to a SQLite-backed object that reuses the existing bounded transport and staging service. The gateway SHALL NOT import the production runtime, Zod, or Temporal, SHALL keep handling limited to transport admission and forwarding, SHALL stream the returned response without parsing or reserializing it, and SHALL map binding failures to the existing JSON error envelope. The host SHALL have no public route or workers.dev endpoint, SHALL route to one stable object per configured synthetic workbook chosen from deployment configuration (never browser input), SHALL keep Google credentials on the host only, SHALL create request-local services, snapshots, counters and principals inside the object, SHALL retain only existing expiring Google caches across requests, and SHALL write no application state into object storage. The existing staging Worker SHALL remain available as the baseline.

#### Scenario: Binding failure
- **WHEN** the gateway's Durable Object binding or object-selection configuration is missing or the forwarding call fails
- **THEN** the gateway responds with the existing bounded JSON error envelope without leaking binding details

#### Scenario: Object state isolation
- **WHEN** concurrent or sequential requests reach the same object
- **THEN** each request uses its own service, snapshot, counters and principal, and no application state is written to object storage

### Requirement: Staging preview benchmark endpoint (amendment 2026-09-27)
The experiment SHALL expose `POST /benchmark/schedule-preview` on the isolated staging topology, controlled by `STAGING_PREVIEW_BENCHMARK_ENABLED` with `false` as the default, and disabled requests SHALL return 404. An enabled request SHALL accept the existing authenticated envelope with operation `admin.schedule.preview` and an empty payload, SHALL require a freshly authorized administrator, SHALL invoke the real preview handler with the authenticated principal rather than a fabricated actor, SHALL fetch Users first and then one schema-derived batch containing SchedulingRuns, Volunteers, RecurringAvailability, AvailabilityExceptions, Sessions, Assignments, and Centers, and SHALL return the existing preview envelope. Neither previews nor rejected requests SHALL modify Sheets, audit rows, or revisions. `/exec` and its three-operation allowlist SHALL be preserved, and the preview operation SHALL be rejected through `/exec`.

#### Scenario: Benchmark disabled by default
- **WHEN** a deployment has not explicitly enabled `STAGING_PREVIEW_BENCHMARK_ENABLED`
- **THEN** `POST /benchmark/schedule-preview` returns 404 without reading the workbook

#### Scenario: Preview denial costs no domain reads
- **WHEN** a non-administrator submits the preview benchmark envelope, or an administrator submits it through `/exec`
- **THEN** the request is denied with the existing envelope and zero domain Sheets reads

### Requirement: Separately measured gateway and object CPU budgets (amendment 2026-09-27)
The experiment SHALL measure gateway CPU and object CPU separately against predeclared thresholds recorded before results are observed: gateway warm p99 ≤5 ms with every warm request ≤8 ms; object read CPU p99 ≤500 ms with every measured request including cold ≤1,000 ms; object preview CPU p99 ≤3,000 ms with every measured request including cold ≤5,000 ms; wall-clock latency thresholds unchanged. Platform metrics SHALL be attributed explicitly to the gateway script, host script, namespace, deployment and time window; coverage gaps, truncation or ambiguous attribution SHALL be reported and cannot pass a gate. Object memory and billable duration SHALL be collected from platform metrics where published, with unavailable measurements recorded as unresolved.

#### Scenario: Thresholds are predeclared
- **WHEN** the campaign runs and the verdict is recorded
- **THEN** the recorded thresholds match the amendment-2026-09-27 values in `evidence/experiment-contract.md` and have not been adjusted after observing results

#### Scenario: Insufficient coverage
- **WHEN** platform attribution is missing, truncated, sampled or ambiguous for a measured dimension
- **THEN** the affected dimension is reported unresolved instead of counted as passing
