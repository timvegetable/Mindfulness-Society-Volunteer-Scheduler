# Schedule-read Inspector profile calibration

Status: disposable local Miniflare calibration on `codex/luna-cpu-profile` at `8475233`. This is evidence about Inspector sampling behavior and the current local proxy path. It does not measure Cloudflare Workers CPU or pass the production `<=9 ms` gate.

## Method

The temporary harness was `/tmp/scheduler-luna-profile-calibrate.mjs`; its profile JSON and CPU profiles are under `/tmp/scheduler-luna-profile-diag/`. It used Node `v24.21.0`, the worktree's Miniflare `5.20261001.0-alpha`, and a 100 microsecond Inspector sampling interval. It ran 30 requests and retained 40 per-isolate profiles:

- A no-op main Worker forwarding to a reader Worker.
- Reader-side JavaScript spins targeted at 4 ms and 8 ms.
- A 30 ms delayed outbound-fetch stub from the reader.
- The real `/api/schedule` main-to-private-reader path, backed only by the checked-in synthetic seed and an issued synthetic administrator ticket. Its response was 1,411 bytes.

Each workload ran twice with the main profile alone, the reader profile alone, and both profiles active. The real route used the same three capture modes and two calls each. Profiles were captured around each request; elapsed wall time is the caller-side `dispatchFetch` plus response-body consumption.

Run from the isolated worktree with:

```sh
cd /tmp/scheduler-luna-profile
node /tmp/scheduler-luna-profile-calibrate.mjs
```

Miniflare needs a loopback Worker socket. The default sandbox attempt stopped before running any request with `listen EPERM` on `127.0.0.1`; the successful run used `exec_command` with `sandbox_permissions: "require_escalated"` as directed by `docs/agents/validation.md`.

## Observations

The simultaneously active profiles cannot be added as request CPU. On a no-op forwarding call, the first request took 4.689 ms wall time, while the main profile reported 12.305 ms and the reader reported 7.394 ms. Their 19.699 ms sum exceeded wall time by more than four times. The next no-op call took 3.518 ms wall time and the profiles summed to 9.008 ms. Main samples also contained `program` and `idle` intervals despite the main Worker doing only the forwarding call.

The reader profile tracked the programmed 8 ms spin more closely: its JavaScript category was 7.202 ms and 7.563 ms across two calls, with 11.879 ms and 10.364 ms wall time. This is a useful control for identifying the busy JavaScript loop, but two samples do not establish an accurate general CPU estimator. During the delayed outbound fetch, the same profile was unstable: reader JavaScript was 2.914 ms and 0 ms on two calls, while idle was 37.346 ms and 0.922 ms. In the simultaneous first call, a `Response` frame received a 31.071 ms delta while the request waited about 30 ms. A sample's time delta can therefore span asynchronous waiting and be attributed to the first sampled frame after the wait.

On the actual route, the 1,411-byte synthetic response took 9.220 ms on the first main-only capture and 8.866 ms on the first reader-only capture. The first simultaneous capture took 10.489 ms wall time, while its two profiles summed to 48.061 ms (34.415 ms main and 13.646 ms reader). The small response does not represent the previous 78 KB diagnostic response size, so it only exercises the real forwarding and capture behavior.

## Interpretation

Inspector `timeDeltas` are sampled elapsed intervals, not an operation-attributed Cloudflare CPU counter. In this Miniflare setup, `program` and `idle` values vary substantially, and asynchronous wait can be charged to a JavaScript frame. Simultaneous isolate profiles overlap and must not be summed. A one-isolate capture avoids that sum but still does not prove Cloudflare operation attribution; use it only to compare local code paths under the same controlled setup. Treat the spin as a calibration signal and delayed fetch as a warning about async attribution. Production success remains gated on Cloudflare's deployed operation CPU measurement, including first-use reads, repeats, and representative response sizes.
