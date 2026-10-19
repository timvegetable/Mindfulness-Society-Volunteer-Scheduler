# Test-data cleanup preparation

Use the offline cleanup generator for the reviewed test proposals, their linked session, and the placeholder roster account. The current target plan cancels three proposals and one linked session, deactivates one linked account while clearing its volunteer link, and deletes one newly joined volunteer after checking that it has no references or history. It refreshes the prepared schedule representation in the same transaction.

Prepare private artifacts from the authorized database export, read-only target inventory, matching Wrangler config, and private seed:

```sh
node scripts/prepare-test-data-cleanup.mjs \
  --backup <private-export.sql> \
  --targets <private-targets.json> \
  --out <private-output-prefix> \
  --config <private-wrangler-config.json> \
  --seed <private-seed.sql> \
  --seed-out <private-seed-plan-prefix> \
  --seed-before-out <private-seed-copy.sql> \
  --seed-cleaned-out <private-seed-candidate.sql>
```

The generator reads these inputs locally, checks the database UUID, exact target statuses, source revisions, zero active synchronization jobs, and zero roster references, then verifies both batches against disposable SQLite copies. It does not connect to D1 or modify its inputs. The current plans contain 13 statements each. Outputs belong in an owner-only private directory; do not add them to Git or print private rows.

The seed candidate preserves the original seed bytes and appends the prepared cleanup SQL. The separate `seed-before` copy must match the source hash. Keep the original seed untouched until the candidate and source hash have been reviewed and the seed replacement has separate explicit approval.

The private runner verifies the production plan by default and makes no network connection:

```sh
node <private-runner>/apply-cleanup.mjs \
  --plan <private-output-prefix> \
  --config <matching-private-wrangler-config.json>
```

Production execution requires separate explicit approval of the exact request hash shown by the offline review, then the same command with `--apply --expected-hash <approved-sha256>`. The runner validates the hash, database UUID, target set, source revisions, and statement structure before it sends one atomic `env.DB.batch()` through the narrow remote D1 binding. It does not use a REST batch endpoint or split a SQL file, and it does not deploy the Worker. If a fence or target check fails, stop and prepare a new plan from fresh read-only evidence.
