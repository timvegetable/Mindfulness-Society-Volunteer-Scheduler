## ADDED Requirements

### Requirement: Identity-scoped route snapshots
The client SHALL keep previously loaded route data in memory only, keyed by authenticated email, role, and route, and SHALL render a cached valid snapshot immediately while current data is refreshed in the background. Cached route data SHALL never be persisted to local storage, session storage, URLs, logs, or a service worker, and cached data SHALL never authorize a mutation or a role decision.

#### Scenario: Cached route renders while refreshing
- **WHEN** an authenticated user returns to a route whose snapshot was already loaded for the same email and role
- **THEN** the client displays the cached valid data immediately, requests a fresh read in the background, and replaces the display when the fresh response arrives

#### Scenario: Identity change clears snapshots
- **WHEN** the authenticated email, role, or sign-in state changes
- **THEN** the client discards every cached snapshot and in-flight read for the previous identity and advances its load generation so no previous identity's data can render

### Requirement: Freshness checks without stale overwrite
The client SHALL deduplicate concurrent reads of the same route and identity, SHALL discard responses that belong to a superseded load generation, and SHALL keep already displayed valid data when a background refresh fails. After a successful mutation, the client SHALL invalidate the active route and force a fresh read. Only non-private loading, checking, or failure text SHALL be announced through a status region; a first load that fails SHALL use the existing error surface.

#### Scenario: Duplicate route load is served once
- **WHEN** two triggers request the same route for the same identity while a read is in flight
- **THEN** the client issues a single read and both triggers observe its result

#### Scenario: Late response is discarded
- **WHEN** a route response arrives after its load generation was superseded by an identity change or a newer refresh
- **THEN** the client does not render the late response

#### Scenario: Mutation invalidates the active route
- **WHEN** a mutation succeeds
- **THEN** the client invalidates the active route snapshot and performs a fresh read before confirming the route is current

### Requirement: Bounded verified-claim caching
The server integration SHALL cache only successfully verified identity claims, keyed by a cryptographic digest of the presented credential rather than the credential itself, for at most the smaller of 300 seconds and the credential's remaining lifetime. Cache hits SHALL revalidate expiration and audience, failures SHALL never be cached, and the current authorization record SHALL be read on every execution.

#### Scenario: Repeated request within the cache window
- **WHEN** the same valid credential is presented again within its cache window
- **THEN** the server reuses the verified claims without a second identity-provider lookup and still authorizes against the current Sheet state

#### Scenario: Expired or failed credential is never served from cache
- **WHEN** a cached credential has expired or a verification attempt failed
- **THEN** the server re-verifies the credential before trusting any claims

### Requirement: Single-pass workbook reads
Each operation SHALL read every required Sheet tab at most once, and decoded rows SHALL be memoized within that request only. Workbook rows SHALL never be retained between requests, in shared caches, or in browser state as authorization data.

#### Scenario: One read per required tab
- **WHEN** an operation lists, looks up, and updates rows across its required tabs
- **THEN** each required tab range is read exactly once for that request

### Requirement: Revision-keyed insight reuse
Availability insights SHALL be reused when the settings and the scheduling-input, schedule-output, assignment-rows, and recurring-availability revisions that produced them are unchanged. The reused dataset SHALL be stored for at most 300 seconds, writes larger than 90 kilobytes SHALL be skipped, corrupt or missing stored values SHALL be treated as a miss, and a dataset whose source revisions changed SHALL be returned only as stale until a regeneration or a forced refresh produces a consistent dataset.

#### Scenario: Unchanged read reuses the derived insight
- **WHEN** an administrator reads insights twice with no source revision change
- **THEN** the second read returns the same derived dataset without recomputation

#### Scenario: Changed source marks the dataset stale
- **WHEN** a source revision changed since the stored dataset was derived
- **THEN** the stored dataset is returned marked stale until a regeneration produces a consistent dataset for the new revisions

### Requirement: Warm read latency objective
Under warm service conditions, fresh read-only Schedule and Insights loads SHALL complete within 2000 milliseconds at the 95th percentile, measured from the client as fresh route-load measurements. Apps Script cold starts, upstream Google delays, and failed requests SHALL be reported separately rather than counted as successful latency samples.

#### Scenario: Warm route-load p95
- **WHEN** at least 40 successful fresh warm read measurements are collected for each of the Schedule and Insights routes
- **THEN** each nearest-rank 95th percentile is at most 2000 milliseconds
