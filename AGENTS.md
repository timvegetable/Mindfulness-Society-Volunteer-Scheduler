# AGENTS.md

Volunteer session scheduling for a mindfulness society. Google Sheets is the system of record, a Google Apps Script web app exposes the JSON operation API, and a static TypeScript client is served from GitHub Pages.

Read `docs/architecture.md` before changing application boundaries, persistence, authorization, revisions, or server operations. Follow `docs/AGENTS.md` when changing documentation. Open work lives in the active change task lists under `openspec/changes/`.

## Critical safety rules

* Do not push, deploy, or mutate production unless explicitly asked. Pushes and deployments are approved one at a time.
* Never infer production write state from `production.local.json` or deployment reports. Follow `docs/operations.md` and verify the live `WRITE_ENABLED` Script Property before any production mutation.
* Prefer the application's own operations for Sheet mutations. Direct Sheet/API writes bypass audit and revision bookkeeping; follow `docs/operations.md` if one is unavoidable.
* Export a workbook snapshot before any server deployment or production Sheet mutation.
* Never commit secrets or private roster/export material.

## Memory (mnemosyne MCP)

Tools: `mnemosyne_remember`, `mnemosyne_recall`, `mnemosyne_forget`.

Recall relevant project memories at session start. Remember durable project facts and decisions with appropriate `scope` and `importance`; do not store secrets, transient debugging state, command output, or short-lived observations.

## Repository layout

```text
src/client/    Browser application
src/server/    Apps Script backend and domain services
src/shared/    Environment-neutral schemas and time helpers
scripts/       Build, deployment, probes, migrations, rollback
config/        Configuration schemas and public examples
docs/          Architecture, development and operational documentation
openspec/      Specifications and source of open work
public/        Static assets; config.json is generated for deployment
```

Detailed architecture: `docs/architecture.md`.

Private material under `migration-output/` and `scrubbed_exports/` must never be committed.

## Commands

```sh
npm ci
npm run dev
npm run build
npm test
npm run check
```

* `npm run build` builds the Vite client, Apps Script bundle, and bundle audit.
* `npm test` runs Vitest with watch disabled.
* `npm run check` runs `tsc --noEmit` followed by ESLint with zero warnings.
* There is no separate lint or typecheck command.

Deployment commands and verification procedures live in `docs/deployment.md`.

## Development conventions

* TypeScript is `strict` with `noUncheckedIndexedAccess`.
* Keep `src/shared/` environment-neutral.
* All Sheet parsing belongs in `src/server/workbook/`; raw Sheet access stays inside that layer.
* Match surrounding style: small pure functions, explicit failure codes, and no new dependency without a concrete reason.
* Cached client data is never an authority for server mutations.
* Recurring availability is semantic interval coverage, not stable row identity. See `docs/subsystems/scheduling.md`.

## Testing

Testing policy: `docs/testing.md`.

For every behavior change, add or update tests that exercise the changed behavior. For bug fixes, verify that the regression test fails without the fix.

Before considering code work complete, run the smallest relevant tests and then:

```sh
npm test
npm run check
```

The Pages workflow does not run the complete local validation suite; see `docs/testing.md`.

## OpenSpec and task state

`openspec/changes/` is the source of truth for remaining work.

* Do not mark a task complete without evidence.
* Record newly discovered follow-ups there as entries with their own measured evidence.
* Validate specification changes with:

```sh
openspec validate <change-name> --strict
```

Do not infer OpenSpec task completion merely because corresponding code exists.

## Commits

Commit subjects are imperative. Bodies explain cause, effect, and verification evidence; follow existing history.

Do not push or deploy unless explicitly asked. Leave unrelated housekeeping edits such as `.gitignore` or this file uncommitted unless the requested task specifically includes them.

## Required references

* Architecture: `docs/architecture.md`
* Development workflow: `docs/development.md`
* Testing policy: `docs/testing.md`
* Deployment and rollback: `docs/deployment.md`
* Production operations and revision bookkeeping: `docs/operations.md`
* Security and configuration: `docs/security.md`
