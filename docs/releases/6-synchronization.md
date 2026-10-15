# Synchronization release evidence — issue #6

Prepared October 14, 2026 (America/New_York). Release remains pending production approval and deployed verification. This record contains sanitized evidence only.

## Version and review

The operator selected `fresh-start` as the release branch. It has no common ancestor with the repository's default `master` branch, so merging those histories is outside this release. The application candidate is `5b14274674fbedb446f3276a6651b7432a9512d7`, including synchronization implementation `d6b977f`. Subsequent release-record commits change documentation only.

Parallel Standards and Spec reviews of `git diff e459955...5b14274` found no blocking findings. A possible future extraction of pending-state construction was a maintainability observation, not a correctness defect.

## Read-only production preparation

- The actual fixed WhenIsGood page passed the existing bounded fetch adapter and strict parser: HTTP 200, 97,456 bytes, eight participants and 46 weekly intervals. Every participant and nested interval passed `ImportParticipantSchema` decoding. No source availability was applied and no private source data was retained in the repository.
- The private production Wrangler config targets the existing `mindfulness-scheduler-prod` database with the `DB` binding, configured production OAuth client, `America/New_York`, and the same fixed source in application code. Its missing Cron Trigger was corrected locally to `*/30 * * * *`; private configuration remains ignored.
- Read-only production schema inspection found `idempotency` installed and `synchronizations` absent. Only `migrations/0002_synchronization.sql` is needed.
- A fresh production export is stored privately in the ignored root file `production-backup-issue6-20261015T0141Z.local.sql`, mode `0600`, 227,761 bytes. A disposable in-memory SQLite restore passed integrity checking and reported zero foreign-key violations. Applying migration 0002 to that disposable copy succeeded with an empty synchronization table. The production database was not modified.
- Cloudflare deployment history and version inspection confirmed access to prior Worker version `65b315ee-294e-45d3-9801-76473bed47d2`. That deployed version exposes only a fetch handler.

## Validation

Checks cover application candidate `5b14274` and the locally corrected private production config:

- `npm run check`: passed.
- `npm run format:check`: passed.
- `npm test`: 261 tests passed in 14 files, including disposable local D1 integration tests.
- `npm run build`: passed, including tracked-config Worker dry run.
- `WRANGLER_WRITE_LOGS=false WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --config wrangler.production.local.json`: passed; no deployment performed.
- `PLAYWRIGHT_BROWSERS_PATH=/tmp/issue6-playwright npm run test:browser`: 45 checks passed across desktop, tablet and mobile. Its initial attempt could not launch Chromium because the matching Playwright runtime was absent; installing that runtime in `/tmp` resolved setup. The passing rerun used the same application code.

## Approval and remaining evidence

The next production operation is the additive migration below, requiring explicit operator approval under issue #6 and README's production procedure:

```sh
WRANGLER_WRITE_LOGS=false WRANGLER_SEND_METRICS=false npx wrangler d1 execute DB --remote --config wrangler.production.local.json --file=migrations/0002_synchronization.sql
```

After confirming migration outcome, separately approve deployment of the reviewed release version with the corrected production config. Deployment enables automatic source application every 30 minutes, including while no administrator is signed in. It does not authorize manual Sync now, participant linking, source-submission changes, or email tests.

Before closing #6, record the deployed version, same-origin client and Google sign-in checks, role-specific reads and participant privacy, existing schedule, load/navigation/Reload behavior, an actual scheduled run and unchanged follow-up, and measured invocation errors, CPU and D1 query/row usage. Forty-eight scheduled executions per day is the configured rate, not measured free-plan compliance.

## Rollback

Following explicit rollback approval, use Wrangler's rollback command with the private production config to restore Worker version `65b315ee-294e-45d3-9801-76473bed47d2`. Verify deployed handlers and Cron Trigger state; stop scheduled updates explicitly if necessary and authorized. Leave the additive table intact unless separately reviewed. Code rollback does not restore availability or any other database records: data restoration requires separate authorization and the reviewed private backup. No rollback or production write was performed during preparation.
