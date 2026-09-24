## ADDED Requirements

### Requirement: Single portable revision authority
After activation, the system SHALL obtain global, scheduling-input and per-tab revisions from one versioned protected workbook control protocol. It SHALL retain schedule-output revision as a distinct domain value, reject malformed or unsupported metadata, and never fall back to zero or independent Script Property counters.

#### Scenario: Revision migration
- **WHEN** a reviewed maintenance procedure activates portable metadata from captured live counters
- **THEN** both implementations read equal nondecreasing counters from the new authority and legacy Properties cease to authorize revisions

#### Scenario: Control metadata is missing
- **WHEN** an activated backend cannot read valid supported control metadata
- **THEN** it returns a controlled failure without presenting data as current or admitting a mutation

### Requirement: Completed snapshot validation
Every participating mutation SHALL publish an in-progress marker and monotonic generation before changing domain rows, and publish completed state only after required persistence and revision bookkeeping. Readers SHALL accept hydrated data only when the same completed generation and revision tuple bracket hydration. Recovery and abort transitions SHALL also advance generation.

#### Scenario: Mutation interrupts a read
- **WHEN** a writer begins, finishes or recovers a mutation between a reader's control checks
- **THEN** the reader rejects the snapshot rather than returning a mixed dataset labelled current

#### Scenario: Writer crashes after a partial change
- **WHEN** the writer stops after changing rows but before recording completion
- **THEN** pending state survives and ordinary reads/writes fail closed until a reviewed recovery reconciles rows, audit and monotonic revisions

### Requirement: One fenced legacy writer during coexistence
Apps Script SHALL remain the sole production writer in this phase, using its script lock plus portable authority/epoch and the live WRITE_ENABLED gate. Every application and maintenance mutation path SHALL participate in the control protocol or run under an explicitly stopped-service reconciliation procedure.

#### Scenario: Import preview while writes are disabled
- **WHEN** a request attempts admin.import.whenIsGood.preview with WRITE_ENABLED false or through read-only dispatch
- **THEN** it is rejected before staging a run or changing rows, audit or revisions

#### Scenario: Import preview without current revision
- **WHEN** a new import staging request omits its required expectedRevision or supplies a stale revision
- **THEN** it is rejected without persistence and the client obtains current authenticated state before a new attempt

#### Scenario: Obsolete writer is offered as rollback
- **WHEN** a deployment only updates Script Property counters after portable activation
- **THEN** it is ineligible for writable rollback unless authority is reconciled under an approved stopped-writer procedure

### Requirement: Trustworthy schema and protection migration
Initialization SHALL resolve the effective schema version, be idempotent, and protect the declared data columns/control metadata rather than only headers. Snapshots and recovery manifests SHALL include metadata and preserve append-only audit history without exposing private data in version control.

#### Scenario: Repeated initialization
- **WHEN** initialization is run twice against a workbook already at the effective schema version
- **THEN** it does not append duplicate version records and verifies actual protected data ranges including the new control metadata

#### Scenario: Recovery from an earlier snapshot
- **WHEN** an approved recovery restores earlier domain contents
- **THEN** it preserves audit history and advances affected counters from their then-current values instead of resetting them to snapshot values

### Requirement: Configuration and release boundaries
The migration SHALL classify policy, identity/configuration, secrets, caches and operational gates separately; secrets SHALL NOT be stored in public config or the control tab. Production activation SHALL require the accepted feasibility verdict, tested recovery, explicit action approval, a workbook snapshot and live write-gate verification before and after the action.

#### Scenario: Local configuration disagrees with live state
- **WHEN** a deployment report claims writes are disabled but the live gate has not been inspected
- **THEN** the production activation does not proceed on that report as evidence
