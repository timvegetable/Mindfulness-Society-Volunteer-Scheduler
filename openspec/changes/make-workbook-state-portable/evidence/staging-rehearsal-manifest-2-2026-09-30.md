# Synthetic staging rehearsal manifest 2 — 2026-09-30 (tasks 4.1/4.2 approval request)

Scope: the two synthetic staging workbooks and the existing staging Worker
topology only. No production resource, workbook, deployment, Script Property,
push or paid service is touched. Workbook ids, credential paths, report paths and
digests stay in ignored private `staging-local/`; this document names roles,
operations and the exact deployment variables.

This supersedes the 2026-09-29 manifest, which requested two deployments and a
different mutation set. It exists because the first window closed the read-plan
and rejection halves of 4.1 and found three defects, and because the straddle
check it could not establish needs an instrumented deployment that did not exist
then.

## Targets

| Target | Role | State |
| --- | --- | --- |
| Synthetic workbook "representative" (305 data rows, zone `America/New_York`) | read plan, rejection matrix, latency, straddle, 4.2 drills | carries an activated control record from the 2026-09-29 window |
| Synthetic workbook "larger" (2,158 data rows, same zone) | the same measurement on a second fixture, and the pre-activation rollback posture | carries the control tabs and **no record** |
| Staging Worker `volunteer-scheduling-staging-host` | serves reads from the workbooks through the control record | deployed with the committed configuration (no control binding) |
| Staging gateway Worker | thin forwarder in front of the host | deployed with the committed configuration |

Both workbooks were initialized and their domain tabs verified byte-identical to
the pinned baselines (`aedfec2b…` representative, `fc05ff65…` larger) at the end
of the 2026-09-29 window. This window must end the same way.

## Deployments (five; each is approved individually before it runs)

Every deployment is a `deploy-staging.mjs` invocation with an explicit `--var`
list, so no `wrangler.jsonc` edit is involved and each deployment's variables are
printed in `--plan` and recorded in its report. Each waits the documented 95 s
Durable Object version lag and is confirmed by `X-Staging-Host-Deployed-At`
before any attempt is counted.

| # | Target | Variables | Purpose |
| --- | --- | --- | --- |
| D-a | host | `STAGING_CONTROL_AUTHORITY=workbook-control` | serve the representative fixture through the record, with the new three-request bracket and the per-read timing header |
| D-b | host | `STAGING_CONTROL_AUTHORITY=workbook-control`, `STAGING_BRACKET_HOLD_MS=8000` | hold the bracket open so the generation straddle is deterministic |
| D-c | host **and** gateway | workbook id switched to the larger fixture, `STAGING_CONTROL_AUTHORITY=workbook-control`, `STAGING_DATA_REVISION=42`, `STAGING_SCHEDULING_INPUT_REVISION=5`, `STAGING_TAB_REVISIONS=<the committed all-ones object>` | serve the larger fixture, which has never carried a record; this is also the rollback-before-activation posture on a workbook that predates the record |
| D-d | host **and** gateway | none — the committed configuration | restore the topology and verify a legacy read at its pre-rehearsal read count |

The larger fixture carries no record and no recorded counter, so D-c pins the
fixture generator's constants (`DATA_REVISION=42`, `SCHEDULING_INPUT_REVISION=5`,
every tab at 1) — the same values the committed staging environment already
carries. The capture step then records exactly those values, and the fixture
identity digest covers domain tabs only, so the pinned baselines are unaffected.
D-c's counters are also the "stale captured" input for the forward-recovery drill
in 4.2.

No benchmark-route deployment is requested: preview is not part of the control
read plan, and its parity is pinned by the differential suite.

## Workbook mutations (each batch snapshotted before and compared after)

Applied through the staging loader service account against the synthetic
workbooks, by the rehearsal runner, which now performs capture and rollback
through the production `ControlMutationWriter` and its transitions rather than
hand-built rows.

| # | Mutation | Expected effect |
| --- | --- | --- |
| B1 | Baseline export and per-tab digest of both workbooks | none (read-only) |
| B2 | Representative: rejection injections — a `pending` marker, a malformed record, a duplicate record, an unsupported protocol version, and an authority mismatch | each read refused with its pinned code; the record restored to idle between injections |
| B3 | Larger: capture/activate with the D-c counters (seeds the production empty record first, because the workbook has none) | record `workbook-control`, epoch + 1, counters equal to the captured values |
| B4 | Representative: generation straddle — a read is started, a `begin`+`abort` pair fires after 1.5 s, the response is awaited | `STALE_REVISION`/`control-generation_changed`, no rows served, record idle afterwards with the generation advanced and every counter untouched |
| B5 | Representative: interrupted-mutation recovery — `begin`, a live read, `recover --decision not-started` | the read refuses `UNAVAILABLE`/`control-pending`; recovery advances the generation, leaves counters untouched, and a repeat is refused |
| B6 | Representative: 4.2 forward recovery — rollback to `script-properties` through `rollbackTransition`, a live read, then capture/activate forward with the stale D-a counters | the read refuses `UNAVAILABLE`/`control-authority_mismatch`; the forward activation keeps counters at `max(captured, current)`, advances the epoch, and the same reader then serves and reports the record's tuple |
| B7 | Representative: legacy-admission drill | refused against the activated record, admitted after B6's rollback step, and the divergence between the record's counters and the deployment's recorded as what the rollback equality check detects |
| B8 | Cleanup: the record left idle on `workbook-control` at its final tuple, no fixture rows, domain digests re-compared | structural deltas only (control tabs, the version-4 Settings record, the larger fixture's new record) |

## Snapshots, cleanup and restoration

- A workbook export and a per-tab digest baseline before B2, and an export after
  each batch, all in private storage with restricted permissions.
- Cleanup: every injected control state removed, the record left `idle`, the
  fixture rows removed, and the topology restored by D-d.
- The control tabs and the version-4 Settings record stay in both workbooks: they
  are the structure under test. The representative record stays activated, and
  the larger record is left activated at its captured tuple; both are listed as
  intended structural deltas rather than counted as differences.
- Domain rows must compare to the baselines with zero differences by stable
  identifier.

## Attempt and read budget

- Attempt ledger: **529** attempts are already spent against the predeclared
  ≤ 1,000-attempt campaign cap (`staging-local/.attempt-budget-ledger.json`).
  This window requests **at most 400 further attempts** — 22 read-matrix checks,
  ~200 latency observations, 90 browser-probe attempts, and the straddle,
  rejection and recovery attempts — leaving at least 71 of headroom. The ledger
  is shared across restarts, and every attempt is retained even when it fails.
- Reads: paced through the existing rolling ledger at ≤ 40 reads per 60 seconds,
  shared between the harness and the browser probe. No 429 is acceptable; a 429
  is a recorded failure, not a retry.
- Deployments: exactly the five above, each approved individually. No retry loop,
  no automatic redeploy, no paid service.

## Operator dependencies

1. A fresh Google ID token, captured through the local sign-in page the runner's
   tooling serves on the loopback origin the staging OAuth client already allows
   (`http://localhost:8788/`). The token is written to ignored
   `staging-local/credential-rehearsal.txt` and is never printed, logged or
   committed. It expires after about an hour, and a read that returns
   `UNAUTHORIZED` is retained and excluded rather than retried away.
2. A signed-in browser page for the browser-probe leg, which measures the same
   read plan through a real browser at 30 attempts per operation.
3. Roughly 1.5–2 hours of wall time for the paced window.

## Verification the window must produce

1. **Measured read-plan counts per path on both fixtures**, against the task 1.7
   table: identity 1, served domain 3 (fused authorization+control, plan, closing
   control), pending refusal 1, authority-mismatch refusal 1, missing/malformed/
   duplicate refusal 1, moved generation 3. A path costing more than its table row
   is reported as a finding, not smoothed over.
2. **Latency as a distribution per read operation per fixture** — p50/p95/p99/max
   from the harness at ≥30 warm observations at ≥3 in flight and from the browser
   probe at 30 attempts per operation, with the control reads' contribution taken
   from `X-Staging-Read-Ms` and instrumentation attempts labelled and excluded.
3. **A live generation straddle** returning the pinned code with no rows served,
   and the record left idle, advanced and counter-identical.
4. **Snapshot and counter parity**: domain rows unchanged by stable identifier;
   no counter ever decreases; the generation advances on every transition
   including abort, restore, rollback and activation.
5. **Quota**: zero 429s, and both ledgers reconciled afterwards.
6. **An explicit "not covered" list**, which will name at least: the Apps Script
   adapter's live leg (transferred to 5.2/5.3), the preview path, and protection
   idempotence (a REST-path measurement, not a production claim).

## Explicitly not part of this approval

- Any production deployment, Sheet mutation, push, or write-gate change.
- Any paid service, any benchmark-route enablement, any change to
  `wrangler.jsonc`.
- Closing or archiving the change, and closing original tasks 10.24/10.25.
- Any further deployment beyond the five above.

## What happens with the answer

- **Approved**: run D-a…D-d and B1–B8 in order, each deployment and batch
  confirmed as it is reached, and record the sanitized results as task 4.1/4.2
  evidence with the raw reports retained privately.
- **Declined or deferred**: record the decision, keep 4.1/4.2 open, and finish the
  locally verifiable remainder (the design restatement, the documentation pass and
  the final gates) so the window can run at any later point.
