# Queue pipeline checkpoint — October 16, 2026

**Continuation:** the subsequent implementation and validation are recorded in [the Queue candidate release record](../releases/6-queue-pipeline.md). The notes below describe the original stopping point.

The operator approved trying the Queue pipeline and then requested a stopping point within seven minutes. The minimal production prototype passed its initial CPU gate. The application pipeline remains unfinished and must not be deployed from this checkpoint.

## Deployed baseline

A disposable Worker and Queue, both named `scheduler-cpu-probe`, were created solely for synthetic measurement. Worker version: `ee43062a-95d8-49dd-ba46-57136384169f`. It had no public route, HTTP handler or scheduled trigger. Its consumer used batch size one and concurrency one, with no JWT verification or application framework setup.

Each delivery performed one read-only D1 query against the existing `meta` revision row. SQL constructed a synthetic JSON job object; the consumer deserialized that object, checked its phase/version, logged a synthetic sequence and acknowledged the message. It loaded no roster records and made no application database writes. This measures a minimal native Queue/D1 baseline, not the complete proposed stage overhead.

Twenty-seven synthetic messages were submitted. Live tail captured twenty distinct invocations, all with batch size one, outcome `ok` and no exceptions. Only the captured invocations support the following CPU claims:

| Reported CPU | Captured invocations |
| --- | ---: |
| 0 ms | 14 |
| 1 ms | 5 |
| 2 ms | 1 |

The first observed invocation used 2 ms CPU; the median was reported as 0 ms and the maximum as 2 ms. Reported wall time was 50–154 ms. Tail reports integer milliseconds: zero is a rounded report, not proof of zero work. The first observed delivery is not a controlled cold-isolate measurement. Missing live-tail events are not evidence of failed jobs or zero CPU. Wrangler's separate 2 ms startup measurement is not invocation CPU.

**Decision:** the bare-consumer baseline is comfortably below the proposed 6–7 ms stop/rethink threshold, so continue the experiment. This does not establish that fetch, parsing, reconciliation, serialization or commit will meet the 10 ms limit. Measure those actual deployed stages separately, including first use and changed/maximum supported input.

Cleanup completed: live tail was stopped, the probe consumer detached, and the disposable Worker and Queue deleted. No experiment trigger remains. Sanitized observations and private temporary scripts/logs remain under `/tmp`; none of the private configuration or logs is checked in.

## Local implementation checkpoint

The branch contains a partial implementation, with runtime wiring deliberately unfinished:

- Additive `0003_synchronization_jobs.sql` defines durable jobs, chunked private artifacts and an outbox. It has not been applied remotely.
- `repositories/synchronizationJobs.ts` implements stage/version fences, current administrator authorization for domain commit, bounded artifact rows and outbox delivery metadata.
- `synchronizationJobs.ts` sketches fetch, parse, prepare and atomic commit phases. Messages carry job references; consumers do not verify JWTs. Only the commit phase applies availability/history changes.
- Existing synchronization logic now exposes shared preparation; D1 persistence separates preparing SQL from executing its transaction. These extractions still serve the direct path.
- The API has an optional job service and optional job status fields. No service is installed in the live runtime, so existing direct synchronization remains in use.
- No application Worker deployment, production migration, Queue binding, cron wiring or client completion behavior was changed in this experiment. The deployed application remains version `48b0aa83-44eb-4007-a9c4-75c237e9f372` from source `2d6ae01`, with previously observed manual/scheduled CPU still above budget.

The pipeline has no dedicated functional tests yet. Passing existing tests does not establish its correctness or its CPU cost. This is a work-in-progress checkpoint, not a release candidate.

Validation at this checkpoint: all 280 existing functional tests passed (including real local D1), both TypeScript checks passed, CSS formatting passed, `npm run build` including the Worker deployment dry run passed, and `git diff --check` passed. The focused synchronization/scheduled/database subset also passed all 53 tests before the full run. Browser validation was not rerun; no client source changed.

## Required next work

1. Make scheduled entry cheap: create/enqueue a durable intent without decoding a full synchronization snapshot. Measure cron and authenticated start separately.
2. Move fetch/fingerprint/compare into the first measured stage so unchanged input can bypass source storage and parsing. The current sketch caches parsing only after storing the source and entering the parse stage.
3. Validate the job repository and consumer through real local D1. Cover duplicate deliveries, atomic commit failure, outbox transport failure/recovery, concurrent stage attempts, stale human writes, superseded jobs, administrator revocation, malformed/oversized source, and retries after a completed commit. Check error transport across `Effect.runPromise`: typed failures must reach the consumer's authorization/conflict handling rather than becoming unclassified retry errors.
4. Resolve job retention/idempotency expiry: the current insert precedes old-job cleanup, so reuse of an expired intent key can conflict with a retained terminal job. Define recovery for exhausted retries/dead-letter delivery and make terminal failure visible.
5. Check artifact and prepared-plan sizes at the full 2 MiB source cap; bounded rows alone do not establish a bounded whole-invocation cost or total query allowance. Stored intermediates are private and need bounded retention.
6. Wire one message per invocation, bounded retries/dead-letter behavior, recovery, runtime service and explicit client queued/running/completed state. Preserve the issue's prohibition on periodic browser polling.
7. Review migration/rollback, complete validation and obtain the separate main-application production approval required by README before applying the migration or deploying the pipeline. Then measure each real stage with ample headroom under 10 ms. Keep issue #6 and the CPU goal open.

The existing [CPU strategy](worker-cpu-strategy.md) contains the architectural rationale, previous production/local measurements and primary-source links. The user approved this experiment after that proposal was written; its earlier request-for-design-approval gate has been satisfied.
