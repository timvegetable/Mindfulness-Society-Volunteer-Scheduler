# Mindfulness volunteer scheduler

A TypeScript application for volunteer availability, deterministic session scheduling, center proposals, and WhenIsGood imports. One Cloudflare Worker serves the Vite SPA and `POST /api` on the same origin; D1 is the system of record. Effect 4 models fallible workflows and external capabilities, and Effect Schema validates requests and results. Pure scheduling rules remain ordinary TypeScript.

## Local setup

Use Node **22.12 or newer** (Node 24 recommended) and npm. Install the locked dependencies:

```sh
npm install
```

The repository uses the current Effect 4 beta, pinned by `package-lock.json`. Wrangler and Miniflare versions are compatible through Wrangler's own runtime dependency. No Cloudflare login or real external-service credentials are needed for tests, local D1, or a dry run.

Initialize the **local** database. `schema.sql` drops and recreates its tables, so use it only for disposable local data:

If your local database is already initialized and contains the private roster, skip initialization and seed loading. Apply the additive synchronization migration before starting this version; it preserves the roster and import history:

```sh
WRANGLER_WRITE_LOGS=false WRANGLER_SEND_METRICS=false npx wrangler d1 execute DB --local --file=migrations/0002_synchronization.sql
```

The initialization commands below are for a new local database.

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

For an initialized local database that already has the idempotency and synchronization tables, add the job tables without resetting the roster:

```sh
npx wrangler d1 execute DB --local --file=migrations/0003_synchronization_jobs.sql
```

Wrangler emulates the configured Queues locally; development does not require creating remote queues. Do not rerun the destructive initializer or seed an existing private roster just to add the pipeline.


## Configuration and development

All application dates and intervals use the fixed `America/New_York` time zone, including daylight-saving transitions. The legacy `TIME_ZONE` environment variable does not override it.

`wrangler.jsonc` contains safe placeholders and these defaults:

| Variable | Purpose/default |
| --- | --- |
| `DISPLAY_INCREMENT_MINUTES` | `30` |
| `SYNC_DEAD_LETTER_QUEUE` | `mindfulness-scheduler-sync-dead`; must match the dead-letter consumer name |
| `OPERATING_HOURS_START`, `OPERATING_HOURS_END` | `09:00`, `21:00` |
| `OAUTH_CLIENT_ID` | Public Google Identity Services client ID |
| `ADMIN_EMAILS` | Comma-separated administrative notification recipients |
| `EMAIL_FROM` | Verified Resend sender address |
| `EMAIL_API_KEY` | Resend API key, a Worker secret |
| `EMAIL_PROVIDER` | `resend` by default; `gmail` selects Gmail API delivery |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Worker secrets for the authorized Gmail sender |

For real local integrations, override placeholders in a private `.dev.vars` file. Configure Google Identity Services to allow the local Vite origin `http://localhost:5173`. The development command uses `localhost` to match the integration wizard; Google treats `127.0.0.1` as a different origin. The Worker verifies Google signatures with cached public JWKS, audience, issuer, expiration, and verified email, then reads the active user and roles from D1 for every request. Add authorized users to the private local seed; there is no anonymous or development authentication bypass.

A blank `EMAIL_API_KEY` is valid when local email setup was skipped. The application still saves changes, but administrative notifications are not delivered.

Start both local processes:

```sh
npm run dev
```

Open the Vite URL printed in the terminal. Vite proxies `/api` and `/client-config` to the local Worker at port 8787.

The launcher reports readiness for both services and rejects occupied ports. Optionally retain local diagnostics with `npm run dev -- --log-file /tmp/scheduler-preview.log`. These logs may contain private data; keep them local.

For credential-free browser layout checks, run `npm run dev:browser` and open `http://localhost:5174/__browser-check`. This separate workspace uses synthetic data and the real client, with no Worker requests. See the [browser validation guide](docs/agents/browser-validation.md) for viewport assertions and workflow checks.

To run the Worker alone after building client assets:

```sh
npx vite build
npx wrangler dev --local
```

With placeholder credentials, Google sign-in and live imports are intentionally unavailable. Automated tests supply deterministic authentication, clock, IDs, captured email, and saved HTML through Effect services. They never send real email or fetch live WhenIsGood pages. Email uses **Resend** by default or **Gmail** when selected; notification failure is logged after commit and does not undo a successful mutation.

### Gmail notifications without an owned domain

Before publishing the Gmail OAuth app's audience, configure its Branding homepage and privacy-policy URLs with publicly reachable pages. `oauth-site/` contains an informational homepage and privacy policy, including a description of Scheduler Gmail Notifications. Review those disclosures before publication. They can be hosted as a separate static-only Worker without database or Gmail bindings; publishing that Worker requires explicit operator approval. Use the same privacy-policy URL in Branding and on the homepage. Providing these links does not itself establish Google domain ownership or complete app verification.

Set `EMAIL_PROVIDER=gmail` and `EMAIL_FROM` to the plain Gmail address of the sending account. Gmail authorization is separate from application sign-in; volunteers do not grant Gmail access. Use a separate Google Cloud project with Gmail API enabled and a Desktop OAuth client. Configure its consent screen with the send-only `https://www.googleapis.com/auth/gmail.send` scope. For sustained delivery, authorize after setting publishing status to Production: Google issues seven-day refresh tokens for external apps left in Testing. Google's personal-use verification exception may apply when only the sending account authorizes the app; an unverified-app warning can remain. See [Google's verification exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) and [token expiration guidance](https://developers.google.com/identity/protocols/oauth2#expiration).

Publishing status and verification are separate: the personal-use Gmail project can remain unverified while its audience is In production. The YouTube demonstration is part of a sensitive-scope verification submission, which Google's personal-use exception does not require. If the console blocks publishing itself, inspect the Audience status and exact blocking message before starting verification. Leaving the project in Testing is suitable for temporary setup, but requires reauthorization after seven days.

After creating the private production Wrangler config, download the Desktop client JSON and run locally:

```sh
node scripts/authorize-gmail.mjs /absolute/path/to/downloaded-client.json sender@gmail.com
```

This opens Google authorization with PKCE and a local loopback callback, saves the refresh credentials to ignored `gmail-secrets.production.local.json` with owner-only permissions, and updates the private production config's sender. Choose the same Gmail account as the supplied sender address. It sends no email and makes no Cloudflare changes. Keep both the downloaded client and saved credentials private. Reauthorize if access is revoked or the sender changes its Google password.

After explicit approval to upload production secrets:

```sh
npx wrangler secret bulk gmail-secrets.production.local.json --config wrangler.production.local.json
```

For Gmail, skip the Resend key and domain setup in the production procedure below. Live email delivery remains a separate verification step. A `workers.dev` website address is sufficient; Gmail sends from the authorized account rather than that website domain.

Availability synchronization uses the single society results page configured in `src/worker/config.ts`. Cloudflare invokes the Worker every **30 minutes**, even with all browsers closed. The interval is operator-configurable through `triggers.crons` in `wrangler.jsonc`; the default is `*/30 * * * *`. No separately managed server or Google session is required for scheduled execution.

Administrators open **Availability sync** to see durable status, pending participants, and import history, or use **Sync now**. Sync now queues a durable check; use **Reload view** to see queued/running/completed/failed progress and the saved result. There is no background browser polling. Resolved participants update weekly availability automatically; explicit empty availability clears only those represented volunteers. Missing participants, dated exceptions, assignments, cancellations, backups, and proposals are preserved. New or ambiguous submissions stay in the administrator queue until linked to an existing roster record. Enrollment and account approval remain separate. Source failures retain the last valid state and show sanitized diagnostics.

Browsers read saved data on page load/sign-in, view navigation, and **Reload view**. There is no periodic or visibility-triggered browser polling. An open page can therefore remain older than the latest scheduled check until reloaded. Unsaved forms and reviewed previews stay in place; reload asks before discarding them, and saves racing an effective synchronization change receive the existing stale-revision message.

Legacy import previews and history remain readable. Once synchronization has attempted a check, legacy promotion is rejected so an old staged snapshot cannot overwrite synchronized availability.

## Validation

```sh
npm test
npm run check
npm run format:check
npm run test:browser
npm run build
npx wrangler deploy --dry-run
```

`npm test` runs Vitest once, including real local D1 transaction tests. `check` runs strict TypeScript checking with unchecked-index protection and unused-local/parameter checks, including the browser-test configuration. `build` builds the SPA and validates the Worker through Wrangler's deployment dry run; it does not deploy.

`format:check` verifies the client stylesheet with Prettier. `test:browser` builds a fixed synthetic preview in a temporary directory and checks native Chromium layouts and navigation at desktop, tablet, and mobile sizes. Install its browser once with `npx playwright install chromium`. The suite uses port 5175 (override with `BROWSER_TEST_PORT`) independently of the interactive preview on 5174; later source edits do not reload a running suite. See the [browser validation guide](docs/agents/browser-validation.md) for manual checks, logs, and failure artifacts. These browser tests require no credentials and do not exercise the Worker. The separate native Queue integration test bundles the real Worker and exercises scheduled/manual synchronization, native Queue delivery, D1 and role rejection with synthetic RSA credentials and a mocked Google public-key endpoint; it does not call Google or production.

Tests cover deterministic ranking and availability overlays, every role/operation combination, dated candidate confirmation, cancellation with live backup revalidation, import fixture parsing and atomic promotion, stale revisions, concurrent competing mutations, durable replay, and post-commit notification failures. See [TASKS.md](TASKS.md) for implementation and verification evidence.

GitHub Actions runs these checks on pushes and pull requests, with a manual run option. CI uses Node 24, locked dependencies, synthetic fixtures, and disposable local D1 databases. It requires no repository secrets or private seed, and the deployment command is a dry run only.

## Architecture and concurrency

- `src/shared/` contains Effect Schemas and pure intervals, availability, scheduling, coverage, and insights.
- `src/worker/` contains typed Effect workflows, capability services, D1 repositories, and the HTTP boundary.
- `src/client/` contains the SPA and response validation. Google credentials remain in memory only.
- `schema.sql` is the destructive local initializer; `migrations/0001_idempotency.sql`, `migrations/0002_synchronization.sql`, and `migrations/0003_synchronization_jobs.sql` are additive migrations.

Every mutation requires a reviewed `expectedRevision` and an `idempotencyKey`. Replays are scoped by actor and operation and compare a canonical serialization of validated, normalized payloads. Identical retries return the stored response bytes even after other writes advance the revision; changed input with the same key is rejected.

Repository snapshots load the tables needed by each operation in one D1 batch, including current accounts and revision metadata. A domain-changing mutation batch begins with a revision assertion that causes a database constraint failure when the expected revision is stale. Domain changes, exactly one global revision increment, any scheduling-input increment, 24-hour replay cleanup, and the successful response record commit together. Any failure rolls the batch back. Application handlers never issue raw SQL. This relies on [D1's transactional batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) and is tested with concurrent local D1 requests.

Synchronization uses a durable Queue pipeline. Cron only enqueues scheduled start and maintenance references; it never loads the roster or fetches the source. Each consumer invocation handles one message/stage. Fetch bounds the source and compares a versioned parser/timezone/content fingerprint. Unchanged source skips HTML storage and parsing. Changed input is stored in bounded D1 chunks, parsed once, reconciled using the shared rules and committed atomically. A human edit between cache lookup and preparation routes the job to full reconciliation. Current administrator authority, domain revision and synchronization generation are checked inside the final transaction; only that stage changes availability/history. Consumers do not verify JWTs. Unchanged results add no history/provenance and advance neither domain nor scheduling revisions. Parser semantic changes must advance `whenIsGoodParserVersion`.

Jobs and a transactional outbox preserve progress across failed sends and redelivery. A redelivered old message republishes the current durable stage; maintenance retries delivery attempts older than five minutes, one per invocation. With the 30-minute cron, recovery can wait until the next scheduled check. Matching failed versions are handled by a dead-letter consumer; one-hour expiry also terminates abandoned jobs. Intermediate artifacts are removed on completion/failure, and terminal jobs retain a 24-hour window with bounded cleanup. Permanent import history is unaffected. Manual replay retains the existing 24-hour actor/operation/key semantics. Conflicting human writes allow at most three reconciliation attempts; a newer completed check supersedes older jobs.

At 48 scheduled checks/day, an unchanged check normally has five deliveries (start, maintenance, fetch, prepare, commit), approximately 720 Queue operations/day using write/read/delete accounting. Changed input normally adds parsing, approximately 864 operations/day if every check changes. Retries, recovery and manual traffic add operations. D1 query-budget tests cover 100 participants/500 intervals per invocation; source storage tests cover 2 MiB. These are functional/storage checks, not deployed CPU or daily quota guarantees. See the [Queue candidate release record](docs/releases/6-queue-pipeline.md) for measured evidence, unresolved CPU gates and rollout/rollback details, [Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Publication retains old outputs and chooses the greatest completed output revision. Schedule preview writes nothing. Candidate confirmation consumes one proposal into its next dated occurrence. Advisory candidate coverage does not reserve volunteers. Insights are computed from current data, without a persisted cache. A scheduling calculation reuses normalized availability from its fixed input snapshot; bounded caches retain at most 256 pure weekday and local-instant conversions each. New York daylight-saving conversion still uses Temporal. Users, roles and mutable application data are read from D1 for every request.

## Production procedure — explicit operator action required

**The following commands modify production. Do not run them without explicit approval for that specific action. Never run `schema.sql` against production.** The implementation process does not create remote resources, deploy, or modify the existing database.

The production D1 database `mindfulness-scheduler-prod` already has the base domain tables. Supply its actual `database_id` in a private production Wrangler configuration copied from `wrangler.jsonc`; keep the placeholder tracked configuration unchanged. Configure the public Worker variables for the production origin and real OAuth client. Supply the Resend secret separately; never commit it or the roster.

After reviewing and exporting a current database backup, apply only the additive idempotency migration:

```sh
# PRODUCTION READ: writes a private local backup. Keep it outside Git.
npx wrangler d1 export mindfulness-scheduler-prod --remote --config wrangler.production.local.json --output=backup.local.sql
# PRODUCTION WRITE: explicit approval required.
npx wrangler d1 execute mindfulness-scheduler-prod --remote --config wrangler.production.local.json --file=migrations/0001_idempotency.sql
# PRODUCTION WRITE: explicit approval required before releasing synchronization.
npx wrangler d1 execute mindfulness-scheduler-prod --remote --config wrangler.production.local.json --file=migrations/0002_synchronization.sql
# PRODUCTION RESOURCES: explicit approval required for the Queue pipeline.
npx wrangler queues create mindfulness-scheduler-sync-dead --config wrangler.production.local.json
npx wrangler queues create mindfulness-scheduler-sync --config wrangler.production.local.json
# PRODUCTION WRITE: explicit approval required for the Queue pipeline migration.
npx wrangler d1 execute mindfulness-scheduler-prod --remote --config wrangler.production.local.json --file=migrations/0003_synchronization_jobs.sql
# PRODUCTION SECRET WRITE: explicit approval required; enter the key interactively.
npx wrangler secret put EMAIL_API_KEY --config wrangler.production.local.json
```

For the Queue candidate, add the producer/consumer definitions and dead-letter variable from the tracked config to the reviewed private config; retain batch size one for both consumers. Verify the reviewed production config includes the 30-minute Cron Trigger, then run the full validation suite and a dry run before deploying. Then, only after separate explicit deployment approval:

```sh
# PRODUCTION DEPLOYMENT: explicit approval required.
npx wrangler deploy --config wrangler.production.local.json
```

Verify the same-origin client, Google sign-in, role-specific reads, and the current schedule. Any live mutation or notification test requires its own explicit approval. Keep the previous Worker version available for rollback; restoring application code does not restore database data.
