# Scheduling subsystem

## Ownership

`availability.ts` overlays dated exceptions on recurring coverage. `scheduler.ts` contains the pure rank-first algorithm. `coverage.ts` calculates advisory coverage. `inputs.ts` validates committed inputs. `publication.ts` manages preview/run metadata and publication stores. `src/shared/time.ts` owns interval normalization, overlap, and containment semantics.

## Input and eligibility contract

A schedulable snapshot contains active volunteers with completed interviews and numeric ranks 1–3, normalized authoritative recurring availability, dated exceptions, locked/confirmed sessions, current assignments, and explicit schedule/source revisions. Proposed sessions are excluded. Sessions that have started at the run instant are excluded.

Availability is semantic interval coverage. `normalizeIntervals` sorts by weekday and merges adjacent or overlapping intervals. Dated exceptions take precedence only on their date and overlap. Never compare availability changes by row ID or row count.

## Deterministic scheduling

- Lower numeric rank wins.
- Same-rank ordering preserves eligible non-conflicting assignment continuity, then uses stable volunteer ID ordering.
- A volunteer cannot hold overlapping occurrences.
- `requiredStaffCount` is 0–2; do not invent a weekly cap.
- Surplus eligible volunteers become a unique ordered backup list under the same policy.
- Missing staff become explicit shortfalls; the engine never invents assignments to satisfy a promise.

The engine is pure and deterministic for the same normalized snapshot.

## Preview and publication

Preview calculates a proposed output with `inputRevision`, `outputRevision`, `computedAt`, and zero-inclusive assignment/backup/shortfall counts. It writes nothing. The current client submits the reviewed global revision for publication; with that value present, any intervening mutation yields `STALE_REVISION` and requires a new preview. See the dispatcher caveat in `integration.md` before changing this boundary.

Publication runs under the write boundary and writes complete assignments, backups, and scheduling-run metadata. Prior current output must remain usable on failure. Scheduling-input revision is separate from the global revision so unrelated changes do not make schedules stale, while every relevant input commit does.

Cancellation is owned by self-service, but backup eligibility must reuse these same availability, overlap, ranking, and ordering rules.
