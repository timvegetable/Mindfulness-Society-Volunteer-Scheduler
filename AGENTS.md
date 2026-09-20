# AGENTS.md

Volunteer session scheduling for a mindfulness society: Google Sheets is the system of record, a Google Apps Script web app dispatches the JSON operation API, and a static TypeScript client is served from GitHub Pages.

## Memory (mnemosyne MCP)
Tools: `mnemosyne_remember`, `mnemosyne_recall`, `mnemosyne_forget`.
Recall relevant memories at session start; `remember` durable facts/decisions immediately with `scope`/`importance`; no secrets.

## Setup commands

- Install deps: `npm ci`
- Start dev:    `npm run dev` (Vite)
- Build:        `npm run build` (Vite client, then the Apps Script bundle + bundle audit)
- Test:         `npm test` (Vitest, watch off)
- Check:        `npm run check` (`tsc --noEmit` then `eslint src --max-warnings=0`)

There is no separate lint or typecheck script — `check` runs both. `npm run deploy:server` pushes the built bundle with clasp; prefer the guarded form under Deployment below.

## Project layout

- `src/client/` — browser app: `main.ts` (routes, actions, config), `views.ts` (pure view functions), `api.ts`, `identity.ts`, `format.ts`, `route-loader.ts`
- `src/server/` — Apps Script backend: `runtime.ts` wires every operation handler; `integration/` (dispatcher, auth, projections), `workbook/` (tab schema, repositories, codecs), plus `centers/`, `scheduling/`, `insights/`, `imports/`, `self-service/`
- `src/shared/` — domain schemas and time helpers used by both sides; keep it environment-neutral
- `scripts/` — build, deploy, probe, migration and rollback tooling; `scripts/lib/config.mjs` validates configuration
- `config/` — JSON schemas and `production.example.json` for the private configuration
- `openspec/changes/volunteer-session-scheduling/` — proposal, design, specs and `tasks.md` (the single source of open work)
- `public/` — static assets; `public/config.json` is generated at deploy time
- `migration-output/`, `scrubbed_exports/` — private roster and export material, never commit

## Code style

- TypeScript `strict` plus `noUncheckedIndexedAccess`, so indexed access yields `T | undefined`
- ESLint flat config (`eslint.config.js`), warning-free (`--max-warnings=0`)
- All Sheet parsing belongs to the codecs in `src/server/workbook/`; keep raw Sheet access inside that layer
- Match the surrounding style: small pure functions, explicit failure codes, no new dependencies without a reason

## Testing instructions

- `npm test` — Vitest, node environment, `include: ['src/**/*.test.ts']`; contract tests are named `*.contract.test.ts`
- Client view tests use a small hand-written DOM double in `src/client/views.test.ts`, not jsdom
- Add a test for every behaviour change, and prove a regression test actually catches the bug by reverting the fix and confirming the test fails
- `.github/workflows/pages.yml` runs only `npm ci`, the config render, `npm run build:client` and the fail-closed deployment check — it does **not** run tests, lint or typecheck, so run `npm test` and `npm run check` locally before deploying

## Commit and deploy conventions

- Commit messages: imperative subject, then a body explaining cause, effect and the evidence; existing history is the model
- Pushes and deploys are approved one at a time — do not push, deploy or mutate production without being asked, and leave housekeeping edits (`.gitignore`, this file) uncommitted unless asked
- Validate the change with `openspec validate volunteer-session-scheduling --strict` before committing task updates

## Project notes

- `tasks.md` is the source of truth for what remains: only tick a task when evidence supports it, and record new follow-ups there as `10.x` entries carrying their own measured numbers
- The production write gate is not what the local config claims: `production.local.json` and the deploy reports assume `writeEnabled: false`, but the live `WRITE_ENABLED` Script Property has been `true`. Confirm it (run `describeSignIn` in the Apps Script editor) before any production mutation
- Expect route reads to be slow: each Schedule/Insights read performs several sequential Sheet reads (~6 s p95 measured against the 2 s objective in `responsive-application-navigation`). `src/server/appsscript.json` uses only `spreadsheets.currentonly` with no Advanced Sheets Service, so batching ranges requires a deliberate scope change
- Script Properties hold the tab revisions (`TAB_REVISION_<Tab>`, `SCHEDULING_INPUT_REVISION`, `DATA_REVISION`) and cannot be written remotely, so a direct Sheet write is invisible to the app's staleness and concurrency bookkeeping — prefer the app's own operations and re-read to confirm
- Recurring availability is coalesced on save (`normalizeIntervals`), so row counts can drop without any coverage change; verify availability by diffing minute-level coverage, never row ids

## Security

- Never commit secrets: `.env*`, `*.local.json`, `.clasp.json`, `migration-output/`, `scrubbed_exports/` are gitignored, and `public/config.json` is generated at deploy time from the private configuration
- The private configuration holds the sheet id, OAuth audience, administrator recipients and the write flag — keep it out of the published bundle (`scripts/deployment-check.mjs` fails closed if private keys or credential markers appear in `dist/`)
- The client stores route snapshots in memory only, keyed by email and role; cached data must never authorise a mutation or be persisted
- Direct Sheets API writes bypass the app's audit log and revisions — treat them as a last resort, snapshot first, and report exactly what changed

## Deployment

- Server (Apps Script), guarded:
  `node scripts/deploy-apps-script.mjs --config production.local.json --server-dist dist/apps-script --report dist/apps-script-deploy-report.json --deployment-id <pinned-id> --execute --confirm DEPLOY_APPS_SCRIPT_WITH_WRITES_DISABLED`
- Client (GitHub Pages): `git push origin master`, then `gh workflow run pages.yml --ref master`; verify by comparing the served `/assets/index-*.js` sha256 against `dist/client/assets/`
- Endpoint health: `node scripts/probe-service.mjs --config production.local.json`
- Export a workbook snapshot before server deploys and before any Sheet mutation
