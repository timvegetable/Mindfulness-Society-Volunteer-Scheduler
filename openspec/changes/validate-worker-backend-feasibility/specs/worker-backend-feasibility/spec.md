## ADDED Requirements

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
