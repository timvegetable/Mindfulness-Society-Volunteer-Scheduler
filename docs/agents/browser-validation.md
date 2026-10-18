# Synthetic browser validation

Use this workspace for native rendering and interaction checks with long tables. It imports the real client and stylesheet, provides 40 synthetic records per table, and validates responses through the real API client. It does not exercise Google authentication, the Worker, D1, or third-party compatibility.

## Launch and establish the target

Run `npm run dev:browser`, wait for **Preview ready**, then open `http://localhost:5174/__browser-check`. The launcher rejects occupied ports, stops its Vite child on exit, and retains logs at the path it reports. Override the log location with `-- --log-file /tmp/browser-preview.log`.

Before navigating after a turn boundary, run `npm run dev:browser:status` with loopback access. It exits successfully only when the synthetic harness responds. If navigation previously failed, navigate to the intended localhost URL; reloading the browser's generated error page may reload a blocked data URL.

This opt-in Vite configuration serves the harness interactively or builds it for browser tests; the production build uses the normal entry point. Both modes use the same HTML entries and synthetic responses. The harness replaces fetch with synthetic responses, simulates reads, previews, synchronization and participant links entirely in browser memory. Other operations are rejected. No database or private configuration is required.

Resize the harness tab to the intended dimensions. Enter those dimensions in its expected width and height fields, or use `?width=390&height=844` in the URL. Click **Check current view**. The report verifies the target path, actual viewport, completed rendering, page containment, table containment, full-height schedule rows, bounded scroll regions on other views, sticky headers, row count, and keyboard focus attributes. A mismatch is a failed check; record the actual dimensions. This catches a resize applied to another tab and stale stylesheet state.

## Exercise each workflow

For interactive volunteer and center-contact UI testing without Google sign-in, open `http://localhost:5174/__role-check`. Use the Test role selector to switch roles and Reset test data to restore the fixture. Weekly availability is shown read-only, with changes directed through WhenIsGood. Dated exceptions, assignment cancellation, and proposal creation/editing/withdrawal update fictional data in browser memory only. Switching roles or resetting clears those changes. The workspace uses the real client and response decoding with a simulated API; it does not verify Google authentication, Worker authorization, D1 persistence, email, or scheduling-rule correctness. The opt-in development route is excluded from production assets.

At desktop and mobile sizes:

1. Check Schedule, then use **Preview schedule** and **Back to published schedule**.
2. Open Availability sync. Check the status and pending-participant table, then use **Sync now** and link a synthetic participant to a roster record. These are browser-memory simulations, with no external fetch or database write.
3. Open Insights and check both tables. Change overlap sorting between weekday/time and descending count. Inspect count ties and select a heatmap interval to compare its names and count with the table.
4. Open Center proposals and check its table.
5. On Schedule, confirm every row is reachable by page scrolling, without a vertically clipped inner table. On other views, focus each scroll region with Tab, press End, and confirm rows scroll while the header stays pinned. Scroll horizontally to reveal trailing columns. These native keyboard checks supplement the report's programmatic scroll measurement.

Capture screenshots only after the report passes. Include its URL, dimensions, page, and table measurements with the evidence. Restore the normal viewport when finished. Reloading this harness signs in synthetically again; real-preview checks still require the user's Google sign-in.

## Automated checks

Install Chromium once with `npx playwright install chromium`, then run `npm run test:browser` with loopback access. The suite builds the synthetic entries once into a unique temporary directory and serves those fixed assets, without hot reload. Later source edits do not change the running suite; start a new run to validate them. The temporary build is removed when the owned server stops.

Automated checks use port 5175, independently of the interactive preview on 5174. Override the test port with `BROWSER_TEST_PORT=5180 npm run test:browser` when needed. An occupied test port fails startup; the runner does not reuse or stop someone else's server.

The suite checks the same layout report at desktop, tablet, and mobile sizes, logo loading, schedule preview and return, keyboard scrolling, and tables in synchronization, insights, and center proposals. Role checks simulate source updates and verify no periodic requests, explicit reload, draft preservation, stale-save recovery, focus, and scroll. It uses the system font fallback to avoid third-party network dependencies.

Failures retain screenshots and traces under ignored `test-results/`; CI uploads that directory. These tests exercise native Chromium rendering against synthetic responses, not authentication or Worker integration. They supplement visual inspection rather than judge visual quality.

The functional suite also checks both friendly interactive routes against a disposable Vite server, including successful JavaScript responses for their module entries. A successful HTML response alone does not establish that the harness can load.

## Design and asset inspection

Read [PRODUCT.md](../../PRODUCT.md) for organization identity and the supplied logo. Use `src/client/app.ts` or `src/client/style.css` as a filesystem target for design tools; route names are not source paths.

For SVG inspection, run `python3 scripts/inspect-svg.py <path>` to see dimensions, shapes, colors, and metadata size without dumping provenance payloads. View the served SVG in the browser to assess its appearance. Preserve the supplied asset and its metadata.

The stylesheet groups each selector's declarations together, with responsive overrides in the final media block. Run `npm run format:css` after editing and `npm run format:check` to verify its formatting.
