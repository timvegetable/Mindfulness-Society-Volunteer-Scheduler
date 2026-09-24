# Client subsystem

## Ownership

`src/client/main.ts` composes configuration, identity, routes, route controllers, parsing, and actions. `api.ts` is the sole network boundary. `identity.ts` owns Google Identity Services state. `route-loader.ts` owns in-memory freshness. `views.ts` builds DOM. `format.ts` owns human-readable labels.

## Contracts

- Load `/config.json` and accept only a valid HTTPS Apps Script URL, public OAuth client ID, and time zone. The configured service host is constrained to Apps Script/Google user-content hosts.
- Send cookieless `POST` requests as `text/plain;charset=utf-8`; include a fresh idempotency key and credential, plus `expectedRevision` for mutations.
- Operation names and request helpers are explicit. Do not add a generic range/query method.
- The browser never decodes the Google credential as verified identity. `IdentityController` becomes authenticated only after `session.me` succeeds.
- Route data is parsed before rendering. Invalid server shapes fail visibly rather than becoming partial trusted state.
- Route snapshots are keyed by email, primary role, and route. Identity changes clear them; concurrent reads coalesce; superseded responses are discarded; successful mutations invalidate and reload the route.
- Snapshots are presentation only. Every mutation carries the current credential and server revision.
- Views use DOM construction and `textContent`, not untrusted HTML interpolation.

The primary role is a navigation choice: administrator wins over center contact, which wins over volunteer. Do not use it as proof of server authorization.

## Tests

API tests pin envelopes and error mapping. Identity tests pin state transitions. Route-loader tests pin cache isolation and late-response behavior. View tests use the Node-only `FakeDocument`/`FakeNode` double; extend it only for APIs the view actually touches.

Schedule and Insights freshness objectives are measured from the browser's `route-load` durations, including failed reads; server phase timing is diagnostic evidence only. The active `meet-read-latency-objective` change still owns the 2000 ms nearest-rank p95 decision. The approved server batch path has no post-change production measurements yet, so it does not change the browser objective or probe rules.
