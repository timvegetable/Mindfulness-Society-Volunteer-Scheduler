# Synthetic staging manifest 3 — 2026-10-01

Status: prepared, not authorized or executed. This window supplies the missing
live evidence identified in the [delivery audit](delivery-checklist-2026-10-01.md).
It preserves all acceptance gates. Task 4.1 stays open if any gate or sample
requirement remains unmet. No push, production, Apps Script deployment, paid
service, Script Property change or benchmark-preview enablement is requested.

## Preflight and operator

Exactly one designated operator subagent performs live deployments and workbook
mutations after the relevant approval; every other agent stays read-only. Before
starting, recheck the actual staging topology, control tuples, headers, domain
digests and both ledgers against private retained reports. Old reports do not
prove current external state. Target only the existing private synthetic roles
`representative` and `larger`; never infer a target from a production config.
Export fresh workbook snapshots before each deployment and each mutation batch.
Verify at least 20 unused slots below the 200-entry control-journal limit on
each role before injections; stop if insufficient. The REST adapter refuses
insufficient capacity and does not implement production journal pruning.

The user confirmed a non-admin staging account exists. Obtain fresh administrator
and non-admin Google ID tokens through the loopback sign-in page, writing only
mode-0600 files in ignored `staging-local/`. Keep credentials, workbook IDs,
exports, journal rows and raw reports private. Browser legs require a signed-in
page at `http://localhost:8788/`. Re-capture expired tokens; retain UNAUTHORIZED
attempts and exclude them without retrying them away.

## Five per-target deployments, individually approved

| Step | Target | Exact intended bindings |
| --- | --- | --- |
| D1 | staging host, representative | Committed fixture/counters plus STAGING_CONTROL_AUTHORITY=workbook-control and STAGING_BRACKET_HOLD_MS=0. Generated STAGING_DEPLOYED_AT is recorded by the deploy tool. |
| D2 | staging host, larger | Same portable authority/hold bindings; private larger workbook ID and its verified counter bindings. No counter is reduced; portable responses use the control record. |
| D3 | staging gateway, larger | Private larger workbook ID; existing staging-host binding and committed allowed origin. |
| D4 | staging host, restore | Committed representative configuration, without portable/hold overrides. |
| D5 | staging gateway, restore | Committed representative configuration. |

D1 is reviewable through the prepared private deploy plan: `deploy-staging.mjs
--target host --var STAGING_CONTROL_AUTHORITY:workbook-control --var
STAGING_BRACKET_HOLD_MS:0 --report <private-report> --plan`. The real command
adds `--confirm` only after D1 approval. It deploys the host and reprovisions its
two existing Google secrets; their values are not printed or committed.

D2–D5 each get their own fresh plan, snapshot and approval immediately before
execution. D1 approval grants no later deployment or mutation. Wait at least
95 seconds after the host marker before reservations and verify the expected
X-Staging-Host-Deployed-At on every observation. Wrong/missing markers are
retained version-lag outcomes and excluded from warm results. No automatic
redeploy or retry is allowed. Straddle evidence already exists; no hold-enabled
redeployment or straddle repeat is included.

## Measurement and mutation sequence

1. After D1, reverify representative served counts/tuple and collect the three
   harness distributions through the gateway. Each has 30 burst attempts at
   concurrency four and one sustained reference. Retain complete body duration,
   actual per-request overlap, read counts, marker and validated read timings.
2. Complete representative unauthorized role refusal with the non-admin token.
   Separately request B1 approval: snapshot, inject missing control record, issue
   one pinned rejection check, restore via the reviewed generation-safe runner,
   verify idle authority/counters, and export/compare after the batch.
3. Stop CLI consumers, restart the probe server, and run 36 browser attempts per
   operation with readPlan=portable and the expected host marker. Persist the
   report; an incomplete run does not satisfy the browser leg.
4. Approve D2 and D3 separately; repeat served verification, harness and browser
   measurements on larger. Complete its unauthenticated check using `credentialMode: none` (still
   ledger/marker gated). Non-admin checks use a separate invocation with the
   captured non-admin credential path; administrator checks keep configured
   credentials. Complete the non-admin role refusal before proceeding.
5. Request B2 approval separately: snapshot larger, then pending, malformed,
   duplicate, unsupported protocol and wrong-authority injections. Each has one
   pinned check and an immediate reviewed restore/tuple verification. Batch
   writes, keep the service read-only, snapshot and compare afterwards. No
   capture, rollback or domain mutation is required: both roles already carry
   activated records, subject to preflight verification.
6. Approve D4 and D5 separately. Verify restored legacy identity/domain counts
   and issue one `admin.schedule.rerun` request to prove the deployed Worker's
   read-only policy refuses it with zero persistence. Pin HTTP 200 / `FORBIDDEN` from the staging allowlist before execution;
   require an explicit zero-read header and use no writable handler. Baseline/verify
   both workbooks, domain digests and monotonic control counters/generations.

The domain digest baselines remain the archived representative/larger values.
Intended structural deltas remain control tabs, version-4 Settings metadata and
activated records. Only control generations/journals advance for injections and
recovery; domain counters and rows must remain equal. Old injection snapshots
are not valid automatic restore inputs. REST clear-then-PUT repair can leave a
missing record if interrupted: stop, retain the failure and request reviewed
recovery rather than replaying or adding an unapproved mutation.

## Read-count adjudication

Conservative `reads` reservations are distinct from measured response counts. A
matrix exit code of zero checks envelope/status/version (and zero reads for the
policy probe); root must separately adjudicate every actual count:

| Path | Required measured Sheets requests |
| --- | ---: |
| Portable served identity, each fixture | 1 |
| Portable served Schedule/Insights, each fixture | 3 |
| Missing credential, each fixture | 0 |
| Authenticated active non-admin, each fixture | 1 |
| Injected control-state refusal | 1 |
| Restored legacy identity/domain | 1 / 2 |
| Registered rerun mutation refused before dispatch | 0 |

A missing header or mismatch is a retained finding even when the envelope
matches. Also compare response counters/tuples to the freshly read control record
and verify the pinned domain digests. No task closes from CLI exit status alone.

## Explicit budget request

Current recorded campaign spend is 782. Charge a conservative seven unresolved
historical requests for planning: effective baseline 789, leaving 211 under the
1,000 cap. Do not edit the ledger to conceal the discrepancy.

| New counted category | Maximum |
| --- | ---: |
| Six harness bursts ×30 | 180 |
| Six sustained references ×1 | 6 |
| Nine missing matrix paths | 9 |
| Six dedicated served-count/tuple checks | 6 |
| Two restored legacy reads | 2 |
| One restored Worker mutation refusal | 1 |
| Marker/preflight allowance | 3 |
| Total | **207** |

This gives a conservative final 996 with four spare, and is below the plan's
≤400 further-attempt request. All failures and lagged outcomes spend attempts;
there is no oversampling after exhaustion. The 30-attempt bursts are reduced
from the plan's proposed 36 to fit remaining headroom: acceptance still requires
at least 30 successful warm observations with actual overlap ≥3 per operation
per fixture. If pacing, failures or trailing requests leave fewer, that leg and
4.1 remain open; this budget makes no promise of sufficient population.

Separately request the plan's browser policy: **216 browser target attempts**
(36 ×3 operations ×2 fixtures), excluded from the attempt ledger but included
in total issued-request reconciliation and the shared read ledger. This differs
from manifest 2, which included browser attempts in its campaign cap. Approval
must explicitly cover that change. Without it, no browser phase runs.

Every tool shares ≤40 reserved Sheets reads per rolling 60 seconds, reserving
portable identity 2 and domain 4 even when measured actual costs are 1 and 3.
Baseline/control REST reads use the same service-account quota but are outside
the gateway ledger: do not overlap them with load phases; use a fresh quiet
60-second interval before and after each REST/export command, with at most 40
read requests in any command (inspect its plan/source bound first), and stop on
quota pressure. Run the gateway check in its own quiet interval between injection
and restore; no export/REST command overlaps its ledger window. Only one reservation consumer runs at a time. Stop the probe server
before CLI runs and restart it afterwards so it reloads persisted budgets.
Existing malformed ledgers fail closed; never reset them to gain headroom.

## Stop conditions and closure

Stop on a 429, unknown target/state drift, unexpected rows/counters, mismatched
snapshot, missing approved action, exhausted budget, unreconciled issued-count
growth, or a failed restore. Retain every failed/lagged attempt. A latency breach
is recorded with its value and leaves 4.1 open; it does not authorize extra runs.
Report p50/p95/p99/max separately for each qualified operation/fixture, including
sample count, overlap and timing-phase distributions. Fused Users/control timing
cannot isolate authorization cost from the first control observation.

Closing evidence must reconcile all issued requests, the campaign/read ledgers,
zero 429s, both domain digests and every control transition. Apps Script live
adapter/protection checks remain tasks 5.2/5.3; preview and original 10.24/10.25
remain open. Task closure is root's evidence adjudication after review, not an
operator action.

The first approval request covers the stated budget policy and **D1 only**.
B1/B2 and D2–D5 remain separate pending approvals. Cleanup deployments are not
implicitly authorized by approving an earlier phase.
