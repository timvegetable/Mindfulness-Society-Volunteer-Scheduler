# Testing

## Philosophy

Tests protect contracts at the boundaries most likely to fail in production: untrusted requests, identity and role decisions, raw Sheet decoding, revision checks, atomic publication behavior, time-zone semantics, Apps Script runtime compatibility, and deterministic scheduling. Favor a small focused regression over broad implementation-coupled assertions.

Vitest runs in the Node environment and discovers `src/**/*.test.ts`:

```sh
pnpm test
```

Run a focused file while developing:

```sh
npx vitest run src/server/scheduling/scheduling.contract.test.ts
```

## Test layers

- `*.contract.test.ts` exercises a module boundary or cross-module promise. Examples cover dispatcher failures, auth claims, workbook codecs/repositories, imports, scheduling, insights, caching, and bundle compatibility.
- Client unit tests cover API envelope construction and failures, identity state, formatting, route snapshot freshness, and view event wiring.
- `src/server/runtime.contract.test.ts` composes the production runtime against in-memory Sheets and Script Properties. Use it for behavior that depends on handler wiring or revision interaction.
- `src/server/workbook/read-plans.contract.test.ts` checks exact tab resolution, request-local reuse, fresh authorization, and Insights cache hit/miss revision behavior. `src/client/read-probe.test.ts` checks the browser probe's redirect-to-404 HTML failure classification.
- `src/server/workbook/initializer.contract.test.ts` pins effective schema-version resolution, initialization idempotence and the declared protected data columns against regressions that fail on the pre-fix initializer. `control.contract.test.ts` and `control-mutation.contract.test.ts` pin the portable control record codec, the failure taxonomy, idempotent initialization, the mutation lifecycle (script lock, live gate, authority, a pending marker surviving a crash before rows, abort and completion counter rules) and the journal's byte and retention bounds. They exercise the in-memory sheet stand-in, which records protections and models one-cell `setValue`.
- `src/server/workbook/batch-read.contract.test.ts` checks allowlisted ranges, response identity/order/shape, request-local batch extension, and spreadsheet-zone serial decoding. `src/server/batch-runtime.contract.test.ts` checks handler-triggered batch access, Schedule parity, Insights cache-hit/miss plans, authorization, and revision changes during the read. `repository.contract.test.ts` checks that primed rows use the ordinary repository snapshot without further Sheet calls.
- `readOnlyRouteParityReport` in `src/server/main.ts` tests the editor-only live-workbook parity check. It refuses unless `WRITE_ENABLED` is exactly false and its report contains no cell values; run the Apps Script editor wrapper `compareAdvancedReadParity()` only after the new scope is authorized. Contract coverage does not replace that live workbook comparison.
- `src/worker/**/*.test.ts` runs in **workerd**, not Node, through `pnpm run test:worker`. It covers the bounded transport (including the default-disabled `POST /benchmark/schedule-preview` route), the staging configuration, the identity gate, the Google token and key handling with real RSA keys (including the concurrent-cold-verification regression test), and the composed reads compared against the existing runtime over one fixture rendered both ways (Apps Script `Date` cells and REST serial numbers). The isolated Durable Object staging topology adds `src/worker/gateway.test.ts` (forwarding, streamed responses, CORS parity, oversized and chunked bodies, binding-failure envelopes, config-derived object naming, gateway→object end-to-end) and `src/worker/host.test.ts` (benchmark enablement, preview parity across two synthetic fixtures, denial costs, request isolation, storage untouched, first-use telemetry). Because the pool enables Node compatibility flags for its runner, the Worker program's types and the ESLint boundary rules are what keep Node-only globals out.
- The staging measurement tools under `scripts/staging/` have contract tests in `src/server/integration/staging-*.contract.test.ts`: the fixture generator is pinned to the experiment contract's dimensions, and the loader, deploy, probe-host and endpoint verifiers are pinned to their refusal paths. The metrics collector's pure functions are pinned for attribution, documented microsecond units, exact-sample/bucket-aggregate quantile semantics, window splitting, ambiguity detection and coverage gates (`staging-metrics.contract.test.ts`), and the load harness for its rolling-window read budget — including the shared cross-restart ledger — the preview operation's budget, the ≤1,000-attempt campaign attempt ledger shared the same way, the Durable Object version-lag check that gates which cold attempts count (`classifyColdObservation`), the failure taxonomy and manifest validation (`staging-measure.contract.test.ts`, `staging-harness.contract.test.ts`). Those tests never contact Google or Cloudflare. Since the 2026-09-29 preview campaign, the browser probe paces every attempt through the probe host's `/__reserve` endpoint, which holds the same shared read ledger the harness holds — the two sides keep one rolling 40-reads-per-60-seconds window, and the probe's report records `pacedThroughSharedLedger`. Every staged measurement campaign still runs under the predeclared protocol in the archived feasibility evidence; thresholds are never adjusted after results.
- The gateway bundle is audited at build time by `scripts/audit-gateway-bundle.mjs` (wired into `pnpm run build:worker:gateway`): it fails when the gateway bundle contains a production-runtime import, Zod, Temporal, a Node builtin, or key material. The ESLint config carries the matching review-time boundary for `src/worker/gateway.ts`.
- `src/server/scheduling/preview-parity.contract.test.ts` is the permanent differential parity guard for the schedule preview: it runs the live computation and the frozen pre-optimization oracle (`src/server/scheduling/reference/`) side by side over the pinned representative and larger fixtures at both pinned clocks, edge cases, and 12 seeded randomized workbooks, and compares complete envelopes byte for byte. Its fixture-identity test regenerates the deployed staging workbooks digest-for-digest, and its anchor test proves the parity harness matches the real preview handler, so the harness cannot drift from the served operation.
- Pure domain helpers should be tested without Apps Script or a browser.
- Deployed browser verification is evidence for production/OpenSpec tasks, not a substitute for automated regression coverage.

## Client DOM double

Vitest intentionally does not use jsdom. `src/client/views.test.ts` contains a small `FakeDocument`/`FakeNode` surface implementing only what the views touch. Extend that double narrowly when a new view behavior requires a DOM capability. Do not make it emulate general browser layout or validation; use deployed/manual browser verification for those behaviors.

## Regression procedure

For every bug fix:

1. Reproduce the behavior at the smallest owning boundary.
2. Add a test that describes the user-visible or contract failure.
3. Confirm the test fails against the buggy behavior before relying on it. Do this before the fix when possible; otherwise temporarily revert only the fix locally, run the focused test, and restore it.
4. Implement the fix and run the focused test.
5. Run the full suite and static checks:

   ```sh
   pnpm test
   pnpm run check
   ```

6. Run `pnpm run build` when the change can affect bundling, entry-point exposure, or client output. Validate OpenSpec when specs or task evidence changed.

Do not mark an OpenSpec task complete merely because a test exists. Browser, production, performance, or administrator-review tasks require the evidence named in the task.

## Apps Script compatibility

Node provides globals that Apps Script V8 may not. The server bundle audit and `bundle-audit.contract.test.ts` reject unsupported use such as `Buffer`, `process`, `TextDecoder`, unguarded `TextEncoder`/`crypto`, and similar leaks. When fixing an Apps Script-only failure, reproduce it with the relevant global absent; the import tests do this for `TextEncoder`.

## Staging tooling contracts

The staging tools are contract-tested in `src/server/integration/`, driven with injected transports and the shared ledgers rather than the network: `staging-deploy.contract.test.ts` (the `--var` contract, its refusals, and that the plan and report carry the same ordered list), `staging-readcheck.contract.test.ts` (the read-matrix driver: one attempt per check, the shared rolling window, the campaign attempt cap, and the report it writes), `staging-measure.contract.test.ts` (the harness: the rolling read budget, the per-operation read-cost override, the shared campaign ledger and the flush that records a finished run), `staging-probe-host.contract.test.ts` (the browser probe: per-operation quantiles, the per-read timing header and the `?attempts=` contract) and `staging-rehearsal.contract.test.ts` (the runner's argument contract, and that its capture and rollback apply exactly what `activationTransition` and `rollbackTransition` produce, journal first).

A contract test proves the path it drives, not the path the CLI takes: the read-matrix driver's report construction was unreachable from its tests and crashed a live run after spending its attempts. Prefer extracting the assembled artifact into an exported pure function over asserting a string in the source.

Portable measurement regressions also cover mixed-operation phase summaries,
corrupt-ledger refusal, concurrent first ledger loads, private-directory
containment, HTTP 429 responses whose body claims success, and the 95-second
expected-version wait. Harness and browser wall time includes response-body
consumption; each attempt records its measured maximum overlap with active
requests, excluding time spent waiting for a quota reservation. Reports separate
successful expected-version observations with at least three requests in flight
from failures, version lag and lower-concurrency observations. A configured pool
width or phase maximum alone does not establish that population.

`staging-rehearsal-request.contract.test.ts` exercises the actual gateway request
helper: campaign/read reservations precede the straddle, an exhausted budget
prevents its transition, and transport or transition failures retain the request
outcome. Straddle and confirmed matrix tests enforce expected-marker age before
reservations and reject matching envelopes from a wrong version or non-200
response. The registered-mutation probe requires an explicit zero-read count;
Worker-native contracts verify the header and zero backend access. The injection-restore contracts check generation advancement,
unchanged counters, journal-before-control persistence, duplicate-row removal,
and refusal of a mismatched role or unrelated newer state. Worker timing tests
complete concurrent Sheets requests in reverse order to verify that the header
still follows request order. Local contracts do not supply missing live evidence.

## What CI checks

Two workflows split validation from release:

- `.github/workflows/validate.yml` runs on every push and pull request and deploys nothing: `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm test`, `pnpm run test:worker`, `pnpm run build`, and the Worker dry-run build (`pnpm run build:worker`). It needs no secret.
- `.github/workflows/pages.yml` publishes the client and runs only on manual dispatch, so a push is not a deployment. It runs `pnpm install --frozen-lockfile`, private-to-public config rendering, `pnpm run build:client`, the fail-closed client deployment check, and the Pages artifact upload and deployment.

`validate.yml` still does **not** run strict OpenSpec validation, which stays a local planning gate, and it does not deploy. Local full-suite evidence is therefore still required before release; a green validation workflow does not establish server or domain correctness.
