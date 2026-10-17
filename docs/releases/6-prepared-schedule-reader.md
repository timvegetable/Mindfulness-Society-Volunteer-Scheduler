# Prepared schedule reader: production trial

Application source `2ecbe19` is deployed and enabled. The controlled production trial met the schedule-read goal of at most 9 ms in every captured read, including the first observed read after identical redeploys of both Workers. This qualifies the measured schedule path, not the whole of issue #6.

## Production evidence

The user explicitly approved the private Worker, signing secret, additive migration, writer preparation, fresh backup/fenced backfill, enabled deployment, read-only measurements, up to two identical redeploys, and rollback on a failed correctness/CPU gate.

Cloudflare live-tail `cpuTime` reported:

| Read | Main Worker, ms | Private reader, ms | Sum, ms |
| --- | ---: | ---: | ---: |
| First after sign-in | 0 | 4 | 4 |
| Repeat | 0 | 3 | 3 |
| First observed after both redeploys | 1 | 4 | 5 |
| Repeat after redeploy | 1 | 2 | 3 |
| Repeat after redeploy | 0 | 4 | 4 |

All five reads returned HTTP 200 / `ok`. The real browser decoded the shared response schema and displayed **Session schedule** after explicit reads. The result uses invocation CPU from Cloudflare, not wall time or local Inspector deltas. The [sanitized invocation record](../performance/schedule-read-production-trial.json) preserves timestamps, versions and CPU. This is a small current-schedule sample, not a global p95/p99 or a bound on every future isolate or larger dataset.

Sign-in reported 8 ms in the private Worker and 2 ms in the main Worker. That combined 10 ms has limited headroom. Other authenticated HTTP endpoints and live writer preparation CPU were not requalified in this read-only trial. Changed-source Queue reconciliation remains a separate measurement gap. Keep issue #6 open.

## Consistency and rollout

A fresh owner-only backup preceded migration `0004_schedule_reads.sql`. The private reader and dedicated signing secret were deployed first. The main Worker then ran in `prepare` mode while the public reader retained its legacy protocol.

A second fresh backup produced the backfill through the real shared schedule selection/schema rules. The reviewed operator runner verified its hash, target UUID and fenced statement structure offline, then used Wrangler's narrow remote-D1 proxy and one `env.DB.batch()` call to apply all four statements atomically. It did not rely on undocumented REST `{batch}` transaction semantics. The backfill's data/source revision fences passed.

A fresh export verified five contiguous parts totaling 78,389 core bytes, the manifest version and digest, all 15 invalidation triggers, and exact prepared bytes. Volunteers, sessions, runs, assignments and backups were unchanged. The public mode switched to `enabled` only after this verification. No publication, cancellation, participant linking, manual synchronization or notification was triggered by the trial. The browser's expired credential required the user to complete Google sign-in once.

Final deployments:

- Main: `7bb1b7b4-daa4-4923-847a-3586c7e29cd6`.
- Private reader: `d679ba8e-64d3-4546-8fdf-055960777e67`.
- Main configuration: `SCHEDULE_READ_MODE=enabled`; cron `*/30 * * * *` and both existing Queue consumers retained.
- Reader: public workers.dev and preview URLs disabled; signing secret exists only there.

Both live tails were stopped after measurement. No rollback was needed.

## Reversibility

Implementation checkpoint `8475233`, experiment evidence, and native text-parity correction `2ecbe19` remain on `codex/schedule-read-cpu`. User-requested experiment branches `codex/luna-cpu-profile` and `codex/luna-cold-exchange` are preserved. Their runtime experiments were discarded; calibrated findings and bounded-reader behavior tests were integrated.

Rollback the main Worker to `8e14fcd6-94ac-4a7d-95f0-99ced8df0cbc` to restore the previous protocol. Preserve cron/Queue bindings. Keep additive tables/triggers and the private reader; code rollback does not restore data. An old writer does not maintain prepared data, so any later reactivation requires a fresh fenced backfill.

Owner-only, Git-ignored recovery files in the repository contain the pre-migration backup, reader/prepare/enabled configurations and signing secret. Their contents must remain private. Raw tails and disposable profiling drivers/bundles were removed after saving allowlisted evidence. Private backfill plans and recovery inputs remain outside tracked source.

## Validation

The corrected source passed 353 functional tests across 19 files, both TypeScript checks, CSS formatting, main/private Worker dry-run builds and all three private release-config dry runs. The unchanged client passed 48 synthetic Chromium checks, including explicit ticket renewal without background requests. Native D1 checks cover preparation parity, current authority, concurrent publication, invalidation, corruption and atomic rollback. The final malformed-Unicode regression failed before correction and passed for valid pairs, lone high/low surrogates and existing replacement characters afterward.

The [implementation record](../performance/schedule-read-implementation.md), [profile calibration](../performance/schedule-read-profile-calibration.md) and [rejected exchange experiment](../performance/luna-cold-exchange-experiment.md) explain the design and diagnostic limits.
