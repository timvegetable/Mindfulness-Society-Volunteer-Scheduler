## MODIFIED Requirements

### Requirement: Warm read latency objective
Under warm service conditions, fresh read-only Schedule and Insights loads SHALL complete within 2000 milliseconds at the 95th percentile, measured from the client as fresh route-load measurements. Apps Script cold starts, upstream Google delays, and failed requests SHALL be reported separately rather than counted as successful latency samples. The objective SHALL remain unmet until both routes pass the defined measurement, and any replacement threshold SHALL require an explicit approved specification change supported by measured platform evidence.

#### Scenario: Warm route-load p95
- **WHEN** at least 40 successful fresh warm read measurements are collected for each of the Schedule and Insights routes
- **THEN** each nearest-rank 95th percentile is at most 2000 milliseconds

#### Scenario: One route misses the objective
- **WHEN** either Schedule or Insights has a nearest-rank 95th percentile above 2000 milliseconds
- **THEN** the objective remains unmet and the report identifies the failing route and eligible sample distribution

#### Scenario: Platform evidence supports renegotiation
- **WHEN** measured platform costs prevent the objective after approved optimization work
- **THEN** the requirement changes only through an explicit administrator-approved specification amendment rather than by treating the observed latency as success
