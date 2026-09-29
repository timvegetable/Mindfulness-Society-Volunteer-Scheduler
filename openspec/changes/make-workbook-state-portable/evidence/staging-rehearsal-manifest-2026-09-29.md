# Synthetic staging rehearsal manifest — 2026-09-29 (tasks 4.1/4.2 approval request)

Scope: the two synthetic staging workbooks and the existing staging Worker
topology only. No production resource, workbook, deployment or Script Property is
touched. Identifiers, credential paths, snapshot paths and digests live in the
private staging manifest under ignored `staging-local/`; this document names roles
and operations.

## Targets

| Target | Role | State |
| --- | --- | --- |
| Synthetic workbook "representative" (305 data rows, zone `America/New_York`) | smaller fixture, read-path checks | loaded by the archived campaign, digest unchanged since |
| Synthetic workbook "larger" (2,158 data rows, same zone) | larger fixture, read-path and control-transition checks | same |
| Staging Worker `volunteer-scheduling-staging-host` | serves reads from the workbooks through the control record | deployed, benchmark route disabled, no public route |
| Staging gateway Worker | thin forwarder in front of the host | deployed, unchanged by this rehearsal |

## Deployments (each needs its own approval; the contract allows one per action)

| # | Deployment | Purpose |
| --- | --- | --- |
| D1 | host redeploy with `STAGING_CONTROL_AUTHORITY=workbook-control` | serve bracketed reads so the completed-snapshot path is exercised live |
| D2 | host redeploy with the binding removed | return the topology to its verified pre-rehearsal state |

No benchmark-route deployment is requested: preview is not part of the control
read plan, and its parity is already pinned by the differential suite and the
archived campaign. Gateway redeploys are not requested.

## Workbook mutations

All mutations are applied through the staging loader service account against the
synthetic workbooks, under a Node runner that mirrors the production maintenance
procedure. Every batch is preceded by a snapshot and followed by a comparison.

| # | Mutation | Expected effect | Reversal |
| --- | --- | --- | --- |
| S1 | Export both workbooks and build the per-tab digest baseline by stable identifier | none (read-only) | n/a |
| S2 | Initialize both workbooks twice | two control tabs added, Settings version record created or converged to 4 in place, declared data-column protections applied; the second run reports `alreadyInitialized` and appends nothing | delete the two tabs and the version record, or restore from S1 |
| S3 | Capture: write the staging counters (`DATA_REVISION`, `SCHEDULING_INPUT_REVISION`, per-tab) into the representative workbook's control record, epoch + 1, `authority: workbook-control`, `mutationState: idle` | record counters equal the captured values | restore the pre-capture record from S1 |
| S4 | Interruption: write a `pending` marker with a synthetic operation id and one declared tab, without touching rows | reads through both adapters refuse with `UNAVAILABLE`; no counter moves | recovery decision `not-started` (S5) |
| S5 | Recovery: apply `not-started` with a recorded reason | generation advances, every counter unchanged, journal records the decision and the interrupted operation id | none needed; a repeat must be refused |
| S6 | Counter transition: apply a `completed` recovery naming two tabs, then read both adapters | global +1, each named tab +1, scheduling-input +1 only if a named tab is a scheduling input; readers report the new tuple | restore the counters from S1's recorded values under a `restored` decision |
| S7 | Partial-write rehearsal: insert a tagged fixture row into one tab, apply `restored` with the snapshot as the restore source, remove the fixture | generation advances, counters unchanged, readers still serve after the restore | fixture removal is part of the step |
| S8 | Rollback rehearsal: set `authority: script-properties` (epoch + 1) and serve a read | both adapters refuse with `AUTHORITY_MISMATCH`-derived `UNAVAILABLE` rather than serving stale counters; the property-only writer path stays closed | restore `authority: workbook-control` from the recorded tuple |

## Snapshots, cleanup and restoration

- A workbook export and a per-tab digest baseline before S2, and an export after
  each mutation batch, all in private storage with restricted permissions.
- Cleanup at the end: S8's authority restored to `workbook-control`, the fixture
  row removed, the record left `idle` at a captured tuple, and the host redeployed
  without the control binding (D2).
- The two control tabs and the version-4 Settings record stay in the staging
  workbooks: they are the structure under test, and removing them would discard
  the evidence. Their presence is recorded in the closing snapshot comparison
  rather than counted as a difference.
- Domain rows must compare to the S1 baseline with zero differences by stable
  identifier; the intended structural deltas are listed explicitly.

## Attempt and read budget

- Attempt ledger: 529 attempts are already spent against the predeclared
  ≤ 1,000-attempt campaign cap (retained in
  `staging-local/.attempt-budget-ledger.json`). This rehearsal requests **at most
  200 further attempts**, leaving at least 271 of headroom; the ledger is shared
  across restarts and every attempt is retained even when it fails.
- Reads: paced through the existing rolling ledger at ≤ 40 reads per 60 seconds,
  shared between the harness and the browser probe through the probe host's
  reservation endpoint. No 429 is acceptable; a 429 is a recorded failure, not a
  retry.
- Deployments: exactly the two in the table above, each approved individually.
  No retry loop, no automatic redeploy, no paid service.

## Verification the rehearsal must produce

1. **Read counts per path**, measured, against the task 1.7 table: identity read
   (control ×2 + Users), domain read (control ×2 + Users + plan), rejected paths
   (control only; control + Users), and the generation-changed path. The Worker's
   `X-Staging-Sheets-Reads` and the probe reports are the sources; a path costing
   more than its table row is reported as a finding.
2. **Counter equality and monotonicity**: after every mutation, the record's
   tuple equals the expected tuple, no counter ever decreases, and the
   generation advances on every transition including aborts and restores.
3. **Rejection paths**: pending, malformed, duplicate, unsupported, wrong
   authority and moved generation each produce their pinned API code from both
   adapters, with no domain rows served.
4. **Snapshot parity**: domain rows unchanged by stable identifier; structural
   deltas listed.
5. **Protections**: the declared protected data columns are protected, including
   both control tabs, and the staging service account still reads the workbook.
6. **Latency and quota**: control-read latency reported separately and the served
   read against the unchanged staging threshold; no 429; the attempt and read
   ledgers reconciled afterwards.

## Explicitly not part of this approval

- Any production deployment, Sheet mutation, push, or write-gate change.
- Any paid service, any gateway redeploy, any benchmark-route enablement.
- Closing or archiving the change, and closing original tasks 10.24/10.25.

## What happens with the answer

- **Approved**: implement the rehearsal runner (a Node script in `scripts/staging/`
  with its contract tests), execute S1–S8 under D1/D2, and record the sanitized
  results as task 4.1/4.2 evidence with the private raw reports retained.
- **Declined or deferred**: record the decision, keep tasks 4.1/4.2 open, and
  finish the locally verifiable remainder (task 2.4's schema-validation half where
  possible, the 4.3 documentation pass, and the independent reviews) so the
  package is ready to rehearse at any later point.
