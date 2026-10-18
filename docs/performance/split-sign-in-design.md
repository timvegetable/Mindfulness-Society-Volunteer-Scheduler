# Split sign-in CPU experiment

Status: local candidate on `codex/split-sign-in-cpu`; production remains the restored `2ecbe19` baseline. This is a bounded sign-in protocol change, not a scheduler rewrite.

The failed `55e53c1` trial measured first-observed sign-in at 12 ms private + 3 ms main. It establishes insufficient headroom but does not isolate Google verification, HMAC setup, D1 conversion or first-use imports. Splitting work is a falsifiable experiment, not a promised fix.

## Interface and ownership

Keep `ApiClient.call('session.me', {})` as the caller's interface. Internally, enabled production uses two sequential external requests:

1. `POST /api/identity` accepts only a bounded Google credential. The private Worker verifies Google using the unchanged issuer/audience/RS256/expiration/verified-email rules, then signs a purpose-specific identity proof. It reads no D1 data and returns no account information.
2. `POST /api` with `session.me` accepts that proof. The private Worker verifies it, loads the current account, centers and revisions in one D1 batch, applies current policy, and issues the existing R2 read session.

The second stage must not invoke the first stage internally: nested work would defeat the intended external-request split. The proof remains a bearer credential in memory only, is never logged or persisted, and is discarded after exchange. Failed transport does not trigger automatic unbounded retries. Existing shared renewal prevents concurrent reads from multiplying exchanges. A sign-out during either stage invalidates the pending result.

This adds one external request per exchange, plus one cheap protocol-negotiation request on first sign-in. It adds no D1 query or Queue operation to Google verification. It trades request count and latency for a smaller CPU budget per request; it does not reduce total computation by itself.

## Proof contract

Use a distinct `g1` version, issuer and `session.exchange` purpose; bind it to the existing application/environment/OAuth audience. Sign exact canonical claims including normalized verified email, issue time, expiry at most 60 seconds, and the original verified Google expiration. The read session must expire no later than that original Google expiration or 15 minutes after issuance. A proof must not extend its own validity or accept caller-supplied identity/expiry.

The proof has no application account ID or roles: account selection and authority are checked fresh at stage two. Account replacement between stages has the same semantics as a fresh Google sign-in, since stage one grants no application account access. The resulting R2 ticket binds the selected account ID and email; subsequent reads reject replaced accounts and revoked authority.

Proofs can be replayed within their 60-second validity, like the Google bearer credential they replace. Replay only performs fresh account authorization and issues an expiry-bounded read session; no domain mutation occurs. A one-use proof would require new transactional storage and extra cost without removing the original Google credential's replayability. Expiry is enforced by the signed server protocol, independently of the browser clock.

Reuse the native canonical HMAC implementation with purpose-specific claim guards. Reject signature tampering, noncanonical encoding, unsupported versions, wrong audience/purpose, future issue times, invalid expirations and excessive lifetimes. Existing bounded key rotation remains; no new secret is needed. Never accept a proof for schedule reads, generic reads or mutations. Writes continue to require Google credentials.

## Compatibility and failure behavior

Retain the old private Google exchange only for older main Worker callers during staged deployment and rollback. New main requires a proof and returns a cheap typed protocol-upgrade response for a legacy Google `session.me`; the new client learns and performs the two steps once. New main sends an explicit protocol header so it cannot accidentally fall back to the combined exchange. Deploy the compatible private Worker before main/client. No migration, storage, new Worker or Queue resource is required.

## Validation and release gates

Native integration must cover real synthetic RSA Google credentials, actual HMAC, two external requests, full session response validation, no D1 access in stage one, proof isolation, expiration, current authority changes between stages, bounded input, disabled mode and legacy rollback compatibility. Client tests cover upgrade, shared renewal, error propagation and sign-out races. Browser tests cover the normal sign-in and explicit read renewal flows without background polling.

Run corrected full tests, types, browser checks, builds and production dry runs before committing. A separate explicit production approval must name the candidate. Capture both Workers; each external request must pass the conservative 9 ms combined CPU gate, including first-observed samples after deployment and the initial typed protocol-negotiation response. Sum main/private CPU within each external request, not across the two separate stages. If either stage fails, roll back both immediately and stop the trial. Do not infer CPU fit from local profiling or functional success. No live domain mutations or notifications are needed.

If Google verification plus proof signing alone exceeds the gate, stop splitting blindly: investigate first-use dependency/crypto cost with one measured variable at a time. Rust/Wasm or custom JWT validation are not justified by the present evidence. Other authenticated reads, writes and changed-source Queue costs remain separate unresolved gates.

## Implementation review

The native HMAC framing and key rotation now have one owner in `signedTokens.ts`. R1, R2 and G1 retain separate exact claim guards; the R1/R2 wire formats are unchanged. Google provider-key caching has one owner shared by the proof stage and the legacy private exchange. The second stage lazily imports Google verification only for legacy protocol callers, so the new proof exchange does not deliberately initialize the Google verifier.

Native tests run the proof stage in a Worker with no D1 binding, use real synthetic RSA Google credentials, and then consume the proof through the normal main/private exchange. They reject proof use for reads/writes, signature tampering, excessive request size and extra caller-supplied identity. Deactivating the account between stages rejects exchange. Existing tests still cover legacy R1 exchange, complete result schemas, revoked roles, replaced account IDs and malformed stored authority. Token tests cover separate purposes/audiences, exact claims, lifetime bounds, original Google expiry and bounded key rotation. Client tests cover shared renewal, protocol discovery, malformed/failed proof responses, browser clock skew and sign-out during verification.

Deployment order is compatible private Worker first, then main/client. Rollback order is main `7bb1b7b4-daa4-4923-847a-3586c7e29cd6` first, then reader `d679ba8e-64d3-4546-8fdf-055960777e67`. No production action is part of this local implementation. Local success establishes functional behavior only; production CPU, largest inputs and the other endpoint costs remain unverified.

Final application validation: 367 tests across 20 files, 48 browser tests, type checks, CSS formatting and both Worker/client builds pass. The native integration additionally passes explicit disabled-mode, invalid-method/content-type and previous-main R2 exchange checks. The initial browser attempt could not launch because the matching Chromium binary was absent; installing the official runtime into `/tmp/scheduler-playwright` allowed the complete suite to run. Both private production configurations pass dry runs. No production deployment was performed.
