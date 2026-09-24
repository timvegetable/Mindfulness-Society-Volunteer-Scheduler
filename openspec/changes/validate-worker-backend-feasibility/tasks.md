## 1. Baseline and Experiment Contract

- [ ] 1.1 Record the current master/prototype commits, reusable fixtures/probes, and an actual-effect inventory of all 16 operations (role, ranges, persistence, locks, revisions, external I/O); identify import preview staging explicitly.
- [ ] 1.2 Pin synthetic fixture dimensions and semantic expected outputs for representative and larger workloads, including preview computation, multi-role/denied users, stale Insights and temporal/blank-cell edge cases.
- [ ] 1.3 Record staging resource/identity prerequisites and dated Cloudflare/Google quota, CPU and billing constraints; define resource headroom and paced-load acceptance thresholds before measurement.

## 2. Local Worker Vertical Slice

- [ ] 2.1 Add pinned Worker/Wrangler configuration, runtime types and Worker-native test execution without changing production routing; justify any new dependency.
- [ ] 2.2 Extract reusable request validation, role/error policy and projection seams while retaining synchronous Apps Script entrypoints; run the existing dispatcher contracts.
- [ ] 2.3 Implement bounded direct JSON POST/CORS/error handling for the three feasibility operations and test paths, methods, origin rejection, malformed/oversized bodies and mutation denial.
- [ ] 2.4 Implement Google ID-token verification and service-account access-token acquisition with separate expiring caches; test signature/claim failures, cache expiry and key rotation without logging secrets.
- [ ] 2.5 Implement async schema-allowlisted Sheets reads and fresh Users decoding through the workbook boundary; test serial/date/time-zone/blank normalization against existing codecs.
- [ ] 2.6 Compose the three operations over the immutable staging fixture state; run semantic differential and negative authorization tests, including unchanged workbook verification.

## 3. Staging Measurement

- [ ] 3.1 Prepare a reviewable staging setup/deployment manifest, secret-handling instructions and rollback; inspect Pages push triggers and separate validation from deployment before any approved push.
- [ ] 3.2 After specific resource/deployment authorization, provision the synthetic workbook/read-only service identity and deploy staging; verify no production resource is referenced.
- [ ] 3.3 Run authenticated real-browser direct-response/CORS probes with all attempts retained; record sanitized outcomes and distinguish them from prototype loopback timings.
- [ ] 3.4 Measure actual cold/warm Worker CPU, wall time, derivation/serialization, Sheet-call counts, larger-fixture preview and paced concurrency; record failures and resource headroom.
- [ ] 3.5 If required by measurements, profile/optimize or evaluate a free Durable Object computation path and rerun the same acceptance workloads; record no-go if constraints remain unmet.

## 4. Decision and Handoff

- [ ] 4.1 Run focused tests, npm test, npm run check, npm run build plus the Worker build, and openspec validate validate-worker-backend-feasibility --strict; record results without marking production latency satisfied.
- [ ] 4.2 Record a dated go/conditional-go/no-go verdict with topology, fixture sizes, measured evidence, unresolved conditions and links to the six-change roadmap; resolve conditions before unlocking production-dependent work.
- [ ] 4.3 Update development/testing/security documentation for the implemented staging workflow and cross-link relevant evidence to meet-read-latency-objective without completing its production acceptance tasks.
