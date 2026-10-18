# Remaining authenticated CPU work

Status: candidate `55e53c1` on `codex/authenticated-cpu-budget` was trialled with explicit approval and rolled back after its first observed sign-in failed the CPU gate. Production is restored to application source `2ecbe19`. No domain mutation was performed.

## Production trial result

The [sanitized trial record](authenticated-read-session-trial.json) records successful HTTP responses but sign-in CPU of 12 ms in the private reader and 3 ms in main (15 ms combined). Its immediately following prepared schedule read used 5 + 1 = 6 ms. The private invocation alone exceeded the Free request limit, so this is not merely a stricter combined-budget failure. Both Workers were rolled back to the versions below; Wrangler confirmed each at 100% of traffic. No identical redeploy or further endpoint sampling was performed after the failure, and the other R2 reads remain unverified in production.

This single sign-in sample establishes insufficient headroom, not the exact cause of the increase over the earlier 8 ms private baseline. R2 still performs one ticket signature; it does not remove the Google verifier, D1 account/center read, or first-use module work from sign-in. The next bounded experiment should separate Google credential verification from account lookup and session-ticket issuance into different external requests, using a short-lived, audience-bound signed identity handoff and a fresh current-account authorization check at issuance. That design requires review before implementation; do not cache permissions or weaken Google verification to meet the budget. Remaining generic-read CPU benefits cannot be claimed from this aborted trial.

## Baseline and diagnosis

Read-only navigation on the current production deployment reported synchronization-status CPU at 16 then 8 ms, Insights at 7 ms, and center proposals at 27, 16 and 17 ms. Every request succeeded functionally. The [sanitized baseline](authenticated-reads-baseline.json) retains operation-attributed Cloudflare CPU. `python3 /tmp/remaining-cpu-budget/read-gate.py` exits 1 if any successful captured read exceeds 9 ms; it was run red before implementation.

The working hypotheses are first-use Google verification/key setup, generic request/runtime overhead, and operation-specific data work. A private-backup local Node probe separated proposal calculation (0.350 ms mean), shared response validation (0.074 ms) and serialization (0.005 ms), averaged over 300 warm calls. This identifies relatively small pure-JavaScript costs on that local runtime; it is not a production CPU bound or proof of the exact production bottleneck.

A new local native Tail probe was also calibrated against a 20-million-iteration CPU loop. It reported zero CPU and wall time, so native local Tail telemetry is not a valid performance gate. Previously calibrated Inspector limitations still apply. Deployment-attributed Cloudflare measurements remain necessary.

## Candidate

Extend the existing short-lived, memory-only read-session mechanism to all non-mutating operations except session exchange. One R2 ticket has issuer `umd-scheduler-read-v2`, purpose `api.read`, application/environment audience, current account ID/email, and expiry no later than Google expiry or 15 minutes. A single signing operation issues it. Existing R1 administrator schedule tickets retain their original scope and continue to work only on the prepared schedule endpoint.

The private Worker verifies R2 signatures. The main Worker never receives the signing secret. Each generic read still transactionally reads current D1 accounts and data, binds both signed account ID and normalized email, and applies the existing operation and resource policies. No identity, activity, role or center-authority cache is added. Every mutation and session exchange requires Google credentials; read tickets are explicitly rejected for writes before any mutation handler runs.

Final review also reproduced a pre-existing authority-shape gap: a malformed stored JSON scalar role string could pass an array-style permission check. The native regression failed before the correction. Generic dispatch now validates the selected current account against the shared `UserSchema` before policy checks. Synthetic tests cover malformed roles and center IDs under both Google and read-session authentication; valid unrelated accounts remain usable. No production corruption was observed.

The client shares renewal across explicit reads, keeps mutation intent handling, and learns the R2 protocol through session exchange or a cheap typed cutover response. There is no Google-verification fallback for generic reads after cutover and no background polling. The prepared schedule keeps its current separate fast path.

For staged deployment and rollback, the private exchange only emits the new `readSession` field when called by the new main Worker with `X-Read-Session-Protocol: 2`. Older main Workers keep the R1 response schema. Deploy the compatible private Worker before the new main/client. Old open clients may require a refresh; new clients recover an already-open cutover with their in-memory Google credential.

## Gates and remaining scope

Validation: all 360 tests across 19 files pass, including native two-Worker service-binding tests; all 48 browser tests pass. Type checks and build pass. Coverage includes scope confusion, account replacement, current role revocation, expiry, bounded input, legacy exchange compatibility, shared renewal and malformed stored authority. Local functional success does not establish CPU fit.

A controlled production trial must measure sign-in, synchronization status, Insights, center proposals, read-only schedule preview and the existing schedule, including first observed requests after deployment. Capture both Workers and sum caller/private verification CPU for each request; require at most 9 ms combined, with correct responses and no CPU-limit errors. Deploy the private Worker first, then main/client, and allow one identical redeploy of each for first-observed samples. Roll back both if correctness or CPU gates fail. Rollback targets are main `7bb1b7b4-daa4-4923-847a-3586c7e29cd6` and reader `d679ba8e-64d3-4546-8fdf-055960777e67`; production source remains `2ecbe19`. No trial domain mutation or notification is needed.

No new migration, secret, database backfill or Queue resource is needed. A production deployment still requires the specific approval in README. Live publication, cancellation, candidate confirmation, changed-source application or notifications need their own authorized boundary; do not manufacture real source changes to collect performance samples.

Writer preparation, read-only schedule preview, genuinely changed-source synchronization and larger-input/daily quota verification remain in scope after this read-path trial. If they require a substantial architectural rewrite, present that change before implementing it.
