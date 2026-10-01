# Plan delivery audit — 2026-10-01

The goal remains the complete `plan.md`: evidence-backed closure of tasks 4.1
and 4.2, local gates, sanitized committed evidence, and no push or production
action. This audit corrects the September 30 checklist; it does not close 4.1.
No live request, deployment or workbook mutation occurred in this local phase.

| Plan requirement | Current disposition and evidence |
| --- | --- |
| 1.1 fused Worker bracket | Existing implementation and September 30 live served counts: identity 1, Schedule/Insights 3 on both fixtures; shared bracket contracts preserve fail-closed behavior. |
| 1.2 staging hold | Existing instrument established abort and pending straddles live; instrumentation excluded from latency. No repeat is required to preserve that evidence. |
| 1.3 timing exposure | Header observed live; request-call order now survives reverse completion, and browser CORS exposes the host marker. New contract regressions cover timing order/count. |
| 1.4 legacy guard | Existing dispatcher enforcement tests prove zero persistence/counter advance on refusal; live record judgement establishes activated refusal, reverted admission and counter divergence. Reads retain legacy behavior. |
| 1.5 rollback | Production transition/writer used in the live rollback and forward recovery; counters preserved and epoch/generation advanced. |
| 2.1 deploy vars | Existing tested tool and retained deployment reports; host plan for the next representative phase prepared without deployment. |
| 2.2 harness | Mixed manifests now retain aggregate and per-operation summaries, valid per-read timings, marker exclusions and successful overlap ≥3 populations. Wall duration includes JSON completion. 95s marker age waits precede reservations. |
| 2.3 matrix driver | Actual counts are separately adjudicated against each path; conservative reservations and exit0 are not read-count acceptance. The corrected driver requires a canonical marker for confirmed runs, waits before reservations, retains body-inclusive timing/read headers and refuses marker/status mismatches. Its sole policy probe is the registered admin.schedule.rerun request, pinned to FORBIDDEN and explicit zero reads. Historical live coverage is 13 of the required 22 portable fixture/path pairs. |
| 2.4 runner | One-shot gateway requests now share campaign budgets, wait for the required expected marker, reread baseline after pacing and retain request/transition failures; marker/status mismatches cannot pass. Injection restore validates role/exact live state, journals production recovery, preserves counters and advances generation. Duplicate repair removes extra physical rows. |
| 2.5 browser | Portable reservations 2/4/4, required marker/wait, measured body-inclusive overlap and per-operation summaries are locally tested. Empty responses no longer imply successful transport. Credential capture atomically creates/replaces mode-0600 files. Live browser leg remains absent. |
| 3.0 approved window | Previous named phases are historical; four labels contained six per-target deployment invocations. Approval count cannot be inferred from the phase table. Manifest 3 budget policy and D1 are now approved for a fresh session; D2–D5 and B1/B2 remain pending. See [the authorization record](staging-rehearsal-authorization-3-2026-10-01.md). No new live phase ran. |
| 3.1/3.3 matrix | Representative 9/11, larger 4/11. Missing: representative unauthorized and missing; larger unauthenticated, unauthorized, pending, malformed, duplicate, unsupported and wrong authority. Two restored-legacy checks are separate. Non-admin account availability confirmed by user. |
| 3.1/3.3 latency | Six historical distributions exist; larger Schedule p99 2,882 ms breaches ≤1,500 ms. They timed headers, not body completion. Pool maxima do not prove each observation overlapped ≥3. Fresh qualified harness populations and both browser legs are required. |
| 3.2 straddle | Established live: abort → STALE_REVISION/control-generation_changed, pending → UNAVAILABLE/control-pending, no rows; final idle tuple advanced, counters unchanged. Retained marker matches the instrumented host. |
| 3.3 activation | Larger fixture capture/activation and serving established live. Domain digest comparison stayed equal to the archived baseline. |
| 3.4 recovery | Core rollback/forward/interrupted recovery and legacy admission established. Supplementary live restored-legacy Worker mutation refusal remains to be recorded. This does not require an Apps Script deployment. |
| 3.5 restore/parity | Historical domain parity established. Old injection restore had a generation-rewind risk in source; no observed live rewind is proved. The failed pending restore stopped before writes and production recovery advanced 19→20. New restore contracts verify safer behavior; next live batch needs fresh snapshots. |
| 4 evidence/task state | Corrected design/read composition and this audit are sanitized. 4.1 remains unchecked; 4.2 is reopened for the strict plan's missing live Worker policy-refusal request, retaining existing core evidence; 4.3/5.x and original 10.24/10.25 remain open. Apps Script live adapter transfer is now explicit in 4.1 and remains a production prerequisite. |
| 4 local gates | Main suite, Worker suite, static checks, build/audits and three Worker dry runs passed during integration. Final source gate receipts are recorded below after the last patch. |
| Scope constraints | No push, deployment, production mutation, paid service or private roster/export commit in this phase. Raw logs and orchestration artifacts stay private. |

## Evidence corrections and limits

Four isolated timing triplets cannot attribute the larger Schedule p99. For a
served domain read the positions are fused authorization/control, domain plan,
closing control. The fused request cannot separate Users cost from the first
control observation. New tools retain all three timings for each observation;
report their distributions without attributing wall tails from unrelated samples.

Historical overlap reconstructed from start time plus header-only duration is a
lower-bound estimate, not acceptance proof: representative identity/Schedule/
Insights 36/30/3; larger 28/16/17. Direct body-lifetime overlap was not retained.
New successful warm quantiles must use the actual ≥3 overlap subset and state its
sample count; pool size four alone is insufficient.

The campaign ledger remains 782. It increased 253 from 529 while the retained
matrix log contains 254 entries (237 harness plus 17 checks); that discrepancy is
unresolved. Three direct straddle fetches are proved unledgered. The prior claim
of seven is not established; reserve seven conservatively for planning, giving
an effective baseline 789 and 211 remaining. Do not rewrite the ledger without
reconciliation. Manifest 3 explicitly requests the plan's browser attempt-ledger
exemption; the previous manifest included browser attempts in its campaign cap.
All tools still share the read cap.

Ledger loads are serialized within a process and corrupt existing files fail
closed. There is no cross-process lock: run one reservation consumer at a time
and restart the probe server after CLI jobs. Browser per-attempt data persists
when the report completes; termination or a hung fetch can leave incomplete
evidence. Retain that outcome and leave the leg open.

REST malformed/duplicate repair journals before control, but clear then PUT is
not atomic. An interrupted repair can leave missing control state; stop and
review recovery from a fresh snapshot. Local tests do not establish live repair
atomicity, Apps Script maintenance execution, protection idempotence or preview
acceptance. Those deferrals remain recorded in the task list.

## Final local gate receipts

All commands below passed on the final frozen implementation (2026-10-01):

- `pnpm test`: 57 files / 569 tests.
- `pnpm run test:worker`: 9 files / 164 tests.
- `pnpm run check`: TypeScript, both Worker type checks and ESLint, exit 0.
- `pnpm run build`: client and Apps Script bundle audit, exit 0.
- `pnpm run build:worker`, `build:worker:host`, `build:worker:gateway`: dry runs,
  exit 0; gateway audit passed. No upload occurred.
- Strict OpenSpec validation and final diff checks are recorded with the local
  commit/handoff review; they do not waive any live gate.

The final confirmed harness requires the canonical host marker. Matrix checks
can explicitly omit credentials while reserving both budgets. Harness, matrix
and browser latch a target 429, settle issued calls and retain canceled granted
reservations without refunds. Browser timing integers and timestamp validation
match the shared helper. The REST adapter refuses journal exhaustion before
transitioning and reserves both events before repair begins.

Independent read-only review identified the missing evidence and final tool
seams; owners supplied bounded fixes and regression evidence. Root ran the full
integrated gates above. Raw validation logs remain private under `.jspace/`.
Continue from [the handoff](handoff-2026-10-01.md); the full plan is unfinished.
