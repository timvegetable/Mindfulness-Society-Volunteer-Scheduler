# Synthetic browser validation

Use this workspace for native rendering and interaction checks with long tables. It imports the real client and stylesheet, provides 40 synthetic records per table, and validates responses through the real API client. It does not exercise Google authentication, the Worker, D1, or third-party compatibility.

## Launch and establish the target

Run `npm run dev:browser`, then open `http://localhost:5174/__browser-check`. This separate Vite configuration serves the harness only during development; the production build uses the normal entry point. The harness replaces fetch with synthetic responses, permits reads and previews, and rejects other operations. No database or private configuration is required.

Resize the harness tab to the intended dimensions. Enter those dimensions in its expected width and height fields, or use `?width=390&height=844` in the URL. Click **Check current view**. The report verifies the target path, actual viewport, completed rendering, page containment, bounded table styles, sticky headers, row count, and keyboard focus attributes. A mismatch is a failed check; record the actual dimensions. This catches a resize applied to another tab and stale stylesheet state.

## Exercise each workflow

At desktop and mobile sizes:

1. Check Schedule, then use **Preview schedule** and **Return to published schedule**.
2. Open Import availability, enter `synthetic`, and select **Preview results**. Check its participant table. This is synthetic staging, not an external fetch.
3. Open Insights and check both tables. Change overlap sorting between weekday/time and descending count. Inspect count ties and select a heatmap interval to compare its names and count with the table.
4. Open Center proposals and check its table.
5. Focus each scroll region with Tab, press End, and confirm rows scroll while the header stays pinned. Scroll horizontally to reveal trailing columns. These native keyboard checks supplement the report's programmatic scroll measurement.

Capture screenshots only after the report passes. Include its URL, dimensions, page, and table measurements with the evidence. Restore the normal viewport when finished. Reloading this harness signs in synthetically again; real-preview checks still require the user's Google sign-in.
