# Development workflow

## Prerequisites and setup

Use Node 22, npm, and the repository lockfile:

```sh
npm ci
```

For Apps Script work, install/authenticate `clasp` through the project tooling and keep `.clasp.json` local. Deployment requires an administrator-owned Apps Script project; ordinary development and tests do not.

Create private configuration from `config/production.example.json` in a gitignored `*.local.json` file. Replace every placeholder and keep `writeEnabled` false. Validate it without publishing anything:

```sh
node scripts/validate-config.mjs --config production.local.json
```

The private file contains deployment and Sheet metadata. Generate only the safe browser projection:

```sh
node scripts/render-public-config.mjs --config production.local.json --output public/config.json
```

`public/config.json` contains the Apps Script URL, public OAuth client ID, and time zone. It is generated and gitignored. Never add private fields to it.

## Normal loop

1. Recall relevant project memory and read the OpenSpec task and subsystem document.
2. Inspect the current implementation and tests; do not infer task completion from code presence.
3. Make the smallest boundary-respecting change and add or update a test.
4. Run the focused test while iterating.
5. Run the full local gates:

   ```sh
   npm test
   npm run check
   npm run build
   ```

6. If task/spec state changed, update `openspec/changes/volunteer-session-scheduling/tasks.md` with evidence and run:

   ```sh
   openspec validate volunteer-session-scheduling --strict
   ```

Do not push or deploy as part of this loop unless the user separately approves that action.

## Local client

Start Vite on port 5173:

```sh
npm run dev
```

The client loads `/config.json`. A realistic sign-in flow therefore needs a generated public config, an OAuth client that permits the local origin, and a reachable public Apps Script `/exec` deployment. The endpoint is still production-capable even when the UI is local: keep the live write gate disabled unless a specifically approved test requires otherwise.

The Vite client uses a relative production base and builds to `dist/client`:

```sh
npm run build:client
```

## Apps Script build

Build the server with:

```sh
npm run build:server
```

This sequence:

1. bundles the TypeScript server to `dist/apps-script/Code.js` with esbuild;
2. audits the emitted bundle for Node-only or unsupported globals;
3. exposes Apps Script entry points as top-level functions;
4. copies `src/server/appsscript.json` into the distribution.

The runtime is V8 and synchronous. Do not return promises from operation handlers. The approved Schedule/Insights read trial enables the Sheets v4 advanced service and adds `spreadsheets.readonly` alongside the existing current-spreadsheet, external-request, and mail scopes. This scope expands the deploying user's read authority beyond the bound workbook; see [security](security.md) and [deployment](deployment.md) before changing or deploying the manifest.

The server build minifies while retaining the English-only Zod locale exclusion. `dist/bundle-evidence.json` records esbuild inputs, per-input emitted contributions, and final bytes outside the clasp upload directory. Use `node scripts/bundle-server.mjs --unminified-trial` and `node scripts/compare-server-bundles.mjs` for a synthetic, read-only bundle comparison; that benchmark does not reproduce remote Sheet or browser latency.

`npm run deploy:server` and `npm run deploy` call `clasp` and can mutate the deployed project. Do not use them as build commands; follow [deployment.md](deployment.md) and use the guarded deployment script only after explicit approval.

## Code conventions

- TypeScript is strict with `noUncheckedIndexedAccess`.
- Shared code must remain environment-neutral.
- Decode and encode Sheet cells in workbook codecs; do not spread raw values through domain services.
- Prefer pure helpers and injected repository/clock/id dependencies.
- Preserve narrow explicit error codes and strict request schemas.
- Add a dependency only when the existing platform and helpers cannot reasonably solve the problem.
- Treat normalized availability as coverage, not stable row identity.
