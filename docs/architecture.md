# Architecture

This application schedules mindfulness-society volunteers while keeping Google Sheets as the system of record. A static TypeScript client is deployed to GitHub Pages. A spreadsheet-bound Google Apps Script web app is the privileged API and runs as the deploying Sheet owner.

## Request and data flow

```text
Browser on GitHub Pages
  |  Google Identity Services credential
  |  POST text/plain JSON: operation, payload, idempotencyKey,
  |  optional expectedRevision, credential
  v
Apps Script adapter -> dispatcher -> authenticated operation handler
  |                   |             |
  |                   |             +-- scheduling/import/insight/self-service/center services
  |                   +-- payload schema, role policy, lock, global revision
  +-- Apps Script JSON/redirect transport
                                      |
                                      v
                        workbook repositories/codecs
                                      |
                                      v
                         protected Google Sheets tabs
                         + Apps Script Script Properties
```

The browser never supplies Sheet names, ranges, formulas, queries, roles, or trusted volunteer ownership. `src/client/api.ts` admits only named operations. `src/server/integration/dispatcher.ts` repeats the allowlist, validates the complete envelope and operation-specific payload, verifies identity, applies role policy, and invokes a synchronous handler.

## Major boundaries

- `src/client/` owns sign-in presentation, routing, in-memory route snapshots, request construction, response parsing, and DOM rendering. It is untrusted for authorization and concurrency.
- `src/shared/` owns environment-neutral Zod schemas and time/interval helpers used on both sides. It must not depend on the DOM, Node-only globals, Apps Script globals, or raw Sheets values.
- `src/server/main.ts` is the Apps Script entry point. It constructs a fresh default server for each request so users, revisions, and workbook rows do not survive between executions.
- `src/server/integration/` owns transport adaptation, token verification, request policies, role checks, response projections, and cross-cutting failure envelopes.
- `src/server/runtime.ts` is the composition root for production repositories and operation handlers. Domain logic belongs in a subsystem, not in the transport.
- `src/server/workbook/` is the only raw Sheet boundary. Schema definitions, initialization, cell normalization, codecs, repositories, audit append, and tab revisions live there.
- `src/server/{scheduling,self-service,imports,insights,centers}/` own their domain rules and accept repository-like dependencies so contracts can run without Apps Script.
- `scripts/` owns build, configuration validation, migration preparation, deployment checks, probing, and rollback checklists. It does not confer authorization to mutate production.

Detailed contracts are in [the subsystem documents](subsystems/).

## Authorization architecture

Google Identity Services returns an ID credential to the browser. The browser treats it as opaque and sends it to the server. The server verifies issuer, audience, expiry, verified email, and subject through Google's token-info boundary; successful claims may be cached only up to credential expiry. It then looks up the normalized email in a freshly decoded `Users` tab snapshot.

An active `Users` row assigns one or more roles:

- `volunteer` requires a linked `volunteerId`; projections and services restrict access to that volunteer.
- `center-contact` is restricted to the listed `centerIds` and cannot confirm candidate sessions.
- `administrator` can use aggregate and administrative operations and is not center-scoped.

When an account has multiple roles, the client primary-role projection prefers administrator, then center contact, then volunteer. That affects the rendered route only; every operation is still authorized server-side. Cached client route data is keyed by email, role, and route, cleared on identity changes, held only in memory, and never authorizes a write.

## Operation contract

`INTEGRATION_OPERATIONS` and `OPERATION_POLICIES` are the API registry. Each policy declares allowed roles, read/write status, expected-revision intent, and a strict Zod payload schema. The dispatcher also:

- caps the encoded envelope at 64 KiB by default;
- rejects nested fields associated with arbitrary Sheet/database access;
- scopes idempotency keys to actor and operation;
- rejects reuse with a changed fingerprint;
- serializes mutations with an Apps Script script lock;
- rejects a stale global revision before calling the handler when the request supplies one;
- rejects promises because Apps Script web-app entry points must complete synchronously;
- maps failures into the shared `ApiResponse` error codes.

`GET` is read-only. The client normally uses cookieless `POST` with `Content-Type: text/plain;charset=utf-8` to avoid a browser preflight and follows Apps Script's echo redirect.

The [integration contract](subsystems/integration.md#request-contract) records the request-local duplicate map; durable replay is not currently guaranteed.

An operation whose policy declares `expectedRevision` is refused with `INVALID_REQUEST` when the caller omits it, before any state is touched, and a supplied value is compared with `DATA_REVISION` under the write lock. All current helpers for operations classified as mutating supply the revision. The supplied revision guards the global operation only: it reaches no per-tab expectation. Under the Script Properties authority handlers read those expectations from the properties within the same request; under the control authority they come from the request's control record, whose counters the completion transition advances.

## Persistence and revisions

Google Sheets stores domain rows. Revisions come from one of two authorities, selected per deployment by the `CONTROL_AUTHORITY` Script Property: **Script Properties** (the state of every deployed build until the approved migration runs, and of any deployment that has not been activated) or the workbook's **control record** (the portable authority). The two are never mixed: the record's own `authority` field must agree with the configuration, or every request fails closed. Which one a workbook uses is live state, read from the workbook, not inferred from configuration.

| Revision | Script Properties authority | Control authority | Purpose |
| --- | --- | --- | --- |
| `TAB_REVISION_<TabName>` | `TAB_REVISION_<TabName>` property | `tabRevisions` entry in the control record | Optimistic concurrency for one repository/tab |
| `SCHEDULING_INPUT_REVISION` | property | `schedulingInputRevision` | Monotonic change counter for `Volunteers`, `RecurringAvailability`, `AvailabilityExceptions`, and `Sessions` |
| `DATA_REVISION` | property | `dataRevision` | Global API revision returned/checked around mutations |
| scheduling output revision | unchanged | unchanged | Identifies one computed/published schedule output; it is a value in the run, assignment and backup rows under **both** authorities |

Repository writes compare the expected tab revision, write rows, append audit data, then advance the tab counter; scheduling-input tab commits also advance the composed counter. The dispatcher compares the client's `expectedRevision` with the global revision under the global write lock and advances it after a successful mutation. An operation whose policy declares `expectedRevision` is refused when the caller omits it.

### Portable control protocol

`WorkbookControl` holds one protected row — protocol version, authority and epoch, a monotonic generation, the counters above, and the in-progress operation — and `ControlJournal` holds a bounded, append-only record of every transition. Under the control authority a mutating operation runs as: acquire the script lock, publish a pending marker and a new generation **before** any row changes, write rows and audit data, then complete with one row write that advances the generation and exactly the counters the commit touched. An abort or a restore advances the generation without moving a counter, which is why readers compare the whole generation/revision tuple rather than revisions alone: equal counters cannot prove that a multi-step mutation finished. Incomplete or unsupported control state fails closed rather than defaulting to zero.

A deployment that is **not** activated is not passive. Before a legacy mutation writes anything, its revision source reads the control record once and refuses with `UNAVAILABLE` when the workbook carries control structure that is not on the Script Properties authority: an activated record, a malformed, duplicated or unsupported one, control tabs with no readable record, or a process that is itself activated. A workbook with no control structure at all is admitted without even looking, so the pre-protocol path costs nothing extra. The check runs after the write lock and the revision comparison and before the handler, so a refusal writes no rows and advances no counter. Without it, a deployment whose `CONTROL_AUTHORITY` was still unset would keep writing domain rows while only the Script Properties counter moved, and the control record's generation would go on describing a workbook that had changed underneath it.

The authority switch runs in both directions through `activationTransition` and `rollbackTransition`, each applied by `ControlMutationWriter` (`activate` and `revert`). Both are stopped-service procedures — the live gate is expected closed and is deliberately not consulted — and both advance the authority epoch and the generation and take every counter as `max(captured, current)`, so a counter a client has already seen can never go backwards. Activation refuses a pending record; rollback additionally requires the record to be **already** activated, which is what makes a repeated rollback stop instead of advancing the epoch a second time.

Readers — the Apps Script runtime and the Worker adapter — hydrate inside a bracket of two control reads and accept the result only when both observations are idle and carry the same completed generation and revision tuple.  `Users` is read fresh for authorization and stays outside the bracket. Import preview is a mutation: staging persists a run, so it takes the lock, requires the live write gate and a current revision, and is refused through a read-only request.

The Worker adapter implements that bracket with one economy the Apps Script adapter cannot make: the authorization batch and the bracket's first control observation are the same Sheets request, so a served domain read costs three requests rather than four, and a rejection that can be decided from the first observation costs one. Measured live on both synthetic fixtures on 2026-09-30: identity 1, served domain 3, and each of the pending, malformed, duplicate, unsupported, missing-record and wrong-authority rejections 1. The Apps Script adapter still pays its own two control reads, which is what its read plan prices.

Interrupted mutations are recovered by a reviewed decision — completed, not-started, or restored — recorded in the journal with its reason; counters only ever increase, and a restore never writes a snapshot value back as a counter. The initializer and the migration loader run under a maintenance fence instead of the request path: the script lock is held for the whole action and the live write gate must be **closed**, so maintenance runs with writers drained.

Direct Sheets API or manual cell writes bypass these counters and the application audit path, so the application cannot reliably detect staleness or concurrency. Under the control authority the reviewed reconciliation records a recovery decision instead of hand-bumping counters. See [operations](operations.md) before any exceptional direct write.

The deployed build carries none of this until an approved release, and a workbook is only activated by the approved capture-and-activation procedure; until then Script Properties remain authoritative. The open work is tracked in the [portable-state change](../openspec/changes/make-workbook-state-portable/tasks.md).

## Scheduling publication and derived data

Scheduling is a pure calculation over a normalized snapshot. Preview computes without writes. Publication requires the reviewed global revision, runs under locks, writes a complete assignment/backup/run output, and attempts to restore the prior assignment and backup rows if a later write fails. Only locked center sessions and confirmed classes that have not started are schedulable.

Insights carry a source revision tuple. An unchanged tuple reuses the cached dataset; changed sources mark a retained dataset stale until refresh or expiry. Missing/expired data is regenerated from a workbook snapshot. See [Insights cache semantics](subsystems/imports-and-insights.md#availability-insights). Import promotion similarly stages and validates a complete result before replacing authoritative availability.

Published Schedule and Insights use the read plans in `src/server/workbook/read-plans.ts`. Repository handles resolve when used, and decoded rows live only for the current request. `Users` is decoded anew through `SpreadsheetApp` before every authorization and is excluded from the Advanced Sheets plans. After authorization, the approved source path uses `Sheets.Spreadsheets.Values.batchGet` for schema-derived ranges bound to the active workbook ID. Schedule reads runs, assignments, backups, sessions, volunteers, and centers in one batch. An Insights cache hit first reads runs; a miss or refresh extends that same request-local snapshot with volunteers, recurring availability, and assignments. Responses are checked against the requested workbook and ranges, then decoded by the existing workbook codecs. The cache never authorizes a request.

The local Apps Script manifest enables the Sheets v4 advanced service and requests `spreadsheets.readonly`; `ADVANCED_SHEETS_READS_ENABLED` is true in source following explicit approval on 2026-09-23. This scope grants the deploying user read access beyond the bound workbook even though the runtime adapter only requests schema-allowlisted ranges from the active workbook. Source configuration and GCP API enablement do not establish owner OAuth consent or production deployment; see [operations](operations.md) and [deployment](deployment.md) for release evidence and gates.

## Time model

Scheduling and display use the configured IANA `TIME_ZONE` (default `America/New_York`). Raw date/time cells must be decoded in the spreadsheet's own time zone, which may differ; `workbookTimeZone()` enforces that distinction. Recurring intervals are normalized and coalesced by semantic coverage, so row IDs and row counts are not stable identities.

## Proposed backend migration

The [Worker feasibility design](../openspec/changes/validate-worker-backend-feasibility/design.md) owns the proposed six-change roadmap and prerequisite gates. These are planning artifacts, not implemented architecture: production still uses Apps Script and Script Properties. The synthetic Node prototype on `codex/read-api-prototype` establishes local transport evidence only; see [operations evidence](operations.md#local-experiment-and-proposed-migration).
