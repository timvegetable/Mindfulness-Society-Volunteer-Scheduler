# Execution record — validate-worker-backend-feasibility

Durable context for resuming this change without replaying a conversation.
`tasks.md` remains the completion authority; this file records milestone status,
commits, decisions, test evidence, review disposition, blockers and the next
action. Longer sanitized reports are linked, not copied.

**Plan owner:** `plan.md` at the repository root (untracked). Execution level
`high`, one working agent plus one fresh read-only verifier per milestone.

## Status

| Milestone | Tasks | State | Commit |
| --- | --- | --- | --- |
| 1. Experiment contract | 1.1–1.3 | implementing | — |
| 2. Worker boundary | 2.1–2.3 | pending | — |
| 3. Authentication | 2.4 | pending | — |
| 4. Workbook integration and parity | 2.5–2.6 | pending | — |
| 5. Release readiness | 3.1 | pending | — |
| 6. Measurement and verdict | 3.2–4.3 | blocked on provisioning/deployment approval | — |

## Decisions

* **2026-09-24 — baseline.** Work starts from `edfd66e` on `master`; prototype
  evidence is read from the sibling branch `a47b274` (`codex/read-api-prototype`).
  Nothing is cherry-picked wholesale; each prototype asset is re-derived.
* **2026-09-24 — reuse strategy.** The Worker composes the *existing*
  synchronous domain path (`createProductionRuntime`, `usersFromSheet`,
  `createWorkbookBatchReader` parsing, `IntegrationDispatcher`) over data that was
  fetched asynchronously *before* the handler runs. Apps Script entry points stay
  synchronous; async orchestration lives only in the Worker layer. Rationale:
  maximum semantic parity for the fewest new lines, and the dispatcher's
  `assertSynchronous` guard keeps the legacy contract honest.
* **2026-09-24 — authorization before hydration.** `Users` is read fresh and
  authorization is decided before any domain range is fetched, matching
  `BATCH_READ_PLANS` excluding `Users`.
* **2026-09-24 — verifier identity.** The plan asks for a fresh verifier with no
  inherited turns. In this harness a `workflow` `agent()` call is the only way to
  start a subagent with no inherited conversation, so verification uses a
  one-agent workflow run rather than `subagent_fork`. Recorded because it changes
  how review evidence is produced.
* **2026-09-24 — no production state portability.** Revisions and configuration
  for staging are immutable Worker configuration, per the design; portable state
  belongs to `make-workbook-state-portable`.

## Evidence

* `evidence/experiment-contract.md` — tasks 1.1–1.3: 16-operation effect
  inventory with revisions and lock conditions (including the import-preview
  hidden write), pinned representative and larger fixtures plus edge-case
  variants, the authoritative `Users` decoder, dated Cloudflare/Google limits,
  prerequisites, measurement sources, the derived Sheets quota ceiling, the read
  budget and pacing arithmetic, and predeclared thresholds.
* `evidence/platform-limits-2026-09-24.md` — archived platform excerpts with
  section anchors and fetch dates so the dated figures are re-checkable offline.
* Baseline validation at `dae580f` with the milestone-1 documents present:
  `npm test` 33 files / 187 tests passed; `npm run check` (`tsc --noEmit` +
  `eslint --max-warnings=0`) clean; `openspec validate
  validate-worker-backend-feasibility --strict` valid.
* Repository map: `.jspace/repository-map.json` (local reasoning aid, mirrored to
  the ignored `repository-map.local.json`; never committed).

## Review disposition

| Milestone | Verifier | Findings | Disposition |
| --- | --- | --- | --- |
| 1 | fresh read-only agent (one-agent workflow run) | 1 blocker, 6 major, 6 minor | All accepted after independent re-check; document rewritten |
| 1 (recheck) | second fresh read-only agent, given the findings verbatim | 10 resolved, 2 partially resolved, 2 major + 8 minor new | All new findings accepted after independent re-check; document corrected again |
| 1 (edit check) | third fresh read-only agent, scoped to the post-recheck edits | 4 checks passed, 2 checks failed with 1 major + 4 minor | All accepted and fixed; measurement protocol re-derived independently by the verifier |

Milestone 1 findings and how each was resolved:

1. **Blocker — paced load exceeded the Sheets quota the same document budgets.**
   Confirmed: 5 req/s × 60 s = 300 requests/min, each issuing ≥ 2 Sheets reads as
   one service account, against a 60 reads/min/user ceiling. Fixed by deriving
   pacing from a read budget (40 reads/min cap ⇒ ≤ 20 requests/min), adding the
   derived sustained-request ceiling to the verdict requirements, and stating the
   per-operation read counts.
2. **Major — blank `active` decodes inactive on the runtime path.** Confirmed in
   `src/server/centers/codecs.ts` + `src/server/workbook/sheet-values.ts`
   (`cellBoolean` fallback `false`) versus `usersFromSheet` (`true`). The contract
   now names `centerUserCodec` as authoritative, expects denial for the blank row,
   keeps `active=false` as the control, and records the divergence for
   `make-workbook-state-portable`.
3. **Major — Insights read-count bound.** Correct for the Apps Script lazy
   prime sequence; the Worker prefetches the union plan in one `batchGet`, so the
   contract now states 1 read (`session.me`) or 2 (schedule, insights) and explains
   the difference.
4. **Major — Insights grid invariant.** Confirmed in `src/server/insights/overlap.ts`
   (`includeEmpty` defaults to false, adjacent equal-set slots merge). Invariant
   restated as covered, merged cells with the nominal width noted.
5. **Major — unpinned fixture inputs.** Fixed by pinning lifecycle/interview/rank
   distribution, required staff counts (including 2-staff sessions), completed-run
   timestamps, and the inherited insight configuration.
6. **Major — CPU thresholds not measurable as stated.** Fixed by naming the
   per-invocation record source and the analytics cross-check, setting a minimum
   cold sample count with an explicit not-evaluated rule, and defining
   "unexpected failure" per category.
7. **Major — prerequisites could not host the fixture set.** Fixed: two deployed
   workbooks plus local edge-case variants, a separate one-time fixture-loading
   identity with its own approval, and a recorded fixture digest.
8. **Minor — inventory cell errors.** Corrected rows 7, 8, 9, 10, 14, 15, 16,
   added a revisions column, made the lock column's `WRITE_ENABLED` condition
   explicit, and recorded conditional mail on rows 3 and 4.
9. **Minor — malformed-row expectation.** Restated as the code's total-decoding
   behaviour (revision coerced to 0, row retained, exclusion only from schedulable
   projections).
10. **Minor — stale-Insights key.** Named `TAB_REVISION_Volunteers` /
    `TAB_REVISION_RecurringAvailability` exactly and recorded that the Worker slice
    has no Insights cache.
11. **Minor — evidence discipline.** Baseline corrected to the reviewed commit
    `dae580f`, platform excerpts archived with section anchors, and the
    `differingProjectionFields` export decision recorded.
12. **Minor — untracked tool workspace.** Commits stage explicit paths; `.jspace/`
    is never staged. The ignored staging directory for secrets and traces is
    created in task 3.1.

Recheck: a second fresh read-only agent was given the findings above verbatim
plus the revised document and asked to confirm or refute each disposition
independently. It confirmed 10 of 12 and partially confirmed 2, and raised ten new
findings, all of which were independently re-checked in the source and then fixed:

13. **Major — pacing and the 4-concurrency wall-time threshold were mutually
    unsatisfiable.** At the read-budget-derived rate the expected in-flight
    concurrency is ~0.5, so a "4 concurrent" threshold could never be sampled, and a
    full token bucket admitted a burst on top of its refill. Fixed by replacing the
    token bucket with a sliding-window limiter (≤ 40 reads in any 60 s), pinning a
    burst phase of 20 requests at 4 in flight, requiring ≥ 30 observations at ≥ 3 in
    flight before the threshold is evaluated, and reporting achieved concurrency.
14. **Major — the contract never named the prefetched plan.** `batch-read.ts` has no
    union operation, so prefetching `insightCacheHit` would cost 3 reads/request and
    exactly hit the 60/minute ceiling. Fixed with a per-operation plan table pinning
    `insightCacheMiss` for insights and `publishedSchedule` for schedule, plus the
    one-reader-per-request rule.
15. **Minor — wrong CPU measurement source.** Real-time logs do not carry CPU
    fields on this plan and the archive did not cover analytics. Fixed: the CPU
    threshold is a published quantile (p99) from the CPU Time per execution series
    with a GraphQL aggregate cross-check; per-invocation trace attributes are an
    optional secondary source and no threshold depends on them. The metrics and
    analytics section is now archived.
16. **Minor — read counter missed the `Users` read.** Fixed: every Sheets API call
    is counted and the console counter must agree.
17. **Minor — row 13 claimed an AuditLog write** that `InsightStore` does not make
    (no audit writer is configured). Corrected.
18. **Minor — row 5 omitted the RecurringAvailability read** made by backup-promotion
    hydration, and stated mail unconditionally. Both corrected.
19. **Minor — subrequest budget ignored cold-isolate calls.** Split into ≤ 3 warm /
    ≤ 5 cold.
20. **Minor — fixture degrees of freedom.** Ineligible volunteer ids and the session
    ordering for "every fifth session" are now enumerated; the stale-Insights case
    now covers all four revision-tuple components including `assignmentRevision`.
21. **Minor — wrong baseline attribution.** `design.md` names `01c735c`, not
    `edfd66e`; corrected.

This harness has no persistent single-agent workflow session, so continuity of
finding identity is preserved but continuity of model session is not; that
limitation is recorded rather than glossed.

Third pass: a fresh agent checked only the post-recheck edits. It passed the
measurement-source, pacing-arithmetic, inventory-row and baseline checks (including
re-deriving that the burst phase stays within 40 reads in any 60-second window for
all three operations, that the sustained phase yields 100 observations per workload
inside the budget, and that the ≥ 3-in-flight rule is satisfiable), and found five
more issues, all fixed:

22. **Major — invented enum values broke fixture materialisation.**
    `cancelled` and `pending` are not members of `LifecycleStatusSchema`
    (`active | newly-joined | inactive | graduated`) or `InterviewStatusSchema`
    (`incomplete | complete`), and `validateMigrationPayload` refuses the whole
    payload if one row fails, so the pinned fixture was unreachable. Replaced with
    `inactive` and `incomplete`, and the constraint is now stated in the document.
23. **Minor — "same five ineligible categories"** contradicted the four enumerated.
    Corrected to four categories repeated five times (150 + 50 = 200), which is the
    arithmetic that actually closes.
24. **Minor — the fourth freshness-tuple component had no variant.** Added a variant
    that cancels an assignment row, advancing `TAB_REVISION_Assignments` without a
    republish, and must report `assignmentRowsRevision` as the stale reason.
25. **Minor — the preview read count claimed a union the reader cannot do.** Stated
    as two `batchGet` calls (3 reads if served, 0 in the local workbench).
26. **Minor — the subrequest ceiling named no instrument.** The Worker-side counter
    now covers every outgoing `fetch`, reported per cold/warm phase.


## Blockers and open questions

* Staging resources and authorized test identities are unassigned. Tasks 3.2–4.3
  cannot start without explicit approval; local work through 3.1 is independent.
* `web_search` returned HTTP 401 during this session; external facts were taken
  from direct page fetches instead.
* Pages currently deploys on every push (`.github/workflows/pages.yml`), so no
  push may happen until task 3.1 separates validation from deployment.

## Next action

Run the milestone-1 verifier against the frozen experiment-contract document,
resolve its findings, mark 1.1–1.3 with evidence, and commit milestone 1.
