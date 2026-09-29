# Execution record — accelerate-schedule-preview (2026-09-29)

Task-by-task record with evidence. Dates: implementation and local validation
2026-09-29 (early UTC); staging campaign 2026-09-29 (07:31–18:02 UTC) under
per-deployment approvals.

## 1. Baseline profile and parity instrumentation

* **1.1 done** — `scripts/staging/profile-schedule-preview.mjs` (committed) measures
  the four phases over both pinned fixtures, one fresh snapshot/runtime per
  iteration, with an end-to-end handler cross-check per iteration
  (`--plan` refuses nothing; `--confirm-local` measures; `--parity` runs the
  differential cases). Baseline report + predeclared interpretation rule +
  branch decision + post-optimization tables:
  [evidence/profile-2026-09-29.md](evidence/profile-2026-09-29.md). Raw JSON in
  ignored `staging-local/profile-*.json`.
* **1.2 done** — `src/server/scheduling/preview-parity.ts` (engine) +
  `preview-parity-cases.ts` (one source of cases) +
  `src/server/scheduling/reference/` (frozen pre-optimization oracle, verbatim
  baseline copies of `src/shared/time.ts` and the scheduler, never imported by
  production). Permanent suite `preview-parity.contract.test.ts`; per-case
  digests: [evidence/baseline-parity-2026-09-29.md](evidence/baseline-parity-2026-09-29.md).
  The comparator self-test proves a deliberate unrelated change surfaces as
  concrete field paths. The fixture-identity test pins the local fixtures to
  the deployed workbooks' digests (including the Sheets-typed cells: serial
  dates and clocks, ISO instants left as strings — verified against the live
  workbooks via `scripts/staging/diff-fixture-diagnostic.mjs`).
* **1.3 done** — pre-measurement verification:
  [evidence/staging-verification-2026-09-29.md](evidence/staging-verification-2026-09-29.md)
  (topology live, benchmark route 404 with zero reads, both workbook digests
  identical to the campaign record, thresholds re-pinned unchanged). The
  campaign's open prerequisites (expired credentials, per-deployment approvals)
  recorded there were satisfied during the campaign.

## 2. Optimization implementation (branch order followed the profile split)

The baseline split (scheduler 97.5%/99.6% of the phase sum) selected the
scan-elimination branch; task 2.4's assembly branch **was not triggered**
(recorded with numbers in the profile evidence).

* **2.1 done** — `src/server/scheduling/scheduler.ts`: request-local indexes —
  exceptions grouped by volunteer id, assigned rows grouped by session id,
  targeted occupancy removal through the assignment index, per-request session
  start-instant memoization, and a Set for the cutoff-exclusion membership
  check. `scheduling.contract.test.ts` and all focused suites pass unmodified.
* **2.2 done** — occupancy is maintained per volunteer: the evaluated session's
  rows are removed only for the volunteers the assignment index names, with
  each volunteer's remaining conflict rows kept in order (was: a walk over
  every volunteer's rows per evaluated session).
* **2.3 done** — `src/shared/time.ts` gained `createIntervalMemo()`
  (request-local): weekday per date, base and normalized-base intervals per
  (availability list, weekday, zone), and memoized (date, zone, clock)
  boundary instants. Temporal semantics and DST resolution are untouched — the
  memo caches pure results keyed by their exact inputs. The composed
  per-(availability, date) result is computed directly (its keys are unique in
  a request's workload; caching it would only spend isolate memory). All
  helpers take the memo as an optional trailing parameter, so every existing
  caller is byte-identical to before.
* **2.4 not triggered** — the profile assigned ≈0.2–1.4% to projection
  assembly on both fixtures; the branch decision and its numbers are recorded
  in [evidence/profile-2026-09-29.md](evidence/profile-2026-09-29.md).
* **2.5 done** — post-optimization profile: representative end-to-end median
  48.12 → 8.69 ms; larger end-to-end median 4,889.78 → 379.78 ms (≈13×);
  post-DST scheduler 443.9 ms. The same file records the campaign-budget
  projection (hypothesis only; the campaign decided).

## 3. Equivalence proof and local validation

* **3.1 done** — the differential suite (4 pinned fixture×clock cases, 4 edge
  cases, 12 seeded randomized workbooks, the handler anchor, the comparator
  self-test) is byte-equal in every case and runs in `pnpm test` — 41 files,
  259 tests, green. The suite is the permanent regression parity guard; no
  existing expectation was modified.
* **3.2 done** — recorded outputs (2026-09-29, repeated after the final code
  changes): `pnpm test` (259 green), `pnpm run test:worker` (8 files, 127
  green), `pnpm run check` (clean, zero warnings), `pnpm run build` (client +
  Apps Script bundle 498.1 KB + audit), `build:worker`/`:host`/`:gateway`
  dry-runs (gateway audit: 5,074 bytes, no forbidden imports),
  `openspec validate accelerate-schedule-preview --strict` (valid). One
  pre-existing test failure outside this change's scope
  (`staging-harness.contract.test.ts` reading the pre-archive staging-manifest
  path, broken by the uncommitted evidence archive move) was fixed by pointing
  the test at the archived location.

## 4. Staging re-measurement campaign

* **4.1 done** — harness extensions (all covered by contract tests in
  `staging-harness.contract.test.ts` and `host.test.ts`):
  * `AttemptBudget` — the ≤1,000-attempt campaign ledger shared across
    harness restarts (`staging-local/.attempt-budget-ledger.json`), with
    deferred-attempt accounting when the cap is reached; saves serialize so
    concurrent workers never lose an increment (a read-modify-write race found
    during the campaign's first run was fixed and its effect disclosed below).
  * **DO version-lag check** — the host echoes its deployment marker
    (`X-Staging-Host-Deployed-At`, stamped per approved redeploy) on every
    response; `classifyColdObservation` counts a cold attempt as genuine only
    when the marker matches the manifest's expected deployment. A lagging
    object is retained as evidence, never counted.
  * **Paced browser probes** — `serve-probe.mjs` exposes `POST /__reserve`
    backed by the same shared read ledger the harness uses
    (`staging-local/.read-budget-ledger.json`); `browser-probe.js` reserves
    before every attempt and reports `pacedThroughSharedLedger` in its report.
    This closes the pacing gap that caused the attributed 429s in 2026-09-28.
  * Preview workloads per fixture (sequential warm + four-way burst, cold on
    `--cold`), every attempt retained in `<report>.attempts.jsonl`.
* **4.2 done** — after per-deployment approvals (10 approved redeploys: 5 host,
  5 gateway, plus the final disable — reports in ignored
  `staging-local/deployment-preview-*.json`), the campaign ran both fixtures:
  representative (1 genuine cold 1,339 ms; two full warm runs, burst p99
  538–722 ms, sustained p99 521–574 ms, zero failures) and larger (cold
  1,110–2,653 ms; burst p99 2,553–4,191 ms and sustained p99 1,161–1,635 ms
  across 8 full runs, zero wall-cap kills, one attributed 503). Workbook
  digests cross-checked before and after each fixture campaign. Sanitized
  attempt logs and reports in ignored `staging-local/preview-campaign-*.json(l)`
  plus the runbook
  [evidence/campaign-runbook-2026-09-29.md](evidence/campaign-runbook-2026-09-29.md).
* **4.3 done** — platform metrics under the attribution rules, explicit
  script/namespace/window attribution, documented microsecond units, the
  exact-sample vs bucket-quantile distinction, and coverage that cannot pass
  on missing coverage: `staging-local/metrics-gateway-representative-window.json`
  (60 attributed invocations, coverage sufficient, exact max 1.76 ms, worst
  bucket p99 1.89 ms, 0 errors), `metrics-host-larger-window.json` (181 DO
  requests, 78.63 s CPU), `metrics-host-burst-window.json` (9.759 s / 20
  ≈ 488 ms per larger burst preview), `metrics-host-preview-2026-09-29.json`
  (whole campaign: 531 DO requests, 192.14 s CPU, isolate P99 40.88–44.88 MiB,
  billable duration unresolved as published). Reports with unchecked coverage
  are labelled so. One full-window gateway collection refused as
  `window-too-dense` by its own splitting guard; the narrow window with
  sufficient coverage is the recorded evidence.
* **4.4 done** — an approved host redeploy disabled the benchmark route
  (18:02Z); verification: `POST /benchmark/schedule-preview` → 404 with zero
  reads (12/12 transport checks pass), a served read still works through
  `/exec` (200, 2 reads, 400 sessions), and both workbook digests unchanged
  (`staging-local/verification-post-campaign-2026-09-29.json`,
  `reader-verification-post-campaign-2026-09-29.json`).

## 5. Verdict and handoff

* **5.1 done** — dated verdict: [evidence/verdict-2026-09-29.md](evidence/verdict-2026-09-29.md)
  — **go** on every evaluated dimension against the unchanged thresholds.
* **5.2 done** — the staging measurement documentation update is scoped to the
  paced-probe procedure and the new ledgers
  (`docs/testing.md` staging-tools paragraph); the handoff note for
  `serve-remaining-reads-from-worker` is
  [evidence/handoff-serve-remaining-reads-2026-09-29.md](evidence/handoff-serve-remaining-reads-2026-09-29.md),
  which links the evidence without claiming that change's tasks complete.

## Disclosed deviations during execution

1. **Ledger race, first campaign run.** The first representative run's
   `AttemptBudget`/`ReadBudget` re-read the ledger file inside every reserve,
   so concurrent workers lost increments (5 of 41). Every attempt was still
   retained in the attempt log; the budgets under-counted (never over-counted),
   so the predeclared caps were respected throughout. Fixed
   (load-once + serialized saves) before the second run; the remainder of the
   campaign reconciles exactly (41-attempt runs recorded as 41).
2. **Report-path clobbering.** The first larger-fixture run's report and
   attempt log were overwritten by the follow-up gateway-cold run before they
   were copied aside. The overwritten run's numbers are recorded in the verdict
   from the session record (cold 2,653 ms genuine, burst 20/20 p99 2,760 ms,
   sustained 20/20 p99 1,634 ms, digest `dc2f5ecf…`, ledger 78→119), and the
   platform telemetry for that window corroborates them. Manifests now use
   separate manifest/report paths.
3. **Expired-credential attempts.** A session gap let the 07:40Z credential
   expire mid-chain; 41 attempts against it are retained as
   `envelope-UNAUTHORIZED` failures (attributed to the operator clock; zero
   domain reads on the verification failures). The chain resumed after a fresh
   sign-in.
4. **Dense-window metrics refusal.** A whole-campaign gateway metrics window
   was refused by the collector's own density guard; the narrow-window
   collection with sufficient coverage is the recorded gateway evidence.
