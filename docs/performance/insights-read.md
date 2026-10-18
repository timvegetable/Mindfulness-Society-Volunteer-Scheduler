# Insights CPU diagnosis

The compact sync candidate's [release trial](compact-sync-release-trial.json) measured the first Insights request at **30 ms combined CPU**, 29 ms main plus 1 ms private reader. It returned HTTP 200 and an `ok` tail outcome, but failed the explicit <=9 ms gate. Both Workers were immediately restored to baseline, verified at 100% traffic; no repeats or later endpoint checks ran. This is a production failure measurement, not a local prediction. The compact sync reads themselves used 5 and 4 ms in that trial.

## Ranked, falsifiable hypotheses

1. **Generic dispatch / snapshot hydration is the main first-use cost.** Prediction: a production variant that stops immediately after the existing current-account authorization, before payload normalization and the Insights handler, retains most of the 29 ms main CPU. This includes the existing transactional snapshot read and conversion. A low snapshot-prefix cost would weaken this hypothesis.
2. **Insights computation is the main added cost.** Prediction: the variant that completes the normal handler but stops before output validation is materially more expensive than the snapshot prefix. This includes payload normalization/clock/handler work; it does not isolate the pure algorithm perfectly.
3. **Output validation / serialization dominates.** Prediction: the completed-validation prefix or normal full response shows the large step up from the earlier prefix. Diagnostic failures use a different error path, so repeated prefix patterns guide the next probe; exact subtraction is not a profiler.

The source-level [bounded-work audit](bounded-work-audit.md) identifies loops and growth risks without asserting which caused this sample. Rust/Wasm and removal of output validation are not justified yet.

## Structural probe, not timing forecast

A read-only local SQLite adapter over the existing private backup measured 85,843 bytes of returned snapshot-row JSON and a 34,208-byte Insights response. It contained 74 volunteers, 144 recurring intervals, one run, 54 assignments, 34 merged grid cells, 57 volunteer occurrences in the grid and 69 leftover volunteers. These aggregate sizes describe that backup, not a fresh production snapshot, native D1 wire bytes or CPU estimates. No identities or private records are checked in. The UI uses name/email/readiness for leftover rows and names for grid details, so a future projection could be smaller, but that is not yet a measured fix.

## Frozen production diagnostic (completed after specific approval)

The [frozen manifest](insights-diagnostic-manifest.json) identifies four copies of application candidate `3ad9f87`: full, snapshot stop, handler/view stop, and output-validation stop. Each diagnostic copy changes only `src/worker/api/dispatch.ts`, conditionally for `admin.insights.read`. Snapshot stops after the existing current-account role check; the other stops retain normal current authority. All stop with a typed error containing only the diagnostic stage. Authentication, queries, domain calculations and full output validation preceding each respective boundary are retained. The full source has no diagnostic switches.

All four deployment configurations passed dry runs with the correct `dist/client` asset directory. Native Miniflare/D1/crypto verification passes 12 synthetic cases: administrator reaches the intended success/typed diagnostic; volunteer is forbidden; forged token is unauthorized, for each variant. Metadata remains unchanged. The harness initially used an incomplete synthetic ticket audience and failed authorization; correcting it to the existing audience-plus-OAuth-client convention made the checks pass, without changing application or diagnostic code.

Proposed scope: deploy the compatible private reader once and main up to five times (four variants plus one identical full redeploy); collect at most five explicit Insights reads per variant/deployment, up to 25 total plus normal sign-in and schedule loading. Permit >9 ms samples only for this diagnostic. Intentional typed errors are expected; unexpected authentication, application or resource failures stop the run. Always restore both baseline Workers at the end regardless of results, main first then reader. No domain mutation, manual sync, migration, new secret/resource, notification or source edit is included. Raw tails/credentials stay private; retain sanitized operation/version/CPU aggregates and remove temporary variants afterward.

README.md requires explicit approval for this specific production diagnostic. The prior compact release approval was consumed by its strict failure/rollback and does not authorize this diagnostic or tolerating over-budget requests.


## Production result

The [sanitized paired record](insights-production-diagnostic.json) contains all 25 explicit Insights reads, deployed versions and combined caller/private CPU:

| Variant | Combined CPU in request order (ms) |
| --- | --- |
| Full | 31, 22, 14, 14, 13 |
| Snapshot stop | 20, 9, 6, 4, 6 |
| Handler/view stop | 29, 22, 12, 11, 12 |
| Output-validation stop | 42, 23, 19, 9, 13 |
| Identical full redeploy | 26, 15, 13, 14, 11 |

All ten normal responses rendered successfully, and all fifteen prefix responses showed the exact intended diagnostic error. Tail outcomes were `ok`/HTTP 200. Normal Insights reads consistently exceeded nine milliseconds, including repeats. The full redeploy reproduced the breach. The error-path prefixes are noisy, especially first use; the validation-prefix 42 ms is larger than either normal first sample, so subtraction would be misleading.

The snapshot prefix itself retains substantial first-use cost, and completing the handler retains an additional recurring cost before output validation. This weakens the hypothesis that output serialization alone causes the breach. It does not attribute the earlier 29 ms to one pure routine or prove output validation is free. Keep validation while testing a dedicated async read and narrower repository queries; preserve the calculation and API contract to isolate the next change. A later browser-computation/split design remains a proposal if this cannot meet the gate.

Sign-in also varied above budget in this run: Google verification used 11 ms combined (1 main + 10 reader), and issuance used 10 ms (2 + 8). Negotiation used 2 ms and initial schedule loading 6 ms. These functional successes are not CPU passes; sign-in remains unresolved despite earlier lower samples. This was a diagnostic with intentional over-budget Insights sampling, not a release qualification.

Both baseline Workers were restored, main first, and Wrangler verified 100% traffic: main `7bb1b7b4-daa4-4923-847a-3586c7e29cd6`, reader `d679ba8e-64d3-4546-8fdf-055960777e67`. Reloading the client showed the signed-out welcome. Both tails stopped. Temporary diagnostic source copies and executable probes were removed; manifest/native proof, sanitized records and private raw tails remain. No domain mutation, manual sync, migration, new secret/resource or notification occurred.

## Next local candidate: dedicated read, unchanged response

Branch `codex/insights-read-cpu` adds a dedicated async `admin.insights.read` handler, retaining the current R2/private verification and transactional current-account checks. Its six-statement batch selects only the calculation's required columns directly: the signed account, full volunteer records, recurring interval calculation fields, run selection fields, assignment selection fields and revisions. It avoids JSON assembly/parsing for every stored row and hydration of run assignment/backup IDs, shortfalls and diagnostics. It still reads all input rows; collection growth remains an open bound.

The shared current-run and assignment selection functions now accept their minimal structural input types, preserving their implementation and tie-breaking. Insights retains its existing calculation and complete output schema; the API response and client are unchanged. Disabled/prepare mode retains generic dispatch. No new protocol, authentication mechanism, output-validation bypass, migration or resource is introduced.

Native integration coverage compares the complete response with generic dispatch on synthetic historical/current/staged/failed runs, historical and cancelled assignments, escaped volunteer names and current eligibility. It covers malformed exposed fields, invalid payload, forged tickets, volunteer denial, corrupt/revoked roles and account replacement. The initial fixture expectation included a newly joined volunteer that is deliberately ineligible; making that synthetic volunteer active for the historical-assignment scenario preserved the real eligibility rule and made the focused checks pass.

A local private-backup projection check confirms complete serialized response equality and a reduction in returned-row JSON from 85,843 to 37,717 bytes over six queries; the response remains 34,208 bytes. These are structural measurements, not native D1 wire metrics or CPU forecasts. The first adapter assertion failed on Node SQLite's null-prototype objects rather than serialized content and emitted private fixture values; the corrected probe emits only aggregates and verifies serialized content without exposing a failure diff. No private records are committed.

Production remains baseline after the diagnostic. This candidate has not been deployed; production CPU, sign-in variation and the broader completion ledger remain unresolved.

Final local validation for this candidate: all 368 tests across 20 files pass, including the expanded native Worker/D1 workflow; both TypeScript checks, client/Worker builds and the enabled private production-configuration dry run pass. Client source and response schema are unchanged; the prior client browser coverage is not a fresh production CPU check. No local timing forecast is used to claim a pass. The preserved production diagnostic remains the red-capable CPU evidence; local functional tests protect behavior rather than pretending to assert Cloudflare CPU.
