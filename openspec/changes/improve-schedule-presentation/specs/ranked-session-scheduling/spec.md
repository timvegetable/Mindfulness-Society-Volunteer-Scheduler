## ADDED Requirements

### Requirement: Distinct session and staffing labels
Every administrator schedule and preview row SHALL present session classification separately from staffing outcome. Stored lifecycle enums SHALL be translated into reader-facing session labels, while staffing SHALL be derived from required staffing, assignments, and shortfalls rather than from the session lifecycle value.

#### Scenario: Locked center session is fully staffed
- **WHEN** a locked center session has its required number of assignments
- **THEN** the row identifies it as a fixed center session and separately reports that it is fully staffed

#### Scenario: Confirmed class is understaffed
- **WHEN** a confirmed class has fewer assignments than its required staffing count
- **THEN** the row identifies it as a confirmed class and separately reports the exact staffing shortfall

#### Scenario: Raw lifecycle value is present
- **WHEN** a session stores a lifecycle value such as `locked` or `confirmed`
- **THEN** the interface does not present that raw value as though it were a staffing result
