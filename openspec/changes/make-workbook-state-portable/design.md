## Context

`src/server/runtime.ts`, `main.ts`, and workbook repositories currently read global, scheduling-input and tab revisions from Script Properties. Schedule-output revisions remain in scheduling rows and are a different concept. Reads check counters around batch hydration, but equal counters alone cannot prove that a multi-step mutation is complete. Import preview saves runs despite a read-only policy. Initializer defects are already recorded as original tasks 10.24 and 10.25.

Depends on accepted feasibility evidence with resolved conditions. Read [architecture](../../../docs/architecture.md) and [operations](../../../docs/operations.md) before changing these boundaries.

### Prerequisite assessment (2026-09-29)

The [2026-09-27 single-Worker no-go](../archive/2026-09-29-validate-worker-backend-feasibility/evidence/verdict.md) remains historical evidence for that topology. The [2026-09-28 gateway/Durable Object campaign](../archive/2026-09-29-validate-worker-backend-feasibility/evidence/verdict-2026-09-28.md) measured primary-read wall p99 at or below 1,015 ms on both fixtures and demonstrated request-local decoding on the free topology; its larger preview still failed CPU, wall and burst gates. The [2026-09-29 preview campaign](../archive/2026-09-29-accelerate-schedule-preview/evidence/verdict-2026-09-29.md) subsequently measured larger-preview burst p99 of 2,553–4,191 ms, cold wall at or below 2,653 ms, zero wall-cap kills and zero quota errors. Its [parity evidence](../archive/2026-09-29-accelerate-schedule-preview/evidence/baseline-parity-2026-09-29.md) records exact equality in 20 differential cases. These results support designing portable state for the gateway/Durable Object topology.

Acceptance remains a prerequisite task, despite the preview report's unconditional go label. Aggregate CPU divided by request count is an average, not the required CPU p99; the 4,191 ms maximum wall bound does not prove the 3,000 ms warm CPU p99 gate. Billable duration is unavailable from the recorded datasets, and its estimates must be reconciled with the contract's consumption projections. The report attributes one 503 to a redeploy-adjacent restart/JWKS failed-load window, but that attribution and its reliability disposition still need review. Under the [experiment contract](../archive/2026-09-29-validate-worker-backend-feasibility/evidence/experiment-contract.md), an unevaluated threshold caps acceptance at conditional-go. Tasks 1.4–1.6 require measured evidence or an explicit unresolved disposition; planning does not satisfy the implementation or production gates.

## Goals / Non-Goals

**Goals:** One portable revision authority, a fail-closed consistency protocol shared by both readers, a sole legacy writer during coexistence, and a recoverable metadata migration.

**Non-Goals:** Worker production writes, concurrent legacy/Worker writers, automatic repair of manual edits, moving secrets into cells, or fixing unrelated scheduling rules.

## Decisions

### Gateway/Durable Object baseline and read budget

Use the measured gateway/Durable Object topology as the candidate for the portable-state reader rehearsal, subject to task 1.1 acceptance. The gateway forwards bounded requests; the host keeps credentials and creates request-local services, principals and snapshots. A cache of decoded snapshots across requests is no longer a prerequisite inferred from the rejected single-Worker topology. If later proposed, it needs separate consistency evidence, fresh Users authorization and completed-generation validation. Preview continues to compute from its own request snapshot under the archived schedule-preview-performance requirements.

The staging campaigns observed one Sheets read for identity and two for domain reads or preview. Those counts did not include this change's control checks. Task 1.7 defines the complete control/Users/domain read sequence, including rejection paths; task 4.1 measures that plan and updates quota and latency projections before accepting the portable reader. Preserve the campaign's shared read ledger for harness and browser probes; do not carry the staging two-read count into production claims without measurement.

### Dedicated versioned control metadata

Add a schema-defined control tab rather than overloading the defective append-only Settings behavior. Store protocol version, writer authority/epoch, global revision, scheduling-input revision, per-tab counters and operation state in one validated control record or atomic logical unit. A monotonic generation changes for every mutation lifecycle transition, including aborted/recovered work; it is distinct from successful-operation DATA_REVISION. Preserve schedule-output revisions in their existing rows. Missing, malformed or unsupported control state fails closed after activation, never defaults to zero.

Migrate captured counters without decreasing them. Switch authority once under a maintenance gate; do not maintain two independent writable sources of truth. Old Properties can be retained as an explicitly non-authoritative rollback artifact. Both adapters use the same provider interface. Inventory each Script Property as portable domain policy, deployment identity/configuration, secret, cache or operational gate. Workbook-derived policy stays versioned; service-account keys and signing material stay in secrets. Keep live WRITE_ENABLED and portable writer fencing as separate checks, both required for mutation admission.

### Pinned control schema and counter transitions (task 1.2)

This pins the physical protocol before implementation. It is a design record derived from the task 1.1 inventory; the inventory, not this section, owns what exists today.

**Physical layout.** Schema version 3 → 4 adds two tabs. `WorkbookControl` holds exactly one data row; `ControlJournal` is append-only with bounded retention. Counters stay inside the one control row, so one row write is the atomic logical unit and no transition can leave a partially updated counter set.

`WorkbookControl` row 2, in column order:

| Column | Type | Meaning and bounds |
| --- | --- | --- |
| `protocolVersion` | integer | Exactly `1`. Any other value is unsupported. |
| `authorityEpoch` | integer ≥ 0 | Advances by one on each authority transition (capture, activation, rollback). Never decreases. |
| `authority` | `script-properties` \| `workbook-control` | Which store currently authorizes revisions. |
| `generation` | integer ≥ 0 | Advances by one on every mutation lifecycle transition, including abort and recovery. |
| `completedGeneration` | integer ≥ 0 | The generation of the last transition that left the protocol idle; equals `generation` while idle. |
| `dataRevision` | integer ≥ 0 | Successful global operations; the value the API reports as `revision`. |
| `schedulingInputRevision` | integer ≥ 0 | The scheduling-input counter. |
| `tabRevisions` | JSON object | Schema tab name → counter, only for tabs with a committed write. ≤ 4,096 bytes, ≤ 15 keys, schema names only. |
| `mutationState` | `idle` \| `pending` | `pending` means a mutation began and never recorded completion. |
| `operationId` | string | `<operation>#<opaque id>` of the in-flight mutation, ≤ 128 characters, empty while idle. Carries no actor or credential material. |
| `operationStartedAt` | ISO instant | Begin timestamp, empty while idle. |
| `operationTabs` | JSON array | Tabs the in-flight mutation may commit; ≤ 15 schema names. |
| `operationBaseline` | JSON object | The revision tuple captured at begin, ≤ 4,096 bytes; recovery reconciles against it and never writes it back as current. |
| `updatedAt` | ISO instant | Last control write. |
| `updatedBy` | string | Actor id or `system`, ≤ 200 characters. |

`ControlJournal` columns: `id`, `generation`, `event` (`capture` \| `activate` \| `begin` \| `commit` \| `abort` \| `recover` \| `rollback`), `operationId`, `actorId`, `tabs`, `before`, `after`, `reason`, `timestamp`. Retention is bounded at 200 rows and 2,048 bytes per row; pruning happens under the writer lock, oldest first, and never removes an entry referenced by the pending mutation.

**Atomic update boundaries.** The control record is one row and every transition rewrites the whole row in one range write; no transition writes a subset of its columns. A mutation is a begin row write, then domain row writes and the audit append, then one completion row write. The journal entry is appended before the control row it describes, so a crash between the two leaves an auditable attempt rather than an unexplained counter jump.

**Counter transitions.** `+1` means exactly one increment under the writer lock; `—` means unchanged.

| Transition | `generation` | `completedGeneration` | `dataRevision` | `schedulingInputRevision` | `tabRevisions` | `mutationState` |
| --- | --- | --- | --- | --- | --- | --- |
| Initialize or capture | — | = `generation` | captured value, or `0` | captured value, or `0` | captured values | `idle` |
| Begin | +1 | — | — | — | — | `pending` |
| Complete after full persistence | +1 | = `generation` | +1 | +1 when a committed tab is a scheduling input | +1 per committed tab | `idle` |
| Abort with no row change | +1 | = `generation` | — | — | — | `idle` |
| Recovery: persistence had completed | +1 | = `generation` | +1 | +1 when applicable | +1 per committed tab | `idle` |
| Recovery: rows restored from snapshot | +1 | = `generation` | — | — | — | `idle` |
| Authority activation or rollback | +1 | = `generation` | `max(captured, current)` | `max(captured, current)` | `max(captured, current)` per tab | `idle` |

Activation takes `max(captured, current)` so a capture snapshot can never lower a counter. Recovery never resets a counter to a snapshot value; the restore transition records what was restored in the journal and leaves every counter at its then-current value.

**Failure conditions after activation.** Detection and response, using existing API error codes:

| Condition | Detected by | Response |
| --- | --- | --- |
| Control tab missing | schema tab absent | `UNAVAILABLE` |
| Control record missing | header present, no data row | `UNAVAILABLE` |
| Duplicate control record | more than one data row | `UNAVAILABLE` |
| Unsupported protocol | `protocolVersion` ≠ 1 | `UNAVAILABLE` |
| Malformed record | non-integer or negative counter, unknown tab name in `tabRevisions`, unparseable JSON, unknown `mutationState`, `completedGeneration` ≠ `generation` while idle | `UNAVAILABLE` |
| Authority mismatch | `authority` ≠ the activated mode, or `authorityEpoch` older than the process recorded | `UNAVAILABLE` |
| Mutation pending | `mutationState` = `pending` | `CONFLICT` for writes; `UNAVAILABLE` for reads |
| Generation changed across a read | second control read differs from the first | `STALE_REVISION` |

Missing or malformed metadata never resolves to zero, and no path falls back to Script Properties after activation.

### Portable reader control read plan (task 1.7)

Sequence for one served request: control read, then fresh `Users` authorization, then the named domain batch, then a second control read. `Users` is never cached and is never covered by a control check. Acceptance requires both control reads to parse, the protocol and authority to be supported, both reads to be idle, and the tuples (`generation`, `completedGeneration`, `dataRevision`, `schedulingInputRevision`, and `tabRevisions` for consumed tabs) to be identical.

Reads paid per path, measured as Sheets read requests:

| Path | Control | `Users` | Domain batch | Total |
| --- | ---: | ---: | ---: | ---: |
| Rejected: invalid, pending, unsupported or missing control state | 1 | 0 | 0 | 1 |
| Rejected: unauthenticated or unauthorized | 2 | 1 | 0 | 2 |
| Served identity read (`session.me`) | 2 | 1 | 0 | 3 |
| Served domain read (Schedule, Insights cache hit or miss) | 2 | 1 | 1 | 4 |
| Rejected: generation changed after hydration | 2 | 1 | 1 | 4 |

The archived staging topology observed one identity read and two reads for domain or preview work, without control checks; those counts are not portable-state evidence and must not be carried into production claims. The portable plan costs two extra reads on every served path, and the rejection paths above are measured, not assumed: a path that costs more than its row is a finding, not a rounding difference.

Quota and latency acceptance for the added checks: the `Sheets.Spreadsheets.Values.batchGet` and `spreadsheets.values.get` quota is per requesting identity, so a single service account serving all browsers sustains `60 / reads-per-request` served reads per minute — 20 identity reads or 15 domain reads with the counts above, against 60 and 30 without the control checks. Harness and browser probes therefore share the existing rolling read ledger, and control reads are counted in it. Latency acceptance is the unchanged contract threshold applied to the served read (warm p99 ≤ 1,500 ms per read operation per fixture), with the control-read contribution reported separately; no latency claim is made from the added reads until task 4.1 measures them. Correctness precedes a one-call target: reducing the plan to a single control read would end the completed-generation guarantee and is not an option.

### Writer protocol and consistent reads

Apps Script remains the only writer and holds its script lock for the entire operation. Before changing any rows, it persists an in-progress marker and a new generation with operation identity and affected tabs. Completion publishes final counters and a completed generation only after domain/audit persistence succeeds. Where legacy operations cannot be atomically committed, store enough protected recovery evidence to restore/reconcile; a crash leaves the marker pending. Ordinary traffic must not clear a pending marker or report partial rows as current.

Readers fetch completed control state, hydrate named ranges, then re-read control state. They accept only the same supported, completed generation and revision tuple. A concurrent transition, pending operation, unknown epoch, or malformed metadata returns a controlled stale/unavailable response. Protocol protection assumes all writers participate; manual Sheet edits cannot be made transactional by metadata and remain governed by the exceptional-write procedure.

### Property classification and the rollback boundary (task 1.3)

Every Script Property the codebase reads, mapped to exactly one storage/authority category. `get`/`set` sites are the production ones; test-only writers are not inventory entries.

| Property | Read at | Written by | Category | After activation |
| --- | --- | --- | --- | --- |
| `TIME_ZONE` | `src/server/runtime.ts` (`runtimeConfiguration`) | operator | Portable domain policy | Versioned workbook state; both readers resolve the same value |
| `DISPLAY_INCREMENT_MINUTES` | `src/server/runtime.ts` | operator | Portable domain policy | Versioned workbook state |
| `OPERATING_HOURS_START` / `OPERATING_HOURS_END` | `src/server/runtime.ts` | operator | Portable domain policy | Versioned workbook state |
| `DATA_REVISION` | `src/server/main.ts`, `src/server/runtime.ts` | `src/server/main.ts` (dispatcher commit) | Revision authority | Superseded by the control record's `dataRevision` |
| `SCHEDULING_INPUT_REVISION` | `src/server/runtime.ts` | `src/server/runtime.ts` (scheduling-input commit) | Revision authority | Superseded by the control record's `schedulingInputRevision` |
| `TAB_REVISION_<TabName>` | `src/server/runtime.ts` (per repository) | `src/server/runtime.ts` (per tab commit) | Revision authority | Superseded by the control record's `tabRevisions` |
| `WRITE_ENABLED` | `src/server/main.ts`, dispatcher | operator | Operational gate | Unchanged: a separate live gate, and both it and portable fencing are required to admit a mutation |
| `OAUTH_AUDIENCE`, `PUBLIC_OAUTH_CLIENT_ID` | `src/server/main.ts` | operator | Deployment identity/configuration | Unchanged: per-deployment identity inputs, never workbook state |
| `WHENISGOOD_ENDPOINT` | `src/server/runtime.ts` | operator | Deployment configuration | Unchanged: external integration endpoint used by the writer only |
| `ADMINISTRATOR_RECIPIENTS` | `src/server/runtime.ts` | operator | Deployment configuration | Unchanged: notification routing for the writer only |
| `MIGRATION_ACTOR` | `src/server/main.ts` (loader) | operator | Deployment configuration | Unchanged: actor label for maintenance runs |

Secrets are not in this table because none lives in Script Properties. Service-account keys, signing material and OAuth client secrets stay in the platform secret stores (`wrangler secret`, the Cloud provider's secret handling) and in private local configuration; they are never written into a cell, the control tab, or public config. Caches (the Insights dataset under the `insight-dataset:` key prefix in `CacheService`, the verified-claim cache under `verified-claims:`, and the request-local duplicate map) are not Script Properties: they never authorize a request and never carry revision authority, and the existing contract tests hold that boundary. One further key exists only in gitignored private procedure material (`ADMINISTRATOR_RECIPIENTS_STASH_5_7`, written by a private notification-test procedure): it is deployment configuration by category, it is not portable state, and nothing in the change may depend on it. `WHENISGOOD_ENDPOINT` is classified deployment configuration pending a private check of whether the configured URL embeds a per-sheet code, in which case it must be treated as a secret and kept out of the workbook and public config.

A portable-domain-policy change is a maintenance mutation, not an ordinary edit: it advances the control record's generation and is journalled, so a read in flight cannot accept a snapshot that straddles a policy change. Where the portable policy physically lives is decided with task 2.1's deterministic Settings resolution; the binding requirement here is only that both readers resolve the same value from workbook state, and that a change is fenced.

**Rollback boundary.** Before activation, rollback is a redeploy of the previous server build and changes no authority. After activation, the eligible writable rollback is a protocol-compatible legacy release that reads the control record; the pre-activation build is not eligible as a writable endpoint because it would advance only Script Properties and silently fork the revision authority. Reverting authority to Script Properties is a separate, separately approved action requiring a stopped-writer reconciliation from the then-current control counters and any pending journal entry — never by copying the retained captured numbers back.

**Tools and deployments that must stay disabled.** The staging gateway and Durable Object host (read-only by construction), the `codex/read-api-prototype` branch prototype (local transport evidence only), `loadMigrationWorkbook` and every editor entrypoint that can initialize or migrate (`validateMigrationWorkbook` calls `initializeWorkbook` even with `apply: false`), and any deployment whose only revision update is a Script Property write. Each stays unavailable as a writable path until it participates in the control protocol or runs under a stopped-service reconciliation.

### Recovery of an interrupted mutation (design for task 3.6)

A pending marker is never cleared by ordinary traffic. Recovery is a reviewed maintenance action with one of three decisions, each recorded as a `recover` journal entry naming the actor, the reason, and the revision tuple before and after:

1. **Persistence had completed.** Every affected tab validates through its codec against the intended post-commit state and the audit append is present. Recovery applies the completion transition, so counters advance exactly as a successful mutation would have.
2. **Rows were never changed.** Every affected tab matches `operationBaseline` and no audit row exists for the operation. Recovery applies the abort transition; counters do not move.
3. **Rows are partial or ambiguous.** Recovery restores the affected rows from the approved snapshot export, then records the restore transition. Counters are never reset to snapshot values and the journal records what was restored, because a restore is a new change, not an undo of the counter history.

Recovery is refused when the journal already records a completion or abort for the same `operationId`, when the protocol version is unsupported, or when the authority epoch does not match the activated mode — a repeated recovery therefore sees an idle protocol and stops instead of advancing counters twice. At most one mutation may be pending at a time; no new mutation is admitted until recovery leaves the protocol idle. The diagnosis inputs are the control row (`operationId`, `operationStartedAt`, `operationTabs`, `operationBaseline`), the journal entries for that window, the audit rows, and a workbook snapshot export; all of them stay in private storage except the sanitised tuple summary recorded in the journal.

### Audit every mutation path

Cover repository commits, scheduling publication/compensation, imports, cancellation, availability, candidates, Insights refresh, initializer/loader and direct-write reconciliation. Revision accounting must distinguish tab commits, scheduling-input changes and successful global operations; record permitted recovery increments, never reset counters to backup values. Fresh Users reads remain mandatory and administrative identity maintenance participates in the maintenance protocol.

Reclassify import preview staging as mutating; reject it when WRITE_ENABLED is false or through read-only dispatch. Add required revision handling to its client flow, sourcing the revision from an authenticated current-state read rather than fabricating it. If identity bootstrap needs a revision field, add it compatibly and test old clients failing safely. Do not attempt an incidental redesign into ephemeral staging.

### Repair prerequisites, preserve backlog ownership

Fix effective schema-version resolution/idempotent initialization and actual protected data columns with tests that fail against current code. Control-tab protection must allow the intended service identities without granting volunteer edit access. Link measurements to original 10.24/10.25; leave their checkboxes open until their own required evidence is recorded. Extend snapshot validation to include control state while keeping exports/private journals ignored in-tree.

## Risks / Trade-offs

- [Additional control reads increase latency and quota use] → Measure exact call counts in primary reads; correctness precedes a one-call target.
- [Legacy multi-step write dies midway] → Pending marker blocks acceptance; reviewed recovery preserves audit and monotonic counters.
- [Historical deployment bypasses new protocol] → Do not use it as a writable rollback endpoint; require a protocol-compatible legacy release.
- [Manual edits bypass the application] → Correct protections and update the exceptional operations procedure; do not claim protection from the workbook owner.

## Migration Plan

First resolve task 1.1 using the archived evidence and tasks 1.4–1.6, and pin the schema, writer inventory, recovery bounds and read plan through tasks 1.1–1.3 and 1.7. Design work may proceed while measurement gaps are identified; implementation and production activation retain the accepted-feasibility prerequisite. After this change's activation and acceptance, `serve-primary-reads-from-worker` owns identity/Schedule/Insights routing and production browser evidence; `serve-remaining-reads-from-worker` then owns scoped reads and preview routing, reusing the archived preview evidence through its own gates.

First rehearse against synthetic staging: initialization twice, controlled migration, interrupted writes and forward recovery. Implement compatible legacy readers/writers while dormant, update client preview handling, and validate all tests/builds/specs. Before each approved production server deployment or Sheet mutation, export a snapshot, inspect live WRITE_ENABLED, disable it as authorized, drain active writers, capture counters and validate workbook schema/protections. Seed and verify control state, activate the compatible implementation, verify semantic parity and monotonic counters, then separately authorize any write reopening. Do not infer live state from local config or a deployment report.

Rollback before activation restores the old implementation without metadata authority changes. After activation, prefer the protocol-compatible legacy release. Reverting authority to Script Properties requires a separately approved stopped-writer reconciliation from then-current counters and pending journals; copying old numbers is forbidden.

## Open Questions

- Exact physical control schema and recovery journal layout must be pinned with byte/row bounds before implementation commits; the protocol above is the acceptance contract.
- Which existing maintenance entrypoints can be adapted directly, and which should be retired during the final change? The inventory must identify all before activation.
