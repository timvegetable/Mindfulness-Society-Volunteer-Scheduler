# Synthetic staging live checks 2 — 2026-09-30 (tasks 4.1/4.2)

Executed under [manifest 2](staging-rehearsal-manifest-2-2026-09-30.md), approved
2026-09-30, against the two synthetic staging workbooks and the staging Worker
topology only. Raw reports, attempt logs and ledgers stay in ignored private
`staging-local/`; this document carries the measured values and the digests.

Result: served read counts, the generation straddle and the core 4.2 drills are
established live. The rejection matrix is partial, a latency gate is breached,
and browser evidence is absent. Task 4.1 remains open.

The [2026-10-01 audit](delivery-checklist-2026-10-01.md) corrects matrix coverage,
timing semantics, deployment counts and attempt accounting below.

## Deployments

Each was a `deploy-staging.mjs` run with explicit `--var` values; `wrangler.jsonc`
was never edited (`git diff --quiet wrangler.jsonc` after the window: unchanged).
The retained harness/straddle reports carry the expected host marker. Historical
marker filtering does not establish that every tool enforced the 95 s wait
before reservations; the corrected tools enforce that ordering. The four phases
below contain six individual host/gateway invocations, despite the manifest's
original five-deployment label.

| # | Target | Marker (`X-Staging-Host-Deployed-At`) | Variables |
| --- | --- | --- | --- |
| D-a | host | `2026-09-30T02:34:30.092Z` | `STAGING_CONTROL_AUTHORITY=workbook-control` |
| D-b | host | `2026-09-30T02:57:59.153Z` | the same plus `STAGING_BRACKET_HOLD_MS=8000` |
| D-c | host + gateway | `2026-09-30T03:05:28.253Z` | larger workbook id, the control binding, `STAGING_DATA_REVISION=42`, `STAGING_SCHEDULING_INPUT_REVISION=5`, tab revisions |
| D-d | host + gateway | `2026-09-30T03:14:13.574Z` | none: the committed configuration |

## The read plan, measured

Counts are the Worker's own `X-Staging-Sheets-Reads`, one attempt per check,
paced through the shared rolling ledger. `planned` is what the check declared.

| Path | Fixture | Reads | Planned | Refusal |
| --- | --- | --- | --- | --- |
| identity (`session.me`) | representative | 1 | 1 | served |
| served Schedule | representative | 3 | 3 | served |
| served Insights | representative | 3 | 3 | served |
| identity | larger | 1 | 1 | served |
| served Schedule | larger | 3 | 3 | served |
| served Insights | larger | 3 | 3 | served |
| unauthenticated (no credential) | representative | 0 | — | `UNAUTHORIZED` |
| pending marker injected | representative | 1 | 1 | `UNAVAILABLE`/`control-pending` |
| malformed record injected | representative | 1 | 1 | `UNAVAILABLE`/`control-malformed` |
| duplicate record injected | representative | 1 | 1 | `UNAVAILABLE`/`control-duplicate` |
| unsupported protocol injected | representative | 1 | 1 | `UNAVAILABLE`/`control-unsupported` |
| authority mismatch injected | representative | 1 | 1 | `UNAVAILABLE`/`control-authority_mismatch` |
| record missing (before capture) | larger | 1 | 1 | `UNAVAILABLE`/`control-missing` |
| restored legacy deployment, identity | representative | 1 | 1 | served |
| restored legacy deployment, domain | representative | 2 | 2 | served |

This is the task 1.7 plan as implemented: a served domain read is the fused
authorization+control batch, the plan, and the closing control read; every
rejection decided from the first observation costs one. The pre-window path cost
four reads for a served domain read and two for a pending rejection; the fused
first observation removed one control read from each. The restored deployment
serves at the archived campaign's one and two reads, which is the rollback
posture the design promises.

Injected states were written by the runner, snapshotted first and restored after
each check; all five restores returned the record to `workbook-control`, idle.

## Latency, per read operation per fixture

Historical burst phase, wall clock in milliseconds through response headers
(the old harness stopped timing before JSON parsing). The in-flight column is
the observed maximum, not proof that every observation qualified at overlap ≥3. The representative fixture ran 36
observations per operation at concurrency 4 plus 12 at concurrency 1; the larger
fixture ran 30 plus 1, because the window's remaining attempt budget was spent
there. Every attempt succeeded; no 429 was observed at any point.

| Operation | Fixture | n | p50 | p95 | p99 | max | in flight | reads/request |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| identity | representative | 36 | 300 | 482 | **520** | 520 | 4 | 1 |
| Schedule | representative | 36 | 613 | 999 | **1,040** | 1,040 | 4 | 3 |
| Insights | representative | 36 | 613 | 766 | **919** | 919 | 3 | 3 |
| identity | larger | 30 | 214 | 300 | **350** | 350 | 4 | 1 |
| Schedule | larger | 30 | 760 | 2,697 | **2,882** | 2,882 | 4 | 3 |
| Insights | larger | 30 | 648 | 1,121 | **1,137** | 1,137 | 4 | 3 |

The predeclared gate (design.md:108) is warm p99 ≤ 1,500 ms per read operation
per fixture. Five of the six populations meet it. **The larger fixture's Schedule
read does not: p99 2,882 ms, p95 2,697 ms.** It is recorded as a missed gate, not
as a pass, and task 4.1 stays open on it.

Attribution, bounded to what was measured: the larger fixture's Schedule read
costs three Sheets requests where the archived campaign's cost two, and its plan
covers 2,158 rows against the representative fixture's 305. The archived
campaign measured this same operation on this same fixture at p99 884 ms under
the two-request plan, so the change in plan cost and payload are the plausible
causes. Nothing in this window separates them, and no CPU or duration claim is
made from wall time.

## The control reads' contribution

`X-Staging-Read-Ms` reports each Sheets request's duration in call order. For a
served domain read the positions are the fused authorization+control batch, the
plan, and the closing control read.

| Observation | Read timings (ms) |
| --- | --- |
| straddle, abort variant | 179, 193, 202 |
| straddle, pending variant | 216, 174, 185 |
| post-activation served read | 196, 338, 176 |
| straddle attempt 1 (retained) | 298, 252, 192 |

Correction from the 2026-10-01 source/evidence audit: these four isolated
responses are not the larger fixture's Schedule burst population. The header
positions mix the fused authorization/control request, domain plan and closing
control request; the 338 ms sample is a plan request. The retained harness
attempt logs omit this header, so neither the control contribution to that
population nor the cause of its p99 breach is established. The header is absent
when a request makes no Sheets read at all, which is asserted in the Worker suite.

## The generation straddle

D-b held the bracket open for 8,000 ms so the interleaving is unconditional: the
read is started, the transition fires 1,500 ms later, and the response is awaited
in the same process.

| Variant | Transition | Refusal | Reads | Generation | Counters | Idle after | Passed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| abort | `begin`+`abort` | `STALE_REVISION`/`control-generation_changed` | 3 | advanced | unchanged | yes | yes |
| pending | `begin` only | `UNAVAILABLE`/`control-pending` | 3 | advanced | unchanged | no (left interrupted on purpose) | yes |

No rows were served in either case. The abort variant is the check three earlier
attempts could not establish: it advances the generation and the completed
generation while leaving every counter identical, so it is rejected by the tuple
comparison and not by a counter comparison.

One attempt is retained rather than discarded. The first abort run at 03:00:28
observed exactly the right refusal with the same generation and counter outcome,
but the runner's own expectation parser compared the reason against the code slot
and printed `passed: false`. That was a defect in the runner, not in the reader;
it was fixed, and the re-run at 03:01:24 passed. Both reports are kept.

## Task 4.2 drills

**Rollback and forward recovery.** Rollback through `rollbackTransition` set the
record to `script-properties` at epoch 8, generation 27, with the counters held
at `max(captured 42, current 46)`. The deployed reader then refused a domain read
with `UNAVAILABLE`/`control-authority_mismatch` at one read rather than serving
stale counters. Activation forward with the deliberately stale deployment
counters (42/5) returned the record to `workbook-control` at epoch 9, generation
28, counters still 46/6, and the same deployed reader served again reporting
`inputRevision: 6` — the record's value, not the deployment's 5.

**Legacy admission and the live divergence.** Against the activated record the
production judgement refuses with `AUTHORITY_MISMATCH` and names the fork risk.
Against the reverted record it admits, and the divergence it reports is the
concrete thing the rollback procedure's equality check must detect: the record's
`dataRevision` 46 against the deployment's 42, `schedulingInputRevision` 6
against 5, and `Volunteers` 2 against 1. A Property-only writer that reopened
after activation would therefore be writing against counters the record has
already passed — which is why the guard refuses instead.

**Interrupted-mutation recovery.** The pending straddle left the marker in place
on purpose. A live read then refused `UNAVAILABLE`/`control-pending` at one read,
the production recovery with decision `not-started` advanced the generation 25 →
26 with every counter untouched and the record idle, and a repeated recovery was
refused with "No interrupted mutation is pending".

## Parity, monotonicity, quota

- **Domain rows**: zero changed tabs against the pre-window baselines on both
  fixtures, compared per tab by digest.
- **Structural deltas** are the intended ones only: both workbooks now carry the
  control tabs, the version-4 Settings record, and an activated control record
  (representative at `dataRevision` 46, larger at 42); the representative's
  journal gained the window's entries.
- **Monotonicity**: no counter decreased anywhere in the window, and the
  generation advanced on every transition, including the aborts, the recovery,
  the rollback and both activations.
- **Quota**: zero 429s across every attempt. Reads stayed inside the shared
  rolling ledger; the ledger had to be repaired once (see the findings).
- **Attempt budget**: 529 spent before the window; 782 recorded after it, against
  the predeclared ≤ 1,000 cap and the ≤ 400 further attempts this window
  requested. The recorded total under-counts the true issued total by the reads
  the straddle made outside any ledger (below).

## Defects found and fixed during the window

1. **The read-matrix driver crashed after spending its attempts.** Its report
   construction referenced an undefined `spentBeforeRun`, so the confirmed CLI
   path died after issuing the reads. The delegated contract tests never reached
   that path. Fixed by extracting the report into an exported pure function with
   both ledger readings asserted.
2. **A scripted restore silently did nothing.** `privateCredentialPath` refused
   the absolute snapshot path the runner prints, so `--from` was rejected and the
   pending injection was never restored; the workbook was left with a pending
   marker. Fixed by resolving the path and checking containment, naming the flag
   in the message. The marker was cleared with the production recovery transition
   (generation 19 → 20, every counter untouched) — a retained failure, not a
   pass, and the reason the recovery drill ran twice.
3. **The harness split the campaign ledger.** It derived the ledger paths from
   the *report's* directory, so reports written into `staging-local/matrix/`
   started a second rolling read window and a second attempt count. Measured: the
   split ledger recorded 138 of the 144 attempts the three latency runs actually
   issued. Fixed to use the repository's campaign ledgers, with a `flush()` so a
   finished run is fully recorded. The 144 issued attempts were reconciled into
   the campaign ledger explicitly, and the split file is retained with a
   `.reconciled` marker.
4. **The straddle mis-reported a correct refusal as a failure.** Its expectation
   is written `CODE[:reason]`, but the parser read the reason from the code slot.
   Fixed; the pre-fix attempt is retained.
5. **Historical attempt accounting is incomplete.** The October 1 audit proves
   three direct unledgered straddle requests; `transition` has no Worker fetch.
   The earlier seven-request claim is not established. The 254 matrix-log entries
   versus the 253 campaign-ledger increment remain unreconciled. Seven is retained
   only as a conservative planning charge; the ledger itself is unchanged. New
   straddle requests now reserve both campaign budgets.

## Not covered by this window

- **The browser-probe leg.** The page, its `?attempts=` contract and its per-read
  timing capture are implemented and contract-tested, but the paced 30-attempt
  run through a real signed-in browser did not happen in this window: the
  operator's ID token had expired by the time the larger fixture's legs finished.
  The harness populations above are the whole latency evidence here.
- **The Apps Script adapter's live leg**, transferred to tasks 5.2/5.3 as the
  change's recorded deferral.
- **The unauthorized-role path live.** All three served operations require
  `administrator` and the captured credential is an administrator, so a live
  role refusal needs a second account's token. It is covered by the Worker
  contract suite, not live.
- **The preview path** and **protection idempotence**, which remain the recorded
  REST-path measurement rather than a production claim.
- **The larger fixture's legacy posture.** Before capture the portable reader
  refused with `control-missing` as expected, but the legacy-serving half of that
  posture was demonstrated on the representative fixture in the 2026-09-29 window
  (D2) and at D-d here, not on the larger fixture itself.
- **The larger fixture's sustained leg**: one observation, against the
  representative fixture's twelve. The burst populations carry the gate.

## Disposition

- **Task 4.1 stays open.** The read plan, both rejection halves, the straddle and
  the quota outcome are established, but the larger fixture's Schedule read
  breaches the predeclared warm p99 gate at 2,882 ms, and the browser leg did not
  run.
- **Task 4.2's rehearsals are complete**: the pre-activation posture, the
  rollback and forward recovery through the production transitions, the
  interrupted-mutation recovery, and the demonstration that a Property-only
  writer is refused rather than reopened.
