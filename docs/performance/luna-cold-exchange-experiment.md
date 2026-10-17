# Cold private exchange experiment

The temporary single-chunk fast path in `readBoundedText` did not establish a reliable cold-CPU improvement, so it was discarded. The change decoded a sole bounded stream chunk directly instead of copying it into a second buffer; streamed byte limits and split UTF-8 handling remained in place.

The benchmark alternated eight fresh native Miniflare Worker/D1 isolates per variant. Each isolate performed one `POST /internal/session`. It used a synthetic administrator row, one synthetic center, two revision rows, an in-memory RS256 key, and a synthetic JWKS response. No private backup, real credential, production Worker, or external key service was used. CPU profiles sampled at 100 μs.

To reproduce from this experiment worktree, the commands were:

```sh
git show 8475233:src/worker/services/http.ts > /tmp/schedule-luna-exchange-profile/http-baseline.ts
RUNS=8 node /tmp/scheduler-luna-exchange/bench-cpu.mjs
```

The benchmark script and profiles are temporary files under `/tmp`; the script is not part of this change. The rows below are paired by run. Values are sampled milliseconds. `JS` counts frames with a source URL, `native` counts frames without one, and `GC` is the garbage-collector frame. These categories are shown separately; `(program)` and idle samples are omitted because they were not reliable measures of request work.

| Run | Baseline JS | Candidate JS | Baseline native | Candidate native | Baseline GC | Candidate GC |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 5.372 | 9.884 | 0.875 | 0.684 | 0 | 0 |
| 1 | 5.605 | 11.589 | 2.686 | 1.010 | 0 | 0 |
| 2 | 6.902 | 4.898 | 1.879 | 0.960 | 0 | 0 |
| 3 | 5.800 | 9.052 | 2.361 | 0.948 | 0 | 0 |
| 4 | 5.063 | 8.218 | 2.203 | 0.980 | 0 | 0.157 |
| 5 | 8.771 | 4.255 | 0.807 | 3.631 | 0 | 0 |
| 6 | 7.373 | 7.734 | 0.478 | 0.637 | 0.157 | 0 |
| 7 | 9.733 | 11.469 | 0.315 | 0.806 | 0.166 | 0.171 |

The JS and native samples moved in opposite directions and varied substantially between fresh isolates. `readBoundedText` itself was sampled inconsistently, from 0–1.741 ms for baseline and 0–2.902 ms for the candidate, so the profiler could not isolate stream setup from copying or decoding. These local samples do not demonstrate a repeatable gain or establish the production ≤9 ms gate. The one-chunk optimization was reverted; the bounded-reader behavior remains unchanged.
