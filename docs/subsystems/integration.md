# Integration subsystem

## Ownership

`src/server/integration/adapters.ts` translates Apps Script events and JSON output. `auth.ts` verifies claims and resolves users. `claim-cache.ts` bounds verified-claim reuse. `dispatcher.ts` owns the API registry/policies and cross-cutting enforcement. `projections.ts` minimizes returned data. `src/server/main.ts` exposes Apps Script entry points; `src/server/runtime.ts` wires production handlers.

## Request contract

The envelope is `{ operation, payload, idempotencyKey, expectedRevision?, credential? }`. Unknown top-level fields, unknown operations, non-object payloads, dangerous range/query fields, excessive depth, invalid operation payloads, and oversized envelopes are rejected before a handler runs.

Each operation declares roles, mutability, GET/read-only eligibility, expected-revision intent, and a strict Zod schema. Mutation order is: validate → authenticate/authorize → idempotency check → acquire write lock → compare a supplied global revision → invoke synchronous handler → advance global revision → return envelope. Locks release in `finally`.

All current client mutation helpers send `expectedRevision`, but the dispatcher currently compares it only when present; it does not enforce presence from the policy flag. Some handlers use current tab revisions internally, so omission is not uniformly rejected downstream either. Preserve client submission and do not cite the policy flag as a complete concurrency guarantee without adding dispatcher enforcement and a regression test.

Idempotency storage is per Apps Script execution because the default server is rebuilt per request. It prevents duplicates within the configured dispatcher lifetime and tests; durable business idempotency must live in domain data (for example import content hashes), not only this map.

## Authorization and projections

Authenticate by verified normalized email against an active freshly read Users row. Preserve non-sensitive rejection reasons for diagnosis. Volunteers require linked ownership; center-contact mutations are center-scoped and cannot set confirmed state; aggregate identities are administrator-only.

Any new handler must return a deliberate projection. Do not return repository rows merely because the caller could theoretically access the tab.

## Runtime contract

Apps Script handlers are synchronous. The server bundle cannot assume Node globals. Production constructs repositories once per request; each repository lazily reads its tab once and shares that snapshot among consumers. The composition root may translate domain errors but must preserve public code/message/details when the subsystem has already classified the failure.

For published Schedule and Insights POST reads, the server logs aggregate phase milliseconds for credential verification, authorization, workbook hydration, derivation, and response construction, plus Sheet-call time and counts. `read-phases` log records contain no credential, request body, or workbook row. Browser-visible duration and outcome remain authoritative for the latency objective, because Apps Script can finish execution even when its redirect handoff returns HTML to the client.

The approved Schedule and Insights batch path starts only when an authorized route handler requests workbook data. The fresh `Users` authorization read stays on `SpreadsheetApp`; the Advanced Sheets Values API reads only the route plan's schema-derived data ranges. The default runtime creates the reader per execution, and the handler compares global and relevant tab/source revisions before and after hydration. This revision check detects application writes during a read; direct Sheet edits still bypass revision bookkeeping.
