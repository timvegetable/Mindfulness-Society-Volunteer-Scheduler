## ADDED Requirements

### Requirement: Single durable writer authority
All supported mutations SHALL enter one workbook-scoped durable coordinator, use the active writer epoch and live write gate, and be serialized across external I/O and restarts. The coordinator SHALL recheck current authorization and require expectedRevision for a new mutation. Obsolete backend endpoints SHALL reject writes independently of browser routing.

#### Scenario: Legacy client after handover
- **WHEN** an already-open client submits a mutation to the legacy endpoint after Worker authority is activated
- **THEN** the legacy endpoint rejects it without changing rows, audit, revisions or notification state

#### Scenario: Concurrent writes across await
- **WHEN** two callers submit mutations while the first coordinator operation is awaiting Sheets
- **THEN** the second cannot validate/commit against an intermediate state and is queued or rejected under the bounded admission policy

#### Scenario: Missing or stale expected revision
- **WHEN** a new mutation omits expectedRevision or supplies a revision different from current committed state
- **THEN** it fails without domain persistence or external notification delivery

### Requirement: Durable identity-bound idempotency
The system SHALL bind each request to actor, operation, idempotency key and a canonical payload/expectedRevision fingerprint, durably retain successful replay results for at least 24 hours, and prevent old keys from reexecution using tombstones thereafter. Replays SHALL require current authorization; changed fingerprints SHALL return CONFLICT. Identical committed replays SHALL return the prior successful result before comparing its original revision to the now-current revision.

#### Scenario: Lost response and restart
- **WHEN** a committed request is retried with the same actor/key/fingerprint after coordinator restart
- **THEN** it returns the stored or reconstructed result without duplicating domain changes, audit, revisions or notification intent

#### Scenario: Key reused with changed payload
- **WHEN** an actor reuses an existing operation key with a different payload or expectedRevision
- **THEN** the coordinator returns CONFLICT and makes no additional changes

#### Scenario: Replay body has expired
- **WHEN** a previously committed key is retried after its replayable result expires
- **THEN** the tombstone prevents reexecution and returns a controlled reconciliation/conflict outcome

### Requirement: Recoverable workbook commit
Domain changes, audit, affected counters, notification intents and operation receipt SHALL be committed as one atomic workbook batch where feasible. The coordinator SHALL persist prepared intent before dispatch, reconcile Sheets commit truth after uncertain outcomes, and prevent conflicting work while unresolved. Marker absence immediately after a timeout SHALL NOT by itself authorize a fresh conflicting commit or unsafe retry.

#### Scenario: Sheets committed before coordinator completion
- **WHEN** Sheets applied the batch but the coordinator lost the response before storing completion
- **THEN** recovery finds the workbook receipt, reconstructs the successful result and completes the durable record without repeating workbook effects

#### Scenario: Timed-out write still in flight
- **WHEN** a write times out and an immediate receipt read finds no marker
- **THEN** the coordinator keeps the operation unresolved until conclusive reconciliation or a proved replay-safe deterministic retry, rather than assuming it never committed

#### Scenario: Batch validation fails
- **WHEN** any component of an atomic domain/audit/revision batch is invalid
- **THEN** none of that batch is applied and the prior completed workbook remains authoritative

### Requirement: Complete mutation-family parity
The Worker SHALL support recurring availability updates, availability exceptions, cancellation, schedule publication, import staging/promotion/mapping, Insights refresh, candidate updates and candidate confirmation through the coordinated boundary. It SHALL preserve ownership, semantic interval coverage, scheduling eligibility, current revision review, import provenance and center confirmation rules. Configured external import URLs SHALL NOT be replaced by arbitrary client URLs.

#### Scenario: Import staging persists a run
- **WHEN** an administrator previews a WhenIsGood import
- **THEN** staging is treated as a coordinated revision-aware mutation and cannot bypass write gates because its name contains preview

#### Scenario: Center contact attempts confirmation
- **WHEN** a center contact without administrator authority requests candidate confirmation or confirmed status
- **THEN** the server rejects the request without changing candidate/session state

#### Scenario: Publication must preserve prior output on failure
- **WHEN** a new schedule cannot be committed completely
- **THEN** no partial assignment/backup/run output is presented as completed and recovery preserves the prior authoritative output or keeps the service explicitly pending

### Requirement: Client reconciliation preserves user intent
Clients SHALL retain the idempotency key for retries of the same mutation intent, present stale/conflict outcomes, and reconcile uncertain commits before offering a new mutation with a new key. They SHALL NOT automatically retry ambiguous writes as new operations or fall back to Apps Script.

#### Scenario: Network failure after submit
- **WHEN** a client loses the response to a mutation
- **THEN** retry uses the same key/fingerprint or an authenticated reconciliation path rather than generating a second independent mutation

### Requirement: Controlled writer handover and rollback
Writer handover SHALL require accepted read releases, all mutation-family and recovery evidence, notification readiness, exact per-action production approval, snapshot, live gate checks, drained writers and a new authority epoch. Rollback SHALL resolve pending work and preserve monotonic revisions and replay/outbox records before enabling exactly one compatible writer; otherwise it SHALL remain read-only pending a forward fix.

#### Scenario: Rollback candidate lacks replay compatibility
- **WHEN** the retained legacy release cannot honor current commit markers and replay records
- **THEN** it is not reopened for writes and rollback remains read-only until a compatible recovery or forward fix is available
