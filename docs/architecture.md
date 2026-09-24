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

All current mutation helpers supply `expectedRevision`. The policy field records that requirement, but the dispatcher currently does not reject an omitted value solely from that field; it only validates and compares a value that is present. Do not treat `OperationPolicy.expectedRevision` as enforcement until the dispatcher has a regression-tested presence check.

## Persistence and revisions

Google Sheets stores domain rows; Apps Script Script Properties store counters. These counters are related but not interchangeable:

| Revision | Storage | Purpose |
| --- | --- | --- |
| `TAB_REVISION_<TabName>` | Script Properties | Optimistic concurrency for one repository/tab |
| `SCHEDULING_INPUT_REVISION` | Script Properties | Monotonic change counter for `Volunteers`, `RecurringAvailability`, `AvailabilityExceptions`, and `Sessions` |
| scheduling output revision | `SchedulingRuns`, assignments, backups | Identifies one computed/published schedule output |
| `DATA_REVISION` | Script Properties | Global API revision returned/checked around mutations |

Repository writes compare the expected tab revision, write rows, append audit data, then advance the tab counter. Scheduling-input tab commits also advance `SCHEDULING_INPUT_REVISION`. The dispatcher compares the client's `expectedRevision` with `DATA_REVISION` under the global write lock and advances it after a successful mutation.

Direct Sheets API or manual cell writes bypass these counters and the application audit path. The application then cannot reliably detect staleness or concurrency. See [operations](operations.md) before any exceptional direct write.

## Scheduling publication and derived data

Scheduling is a pure calculation over a normalized snapshot. Preview computes without writes. Publication requires the reviewed global revision, runs under locks, writes a complete assignment/backup/run output, and attempts to restore the prior assignment and backup rows if a later write fails. Only locked center sessions and confirmed classes that have not started are schedulable.

Insights are derived from source revisions and may be reused only when their source revision tuple matches. When cached data is absent or stale, the server regenerates it from one workbook snapshot. Import promotion similarly stages and validates a complete result before replacing authoritative availability.

Published Schedule and Insights use the read plans in `src/server/workbook/read-plans.ts`. Repository handles resolve when used, and decoded rows live only for the current request. `Users` is decoded anew through `SpreadsheetApp` before every authorization and is excluded from the Advanced Sheets plans. After authorization, the approved source path uses `Sheets.Spreadsheets.Values.batchGet` for schema-derived ranges bound to the active workbook ID. Schedule reads runs, assignments, backups, sessions, volunteers, and centers in one batch. An Insights cache hit first reads runs; a miss or refresh extends that same request-local snapshot with volunteers, recurring availability, and assignments. Responses are checked against the requested workbook and ranges, then decoded by the existing workbook codecs. The cache never authorizes a request.

The local Apps Script manifest enables the Sheets v4 advanced service and requests `spreadsheets.readonly`; `ADVANCED_SHEETS_READS_ENABLED` is true in source following explicit approval on 2026-09-23. This scope grants the deploying user read access beyond the bound workbook even though the runtime adapter only requests schema-allowlisted ranges from the active workbook. Source configuration and GCP API enablement do not establish owner OAuth consent or production deployment; see [operations](operations.md) and [deployment](deployment.md) for release evidence and gates.

## Time model

Scheduling and display use the configured IANA `TIME_ZONE` (default `America/New_York`). Raw date/time cells must be decoded in the spreadsheet's own time zone, which may differ; `workbookTimeZone()` enforces that distinction. Recurring intervals are normalized and coalesced by semantic coverage, so row IDs and row counts are not stable identities.
