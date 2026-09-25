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
| 1. Experiment contract | 1.1–1.3 | complete, verified | `2791323` |
| 2. Worker boundary | 2.1–2.3 | complete, verified | `5dcd384` |
| 3. Authentication | 2.4 | complete, verified | `3dc8667` |
| 4. Workbook integration and parity | 2.5–2.6 | complete, verified | `591b76d` |
| 5. Release readiness | 3.1 | complete, verified | `c5eab07` |
| 6. Measurement and verdict | 3.2–4.3 | **blocked on provisioning/deployment approval** — checkpoint written | — |

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
* **2026-09-24 — new dependencies, justified (task 2.1).** Three pinned
  devDependencies: `wrangler@4.139.0` (Worker build and dry-run validation),
  `@cloudflare/workers-types@5.20260924.1` (runtime types for the isolated Worker
  type program), and `@cloudflare/vitest-pool-workers@0.12.21` (Worker-native tests
  in workerd). `0.12.21` is the newest release in that line compatible with the
  repository's pinned `vitest@^3.2.4`; `0.13.0` and later require vitest 4, which
  would churn the whole existing suite for no feasibility benefit. No runtime
  dependency was added, and `nodejs_compat` is not enabled.
* **2026-09-24 — compatibility date.** `wrangler.jsonc` pins
  `compatibility_date: 2026-03-10`, the newest date the pinned local workerd
  (1.20260310.x, via `@cloudflare/vitest-pool-workers@0.12.21`) implements;
  pinning a later date made the Worker-native tests silently fall back to an
  older runtime, which would have made local evidence diverge from the deployed
  configuration.
* **2026-09-24 — Worker runtime isolation is enforced by three checks, not one.**
  `tsconfig.worker.json` checks Worker *source* against Workers types only (test
  files excluded, because a test runner pulls Node's types in), and
  `tsconfig.worker-tests.json` checks the tests separately. Because
  `@cloudflare/workers-types` itself declares `Buffer` and `process` as `any` for
  the nodejs_compat surface, the type program alone cannot catch those two, so
  ESLint additionally restricts Node built-in imports and the `process`, `Buffer`,
  `require`, `__dirname`, `__filename`, `global` and `setImmediate` globals inside
  `src/worker`. A probe file using `node:fs`, `process` and `Buffer` was added and
  removed: ESLint reported three errors and the check passed again afterwards.
  Known limitation: `@cloudflare/vitest-pool-workers` enables several
  `enable_nodejs_*` compatibility flags for the Vitest runner itself, so the test
  runtime is slightly more permissive than the deployed Worker; the ESLint rule and
  the isolated type program are what close that gap.
* **2026-09-24 — shared request policy, one copy.** The operation registry,
  payload schemas, envelope rejection rules and failure envelopes moved from
  `dispatcher.ts` into `request-policy.ts`; the dispatcher re-exports the previous
  surface so no importer changed, and it now validates through
  `validateRequestEnvelope`. The Worker consumes the same module, so the transport
  cannot drift from the dispatcher's rules. The reviewer compared all nine
  rejection paths against `git show HEAD:…dispatcher.ts` and found no envelope
  change.
* **2026-09-24 — production code touched twice, type-level only.** `utf8.ts` and
  `workbook/repository.ts` keep their `typeof globalThis.X === ...` guards — the
  Apps Script bundle audit proves those guards — but cast through `unknown`
  because the Workers type program declares `TextEncoder` as a class and `crypto`
  as a `const`, which TypeScript does not project onto `globalThis`. Runtime
  behaviour is unchanged; the bundle audit still passes.
* **2026-09-24 — bounded body read.** The transport reads the request body through
  a stream with a hard byte cap rather than buffering it, so an oversized body is
  refused while it is still arriving.
* **2026-09-24 — the operation allowlist is load-bearing.** Nine of the sixteen
  operations are policy-mutating, but `admin.import.whenIsGood.preview` is
  registered read-only while its handler writes an `Imports` row. For that
  operation the three-operation transport allowlist is the only barrier, so
  `read-api.ts` documents that adding an operation requires re-checking its actual
  effects first.

## Milestone 2 evidence (Worker boundary, tasks 2.1–2.3)

* `wrangler.jsonc`, `tsconfig.worker.json`, `tsconfig.worker-tests.json`,
  `vitest.worker.config.ts`, `package.json` scripts `build:worker`, `test:worker`,
  `typecheck:worker`; the root `tsconfig.json` excludes `src/worker` and the Node
  vitest config excludes `src/worker/**`, so both suites keep their own runtime and
  globals.
* `src/server/integration/request-policy.ts` and `projection-diff.ts` — extracted
  seams; `src/worker/{config,read-api,dispatch,entry}.ts` — staging slice.
* Commands and outcomes at this commit: `npm test` 34 files / 194 tests;
  `npm run test:worker` 4 files / 38 tests in workerd; `npm run check` clean
  (the Node program, both Worker programs, and eslint with the Worker boundary
  rules); `npm run build` passes including the Apps Script bundle audit;
  `npm run build:worker` bundles to 795.54 KiB (125.22 KiB gzip) against the
  64 MiB limit; `openspec validate validate-worker-backend-feasibility --strict`
  valid.
* Environment note: the DSH file sandbox cannot create `~/.config/.wrangler`, so
  `build:worker` was run with `XDG_CONFIG_HOME` pointed inside the workspace. The
  committed script is unchanged and needs no such override on a normal machine or
  in CI.

## Milestone 1 evidence (Experiment contract, tasks 1.1–1.3)

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
| 2 | fresh read-only agent (one-agent workflow run) | 0 blocker, 0 major, 5 minor | All five accepted and fixed; the reviewer reproduced every claimed test number |
| 2 (recheck) | second fresh read-only agent, given findings 27–31 verbatim | 5 fixed, 4 minor new | All four accepted and fixed; the reviewer independently reproduced the workerd version and the lint boundary |
| 3 (mandatory auth gate) | fresh read-only security verifier | 0 blocker, 2 major, 5 minor | All seven accepted and fixed; two majors were real cache defects |
| 3 (recheck) | second fresh read-only security verifier | 7 fixed/partially fixed, 3 minor new | All three accepted and fixed |
| 4 | fresh read-only agent (one-agent workflow run) | 0 blocker, 0 major, 9 minor | All nine accepted; eight fixed, one recorded as a 4.3 follow-up |
| 4 (recheck) | second fresh read-only agent | 4 fixed, 4 partially fixed, 1 not fixed (the 4.3 follow-up), 2 minor new | All accepted; residuals and both new findings fixed |
| 5 (mandatory release gate) | fresh read-only release reviewer | 2 blocker, 4 major, 5 minor | All eleven accepted and fixed |

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

Milestone 2 findings and how each was resolved:

27. **Minor — the dependency justification was wrong.** `0.12.21`, not `0.12.0`, is
    the newest `@cloudflare/vitest-pool-workers` compatible with `vitest@^3.2.4`
    (0.13.0+ requires vitest 4). The pin was raised to `0.12.21`, which also moved
    the local workerd to 1.20260310.x and let the compatibility date move from
    2026-01-03 to 2026-03-10.
28. **Minor — the Worker type program was not actually isolated.** It included the
    Worker test files, whose runner types pull `@types/node` into the program, so a
    Node-only global in Worker source could pass `npm run check`. Split into
    `tsconfig.worker.json` (source, Workers types only, test files excluded) and
    `tsconfig.worker-tests.json` (tests), and verified by probe that Node globals
    are now rejected: `@cloudflare/workers-types` declares `Buffer` and `process`
    as `any`, so ESLint additionally restricts Node built-in imports and those
    globals inside `src/worker`. The probe produced three ESLint errors.
29. **Minor — the fail-closed misconfiguration path was untested.** Added an entry
    test that calls the Worker with an invalid allowlist binding and asserts a
    bounded 503 `UNAVAILABLE` envelope that names neither the binding nor the value.
30. **Minor — a non-serializable dispatch result produced an empty 200 body.**
    `read-api.ts` now serializes through a guard that always emits the application
    envelope, with a test covering `undefined`, a function and a `BigInt`.
31. **Minor — a misleading comment and an unrecorded nuance.** The comment now names
    the nine policy-mutating operations, and the load-bearing role of the transport
    allowlist for the read-only-but-writing import-preview operation is recorded
    both in `read-api.ts` and above.

Milestone 2 recheck (a fresh agent given findings 27–31 verbatim) confirmed all
five fixed, reproduced the environment independently, and raised four more, all
fixed:

32. **Minor — the serialization guard proved only stringify-ability, not envelope
    shape.** A result that serializes to `{}`, `null` or `42` would still be served
    as if it were an `ApiResponse`. The guard now requires an object with a boolean
    `ok`, and the test covers `undefined`, a function, a `BigInt`, `null`, a number,
    a `Map`, a `Symbol` and a cyclic object.
33. **Minor — `clearImmediate` escaped both guards.** `@cloudflare/workers-types`
    declares it, and it was absent from the restricted-globals list, so a
    Node-only global could pass the check and throw in workerd. Added, and the
    entry point now wraps `api.fetch` as well as configuration, so an unexpected
    transport throw still returns the bounded envelope instead of a platform error
    page.
34. **Minor — the lint boundary was narrower than the Worker program.** The shared
    `src/shared` and `src/server` modules the Worker compiles were not linted for
    Node globals. The rule now covers `src/worker`, `src/shared` and `src/server`
    (test files excluded), and a `--stdin` probe confirmed it rejects `process` and
    `clearImmediate` in a shared module while leaving test files alone.
35. **Minor — `vitest.worker.config.ts` was covered by no check.** It is now in the
    root TypeScript program, and the lint step also covers the three root config
    files.

## Milestone 3 evidence (Authentication, task 2.4)

* `src/worker/google/{jwt,jwks,id-token,service-account,index}.ts` — RS256
  verification against Google's published key set, the JWT-bearer assertion and
  token exchange, and the two separate expiring caches; `dispatch.ts` verifies
  the ID token in the real request path before refusing, so the modules are wired
  and in the bundle rather than dead code.
* Commands and outcomes: `npm test` 34 files / 194 tests; `npm run test:worker`
  5 files / 79 tests in workerd with real key generation and real signatures;
  `npm run check` clean; `npm run build` passes including the Apps Script bundle
  audit; `npm run build:worker` 819.81 KiB / 130.87 KiB gzip; `openspec validate
  validate-worker-backend-feasibility --strict` valid.

Milestone 3 findings and how each was resolved (mandatory authentication gate):

36. **Major — the "expiring caches" were per request.** `createStagingDispatch`
    and `createGoogleDependencies` ran on every request, so no key set or access
    token survived a request: every credential-bearing request refetched the key
    set, and every future Sheets read would have exchanged a token. The assembled
    clients are now memoized for the isolate under a structural configuration key,
    with the isolate cache exported so a test can exercise the real sharing
    behaviour while injecting a transport.
37. **Major — the rotation bound was not concurrency-safe.** `lastLoadAt` was
    stamped only after a successful load and loads were not de-duplicated, so ten
    concurrent unknown-`kid` requests caused ten outbound fetches. One in-flight
    load is now shared by all callers and the window is stamped at attempt start;
    measured 10 concurrent → 1 reload.
38. **Minor — an invalid `expires_in` was silently replaced by an hour.** A
    present-but-invalid lifetime now fails the exchange, and a missing lifetime is
    treated as short-lived rather than long-lived, so an already-dead token is
    never cached.
39. **Minor — a token without `kid` only tried the first key, and one
    unimportable entry aborted every token resolving to it.** The store now
    returns all candidates for a kid-less token and skips entries that fail to
    import.
40. **Minor — a key-endpoint outage was reported as a bad credential.** Key-set
    failures are now classified as `unavailable` and answered with `UNAVAILABLE`,
    so a client does not discard a valid session during a Google incident.
41. **Minor — comments asserted properties the code did not implement.** The
    claim validator is now built per verification with a signature flag that only
    the preceding check can set, so removing that check fails closed; the
    "stays in the log" claim is now true (rejections log a fixed reason
    server-side), and log output was checked to contain no credential, key,
    assertion or token.
42. **Minor — missing coverage.** Added: concurrent cold-cache load de-duplication,
    concurrent unknown-`kid` single reload, kid-less and unimportable entries,
    invalid and missing lifetimes, outage classification, configuration isolation,
    credential never echoed, and retired-key expiry.

Milestone 3 recheck raised three more, all fixed:

43. **Minor — unknown/retired `kid` was misclassified as an outage** by the
    finding-40 fix. `SigningKeyError` now carries an explicit `unavailable` flag
    set only by key-set failures; a forged or retired key id is `UNAUTHORIZED`
    again, with a test asserting it.
44. **Minor — the cold/expired path bypassed the retry window**, so a failing key
    endpoint still cost one outbound fetch per request. The same window now bounds
    it: one attempt per window, failing closed without using a stale key.
45. **Minor — the cache key joined fields with a delimiter** and ignored injected
    transports, so two configurations could in principle collide and an injected
    client could be observed by another dispatcher. The key is now structural
    (`JSON.stringify`), and a dispatcher that injects a transport or clock gets a
    private cache unless it explicitly asks for the shared one.

## Milestone 4 evidence (Workbook integration and parity, tasks 2.5–2.6)

* `src/worker/workbook/sheets.ts` — the Sheets v4 REST boundary: schema-derived
  ranges only, shared response validation, no caller-supplied range or rendering
  option; `src/worker/workbook/snapshot.ts` — the read-only replay surface, where
  an unfetched tab is absent rather than empty and every mutator throws;
  `src/worker/staging.ts` — the composition, one runtime per request.
* `src/server/workbook/batch-read.ts` exports `requestedRange`,
  `batchGetRequestForTabs` and `parseBatchGetResponse` so both runtimes accept
  exactly the same payloads; `WorkbookTabName` keeps the tab allowlist closed.
* Commands and outcomes: `npm test` 34 files / 194 tests; `npm run test:worker`
  6 files / 98 tests in workerd; `npm run check` clean; `npm run build` passes
  including the Apps Script bundle audit; `npm run build:worker` 1300.46 KiB /
  236.82 KiB gzip; `openspec validate validate-worker-backend-feasibility
  --strict` valid.
* Mutation checks run during review: forcing the snapshot decode zone to UTC
  fails four Worker tests (including the workbook-zone variant), and breaking
  `centerUserCodec`'s `volunteerId`/`centerIds` parsing fails the identity
  differential — so the parity tests are not vacuous.

Milestone 4 findings and how each was resolved:

46. **Minor — the snapshot digest claimed SHA-256 but was a 32-bit FNV-1a over
    only the fetched tabs.** It is now a real SHA-256 over every schema tab with
    absent tabs marked, and it is computed by the harness rather than on every
    routed request, because nothing on the routed path recorded it and it cost
    CPU against the 5 ms threshold.
47. **Minor — the DST transition was not exercised through the Worker.** Added a
    session on 2026-11-01 whose ambiguous 01:30 local time is asserted together
    with its decoded instant, plus a post-transition differential run.
48. **Minor — the malformed-row variant had no coverage.** Added a variant with a
    non-numeric revision on a *session* (so the coercion is visible in the served
    projection as `revision: 0` with the row retained) and an unknown session kind
    that must never be schedulable.
49. **Minor — the omitted-trailing-cells row was not modelled or asserted.** One
    volunteer now has genuinely blank `source`/`updatedAt`, its REST row stops at
    the last populated cell, and the padding is exercised through the shared
    validator.
50. **Minor — `session.me` was asserted against literals.** It is now compared
    with the existing runtime for all four roles.
51. **Minor — the read-only guarantee was only partly tested.** Every mutator, the
    partial-plan batch reader and the immutable properties facade now have
    assertions that fail if a throw is removed.
52. **Minor — exporting the helpers widened the tab allowlist to `string`.** A
    closed `WorkbookTabName` union restores the compile-time check; an
    out-of-schema name now fails to compile.
53. **Minor — two runtimes were built per request.** One runtime now serves both
    the authorization read and the handlers, with the fetched map filled after
    authorization.
54. **Minor — the `UNAUTHORIZED` envelope discloses the Users row count.** Shared,
    pre-existing behaviour reachable only with a valid ID token. Recorded as an
    explicit follow-up under task 4.3 with its measured evidence rather than
    changed here, because the Apps Script path pins the same detail.

Milestone 4 recheck residuals, all fixed:

55. **Partial — the digest was still a function of the fetched subset and was
    unreachable on the routed path.** Removed from the request path; the harness
    computes it over a fully primed snapshot.
56. **Partial — the DST case could not fail if the decode zone were dropped.**
    Added a workbook-zone variant (workbook Chicago, scheduling New York) that
    fails when the snapshot zone is ignored; verified by mutation.
57. **Partial — the short row truncated populated cells.** The row is now
    faithfully short, with the blank cells genuinely blank in both renderings.
58. **Partial — `setProperty` was unasserted.** The immutable properties facade is
    now asserted directly.
59. **New — the per-request digest was stale after a failed request.** Removed
    with the digest from the request path.
60. **New — the short-row fixture diverged from the legacy path on volunteer
    timestamps.** Fixed by making the omitted cells blank in both renderings.

## Milestone 5 evidence (Release readiness, task 3.1)

* `evidence/staging-manifest.md` — resource isolation, the complete binding set,
  provisioning, deployment, rollback, the Pages trigger analysis, the
  measurement tooling and a pre-deployment checklist.
* `scripts/staging/measure-worker.mjs` (+ `.d.mts`) — the paced harness: staging
  target guard, read budget, cold/warm phases, the contract's failure taxonomy,
  Worker-reported read counts and snapshot digest, achieved rates and observed
  concurrency, and an append-only attempt log.
* `scripts/staging/browser-probe.{html,js}` — real-browser transport and wall-time
  probe with four requests in flight and a staging-host guard.
* `.github/workflows/validate.yml` (new, push and PR, deploys nothing) and
  `.github/workflows/pages.yml` (manual dispatch only); `.gitignore` now covers
  `staging-local/`; `wrangler.jsonc` lists every staging binding as a
  fail-closed placeholder; `docs/testing.md` and `docs/deployment.md` corrected.
* Commands and outcomes: `npm test` 35 files / 207 tests; `npm run test:worker`
  6 files / 99 tests; `npm run check` clean; `npm run build` passes including the
  Apps Script bundle audit; `npm run build:worker` 1300.65 KiB / 237.01 KiB gzip;
  `openspec validate --strict` valid; `git check-ignore staging-local/…` matches;
  the harness `--plan` path validates a manifest and sends nothing.

Milestone 5 findings and how each was resolved (mandatory release gate):

61. **Blocker — the deployment procedure could not execute.** `wrangler.jsonc`
    supplied only the origin binding for `env.staging`, so a documented deploy
    would have produced an endpoint refusing every request. Every binding is now
    present as a `REPLACE_…` placeholder that fails validation, so a deploy
    cannot omit one and a surviving placeholder refuses rather than guesses.
62. **Blocker — the documented rollback was wrong.** `wrangler versions deploy`
    without a version spec does not roll back; the manifest now names the version
    id, uses `wrangler versions list` to find it, and states that only
    `wrangler delete` disables serving.
63. **Major — the harness could not produce the numbers the contract requires.**
    Added cold/warm separation with a sufficiency flag, the contract's seven-way
    failure taxonomy, Worker-reported Sheets reads and snapshot digest (published
    as response headers and consumed by the harness), achieved requests and reads
    per minute, observed maximum in-flight concurrency, and an append-only
    attempt log so an aborted run keeps its evidence.
64. **Major — the browser probe was sequential** and so could never satisfy the
    ≥ 3-in-flight wall-time rule, and it did not record the point of presence.
    It now drives four requests in flight and records `cf-ray`.
65. **Major — the workflow split left two canonical docs false.** `docs/testing.md`
    and `docs/deployment.md` now describe the validation workflow and the
    manual-only Pages workflow, and tasks.md records the re-read for 4.3.
66. **Major — neither tool refused a production target.** The harness requires a
    staging-shaped `*.workers.dev` host unless a host is named with
    `--allow-host`, and the probe refuses anything that is not a
    staging-shaped host.
67. **Minor — `GOOGLE_SERVICE_ACCOUNT_EMAIL` was listed as a plain variable but
    set as a secret.** The table now marks it and says why.
68. **Minor — the fixture-loading identity was unspecified.** The manifest names
    the mechanism, its scope, and when its access is removed.
69. **Minor — the deployment procedure omitted the snapshot step and secret
    ordering.** Added as step 0 and an explicit pre-serve requirement, plus a
    post-deploy verification step.
70. **Minor — the path guard only checked for `..`.** Report and credential paths
    are now resolved and must stay inside `staging-local/`, with tests for an
    absolute path and a traversal path.
71. **Minor — the recorded test counts were stale.** Corrected to the measured
    counts in the manifest and this record.

## Blockers and open questions

* Staging resources and authorized test identities are unassigned. Tasks 3.2–4.3
  cannot start without explicit approval; local work through 3.1 is independent.
* `web_search` returned HTTP 401 during this session; external facts were taken
  from direct page fetches instead.
* Pages currently deploys on every push (`.github/workflows/pages.yml`), so no
  push may happen until task 3.1 separates validation from deployment.

## Milestone 6 checkpoint

`evidence/milestone-6-checkpoint.md` records the state, the concrete approval
request (resources and one deployment), the resume instructions and the known
limitations. Tasks 3.2–4.3 remain unchecked: no threshold has been evaluated and
no number in this change is a measurement of the deployed topology.

## Tooling limitation: the j-space ship gate could not be closed

The independent delivery reviews are recorded in this change
(`evidence/final-delivery-review.md`, `-2.md`, `-3.md`, `-4.md`, `-5.md`); the
third, fourth and fifth all accepted the delivered state, and the fifth
acceptance is recorded in the j-space controller against the current report.

The controller's `check --stage ship` still blocks, and the block is bookkeeping
rather than substance. Each accepted review requires a fresh report whenever any
pinned artifact changes, and each report or agent retirement changes the
integration scope and demands another report. One-shot verifier agents cannot
sustain that cycle: they cannot consume the context broadcast that a report
creates for them, and retiring one invalidates the acceptance it just recorded.
Closing it would require either a long-lived registered reviewer or running the
reviewer's own pulse on its behalf, which the controller explicitly forbids and
this record will not fake.

The substantive gate is met: three independent read-only reviewers reproduced
every command, verified the goal clause by clause, and accepted the delivery.

## Next action

Await approval for the resources and the staging deployment described in
`evidence/staging-manifest.md`; on approval, resume at its pre-deployment
checklist and then run the milestone-6 measurement tasks.
