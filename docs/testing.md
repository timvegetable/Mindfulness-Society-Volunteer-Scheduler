# Testing

## Philosophy

Tests protect contracts at the boundaries most likely to fail in production: untrusted requests, identity and role decisions, raw Sheet decoding, revision checks, atomic publication behavior, time-zone semantics, Apps Script runtime compatibility, and deterministic scheduling. Favor a small focused regression over broad implementation-coupled assertions.

Vitest runs in the Node environment and discovers `src/**/*.test.ts`:

```sh
npm test
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
- `src/server/workbook/batch-read.contract.test.ts` checks allowlisted ranges, response identity/order/shape, request-local batch extension, and spreadsheet-zone serial decoding. `src/server/batch-runtime.contract.test.ts` checks handler-triggered batch access, Schedule parity, Insights cache-hit/miss plans, authorization, and revision changes during the read. `repository.contract.test.ts` checks that primed rows use the ordinary repository snapshot without further Sheet calls.
- `readOnlyRouteParityReport` in `src/server/main.ts` tests the editor-only live-workbook parity check. It refuses unless `WRITE_ENABLED` is exactly false and its report contains no cell values; run the Apps Script editor wrapper `compareAdvancedReadParity()` only after the new scope is authorized. Contract coverage does not replace that live workbook comparison.
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
   npm test
   npm run check
   ```

6. Run `npm run build` when the change can affect bundling, entry-point exposure, or client output. Validate OpenSpec when specs or task evidence changed.

Do not mark an OpenSpec task complete merely because a test exists. Browser, production, performance, or administrator-review tasks require the evidence named in the task.

## Apps Script compatibility

Node provides globals that Apps Script V8 may not. The server bundle audit and `bundle-audit.contract.test.ts` reject unsupported use such as `Buffer`, `process`, `TextDecoder`, unguarded `TextEncoder`/`crypto`, and similar leaks. When fixing an Apps Script-only failure, reproduce it with the relevant global absent; the import tests do this for `TextEncoder`.

## What CI checks

`.github/workflows/pages.yml` is a manually dispatched deployment workflow. It currently runs:

- `npm ci`;
- private-to-public config rendering;
- `npm run build:client`;
- the fail-closed client deployment check;
- Pages artifact upload and deployment.

It does **not** run `npm test`, `npm run check`, the server build/audit, or OpenSpec validation. Local full-suite evidence is therefore required before release; a green Pages workflow does not establish server or domain correctness.
