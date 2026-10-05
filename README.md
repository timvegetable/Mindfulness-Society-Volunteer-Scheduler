# Mindfulness volunteer scheduler

A TypeScript application for volunteer availability, deterministic session scheduling, center proposals, and WhenIsGood imports. One Cloudflare Worker serves the Vite SPA and `POST /api` on the same origin; D1 is the system of record. Effect 4 models fallible workflows and external capabilities, and Effect Schema validates requests and results. Pure scheduling rules remain ordinary TypeScript.

## Local setup

Use Node **22.12 or newer** (Node 24 recommended) and npm. Install the locked dependencies:

```sh
npm install
```

The repository uses the current Effect 4 beta, pinned by `package-lock.json`. Wrangler and Miniflare versions are compatible through Wrangler's own runtime dependency. No Cloudflare login or real external-service credentials are needed for tests, local D1, or a dry run.

Initialize the **local** database. `schema.sql` drops and recreates its tables, so use it only for disposable local data:

If your local database is already initialized and contains the private roster, skip initialization and seed loading. The commands below are for a new local database.

```sh
npm run db:init
```

For the operator's roster, place the private `seed.sql` at the repository root; it is ignored by Git. Then run:

```sh
npx wrangler d1 execute DB --local --file=seed.sql
```

Without the private seed, use the public synthetic fixture instead (do not load both seeds):

```sh
npm run db:seed:test
npx wrangler d1 execute DB --local --command="SELECT id, name FROM volunteers ORDER BY id"
```

The fixture has three centers and five fictional volunteers. Tests create a separate, disposable local D1 instance and apply `schema.sql` plus this fixture automatically. The operator's private seed is never required or read by automated tests.

## Configuration and development

`wrangler.jsonc` contains safe placeholders and these defaults:

| Variable | Purpose/default |
| --- | --- |
| `TIME_ZONE` | `America/New_York`; all newly written intervals use it |
| `DISPLAY_INCREMENT_MINUTES` | `30` |
| `OPERATING_HOURS_START`, `OPERATING_HOURS_END` | `09:00`, `21:00` |
| `OAUTH_CLIENT_ID` | Public Google Identity Services client ID |
| `ADMIN_EMAILS` | Comma-separated administrative notification recipients |
| `WHENISGOOD_ENDPOINT` | HTTPS URL template containing `{resultId}` |
| `EMAIL_FROM` | Verified Resend sender address |
| `EMAIL_API_KEY` | Resend API key, a Worker secret |

For real local integrations, override placeholders in a private `.dev.vars` file. Configure Google Identity Services to allow the local Vite origin `http://localhost:5173`. The development command uses `localhost` to match the integration wizard; Google treats `127.0.0.1` as a different origin. The Worker verifies Google signatures with cached public JWKS, audience, issuer, expiration, and verified email, then reads the active user and roles from D1 for every request. Add authorized users to the private local seed; there is no anonymous or development authentication bypass.

A blank `EMAIL_API_KEY` is valid when local email setup was skipped. The application still saves changes, but administrative notifications are not delivered.

Start both local processes:

```sh
npm run dev
```

Open the Vite URL printed in the terminal. Vite proxies `/api` and `/client-config` to the local Worker at port 8787. To run the Worker alone after building client assets:

```sh
npx vite build
npx wrangler dev --local
```

With placeholder credentials, Google sign-in and live imports are intentionally unavailable. Automated tests supply deterministic authentication, clock, IDs, captured email, and saved HTML through Effect services. They never send real email or fetch live WhenIsGood pages. The email adapter uses **Resend**; notification failure is logged after commit and does not undo a successful mutation.

## Validation

```sh
npm test
npm run check
npm run build
npx wrangler deploy --dry-run
```

`npm test` runs Vitest once, including real local D1 transaction tests. `check` runs strict TypeScript checking with unchecked-index protection. `build` builds the SPA and validates the Worker through Wrangler's deployment dry run; it does not deploy.

Tests cover deterministic ranking and availability overlays, every role/operation combination, dated candidate confirmation, cancellation with live backup revalidation, import fixture parsing and atomic promotion, stale revisions, concurrent competing mutations, durable replay, and post-commit notification failures. See [TASKS.md](TASKS.md) for implementation and verification evidence.

GitHub Actions runs these checks on pushes and pull requests, with a manual run option. CI uses Node 24, locked dependencies, synthetic fixtures, and disposable local D1 databases. It requires no repository secrets or private seed, and the deployment command is a dry run only.

## Architecture and concurrency

- `src/shared/` contains Effect Schemas and pure intervals, availability, scheduling, coverage, and insights.
- `src/worker/` contains typed Effect workflows, capability services, D1 repositories, and the HTTP boundary.
- `src/client/` contains the SPA and response validation. Google credentials remain in memory only.
- `schema.sql` is the destructive local initializer; `migrations/0001_idempotency.sql` is the additive production migration.

Every mutation requires a reviewed `expectedRevision` and an `idempotencyKey`. Replays are scoped by actor and operation and compare a canonical serialization of validated, normalized payloads. Identical retries return the stored response bytes even after other writes advance the revision; changed input with the same key is rejected.

Repository snapshots are read in one D1 batch. A mutation batch begins with a revision assertion that causes a database constraint failure when the expected revision is stale. Domain changes, exactly one global revision increment, any scheduling-input increment, 24-hour replay cleanup, and the successful response record commit together. Any failure rolls the batch back. Application handlers never issue raw SQL. This relies on [D1's transactional batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) and is tested with concurrent local D1 requests.

Publication retains old outputs and chooses the greatest completed output revision. Schedule preview writes nothing. Candidate confirmation consumes one proposal into its next dated occurrence. Advisory candidate coverage does not reserve volunteers. Insights are computed from current data, without a persisted cache.

## Production procedure — explicit operator action required

**The following commands modify production. Do not run them without explicit approval for that specific action. Never run `schema.sql` against production.** The implementation process does not create remote resources, deploy, or modify the existing database.

The production D1 database `mindfulness-scheduler-prod` already has the base domain tables. Supply its actual `database_id` in a private production Wrangler configuration copied from `wrangler.jsonc`; keep the placeholder tracked configuration unchanged. Configure the public Worker variables for the production origin and real OAuth client. Supply the Resend secret separately; never commit it or the roster.

After reviewing and exporting a current database backup, apply only the additive idempotency migration:

```sh
# PRODUCTION READ: writes a private local backup. Keep it outside Git.
npx wrangler d1 export mindfulness-scheduler-prod --remote --config wrangler.production.local.json --output=backup.local.sql
# PRODUCTION WRITE: explicit approval required.
npx wrangler d1 execute mindfulness-scheduler-prod --remote --config wrangler.production.local.json --file=migrations/0001_idempotency.sql
# PRODUCTION SECRET WRITE: explicit approval required; enter the key interactively.
npx wrangler secret put EMAIL_API_KEY --config wrangler.production.local.json
```

Run the full validation suite and a dry run using the reviewed production config before deploying. Then, only after separate explicit deployment approval:

```sh
# PRODUCTION DEPLOYMENT: explicit approval required.
npx wrangler deploy --config wrangler.production.local.json
```

Verify the same-origin client, Google sign-in, role-specific reads, and the current schedule. Any live mutation or notification test requires its own explicit approval. Keep the previous Worker version available for rollback; restoring application code does not restore database data.
