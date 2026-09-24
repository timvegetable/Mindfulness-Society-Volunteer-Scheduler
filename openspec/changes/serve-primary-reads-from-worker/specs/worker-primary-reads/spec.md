## ADDED Requirements

### Requirement: Direct primary-operation transport
The Worker SHALL serve session.me, admin.schedule.read and admin.insights.read as direct JSON responses to the existing cookieless POST text/plain envelope, preserving operation/payload validation, idempotencyKey presence, optional expectedRevision and application error codes. It SHALL enforce a 64 KiB body cap while consuming the body, exact origin CORS, no-store and controlled route/method/error handling.

#### Scenario: Primary browser route loads
- **WHEN** the client selects a Worker-routed primary operation
- **THEN** it sends the existing envelope to the configured Worker endpoint, accepts the direct JSON envelope and treats any redirect as a failure without falling back to Apps Script

#### Scenario: Invalid or oversized request
- **WHEN** a request has malformed JSON, an unsupported operation, arbitrary Sheet access fields or a body exceeding the byte limit
- **THEN** the boundary returns a controlled rejection without invoking a domain handler

#### Scenario: Allowed-origin error response
- **WHEN** an allowed-origin request fails authorization or an upstream request
- **THEN** the application error is browser-readable through the same exact-origin CORS policy without exposing tokens, rows or raw upstream error bodies

### Requirement: Fresh authorization and consistent Sheets snapshots
The Worker SHALL verify Google ID-token signature, issuer, audience, expiry, subject and verified email, resolve a fresh active Users entry, and apply existing role policies before domain hydration. It SHALL use fixed workbook/schema-derived ranges, read-only credentials and the completed portable-state snapshot protocol. Public keys/access-token caches SHALL NOT replace fresh Users authorization.

#### Scenario: Cached credentials after role revocation
- **WHEN** a previously valid administrator loses its active role while its credential remains unexpired
- **THEN** the next admin read is denied before fetching Schedule or Insights data

#### Scenario: Rows change during hydration
- **WHEN** the portable mutation generation or relevant revisions change during a batch read
- **THEN** the Worker rejects that snapshot and does not publish a current projection or cache entry from it

### Requirement: Shared Insights freshness semantics
Insights SHALL reuse a non-expired dataset when its source revisions are unchanged, label a retained changed-source dataset stale with reasons, and regenerate absent or expired data from a consistent snapshot. The cache SHALL use a 300-second TTL and SHALL NOT authorize requests. Legacy refresh during coexistence SHALL invalidate Worker cache reuse through a portable refresh generation. Concurrent older derivations SHALL NOT replace newer cache generations.

#### Scenario: Unchanged source cache hit
- **WHEN** a subsequent authorized read observes the same source revisions and an unexpired dataset
- **THEN** it returns that dataset without repeating derivation

#### Scenario: Legacy refresh followed by Worker read
- **WHEN** legacy admin.insights.refresh succeeds and advances the portable refresh generation
- **THEN** the next Worker read does not reuse the pre-refresh cache generation and returns regenerated data only after completed-snapshot validation

#### Scenario: Stale dataset before refresh or expiry
- **WHEN** relevant source revisions change while a retained dataset has not expired
- **THEN** the response reports that dataset as stale with the changed-source reasons rather than falsely marking it current

### Requirement: Explicit mixed-backend routing
Client/configuration tooling SHALL route exactly the three primary operations to Worker when enabled, preserve legacy routing for other operations, validate endpoints/origins, and render backend-appropriate diagnostics. Rollback SHALL be an intentional configuration release to a portable-protocol-compatible legacy deployment.

#### Scenario: Worker failure during bootstrap
- **WHEN** Worker session.me is unavailable
- **THEN** the client reports the failure without silently invoking Apps Script or treating cached identity as authority

### Requirement: Separate reliability and latency acceptance
Production acceptance SHALL record two warmups and a predeclared 40-attempt warm window per Schedule and Insights route, all outcomes, min/median/nearest-rank p95/max, platform/configuration versions and sanitized request metadata. Reliability SHALL pass only with 40/40 successes, zero redirects/echo/HTML/bodyless replays and semantic parity. The existing 2000 ms p95 objective SHALL remain independently unmet until both routes satisfy its owning specification.

#### Scenario: Reliable but slow
- **WHEN** all measured requests succeed but either route exceeds 2000 ms p95
- **THEN** transport reliability can pass while the latency objective remains open and requires further work or an explicitly approved specification amendment

#### Scenario: A failed measured attempt
- **WHEN** any attempt in the declared window fails and later diagnostic requests succeed
- **THEN** the failure remains in that window's report and it is not relabelled 40/40 by collecting replacements

### Requirement: Sanitized observability and gated release
The implementation SHALL record bounded request IDs, operation/outcome, phase durations, response byte count and upstream call counts without credentials, private rows or one-time URLs. Production routing SHALL require accepted prerequisites, staging parity, complete required validation and separately authorized Worker/Pages releases with the required snapshot and live-gate checks.

#### Scenario: Platform terminates the Worker
- **WHEN** CPU or platform quota termination prevents application JSON handling
- **THEN** browser diagnostics classify the non-JSON/transport failure accurately and the acceptance report records it rather than assuming the outer exception handler covered it
