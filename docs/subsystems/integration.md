# Integration subsystem

## Ownership

`src/server/integration/adapters.ts` translates Apps Script events and JSON output. `auth.ts` verifies claims and resolves users. `claim-cache.ts` bounds verified-claim reuse. `dispatcher.ts` owns the API registry/policies and cross-cutting enforcement. `projections.ts` minimizes returned data. `src/server/main.ts` exposes Apps Script entry points; `src/server/runtime.ts` wires production handlers.

## Request contract

The envelope is `{ operation, payload, idempotencyKey, expectedRevision?, credential? }`. Unknown top-level fields, unknown operations, non-object payloads, dangerous range/query fields, excessive depth, invalid operation payloads, and oversized envelopes are rejected before a handler runs.

Each operation declares roles, mutability, GET/read-only eligibility, expected-revision intent, and a strict Zod schema. Mutation order is: validate → authenticate/authorize → idempotency check → acquire write lock → compare a supplied global revision → invoke synchronous handler → advance global revision → return envelope. Locks release in `finally`.

All current client mutation helpers send `expectedRevision`, and the dispatcher enforces presence for an operation whose policy declares it: a request that omits the revision is rejected with `INVALID_REQUEST` before any state is touched. A supplied value is compared with the global revision under the write lock. The client revision still reaches no tab-level check: handlers read their tab expectations from the active authority within the same request — Script Properties, or the request's control record once the workbook is activated — so treat the supplied revision as a global-operation guard, not as per-tab optimistic concurrency.

Idempotency storage is per dispatcher instance; production rebuilds that instance for each request. Identical repeated keys within one instance return `DUPLICATE_REQUEST`, while changed fingerprints return `CONFLICT`; the saved response is not replayed. This is not durable cross-request retry protection. Domain idempotency (for example import content hashes) is separate.

`admin.import.whenIsGood.preview` is classified as mutating, revision-requiring and not read-only, because staging persists an `Imports` run: it takes the write lock, requires the live write gate and the caller's revision, and advances the global revision (2026-09-29, [task 3.3](../../openspec/changes/make-workbook-state-portable/tasks.md)). The deployed Apps Script build does not include that change until an approved release, so check which build is serving before relying on the classification. `admin.schedule.preview` is genuinely side-effect-free; `admin.insights.refresh` is classified as mutating even though its output is derived data.

## Authorization and projections

Authenticate by verified normalized email against an active freshly read Users row. Preserve non-sensitive rejection reasons for diagnosis. Volunteers require linked ownership; center-contact mutations are center-scoped and cannot set confirmed state; aggregate identities are administrator-only.

Any new handler must return a deliberate projection. Do not return repository rows merely because the caller could theoretically access the tab.

## Runtime contract

Apps Script handlers are synchronous. The server bundle cannot assume Node globals. Production constructs repositories once per request; each repository lazily reads its tab once and shares that snapshot among consumers. The composition root may translate domain errors but must preserve public code/message/details when the subsystem has already classified the failure.

For published Schedule and Insights POST reads, the server logs aggregate phase milliseconds for credential verification, authorization, workbook hydration, derivation, and response construction, plus Sheet-call time and counts. `read-phases` log records contain no credential, request body, or workbook row. Browser-visible duration and outcome remain authoritative for the latency objective, because Apps Script can finish execution even when its redirect handoff returns HTML to the client.

The approved Schedule and Insights batch path starts only when an authorized route handler requests workbook data. The fresh `Users` authorization read stays on `SpreadsheetApp`; the Advanced Sheets Values API reads only the route plan's schema-derived data ranges. The default runtime creates the reader per execution, and the handler compares global and relevant tab/source revisions before and after hydration. This check rejects observed counter changes; it does not prove isolation from an in-progress multi-step write before that write advances its counters. Direct Sheet edits also bypass revision bookkeeping. The proposed portable-state protocol addresses interrupted-write detection.
