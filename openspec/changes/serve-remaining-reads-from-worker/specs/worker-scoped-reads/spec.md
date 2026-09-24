## ADDED Requirements

### Requirement: Explicit remaining-read allowlist
The Worker SHALL additionally serve volunteer.dashboard, center.candidate.read and admin.schedule.preview after primary-read acceptance, using the same verified-identity, fresh-Users and completed-snapshot boundaries. Import preview staging and Insights refresh SHALL remain excluded from read-only routing.

#### Scenario: Import preview sent to read boundary
- **WHEN** a caller submits admin.import.whenIsGood.preview to a read-only Worker deployment
- **THEN** it is rejected without fetching/staging an import or changing revisions

### Requirement: Ownership-preserving projections
Volunteer dashboards SHALL expose only the authenticated volunteer's permitted information. Center-contact reads SHALL be restricted to their current centerIds, and administrator/multi-role behavior SHALL preserve existing policies without trusting client role/ownership claims.

#### Scenario: Different volunteer requested
- **WHEN** a volunteer attempts to supply another volunteer's identity or arbitrary Sheet access fields
- **THEN** validation or authorization rejects the request without exposing that volunteer's data

#### Scenario: Center scope changes
- **WHEN** a center contact's authorized centers change between requests
- **THEN** the next response reflects the fresh Users scope and excludes centers no longer authorized

### Requirement: Side-effect-free reviewed scheduling preview
Worker scheduling preview SHALL preserve scheduling eligibility, ranking, interval/time-zone and tie-breaking behavior over one completed snapshot. It SHALL return the global revision used for review and SHALL NOT write assignments, backups, scheduling runs, audit or revision state.

#### Scenario: Preview followed by concurrent edit
- **WHEN** another operation changes scheduling state after a preview and the administrator submits its old revision for publication
- **THEN** the writer rejects publication as stale rather than publishing an unreviewed result

#### Scenario: Preview succeeds
- **WHEN** an administrator previews a synthetic roster including cancelled, graduated and unranked cases
- **THEN** the output matches the existing domain baseline and all persisted rows and counters are unchanged

### Requirement: Resource and staged-release evidence
Each operation SHALL have differential/negative tests, schema-derived read-count coverage and role-appropriate browser evidence. Preview SHALL fit the accepted free execution topology on predeclared representative and larger fixtures, with measured CPU and failure outcomes. Releases SHALL retain per-action approval and deliberate operation-scoped rollback.

#### Scenario: Preview exceeds resource budget
- **WHEN** the larger acceptance fixture exceeds the selected runtime's resource envelope
- **THEN** preview routing remains disabled until a tested free topology passes, without weakening domain behavior or silently upgrading billing
