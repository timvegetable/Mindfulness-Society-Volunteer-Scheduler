## ADDED Requirements

### Requirement: Durable notification intent
Notifications for recurring-availability updates, dated exceptions and assignment cancellations SHALL create a durable outbox intent in the same workbook commit as their mutation outcome and audit. Notification dispatch SHALL use the selected Worker-compatible sender and SHALL NOT depend on Apps Script or a request-local status repository.

#### Scenario: Process stops after cancellation commit
- **WHEN** the coordinator stops after persisting cancellation but before sending its notification
- **THEN** the durable intent remains discoverable for delivery without reapplying the cancellation

### Requirement: Observable delivery and bounded retry
The system SHALL persist notification attempts and delivered, failed or unknown outcomes, expose administrator-only status and retry operations, and use stable provider deduplication keys when available. Unknown send outcomes SHALL be reconciled before automatic resending; the system SHALL NOT claim exactly-once external email delivery.

#### Scenario: Provider accepts but response is lost
- **WHEN** the provider may have accepted a message but the application cannot confirm the result
- **THEN** status records the uncertainty and does not blindly create another send attempt

#### Scenario: Administrator retries a known failure
- **WHEN** an authorized administrator requests retry of a failed notification with valid request/revision state
- **THEN** the system records and performs a bounded durable retry without changing the associated cancellation again

#### Scenario: Volunteer requests status or retry
- **WHEN** a non-administrator attempts administrator notification operations
- **THEN** the request is denied without revealing recipients or changing delivery state

### Requirement: Sender feasibility and observed acceptance
The selected sender SHALL have documented credential scope, sender identity, current free-tier limits and retry/deduplication behavior before cancellation cutover. Acceptance SHALL include a real application notification observed at its intended test recipient and durable failure/retry evidence; mocked provider success alone SHALL NOT close delivery acceptance.

#### Scenario: No acceptable sender is configured
- **WHEN** a no-cost, appropriately scoped Worker-compatible mail path has not been validated
- **THEN** production writer handover remains blocked rather than dropping email behavior or retaining an undisclosed Apps Script relay

### Requirement: Preserve every existing notification trigger
The migration SHALL retain notification behavior for recurring-availability updates and dated exceptions as well as cancellations, with the same durable status and retry guarantees.

#### Scenario: Availability notification survives restart
- **WHEN** an availability update or dated exception commits and the process stops before sending
- **THEN** its notification intent remains durably discoverable without repeating the underlying volunteer mutation
