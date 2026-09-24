# Volunteer Session Scheduling

Volunteer session scheduling for a mindfulness society. Google Sheets is the system of record, a spreadsheet-bound Google Apps Script web app exposes a privileged JSON operation API, and a static TypeScript client is served from GitHub Pages.

## How it works

```text
Browser on GitHub Pages (untrusted)
  |  Google Identity Services credential + named operation + payload
  v
Apps Script web app (runs as the deploying Sheet owner)
  adapter -> dispatcher -> authenticated operation handler -> workbook repositories
  v
Protected Google Sheet tabs + Apps Script Script Properties (revisions/counters)
```

- The client only sends named operations (`src/client/api.ts`); it never supplies Sheet names, ranges, roles, or ownership.
- The server (`src/server/integration/dispatcher.ts`) validates the envelope and payload (Zod), verifies the Google ID credential, enforces role policy, serializes mutations under a script lock, and checks optimistic concurrency via the global `DATA_REVISION`.
- Roles come from the `Users` tab: `volunteer` (own records only), `center-contact` (own centers, cannot confirm sessions), `administrator` (aggregate/admin operations). Every operation is authorized server-side.
- Scheduling is a pure calculation over a normalized workbook snapshot. Scheduling preview writes nothing; publication writes a complete assignment/backup/run output under locks.
- See [`docs/architecture.md`](docs/architecture.md) before changing application boundaries, persistence, authorization, revisions, or server operations.

## Repository layout

```text
src/client/    Browser application (untrusted for auth/concurrency)
src/server/    Apps Script backend, domain services, workbook layer
src/shared/    Environment-neutral Zod schemas and time helpers
scripts/       Build, config validation, deployment checks, probes, rollback
config/        Configuration schemas and public examples
docs/          Architecture, development, testing, deployment, operations, security
docs/subsystems/  Module ownership and detailed contracts
openspec/      Specifications and open work (source of truth for remaining tasks)
public/        Static assets; config.json is generated for deployment, not committed
```

Key rules: TypeScript `strict` with `noUncheckedIndexedAccess`; `src/shared/` stays environment-neutral; all Sheet parsing lives in `src/server/workbook/`; recurring availability is semantic interval coverage, not stable row identity.

The [backend migration roadmap](openspec/changes/validate-worker-backend-feasibility/design.md) defines proposed Worker work and its six prerequisite-gated changes. It has not replaced the deployed Apps Script backend.

## Prerequisites

- Node 22, npm, the repository lockfile.
- `clasp` (via project tooling) only for Apps Script deployment work; ordinary development and tests do not need it.

## Quickstart

```sh
npm ci
npm run dev        # Vite client on :5173
```

For a realistic local sign-in flow you need a generated `public/config.json`, an OAuth client that permits the local origin, and a reachable Apps Script `/exec` deployment. The endpoint is production-capable even when the UI is local — keep the live write gate disabled unless a specifically approved test requires otherwise.

Private configuration (gitignored, never committed):

```sh
# copy config/production.example.json to production.local.json,
# replace every placeholder, keep writeEnabled false
node scripts/validate-config.mjs --config production.local.json
node scripts/render-public-config.mjs --config production.local.json --output public/config.json
```

`public/config.json` contains only the Apps Script URL, public OAuth client ID, and time zone.

## Commands

```sh
npm ci
npm run dev      # local Vite client
npm run build    # client + Apps Script bundle + bundle audit
npm test         # Vitest, watch disabled
npm run check    # tsc --noEmit + ESLint with zero warnings
```

There is no separate lint or typecheck command. Deployment commands and verification procedures live in [`docs/deployment.md`](docs/deployment.md).

## Testing

```sh
npm test
npm run check
```

Testing policy: [`docs/testing.md`](docs/testing.md). For every behavior change, add or update tests covering the changed behavior; for bug fixes, confirm the regression test fails without the fix. Vitest discovers `src/**/*.test.ts` (no jsdom — client views use a narrow `FakeDocument` double). The Pages workflow does not run the full local suite, so local `npm test` + `npm run check` (+ `npm run build` when bundling is affected) evidence is required before release.

## Configuration and security

- Private config (`*.local.json`, `.clasp.json`, Sheet IDs, credentials, roster/export material) is never committed. Identifiers such as the Apps Script URL and OAuth client ID are public; client secrets, tokens, and workbook data are not.
- The Apps Script web app is reachable by anyone at the platform layer so the static cross-origin client can call it; every operation still requires and verifies a Google credential.
- Never accept client-supplied roles, ownership, center scope, or Sheet references — see [`docs/security.md`](docs/security.md).

## Production safety

Read [`docs/operations.md`](docs/operations.md) and [`docs/deployment.md`](docs/deployment.md) before touching anything live.

- Do not push, deploy, or mutate production unless explicitly asked. Pushes and deployments are approved one at a time.
- Mutations are gated by the live `WRITE_ENABLED` Script Property. Never infer live state from `production.local.json` or deployment reports — verify it in the bound Apps Script project (e.g. via `describeSignIn`) before any production mutation.
- Prefer the application's own operations for Sheet mutations; direct Sheet/API writes bypass audit and revision bookkeeping (`TAB_REVISION_<TabName>`, `SCHEDULING_INPUT_REVISION`, global `DATA_REVISION`).
- Export a workbook snapshot before any server deployment or production Sheet mutation.
- `scripts/rollback.mjs` generates a rollback checklist; it does not roll back automatically.

## Documentation

| Topic | Document |
| --- | --- |
| End-to-end flow, boundaries, authorization, revisions | [`docs/architecture.md`](docs/architecture.md) |
| Installation, configuration, build, local loop | [`docs/development.md`](docs/development.md) |
| Test layers, regression procedure, CI gaps | [`docs/testing.md`](docs/testing.md) |
| Release, verification, snapshots, rollback | [`docs/deployment.md`](docs/deployment.md) |
| Secrets, public/private config, trust boundaries | [`docs/security.md`](docs/security.md) |
| Live write gate, diagnostics, probes | [`docs/operations.md`](docs/operations.md) |
| Module contracts | [`docs/subsystems/`](docs/subsystems/) |
| Open work and task state | [`openspec/changes/`](openspec/changes/) |
