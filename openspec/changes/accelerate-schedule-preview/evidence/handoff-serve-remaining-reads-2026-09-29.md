# Handoff — evidence for `serve-remaining-reads-from-worker`'s preview acceptance tasks (2026-09-29)

This note provides evidence only. It does **not** claim any task of
`serve-remaining-reads-from-worker` complete: its preview acceptance tasks run
through that change's own gates.

## What is handed over

1. **The optimized preview computation**, byte-identical to the pre-optimization
   implementation (differential parity over the pinned fixtures, edge cases and
   12 seeded randomized workbooks — permanent suite
   `src/server/scheduling/preview-parity.contract.test.ts`; digests in
   [baseline-parity-2026-09-29.md](baseline-parity-2026-09-29.md)).
2. **The campaign-verified resource envelope on the selected free topology**:
   [verdict-2026-09-29.md](verdict-2026-09-29.md) — a **go** against the
   unchanged amended-contract thresholds on the isolated Durable Object
   topology. Headline numbers: larger-fixture four-way burst p99 2,553–4,191 ms
   with zero wall-cap kills (2026-09-28: ten requests killed at ~37 s), cold
   ≤ 2,653 ms, per-request DO CPU in the hundreds of milliseconds
   (aggregate-evaluated, labelled), memory P99 ≤ 44.88 MiB, zero 429s, 5+5
   version-lag-checked genuine colds.
3. **The measurement harness with the ledgers the 2026-09-28 campaign lacked**:
   the ≤1,000-attempt campaign budget shared across restarts, the Durable
   Object version-lag check before cold observations are counted, and browser
   probes paced through the same shared read ledger as the harness attempts
   (`staging-harness.contract.test.ts` covers all three).
4. **The staging record**: pre-campaign and post-campaign verification reports
   both show the benchmark route 404'd with zero reads and the workbook digests
   unchanged; the campaign left the topology in its verified pre-campaign
   state.

## What still belongs to `serve-remaining-reads-from-worker`

* Its own proposal/design/tasks and gates for moving `admin.schedule.preview`
  (and the remaining reads) onto the Worker topology.
* Whatever production acceptance it predeclares — this verdict measured the
  staging topology only, and authorizes no production deployment.
* The profile evidence it may reuse when sizing the preview's production
  rollout: [profile-2026-09-29.md](profile-2026-09-29.md) documents the
  predeclared interpretation rule, the branch decision, and the before/after
  splits.
