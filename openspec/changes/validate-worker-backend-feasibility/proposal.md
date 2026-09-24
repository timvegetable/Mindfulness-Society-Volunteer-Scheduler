## Why

Apps Script can finish a handler successfully while its ContentService redirect handoff fails in the browser. The local Node prototype demonstrates direct JSON transport but does not establish that real Google authentication, Sheets access, and this application's calculations fit Cloudflare's free runtime.

## What Changes

- Build a bounded staging vertical slice for `session.me`, `admin.schedule.read`, and `admin.insights.read` using a synthetic workbook and real Google identity verification.
- Reuse existing schemas, workbook codecs, read plans, derivations, and selected prototype fixtures/probes; measure representative and larger workloads, including scheduling-preview computation.
- Produce a dated feasibility verdict covering correctness, CPU, latency, quotas, credentials, and zero-cost operation before production migration.
- Establish the six-change dependency roadmap in this change's design. Proposal readiness does not authorize deployment, production writes, a paid plan, or subsequent cutover.

## Capabilities

### New Capabilities

- `worker-backend-feasibility`: Staging experiment and evidence gates for choosing the Worker architecture.

### Modified Capabilities

None. Existing scheduling, authorization, and 2000 ms latency requirements remain in force. The repository currently holds its behavioral specifications in active changes rather than `openspec/specs/`.

## Impact

Worker scaffolding, staging configuration, Google OAuth/identity adapters, workbook REST reads, runtime tests, and sanitized probes in the existing repository. No production endpoint or persistence authority changes. Follow-on: `make-workbook-state-portable`.
