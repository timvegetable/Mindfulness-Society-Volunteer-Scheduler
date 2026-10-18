# Nine-millisecond Worker goal: completion ledger

Objective: ensure that no single Worker request exceeds 9 ms while preserving correct application behavior. Status: active and unachieved. A successful narrow read or test suite cannot close this ledger.

Use Cloudflare operation-attributed CPU for production gates, summing caller/private CPU within an external HTTP request. Keep separate external requests separate. Check scheduled and Queue invocations individually. Integer zero means less than reported precision, not no work. Record deployment versions and input scope. Local Node, Inspector, wall time and native Tail zeros are not production CPU proofs.

| Required surface | Current evidence | Remaining proof/work |
| --- | --- | --- |
| Static assets, client config and bounded invalid-request handling | Earlier observations include cheap unlabeled HTTP responses | Explicit route/error attribution and worst supported input bounds |
| Sign-in and renewal | `7838e51` initial split stages 6 and 5 ms, negotiation 1 ms; rolled back after later read failure | Candidate first/repeat and first-observed after redeploy, renewal, rejection/error cases |
| Prepared schedule | `2ecbe19` approved trial 3–5 ms, including first observed after redeploy; `7838e51` initial read 3 ms | Preserve gates after further changes; largest supported schedules |
| Sync status | `7838e51` first read 14 ms; current small-route local candidate | Production first/repeat and redeploy evidence, populated history and growth bounds |
| Insights and center proposals | Historical samples include 7–8 ms and proposal breaches 16–27 ms | Current candidate operation-attributed first/repeat measurements and bounded largest inputs |
| Volunteer dashboard | Functional/schema/authorization coverage | Production CPU with an authorized volunteer; largest supported data |
| Read-only schedule preview | Functional scheduling tests | Production first/repeat CPU; representative largest scheduling input; split/client-side computation proposal if needed |
| HTTP mutations and prepared schedule writers | Functional atomicity/concurrency/replay tests; historical manual enqueue 6 ms | Per-operation first/repeat success, replay/error and added preparation CPU; production writes need explicit concrete approval |
| Cron and unchanged Queue pipeline | Earlier `55b1a71` observations 1–7 ms across cron/start/recover/fetch/prepare/commit | Reconfirm deployed candidate and input scope; retry/maintenance/dead-letter worst-case bounds |
| Changed-source Queue pipeline | Earlier pre-optimization parse 8 ms/reconcile 15 ms; current functional tests only | Current parse/reconcile/commit CPU on genuine changed-domain workload, source-size/chunk and conflict/retry bounds |
| Growing history, rosters and other input sizes | Local D1 functional/query-budget checks only | Bound work per invocation without losing data; pagination/continuations where required; verify CPU at supported bounds |

Production is the restored `2ecbe19` application baseline (main `7bb1b7b4-daa4-4923-847a-3586c7e29cd6`, reader `d679ba8e-64d3-4546-8fdf-055960777e67`). Candidates and rollback evidence are preserved in Git. No broad CPU completion claim is justified by the current record. Keep issue #6 open.
