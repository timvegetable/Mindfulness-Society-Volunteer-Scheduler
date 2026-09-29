# Prerequisite inventory: Script Properties, revisions, API writers, maintenance paths

Date: 2026-09-29. Task 1.1 evidence (source-linked inventory). Sources were read at
commit `6905445`; the later `33188b8` ("Pin the portable control schema, recovery rules
and reader read plan") changed no source file, so every source link below is valid at
HEAD `33188b8`, where `design.md`'s task 1.2–1.3 pinning now cites this inventory.

Scope: every Script Property the code reads or writes, every revision consumer and
producer, every API operation and whether it writes, and every maintenance, loader or
direct-write path that can initialize, migrate, repair or write rows outside the
ordinary API. Every entry below was established by **reading** the cited file; a grep
hit alone was not accepted as evidence of behaviour. Sanitized: no spreadsheet ids,
credential values, addresses or private configuration values appear here.

Method (exact searches, so the coverage statement in section 5 is checkable):

- `PropertiesService|getProperty|setProperty|deleteProperty|getProperties|getScriptProperties|getDocumentProperties|getUserProperties` over `**/*.ts`.
- The property names found above (`DATA_REVISION`, `SCHEDULING_INPUT_REVISION`,
  `TAB_REVISION`, `WRITE_ENABLED`, `OAUTH_AUDIENCE`, `PUBLIC_OAUTH_CLIENT_ID`,
  `MIGRATION_ACTOR`, `TIME_ZONE`, `DISPLAY_INCREMENT_MINUTES`, `OPERATING_HOURS_*`,
  `ADMINISTRATOR_RECIPIENTS`, `WHENISGOOD_ENDPOINT`) across `*.mjs`, `*.js`, `*.json`,
  `*.yml`, `*.md`, `*.html`, then reading each hit.
- `.replace(|.upsert(|saveRun|saveMapping|replaceAuthoritative|replaceProvenance|appendAudit(` over `src/**/*.ts` to enumerate repository write call sites.
- `setProperty|deleteProperty|PropertiesService|values.update|values.append|batchUpdate|spreadsheets.values|ScriptApp|clasp|deployments|wrangler` over `scripts/`.
- Reachability greps for the writer classes that are exported but never constructed
  (`CenterDirectoryService`, `CenterUserService`, `AdministratorRosterService`).

## 1. Script Properties inventory

Fourteen keys or key patterns are read or written anywhere in the tree. The five
classification categories are the ones the design fixes at `design.md:31` (portable
domain policy, deployment identity/configuration, secret, cache, operational gate).
**Those five do not name the three revision counters.** The design's task 1.3 table
(`design.md:116-132`) resolves this by giving them their own category,
"Revision authority" (`design.md:125-127`); this inventory uses that label so the two
documents agree. Two entries below are outside that table by construction and are marked
where they appear: the private stash key, which exists only in gitignored procedure
material, and the Script Cache keys, which are not Script Properties at all.

| Key / pattern | Read at | Written at | Classification |
| --- | --- | --- | --- |
| `DATA_REVISION` | `src/server/main.ts:101`; `src/server/runtime.ts:471`; `src/server/main.ts:172-178` (parity revision list); `src/worker/staging.ts:313` (staging facade) | `src/server/main.ts:108` (`advance`), reached only from `src/server/integration/dispatcher.ts:208` | Revision authority (migration source; `design.md:125`) |
| `SCHEDULING_INPUT_REVISION` | `src/server/runtime.ts:123` (constant `src/server/runtime.ts:119`); `src/server/runtime.ts:445`; `src/server/runtime.ts:518`, `:520`, `:548`, `:560`; `src/server/main.ts:174` | `src/server/runtime.ts:128`, invoked from `src/server/runtime.ts:140` (the `RevisionStore` setter built at `src/server/runtime.ts:179`) | Revision authority (migration source; `design.md:125`) |
| `TAB_REVISION_<TabName>` | `src/server/runtime.ts:135` (key built at `src/server/runtime.ts:132`); `src/server/runtime.ts:444-445`; `src/server/main.ts:175-176` | `src/server/runtime.ts:139` | Revision authority (per-tab optimistic-concurrency counter; `design.md:127`) |
| `WRITE_ENABLED` | `src/server/main.ts:252` (mutation admission); `:152` (parity preflight); `:194`; `:330` (loader); `:353` (`describeSignIn`) | Nothing in the tree writes it. Set by a human in Project Settings, or by the gitignored private procedures below | operational gate |
| `OAUTH_AUDIENCE` | `src/server/main.ts:244` (throws when absent, `:245`); `:350`, `:351` | — | deployment identity/configuration |
| `PUBLIC_OAUTH_CLIENT_ID` | `src/server/main.ts:352` only (advisory comparison with `OAUTH_AUDIENCE`) | — | deployment identity/configuration |
| `MIGRATION_ACTOR` | `src/server/main.ts:333` (loader audit actor; default `'migration'`) | — | deployment identity/configuration |
| `TIME_ZONE` | `src/server/runtime.ts:65`; `src/server/main.ts:355` | — | portable domain policy (default `America/New_York`, `src/server/runtime.ts:58`) |
| `DISPLAY_INCREMENT_MINUTES` | `src/server/runtime.ts:63`; `src/server/main.ts:361` | — | portable domain policy (default `30`, `src/server/runtime.ts:59`; accepted range `src/server/runtime.ts:66`) |
| `OPERATING_HOURS_START` | `src/server/runtime.ts:68`; `src/server/main.ts:364` | — | portable domain policy (default `09:00`, `src/server/runtime.ts:60`) |
| `OPERATING_HOURS_END` | `src/server/runtime.ts:69`; `src/server/main.ts:364` | — | portable domain policy (default `21:00`, `src/server/runtime.ts:60`) |
| `ADMINISTRATOR_RECIPIENTS` | `src/server/runtime.ts:449` (parsed by `listField`, `src/server/runtime.ts:97-107`) | — | deployment identity/configuration (notification routing; `design.md:131`) |
| `WHENISGOOD_ENDPOINT` | `src/server/runtime.ts:464`; `src/server/main.ts:365` | — | deployment configuration / integration endpoint — **possibly secret-bearing; unresolved (section 6)** |
| `ADMINISTRATOR_RECIPIENTS_STASH_5_7` | gitignored `srikar-task-5.7/NotificationTestProperty.gs:48`, `:83` | gitignored `srikar-task-5.7/NotificationTestProperty.gs:57`, deleted `:78` (constant `:19`) | deployment configuration (temporary stash written by a private, untracked procedure; **absent from the design's task 1.3 table**) |

Notes that matter for the classification work in task 1.3:

- No service-account key, signing material or other secret is read from Script
  Properties anywhere in the tree. The only secret-shaped material in the system is the
  Worker slice's service-account key, which arrives as a Cloudflare binding/secret
  (`src/worker/config.ts:87`, `:113-114`), never as a property. The Worker's
  `ScriptProperties` facade is a frozen map that throws on write
  (`src/worker/config.ts:189-192`).
- `TAB_REVISION_*` exists for exactly the 13 tabs that have a repository
  (`src/server/runtime.ts:201-213`, confirmed by counting the `make(tabDefinition(...))`
  rows). `Settings` (`src/server/workbook/schema.ts:22`) and `AuditLog`
  (`src/server/workbook/schema.ts:23`) have no repository, so no
  `TAB_REVISION_Settings` or `TAB_REVISION_AuditLog` is ever read or written. Audit rows
  are appended directly (`src/server/runtime.ts:145-157`).
- `production.local.json` and its schema keys (`environment`, `writeEnabled`, `sheetId`,
  `sheetOwnerEmail`, `oauthAudience`, …; `config/production.schema.json`) are local
  deployment inputs, not Script Properties, and are explicitly not authority for live
  state (`docs/operations.md:9`).

State that is **not** a Script Property and must not be conflated with one:

| Store | Key | Read / write | Classification |
| --- | --- | --- | --- |
| Apps Script Script Cache | `insight-dataset:<fnv-hash>` (`src/server/insights/cache-repository.ts:18`, `:116`) | read `:120`; written `:137-149`; TTL 300 s (`:19`, `:140`) | cache |
| Apps Script Script Cache | `verified-claims:<sha256-of-credential>` (`src/server/integration/claim-cache.ts:31`, `:76`) | read `:77`; written `:84`; TTL ≤ 300 s and ≤ credential expiry (`:28`, `:83`) | cache (contains no credential; the digest is the key, `:15`) |

## 2. Revision consumers and producers

### 2.1 `DATA_REVISION` (global API revision)

- Read: `src/server/main.ts:101` (the dispatcher's `RevisionSource.current`),
  `src/server/runtime.ts:471` (`globalRevision()`, used by every projection that reports
  `revision`), `src/server/main.ts:172-178` (parity snapshot),
  `src/worker/staging.ts:313` (staging dispatcher, `current` only — no `advance`).
- Written: `src/server/main.ts:108`, called once per admitted mutating dispatch from
  `src/server/integration/dispatcher.ts:208`. `advance` is only invoked for
  `policy.mutating` operations.
- The API returns it to clients under the name `revision` in two places: as the
  top-level `ApiResponse.revision` on a mutating response (post-increment,
  `src/server/integration/dispatcher.ts:209`) and inside the payload as `revision` (the
  pre-increment current value read by `globalRevision()` at, for example,
  `src/server/runtime.ts:517`, `:580`, `:503`, `:643`).
- It is also compared, never written, by the batched-read stability check
  (`src/server/runtime.ts:444-448`).

### 2.2 `SCHEDULING_INPUT_REVISION` (monotonic scheduling-input counter)

- Defined at `src/server/runtime.ts:119`; the four tabs that compose it are enumerated at
  `src/server/runtime.ts:120`.
- Readers: `src/server/runtime.ts:123` (`schedulingInputRevision`, with the same
  parse-guard as `DATA_REVISION`), `:518`/`:520` (volunteer dashboard), `:548`/`:560`
  (preview/rerun input revision), `:375` (schedule `stale` verdict), `:445` (batch
  stability), `src/server/main.ts:174` (parity).
- Writers: `src/server/runtime.ts:128` only, reached through the `RevisionStore` commit
  callback installed at `src/server/runtime.ts:179` for scheduling-input tabs
  (`src/server/runtime.ts:178`). One increment per committing repository, i.e. **per
  tab commit, not per operation**:
  - `volunteer.availability.recurring.update` commits `RecurringAvailability` and
    `Volunteers` → **+2** (`src/server/self-service/availability.ts:315`, `:325`).
  - `admin.center.candidate.confirm` commits one `Sessions` row per occurrence inside a
    loop → **+N for N occurrence dates** (`src/server/centers/service.ts:639-641`).
  - `admin.import.whenIsGood.promote` commits `RecurringAvailability` once → +1
    (`src/server/imports/service.ts:287`); the `ImportedAvailability` and `Imports`
    commits in the same transaction do not move it.
  - `volunteer.assignment.cancel` commits `AvailabilityExceptions`, `Assignments` and
    (unconditionally, through promotion) `Backups` → **+1 only**, because the exception
    tab is the sole scheduling input among them
    (`src/server/self-service/cancellation.ts:319-320`, `:207`; input set at
    `src/server/runtime.ts:120`).
  - `loadMigrationWorkbook` commits `Volunteers` and `Sessions` → **+2** with no
    dispatcher involvement (`src/server/workbook/loader.ts:171-173`).
- The API returns it as `inputRevision` (`src/server/runtime.ts:366` for Schedule,
  `:518` for the volunteer dashboard) and derives `stale` from it
  (`src/server/runtime.ts:375`, `:520`).

### 2.3 `TAB_REVISION_<TabName>` (per-tab optimistic-concurrency counter)

- Key built at `src/server/runtime.ts:132`; read at `:135`; written at `:139`; the
  `get()` synthesises `changedAt`/`changedBy`/`source` per read (`:136`), so those three
  fields are not durable state.
- Incremented exactly once per repository commit
  (`src/server/workbook/repository.ts:215-217`), whatever the operation.
- Read for admission by the repository itself (`src/server/workbook/repository.ts:214`)
  and batched for the read-stability check (`src/server/runtime.ts:444-445`,
  `src/server/main.ts:175-176`).
- Never returned to clients: the only reads of `revision()` that reach a response are
  the server-side expected values in section 2.6; no projection includes a tab counter.
  This confirms `docs/operations.md:56` in source.

### 2.4 The scheduling-output revision (lives in scheduling rows)

- Producer: `src/server/scheduling/publication.ts:163` (`outputRevision =
  currentRevision() + 1`) inside `stageRun`, which stamps every staged assignment and
  backup row (`:192-193`); `src/server/scheduling/publication.ts:292` seeds the
  scheduler's `scheduleRevision` with the same next value. `currentRevision` is the
  in-memory pointer (`:106`) seeded from the previous completed run
  (`src/server/runtime.ts:475`).
- Persisted to rows (run, assignments, backups) by `admin.schedule.rerun`:
  `SchedulingRuns.upsert` at
  `src/server/runtime.ts:568`, after `Assignments.replace` (`:566`) and
  `Backups.replace` (`:567`). Publication is otherwise in-memory
  (`src/server/scheduling/publication.ts:208-226`); `admin.schedule.preview` never
  persists it (`src/server/runtime.ts:545-557`).
- Consumers: latest-completed-run selection (`src/server/runtime.ts:296-298`); the
  assignment/backup row filter `scheduleRevision === outputRevision`
  (`src/server/runtime.ts:343`, `:350`); the `scheduleRevision` and `outputRevision`
  projection fields (`:367-368`, `:519`); the Insights source tuple
  (`src/server/runtime.ts:384-394`, `assignmentRevision`); backup promotion copies it
  onto the promoted assignment (`src/server/self-service/cancellation.ts:192`).

### 2.5 Counter advancement relative to the row write and the audit append

This is the ordering the design's pending-marker protocol replaces; the exact sequence is:

1. Read and compare the tab counter — `src/server/workbook/repository.ts:213-214`.
2. Compute the next counter in memory — `:215`.
3. Write rows — `setValues` at `src/server/workbook/repository.ts:168`, trailing-row
   clear at `:169-172`, request snapshot update at `:175`.
4. Append the audit row — `src/server/workbook/repository.ts:176`, which calls the
   runtime audit writer (`src/server/runtime.ts:145-157`) and therefore
   `AuditLog.appendRow`.
5. **Only now** store the tab counter — `src/server/workbook/repository.ts:217` →
   `src/server/runtime.ts:139`; and, for a scheduling-input tab, the callback at
   `src/server/runtime.ts:140` runs the increment at `:128`.
6. `DATA_REVISION` is advanced last of all, after the handler returns —
   `src/server/integration/dispatcher.ts:205-209`.

Consequences, stated plainly because tasks 1.2/3.1 depend on them:

- Rows are visible before any counter that describes them, and `DATA_REVISION` trails
  every other counter. An interrupted multi-tab mutation therefore leaves rows changed
  and counters partially advanced — the condition the design describes at
  `design.md:3` and `design.md:35`, and the reason equal counters cannot prove
  completion (`docs/subsystems/integration.md:31`).
- The rollback path inside `admin.schedule.rerun` re-commits the previous rows
  (`src/server/runtime.ts:570-571`) and therefore advances the `Assignments`/`Backups`
  counters a second time and appends further audit rows; it is not a counter rollback.
- Import preview writes a tab counter with no `DATA_REVISION` movement at all — see
  section 3.1.
- There is exactly one script lock in production, the dispatcher's
  (`LockService.getScriptLock()` read at `src/server/main.ts:115-116`, acquired at
  `src/server/integration/dispatcher.ts:184`). The repository-level `withScriptLock`
  helper (`src/server/workbook/repository.ts:21`, applied at `:220`) is inert: the
  `RevisionStore` built for production passes no `lock`
  (`src/server/runtime.ts:131-143`). Any maintenance path that bypasses the dispatcher
  therefore runs unlocked even though a lock helper exists.

### 2.6 Which check compares what

| Check | Compares | Site |
| --- | --- | --- |
| Dispatcher global revision | client `expectedRevision` vs `DATA_REVISION`, **only when supplied** | `src/server/integration/dispatcher.ts:189-192` |
| Repository tab revision | expected tab revision (server-read in production) vs current tab counter | `src/server/workbook/repository.ts:214` |
| Cancellation assignment revision | server-read tab revision vs current tab counter | `src/server/self-service/cancellation.ts:294` |
| Cancellation exception revision | same | `src/server/self-service/cancellation.ts:299-300` |
| Availability/exception services | `expectedRevision` required to be present, then used as the tab expectation | `src/server/self-service/availability.ts:175-176`, `:227-231`, `:335` |
| Center candidate confirm | server-read candidate revision vs current tab counter | `src/server/centers/service.ts:593`, `:647`; caller value from `src/server/runtime.ts:677` |
| Batched-read stability | `DATA_REVISION`, `SCHEDULING_INPUT_REVISION` and the plan's tab counters, before vs after hydration | `src/server/runtime.ts:444-448` |
| Schedule staleness | latest completed run's `inputRevision` vs `SCHEDULING_INPUT_REVISION` | `src/server/runtime.ts:375`, `:520` |
| Insights freshness | four-field tuple `assignmentRevision`/`assignmentRowsRevision`/`eligibilityRevision`/`availabilityRevision` | `src/server/runtime.ts:384-394`; marking `src/server/insights/store.ts:76-86`; cache compare `src/server/insights/cache-repository.ts:132` |
| Editor parity | revision list unchanged and the gate stayed `false` | `src/server/main.ts:193-194` |

**Finding (task 1.1):** the client-supplied `expectedRevision` is compared *only* against
`DATA_REVISION` at the dispatcher. Every per-tab expectation that reaches a service check
is read from Script Properties inside the same request
(`src/server/runtime.ts:525`, `:529`, `:533`, `:677`), and `HandlerContext.expectedRevision`
(`src/server/integration/dispatcher.ts:90`, set at `:202`) is consumed by no handler, so
a stale client cannot trip a tab-level `STALE_REVISION` through any current operation.

## 3. API writer inventory

Registry and policies: `src/server/integration/request-policy.ts:94-111`. Dispatch rules:
`src/server/integration/dispatcher.ts:158-220`. The live write gate is consulted once per
request, not per operation: `WRITE_ENABLED === 'true'` decides whether a write lock is
built at all (`src/server/main.ts:252-253`), and a policy-mutating request without a
revision source or lock is refused `UNAVAILABLE` before any handler runs
(`src/server/integration/dispatcher.ts:176`). Read-only dispatch (`doGet`) additionally
rejects every non-`readOnly` policy (`src/server/integration/adapters.ts:103-106` →
`src/server/integration/dispatcher.ts:222-224` → `src/server/integration/request-policy.ts:266-268`).

| # | Operation | Policy `mutating`/`readOnly` | `expectedRevision` flag | What actually writes | Lock | Gate | Revisions advanced |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `session.me` | false / true (`request-policy.ts:95`) | false | nothing; `src/server/runtime.ts:505` | no | no | none |
| 2 | `volunteer.dashboard` | false / true (`:96`) | false | nothing; `src/server/runtime.ts:506-522` | no | no | none |
| 3 | `volunteer.availability.recurring.update` | true / false (`:97`) | true | `RecurringAvailability.replace` + `Volunteers.upsert` (`src/server/self-service/availability.ts:315`, `:325`) | script lock | `WRITE_ENABLED` | `TAB_REVISION_RecurringAvailability`, `TAB_REVISION_Volunteers`, `SCHEDULING_INPUT_REVISION` ×2, `DATA_REVISION` |
| 4 | `volunteer.availability.exception.create` | true / false (`:98`) | true | `AvailabilityExceptions.upsert` (`src/server/self-service/availability.ts:335`) | script lock | `WRITE_ENABLED` | `TAB_REVISION_AvailabilityExceptions`, `SCHEDULING_INPUT_REVISION`, `DATA_REVISION` |
| 5 | `volunteer.assignment.cancel` | true / false (`:99`) | true | `AvailabilityExceptions.upsert` + `Assignments.upsert` (`src/server/self-service/cancellation.ts:319-320`); promotion runs on every cancellation (`:330`) and always replaces `Backups` (`:207`), adding a second `Assignments.upsert` when a backup is promoted (`:204`) | script lock | `WRITE_ENABLED` | `TAB_REVISION_AvailabilityExceptions` +1, `TAB_REVISION_Assignments` +1 (+1 more on promotion), `TAB_REVISION_Backups` +1, `SCHEDULING_INPUT_REVISION` +1, `DATA_REVISION` |
| 6 | `admin.schedule.read` | false / true (`:100`) | false | nothing (`src/server/runtime.ts:535-542`) | no | no | none |
| 7 | `admin.schedule.preview` | false / true (`:101`) | false | nothing; in-memory calculation (`src/server/runtime.ts:545-557`) | no | no | none |
| 8 | `admin.schedule.rerun` | true / false (`:102`) | true | `Assignments.replace`, `Backups.replace`, `SchedulingRuns.upsert` (`src/server/runtime.ts:566-568`) | script lock | `WRITE_ENABLED` | those three tab counters, `DATA_REVISION`; the failure path re-commits and re-advances `Assignments`/`Backups` (`:570-571`) |
| 9 | `admin.import.whenIsGood.preview` | **false / true (`:103`)** | false | **`Imports.upsert` via `saveRun`** (`src/server/imports/service.ts:227`; failure path `:327`) through `src/server/runtime.ts:579`, unless the run is already settled and the idempotent early return applies (`service.ts:203-205`) | **no** | **no** | `TAB_REVISION_Imports` only when a row was written; `DATA_REVISION` unchanged |
| 10 | `admin.import.whenIsGood.promote` | true / false (`:104`) | true | `RecurringAvailability` + `ImportedAvailability` replaces and `Imports` upserts (`src/server/imports/service.ts:287-288`, `:266`), plus the staging write at `:227` when the run is re-staged | script lock | `WRITE_ENABLED` | `TAB_REVISION_RecurringAvailability`, `TAB_REVISION_ImportedAvailability`, `TAB_REVISION_Imports` (×1, or ×2 when staging also wrote), `SCHEDULING_INPUT_REVISION`, `DATA_REVISION` |
| 11 | `admin.import.mapping.upsert` | true / false (`:105`) | true | `ImportMappings.upsert` (`src/server/imports/matching.ts:135` → `src/server/runtime.ts:237`) and, when an unresolved staged run exists, re-staging `Imports` (`src/server/imports/service.ts:239-241` → `:227`) | script lock | `WRITE_ENABLED` | `TAB_REVISION_ImportMappings`, `TAB_REVISION_Imports` when re-staged, `DATA_REVISION` |
| 12 | `admin.insights.read` | false / true (`:106`) | false | Script Cache only, and only when a stored dataset is marked stale (`src/server/insights/store.ts:84` → `src/server/insights/cache-repository.ts:146`) | no | no | no Sheet revision; cache entry rewritten |
| 13 | `admin.insights.refresh` | true / false (`:107`) | true | Script Cache write (`src/server/insights/store.ts:148` → `cache-repository.ts:146`); no Sheet row, no audit row | script lock | `WRITE_ENABLED` | `DATA_REVISION` only |
| 14 | `center.candidate.read` | false / true (`:108`) | false | nothing (`src/server/runtime.ts:632-644`) | no | no | none |
| 15 | `center.candidate.update` | true / false (`:109`) | true | `CandidateSchedules.upsert` (`src/server/centers/service.ts:407`, `:453`) | script lock | `WRITE_ENABLED` | `TAB_REVISION_CandidateSchedules`, `DATA_REVISION` |
| 16 | `admin.center.candidate.confirm` | true / false (`:110`) | true | one `Sessions.upsert` per occurrence date (`src/server/centers/service.ts:639-641`) plus `CandidateSchedules.upsert` (`:647`) | script lock | `WRITE_ENABLED` | `TAB_REVISION_Sessions`, `TAB_REVISION_CandidateSchedules`, `SCHEDULING_INPUT_REVISION` ×N, `DATA_REVISION` |

Nine policies are mutating and declare `expectedRevision: true` (`request-policy.ts:97-99`,
`:102`, `:104-105`, `:107`, `:109-110`); seven are read-only (`:95-96`, `:100-101`,
`:103`, `:106`, `:108`).

Writer services that are exported but unreachable from the API: `CenterDirectoryService`
and `CenterUserService` (`src/server/centers/service.ts:501`, `:547`) are constructed by
nothing in `src/` (verified by reading every importer of the module), and
`AdministratorRosterService` (`src/server/imports/roster.ts:40`) is exported through
`src/server/imports/index.ts:2` but the production runtime never builds it — only
`requireAdministrator` is imported elsewhere (`src/server/imports/service.ts:3`,
`src/server/imports/matching.ts:2`). No dispatcher operation reaches them.

### 3.1 Recorded defect: import preview is classified non-mutating while it persists staged runs — confirmed

- Policy: `src/server/integration/request-policy.ts:103` — `mutating: false`,
  `readOnly: true`, `expectedRevision: false`.
- Handler: `src/server/runtime.ts:576-581` calls
  `imports.stageFromFetcher(...)`, which reaches `stage` and `this.repository.saveRun(run)`
  at `src/server/imports/service.ts:227`; the failure path writes at
  `src/server/imports/service.ts:327`. `saveRun` upserts a row
  (`src/server/runtime.ts:230`) and therefore commits `TAB_REVISION_Imports`
  (`src/server/workbook/repository.ts:217`).
- Because the policy is non-mutating, the dispatcher takes no lock and advances no
  `DATA_REVISION` (`src/server/integration/dispatcher.ts:184`, `:188`, `:208`), and the
  read-only dispatch path admits it (`request-policy.ts:266-268`).
- The client never sends a revision for it: `src/client/api.ts:336-338` takes only
  `resultsCode` and `credential` (contrast `src/client/api.ts:340-342`).
- This matches the recorded gap at
  `openspec/changes/make-workbook-state-portable/tasks.md:43` and the documented
  limitation at `docs/subsystems/integration.md:17` and `docs/operations.md:7`, and it is
  the write the archived feasibility contract already found
  (`openspec/changes/archive/2026-09-29-validate-worker-backend-feasibility/evidence/experiment-contract.md:72-81`).

### 3.2 Does the dispatcher reject a missing `expectedRevision`? No — `architecture.md` is right

Verified in source, not taken from the document:

- The envelope field is optional: `src/shared/domain.ts:102`
  (`expectedRevision: z.number().int().nonnegative().optional()`), and
  `expectedRevisionFrom` returns `undefined` for an absent value
  (`src/server/integration/request-policy.ts:181-187`).
- The policy flag exists (`src/server/integration/request-policy.ts:42`, values at
  `:95-110`) but **has no reader in the tree**: the dispatcher obtains
  `const expectedRevision = expectedRevisionFrom(...)` at
  `src/server/integration/dispatcher.ts:175` and compares it only when it is not
  `undefined` (`:189`). No other module reads `policy.expectedRevision`.
- The only admission refusals that can catch a missing revision are the
  `UNAVAILABLE` checks at `src/server/integration/dispatcher.ts:176` and `:194-197`,
  neither of which inspects the revision.
- `HandlerContext.expectedRevision` (`src/server/integration/dispatcher.ts:90`, `:202`)
  is never read by a handler, so omission is not uniformly rejected downstream either.

So the claim at `docs/architecture.md:71` ("the dispatcher currently does not reject an
omitted value solely from that field") is correct as written, as is
`docs/subsystems/integration.md:13`.

## 4. Maintenance, loader and direct-write paths

Editor entry points are the eight trampolines emitted for the Apps Script project
(`scripts/expose-appsscript.mjs:5-14`): `doGet`, `doPost`, `initializeWorkbook`,
`checkWorkbookSchema`, `validateMigrationWorkbook`, `loadMigrationWorkbook`,
`describeSignIn`, `compareAdvancedReadParity`. In the table, "script lock" means the
dispatcher's Apps Script script lock (section 2.5); no other path in the tree acquires
one.

| Path | What it writes | Script lock? | Live gate? | Advances revisions? |
| --- | --- | --- | --- | --- |
| Web app `doPost`/`doGet` (`src/server/main.ts:382-400` → `src/server/integration/adapters.ts:103-110`) | only through dispatched operations (section 3) | yes for policy-mutating operations only (`src/server/integration/dispatcher.ts:184`, lock built at `src/server/main.ts:114-122`) | yes, via the lock's construction (`src/server/main.ts:252-253`) | via repositories and the dispatcher |
| `initializeWorkbook()` editor function (`src/server/main.ts:292-294` → `src/server/main.ts:228` → `src/server/workbook/initializer.ts:94-98`) | creates missing tabs (`initializer.ts:81`), rewrites headers (`:46`), applies protections (`:53`), appends a `Settings` version row (`:90`) | **no** | **no** | **none** |
| `checkWorkbookSchema()` (`src/server/main.ts:296-298` → `initializer.ts:100-104`) | nothing (reads the first matching `Settings` version row, `initializer.ts:56-68`) | n/a | no | none |
| `validateMigrationWorkbook()` (`src/server/main.ts:310-315`) | **not read-only despite its name**: `applyMigrationPayload` calls `initializeWorkbook` first (`src/server/workbook/loader.ts:140`) before validating the payload (`:141`), with `apply: false` only skipping the row writes (`:160-169`). Matches `docs/operations.md:126` and `docs/subsystems/workbook.md:15` | **no** | **no** | **none** |
| `loadMigrationWorkbook()` (`src/server/main.ts:326-335`) | `Volunteers`, `Centers`, `Sessions`, `Users` whole-tab replaces (`loader.ts:171-174` → `:125`), plus initialization (`loader.ts:140`) and one audit row per replace | **no** | **yes** — throws unless `WRITE_ENABLED === 'true'` (`src/server/main.ts:330-332`) | `TAB_REVISION_Volunteers/Centers/Sessions/Users`, and `SCHEDULING_INPUT_REVISION` **+2** (Volunteers, Sessions). **`DATA_REVISION` is not advanced** — this path never reaches the dispatcher |
| `describeSignIn()` (`src/server/main.ts:342-372`) | nothing; reads the gate, config properties and the `Users` tab | n/a | reads it | none |
| `compareAdvancedReadParity()` (`src/server/main.ts:213-219` → `readOnlyRouteParityReport`, `:147-210`) | nothing; refuses unless the gate is exactly `false` (`:152`), invokes the Schedule/Insights handlers directly (`:181-185`), and asserts the revision list is unchanged (`:193`). The runtimes it builds pass no `scriptCache` (`:159-171`), so Insights staleness marking stays in each request's memory | no (direct handler calls) | yes, as a precondition | none |
| `src/server/workbook/initializer.ts` `initializeWorkbook` | same behaviour as the `initializeWorkbook()` editor function above | no | no | none |
| `src/server/workbook/loader.ts` `applyMigrationPayload` | the function the two migration editor functions call; writes only when `apply` is true (`src/server/workbook/loader.ts:151-158` refuse a partial load) | no | only its caller checks it | tab counters, `SCHEDULING_INPUT_REVISION`; never `DATA_REVISION` |
| `scripts/build-migration-payload.mjs:52-58` | writes `MigrationPayload.gs` locally (real contact data; copy present in the working tree under `migration-output/`), which is pushed into the project and read by `src/server/main.ts:374-380` | n/a | no | none |
| `scripts/deploy-apps-script.mjs:145`, `:150` | Apps Script project/deployment (`clasp push --force`, `create-deployment`). Requires local config `writeEnabled === false` (`:106-107`) but does not read or set the live property | n/a | no (local config only) | none |
| `scripts/staging/workbook.mjs:89-95`, `:98-119`, `:122-140` | **staging workbooks only**, through the Sheets REST API: spreadsheet time zone, tab creation + header rewrite, whole-tab data writes | n/a | no | none (writes cells directly; no Script Properties exist in the Node context) |
| `scripts/staging/load-fixture.mjs:105-116` | the only caller that writes to a workbook, behind `--confirm-staging` (`:84-91`); refuses without an explicit spreadsheet id and key (`:44-48`) | n/a | no | none |
| `scripts/staging/verify-staging.mjs:33`, `scripts/staging/diff-fixture-diagnostic.mjs:53` | nothing — `metadata()`, `readTabs()`, `digest()` only | n/a | no | none |
| `scripts/staging/deploy-staging.mjs:159`, `:173` | Cloudflare Worker deploy and `wrangler secret put`; no Sheet or property access | n/a | no | none |
| `scripts/migrate.mjs:431`, `scripts/rollback.mjs:61`, `:87` | local reports/checklists only; rollback explicitly does not execute (`rollback.mjs:87`) | n/a | no | none |
| `scripts/probe-service.mjs:99-103`, `scripts/browser-read-probe.js:5-8`, `:38` | HTTP reads only (`session.me`, `admin.schedule.read`, `admin.insights.read`) with a non-credential probe string | n/a | no | none (an Insights read may rewrite the Script Cache) |
| Reviewed direct-write reconciliation (`docs/operations.md:46-76`) | human/Sheet-API row edits plus manual counter bumps: `+1` per touched tab, `+1` `SCHEDULING_INPUT_REVISION` when a scheduling-input tab is touched, `+1` `DATA_REVISION` (`:63-66`); requires the gate disabled and a snapshot (`:60-62`) | no | yes, procedurally | yes, by hand; recorded as exercised 2026-09-21 (`:76`) |
| Gitignored private editor procedures (`srikar-task-5.7/*.gs`) | direct row writes and counter bumps: `fixtureSetup_5_7` (`FixtureSetup.gs:101`, bump `:132`), `fixtureRestore_5_7` (`FixtureRestore.gs:16`, bump `:42`; also `FixtureProcedures.gs:273`), `fixtureGate_5_7` (`FixtureGate.gs:12`, `WRITE_ENABLED` at `:49`), `notificationTestRecipients_5_7` (`NotificationTestProperty.gs:45`, gate check `:51`, stash writes `:57`, `:74-78`) | no | they refuse while the gate is open (`FixtureRestore.gs:18`, `FixtureSetup.gs:103`, `FixtureProcedures.gs:209`) | yes, by hand |

Two facts this table establishes for task 3.4: (a) no path in the tree except the
dispatcher and the private procedures consults `WRITE_ENABLED` before a workbook write —
the two loader/initializer editor functions and `validateMigrationWorkbook` do not; and
(b) `loadMigrationWorkbook` is a writer that advances four tab counters (`Volunteers`,
`Centers`, `Sessions`, `Users`) plus two scheduling-input increments while leaving
`DATA_REVISION` untouched.

## 5. Coverage statement

Inspected by reading, in full or in the cited ranges:

- `src/server/`: `main.ts`, `runtime.ts`, `integration/{dispatcher,request-policy,adapters,projections,claim-cache}.ts`, `workbook/{repository,initializer,loader,schema,read-plans,batch-read,hydration}.ts`, `insights/{store,cache-repository}.ts`, `imports/{service,matching,roster}.ts`, `self-service/{index,availability,cancellation,notifications}.ts`, `centers/service.ts`, `scheduling/{index,publication}.ts`.
- `src/worker/`: `config.ts`, `staging.ts` (dispatch/revision region), `read-api.ts`, `entry.ts`, `host.ts`.
- `src/client/`: `api.ts` (mutation helpers), `main.ts` (route actions), `views.ts` (revision display).
- `scripts/`: every top-level `*.mjs`/`*.js` was searched; `deploy-apps-script.mjs`, `rollback.mjs`, `migrate.mjs`, `build-migration-payload.mjs`, `expose-appsscript.mjs`, `probe-service.mjs`, `staging/workbook.mjs`, `staging/load-fixture.mjs`, `staging/verify-staging.mjs`, `staging/diff-fixture-diagnostic.mjs`, `staging/deploy-staging.mjs`, `staging/profile-schedule-preview.mjs`, `snapshot/*.py` (header/IO), `browser-read-probe.js`, `compare-server-bundles.mjs` were read in the ranges cited.
- Docs read: `docs/architecture.md`, `docs/operations.md`, `docs/subsystems/{workbook,integration}.md`, `docs/security.md` (cache/write-hazard sections).
- Gitignored private material: the `srikar-task-5.7/*.gs` procedures were read for property and counter behaviour only; no values, addresses or fixture data were copied, and `migration-output/` and `scrubbed_exports/` contents were not read.
- `dist/apps-script/Code.js` (gitignored build artifact, 72 lines) was spot-checked for the gate refusal string and the stale-revision string (`src/server/integration/dispatcher.ts:176`, `:191`): both are present, so the last local build contains the behaviour described in section 3.2. This is a build-artifact check, not evidence about the deployed version.

Not inspected / out of reach:

- The live Apps Script project, its Script Properties, the bound spreadsheet, the pinned deployment and its version history; any Cloudflare account state. Local read-only commands only.
- Non-repository writers: manual Sheet edits, other Apps Script projects or add-ons bound to the same workbook, and the `SpreadsheetApp` editor procedures that may still exist in the project but not in this tree. A source inventory cannot see these.
- The full client bundle and the Worker gateway/host routes were not exhaustively audited; only the mutation helpers, the route actions and the read-only dispatch wiring cited above.
- `src/server/**/*.test.ts`, `src/worker/*.test.ts` and the private baseline/snapshot data were not treated as evidence of production behaviour.
- Not read line by line, only searched for the write keywords above plus any property name: `scripts/{serve-pages-preview,bundle-server,audit-server-bundle,audit-gateway-bundle,render-public-config,validate-config,deployment-check,compare-server-bundles}.mjs`, `scripts/lib/config.mjs`, `scripts/staging/{fixture,google-auth,collect-metrics,measure-worker,verify-worker,serve-probe}.mjs`, `scripts/staging/browser-probe.js`, `scripts/snapshot/*.py` (searched for write calls: only a local baseline JSON write at `scripts/snapshot/build_baseline.py:26`), and `srikar-task-5.7/*.py`. No Sheets or Properties write call matched in any of them, but the strongest claim they support is "no write call matched the search", not "proven read-only".

Strongest statement this inventory supports: **within the tracked source at commit
`6905445`, every read and write of Script Properties, every revision consumer and
producer, and every workbook-writing path is listed above.** The absence of a writer from
this list is only as strong as the searches recorded at the top of this file: they are
literal name and API searches plus read-through of every hit, so a writer that reaches
`PropertiesService` or a `SpreadsheetApp`/Sheets write through an indirection not using
those names, or that lives outside this repository, would not appear.

## 6. Unresolved items

1. **Are the private fixture/notification procedures still in the bound Apps Script
   project?** `srikar-task-5.7/*.gs` writes rows and counters directly and would bypass
   the new protocol. The staged question: which `.gs` files does the project currently
   contain, and does either `MigrationPayload.gs` or a `fixture*_5_7` function remain?
   Settled by listing the project's files in the editor (read-only) — not possible from a
   sandboxed local session.
2. **Is `WHENISGOOD_ENDPOINT` a configuration value or a secret?** It is read at
   `src/server/runtime.ts:464` and passed to `WhenIsGoodFetcher`; if the configured URL
   embeds a per-sheet code it is effectively a credential and task 1.3 must classify it
   as a secret. Settled by inspecting the live property value privately (never pasted
   here) and the WhenIsGood URL format in use.
3. **Does `ADMINISTRATOR_RECIPIENTS_STASH_5_7` still exist?** The recorded restoration
   says the stash was cleared (`openspec/changes/volunteer-session-scheduling/tasks.md:118`),
   but that is a dated claim, not a live read. Settled by reading Project Settings.
4. **Does the pinned deployment's code match this worktree?** `dist/` is gitignored and
   the last recorded deployment evidence is version 28 on 2026-09-24
   (`docs/operations.md:138`); this inventory describes source, not the served version.
   Settled by `clasp deployments` plus a version-content diff (requires the administrator
   clasp credentials this session must not use).
5. **What are the live values of the 13 `TAB_REVISION_*` counters and of
   `DATA_REVISION` / `SCHEDULING_INPUT_REVISION`?** Needed as the migration source for
   task 1.2/1.3; deliberately not read here. Settled by the owner reading Project Settings
   and recording them in the private manifest.
6. **Do gitignored or private local scripts write the production workbook?** The tracked
   tree contains no local script that writes a non-staging workbook (the only workbook
   writer is `scripts/staging/workbook.mjs`, called from `load-fixture.mjs` behind
   `--confirm-staging`), but `srikar-task-5.7/` holds private Python tooling that reads
   snapshots and the runbook states all writes were performed through editor procedures.
   Settled by the runbook's own record plus, if stronger evidence is required, the
   workbook's edit history.
