## 1. Prerequisite and Contract Baseline

- [ ] 1.1 Verify accepted feasibility and portable-state activation/recovery evidence; pin the compatible legacy release and current shared envelope/error/projection contracts.
- [ ] 1.2 Pin differential fixtures/clocks for identity, published Schedule and Insights cold/hit/stale/expiry/refresh cases, preserving workbook-zone and source-revision semantics.

## 2. Production Read Boundary

- [ ] 2.1 Harden Worker route/method/CORS/body-limit/error handling and expiring token/key caches; test key rotation, wrong claims, malformed inputs and no secret/raw-upstream leakage.
- [ ] 2.2 Integrate fresh Users authorization, Viewer credentials, fixed workbook/range plans and completed-generation checks; test revocation and denial before domain hydration.
- [ ] 2.3 Wire session.me and published Schedule to shared projections and async workbook snapshots; prove field/revision and read-count parity.
- [ ] 2.4 Implement workbook-scoped disposable Insights cache with 300-second TTL, source tuple, stale reasons and older-generation overwrite protection; test concurrent cache misses and failures.
- [ ] 2.5 Add portable refresh generation and legacy refresh integration so Worker reads invalidate old derived data; test cross-backend refresh with stale and current source tuples.
- [ ] 2.6 Add bounded upstream retries/deadlines and sanitized request IDs, timings, byte sizes and call counts; test non-JSON/platform failure classification separately from application exceptions.

## 3. Client and Release Configuration

- [ ] 3.1 Add explicit per-operation backend routing for exactly the three primary operations, Worker redirect rejection and backend-aware errors; test no automatic fallback and retained legacy mutation routes.
- [ ] 3.2 Update public/private configuration schemas, safe renderer and fail-closed deployment checks together; test HTTPS, origins, invalid maps and legacy rollback configuration.
- [ ] 3.3 Separate complete validation from authorized Pages/Worker releases, addressing the current every-push Pages trigger before any approved push; record environment and secret setup procedures.

## 4. Staging Acceptance

- [ ] 4.1 Run differential parity, fresh-role revocation, concurrent legacy mutations, interrupted writes and cross-backend refresh against synthetic staging.
- [ ] 4.2 Run browser bootstrap/Schedule/Insights CORS/direct-response tests and representative/larger CPU/quota probes on the selected free topology.
- [ ] 4.3 Run focused tests, npm test, npm run check, all builds and openspec validate serve-primary-reads-from-worker --strict; record results and review exact release/rollback artifacts.

## 5. Production Release and Evidence

- [ ] 5.1 After specific approval, export the required snapshot, verify live gates, deploy Worker without client routing and verify authenticated direct responses; recheck gates after the action.
- [ ] 5.2 Separately approve and release Pages routing for session.me/Schedule/Insights; retain the portable-compatible legacy rollback and verify actual identity bootstrap.
- [ ] 5.3 Capture the predeclared two-warmup/40-attempt windows per data route with all outcomes, nearest-rank p95 and request metadata; record reliability and 2000 ms latency verdicts separately.
- [ ] 5.4 Rehearse deliberate read routing rollback and restore only under the respective deployment approvals; confirm there is no automatic fallback.
- [ ] 5.5 Update architecture/development/security/testing/deployment/operations for the implemented route and cache behavior; link production evidence to latency tasks 4.3/4.4 without silently changing their requirements.
