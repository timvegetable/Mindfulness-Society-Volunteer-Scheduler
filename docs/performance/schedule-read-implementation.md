# Prepared schedule reader implementation

The approved design is implemented on `codex/schedule-read-cpu`. It has not been deployed. The production CPU goal remains unachieved. Production is still source `55b1a71`, Worker `8e14fcd6-94ac-4a7d-95f0-99ced8df0cbc`.

## Implemented boundaries

- `/api/schedule` forwards to a private `mindfulness-scheduler-reader` Worker through `SCHEDULE_READER`. The tracked assets configuration explicitly routes `/api/*` through the Worker. The reader has no public workers.dev or preview URL.
- Enabled `session.me` verifies Google credentials in that private Worker and issues administrator read tickets, clamped to Google expiry and 15 minutes. The main Worker validates its session response with the existing shared schema. The Google verifier is shared with existing authentication; public-key caching retains provider freshness and single-flight behavior. No user or authority is cached.
- Every schedule read verifies the ticket with native HMAC, checks the current D1 account ID/email, activity and operation policy, and transactionally reads the prepared representation with current revision metadata. Invalidated or corrupt data fails explicitly; there is no expensive fallback.
- Shared schedule selection and schema validation run during preparation. Canonical storage normalization and binary ID ordering preserve the response that a subsequent D1 read would produce. Publication, cancellation/backup promotion and candidate confirmation commit domain changes and the representation atomically under existing revision fences.
- Additive migration `0004_schedule_reads.sql` stores bounded chunks and a digest/version manifest. Triggers on all five core tables invalidate direct maintenance edits. Availability and synchronization retain current core bytes and refresh live revisions/stale state without extra preparation stages.
- Browser credentials remain in memory. Explicit reads renew expired/rejected tickets once; concurrent renewals share one exchange. Sign-out invalidates pending replies. There is no background polling. A new client already open during cutover recognizes the typed protocol transition from `/api`.

## Local evidence and remaining performance gates

The functional workflow coverage includes native multi-Worker service binding, synthetic RSA Google credentials, current-role revocation, account replacement, empty/legacy/equal-revision schedules, Unicode chunking, concurrent publication, fenced backfill, atomic rollback, and ticket expiry/cutover recovery.

Inspector active-time sampling is a causal local diagnostic, not Cloudflare CPU accounting. A clean isolated-reader run measured 48 reads in 16 fresh runtimes; the maximum was 7.546 ms. The integrated main-Worker version produced first-read outliers above 10 ms and was replaced by the private reader. A two-query join experiment was slower and was discarded. A concurrent-test run was discarded as interfered evidence.

Cold private sign-in exchange profiles still exceed the local budget (roughly 11–15 ms); warm exchanges are much cheaper. Static initialization and a bounded TransformStream body-reader experiment did not establish reliable headroom; both experiments were reverted. The current source retains the bounded reader and lazy exchange import. Do not claim the exchange fits production limits.

A simultaneous two-isolate Inspector experiment reports large unattributed `(program)` intervals in the main forwarding Worker. These samples may overlap work on the shared runtime thread; adding the two profiles is not an established measurement of total request CPU. Calibrate against controlled work and I/O, then measure each target separately before inferring another architecture change. The user requested a brainstorming agent and two Luna agents at max reasoning to experiment in separate branches.

## Rollout contract

`SCHEDULE_READ_MODE=disabled` preserves the legacy protocol. `prepare` maintains prepared writes while serving the old reader. `enabled` switches the public schedule/session protocol and requires the private reader binding. The signing key belongs only to the private reader Worker. Audience combines the configured environment audience and Google OAuth client ID.

No production changes are authorized by implementation approval alone. After the exact candidate and performance evidence are reviewable, request specific approval for the new private Worker deployment, one dedicated random signing secret, additive migration, writer preparation deployment, fresh backup/backfill and final enabled deployment. Preserve current cron and both Queue consumers. Never execute destructive `schema.sql` against production.

Generate a private backfill plan with `scripts/prepare-schedule-backfill.mjs --backup <private.sql> --out <private-prefix> --database-id <UUID>`. It performs no network access, uses the real preparation rules, writes owner-only files without overwriting, and includes data/source revision fences. Applying it must use documented `env.DB.batch()` atomicity, through a localhost-only maintenance Worker with a remote D1 binding and the exact reviewed plan. That maintenance runner still needs implementation and native validation before rollout. Do not rely on undocumented REST `{batch}` atomicity or assume CLI file splitting is atomic. A stale fence must abort every representation write and trigger regeneration from a fresh backup.

Before cutover, verify exact response parity and representation integrity against the fresh backup, then measure actual deployed operation-attributed CPU including first-use reads, repeats, exchange and new write costs. Local tests/dry runs do not pass these gates. Representative large-response CPU and Free-plan query/operation quotas also remain deployment gates.

Rollback to the current production version restores the old protocol while leaving additive tables intact. Keep the new reader private. Any reactivation after an old writer requires a fresh fenced backfill. A code rollback does not restore database data. Key rotation may accept one previous key only within an explicit overlap window of at most 15 minutes; role revocation remains immediate because every read queries current authority.
