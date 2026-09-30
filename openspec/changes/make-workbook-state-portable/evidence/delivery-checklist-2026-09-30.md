# Delivery checklist — j-space goal, line by line (2026-09-30)

Goal under check: *Close tasks 4.1/4.2 of make-workbook-state-portable by
executing plan.md: workstream 1 code (Worker bracket reuse, staging bracket-hold
instrument, per-read timing header, legacy-mode write guard, rollback
transition), workstream 2 rehearsal tooling (deploy vars, harness per-operation
summaries, read-matrix driver, runner straddle/legacy subcommands, browser
probe), workstream 3 the individually approved five-deployment synthetic staging
window (read matrix, latency distribution, generation straddle, larger fixture,
4.2 drills, restore), workstream 4 sanitized evidence, task ticks and gates. No
push, no production, no paid services.*

| Goal clause | State | Where it is verified |
| --- | --- | --- |
| Worker bracket reuse (fused first observation) | delivered | `f1494aa`; measured live at 3 reads per served domain read on both fixtures |
| Staging bracket-hold instrument | delivered | `f1494aa`; D-b deployed it and the straddle became deterministic |
| Per-read timing header | delivered | `f1494aa`; `X-Staging-Read-Ms` observed live on every straddle and served read |
| Legacy-mode write guard | delivered | `ad2beca`; 15 contract cases; admitted/refused live through `legacy-admission` |
| Rollback transition | delivered | `5bd2c93`; ran live at epoch 8/generation 27 and again forward at epoch 9/generation 28 |
| Deploy `--var` tool | delivered | `843e49c`; every deployment in the window used it and `wrangler.jsonc` is unchanged |
| Harness per-operation summaries | partial | `9103a9c` added the read-cost override and the shared ledger; per-operation quantiles come from one manifest per operation, not from sub-summaries inside a multi-operation manifest |
| Runner inject/restore for the rejection matrix | delivered | `9103a9c`; five injected states written, checked and restored live |
| Read-matrix driver | delivered | `843e49c`; drove all 15 live checks and their attempt logs |
| Runner straddle and legacy-admission subcommands | delivered | `b11d7be`, `9103a9c`; both ran live, both variants of the straddle included |
| Browser probe upgrades | delivered, not run | `1032eff` with 6 contract cases; the live leg did not run (token expiry) |
| Five-deployment approved window | delivered | D-a, D-b, D-c (host+gateway), D-d (host+gateway); markers recorded in the live-checks evidence |
| Read matrix | delivered | 15 measured paths across both fixtures at their pinned counts |
| Latency distribution | partial | harness populations on both fixtures; the browser leg is missing, and the larger fixture's Schedule p99 breaches the gate |
| Generation straddle | delivered | abort and pending variants, no rows served, record idle/advanced/counter-identical |
| Larger fixture | delivered | pre-capture refusals, activation through the production writer, read plan and latency |
| 4.2 drills | delivered | rollback, forward recovery, interrupted-mutation recovery, property-only refusal with the live divergence |
| Restore | delivered | legacy counts 1 and 2 reads; zero changed domain tabs on both fixtures |
| Sanitized evidence | delivered | `staging-rehearsal-live-checks-2-2026-09-30.md` and the manifest; raw reports private |
| Task ticks | partial, by design | 4.2 ticked with evidence; 4.1 left open on a measured gate breach and the missing browser leg |
| Gates | delivered | `pnpm test` 55/509, `test:worker` 8/161, `check` exit 0, `build` with bundle audit, strict OpenSpec valid, `git diff --check` clean |
| No push / no production / no paid service | held | branch local, 13 commits unpushed; every target was a synthetic staging resource |

## Limitations this delivery states rather than hides

1. **Task 4.1 is open.** The larger fixture's Schedule read measures p99 2,882 ms
   against a predeclared 1,500 ms gate. Nothing measured separates the added
   control read from the larger plan payload as its cause.
2. **The browser-probe leg did not run.** The tooling is complete and
   contract-tested; the paced live run needs a fresh sign-in.
3. **The harness's per-operation breakdown is per manifest.** Running one
   operation per manifest gives per-operation quantiles; a single manifest with
   several operations still reports one combined distribution.
4. **Straddle and transition reads are not attempt-ledgered** (seven reads in
   this window), so the campaign total under-counts what was issued.
5. **The Apps Script adapter's live leg** remains transferred to tasks 5.2/5.3,
   as the change's recorded deferral.
6. **Tasks 4.3 and 5.x are untouched**: this goal covered 4.1 and 4.2.
7. **Two failures are retained rather than erased**: a driver that crashed after
   spending its attempts, and a restore that left a pending marker which the
   production recovery then cleared.
