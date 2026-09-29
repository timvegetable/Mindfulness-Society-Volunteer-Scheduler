# Prerequisite: the attributed 503 and the JWKS failed-load condition (task 1.6)

Date: 2026-09-29. Scope: classify the one 503 the 2026-09-29 preview campaign
retained, under the predeclared failure rules of the **unchanged** experiment
contract (`archive/2026-09-29-validate-worker-backend-feasibility/evidence/experiment-contract.md`,
amendment 2026-09-27), and state plainly whether those rules required a repair or
whether recording an attributed, retained failure was sufficient.

Method and provenance: read-only review of the private campaign material in
`staging-local/` and of the worker source. Exactly one tracked file was written
(this one). No source, script, documentation or task-list edit; no deployment, no
`wrangler` invocation, no Cloudflare or Google mutation, no install. Sections
**(a)**, **(b)** and **(c)** separate retained measurement, code reading, and
inference; every claim is labelled with the section that supports it.

Summary finding: the recorded 503 is real, retained and deployment-adjacent, but
**it was never served by the Durable Object**, and the mechanism the archived
verdict names for it ("the documented JWKS failed-load window") is contradicted by
the retained record. Its nearest script-modifying operation was 4.6 s before it, not
12 s: each approved redeploy is a version upload plus two secret uploads, and the
failing cycle is the only one of fourteen retained host cycles that lost an attempt.
The JWKS failed-load condition itself has no retained 2026-09-29 occurrence. Task
1.6's two halves are therefore separate: the 503 needs a corrected attribution, and
the JWKS condition needs either a matching observation or a repair plus repetition.

## (a) What the retained telemetry shows

### The event

Source of record: `staging-local/preview-campaign-larger-h5.attempts.jsonl`, line 3
(the campaign's primary report path was `staging-local/preview-campaign-larger.json`;
`-h5` is the copy set aside after the run, and both attempt logs hold the same line).
Summarised at `staging-local/preview-campaign-larger-h5.json`:
`burst.statuses = {200: 19, 503: 1}`, `burst.failures = {5xx: 1}`.

| Field (as recorded) | Value |
| --- | --- |
| `startedAt` | 2026-09-29T17:48:02.150Z |
| `durationMs` | 609 |
| `status` | 503 |
| envelope | `ok:false` with error code `UNAVAILABLE` (the harness records only the code, `scripts/staging/measure-worker.mjs:341`) |
| `sheetsReads` | 0 |
| `phase` / `index` | burst / 4 (fifth of twenty) |
| `inFlight` | 4 |
| `X-Staging-Snapshot-Digest` | absent |
| `X-Staging-Host-Deployed-At` | absent |
| `X-Staging-Correlation-Id` | **absent** |

The other retained failure lines in the private directory are fourteen, all from the
2026-09-28 insight and preview runs listed under "Related occurrences". On
2026-09-29 the 503 is the only recorded non-200 attempt — it appears once in each of
the two copies of that run's attempt log, and nowhere else in `staging-local/`.

The failing attempt is bracketed by successes that carry both server headers: the
cold attempt at 2026-09-29T17:47:57.693Z (200, 1,637 ms, 2 reads) and the four burst
attempts that started at 17:47:59.342–17:47:59.345Z (200, 1.4 s and 3.4 s) each
record a deployment marker and a correlation id, and 40 of the run's 41 attempts
carry both fields. The
harness reads those headers from the same response object for every attempt
(`scripts/staging/measure-worker.mjs:330-338`), so their absence on the 503 is a
property of that response, not of the capture path. No correlation id is retained
for the 503; the archived verdict's "correlation id present" cannot be reproduced
from the retained attempt records.

### The deployment cross-check

Real field name in the deployment reports is `deployedAt` (not a duration or a
marker of its own):

* `staging-local/deployment-preview-host-5.json` — `deployedAt` =
  **2026-09-29T17:47:50.265Z**, `target: host`, benchmark enabled.
* `staging-local/deployment-preview-gateway-5.json` — `deployedAt` =
  2026-09-29T17:41:44.356Z, `target: gateway` (6 min 17.8 s before the event).

Gap from the deployment stamp to the 503: **11.885 s**. The claim "12 seconds after a
host redeploy" therefore **holds** against the recorded deployment timestamp, and it
does not describe the gateway redeploy. The run's own marker agrees: the report and
every successful attempt carry `hostDeployedAt = 2026-09-29T17:47:50.265Z`, exactly
the host #5 `deployedAt`, and the manifest that produced the run
(`staging-local/preview-manifest-larger.json`) pins the same value, so the run
followed host #5 and its cold attempt was counted as genuine by the version-lag
check (`scripts/staging/measure-worker.mjs:230-237, 427`).

#### The redeploy was three script-modifying operations, not one

The retained Wrangler CLI logs (`.jspace/wrangler-logs/`, private, not committed)
show what each approved redeploy actually did: a script/version upload, then two
`wrangler secret put` uploads against the same script — the order
`scripts/staging/deploy-staging.mjs` performs (`:115-123`, `:148-159`, "Code first,
then secrets"), with the same shape in **every** host cycle retained for the two
campaigns (six cycles on 2026-09-29, eight on 2026-09-28), while the gateway cycles
upload no secrets. For the host #5 cycle:

| Operation | Completed (UTC) | Before the 503 |
| --- | --- | ---: |
| script/version upload (`PUT …/versions` in the deploy log) | 2026-09-29T17:47:54.588Z | 7.562 s |
| `secret put` of the service-account private key | 2026-09-29T17:47:56.361Z | 5.789 s |
| `secret put` of the service-account email | 2026-09-29T17:47:57.569Z | **4.581 s** |
| deployment stamp / marker (`deployedAt`) | 2026-09-29T17:47:50.265Z | 11.885 s |
| first request of the measured run (cold attempt) | 2026-09-29T17:47:57.693Z | (4.457 s before the 503) |

So the measured run began **0.122 s** after the last script-modifying upload and
3.103 s after the version upload — not 12 s after the last change. The same position
in the sequence is *not* by itself harmful: the immediately preceding cycle (host #4)
started its run 0.128 s after its own second secret upload and produced 41/41 healthy
attempts, and the host #1 cycle's run started 5.6 s after its second secret upload,
also clean. Two consequences to record:

* A `wrangler secret put` is a script-modifying API operation against the deployed
  script. Whether the platform rolls each into its own propagated version is a
  platform behaviour the retained CLI logs do not show; the campaign script treats
  all three operations as one deployment.
* The harness's deployment marker is fixed at upload time
  (`scripts/staging/deploy-staging.mjs:155-158`), so the version-lag check cannot see
  the two later secret uploads: a "genuine cold" verdict is blind to them.

### The object never served the failed request

The namespace-filtered invocation dataset for the campaign window
(`staging-local/raw-do-invocations-preview-campaign-2026-09-29T20-15-00-154Z.json`,
335 rows, 2026-09-29T07:20:00Z–18:15:00Z) reports platform status `success` and
`errors: 0` on **every** row (570 recorded object requests, 0 errors). Summing the
per-second `sum.requests` over each run's own window (`startedAt`..`generatedAt`)
and comparing with the attempt log the harness wrote for that run:

| Run (larger fixture) | Attempts issued | Object requests in window |
| --- | ---: | ---: |
| gateway cold #1 (`…larger-gw1`) | 41 | 41 |
| gateway cold #2 (`…larger-gw2`) | 41 | 41 |
| gateway cold #3 (`…larger-gw3`) | 41 | 41 |
| host cold #3 (`…larger-h3`) | 41 | 41 |
| gateway cold #4 (`…larger-gw4`) | 41 | 41 |
| gateway cold #5 (`…larger-gw5`) | 41 | 41 |
| host cold #4 (`…larger-h4`) | 41 | 41 |
| **host cold #5 (`…larger-h5`)** | **41** | **40** |

Seven control runs reconcile exactly; the failing run is short by exactly one
request. The h5 run issued 41 attempts with none deferred (attempt ledger
`staging-local/.attempt-budget-ledger.json` moved 488 → 529; the report records
`deferredByPhase = 0`), and its window contains no other known traffic: the paced
browser probe ran at ~18:01Z (`staging-local/.read-budget-ledger.json` retains only
its 18:01:27–18:01:29Z reservations) and post-campaign verification at 18:02Z, both
outside the window. The direction of the arithmetic also makes the finding robust:
any *unrecorded* traffic in that window would increase the served count, so the
shortfall is a lower bound of one — the failing attempt is the only candidate.

Consequence: the failed request produced no Durable Object invocation record. The
platform therefore neither confirmed nor refuted an object-side error for it; it
recorded nothing to attribute an object-side failure to.

### Non-recurrence

The condition did not recur in the retained traffic after the event: the paced
browser probe finished 15/15 successful (`staging-local/browser-probe-probe-2026-09-29T18-01-29-527Z.json`)
about thirteen minutes later, and the post-campaign verification passed. That is a
statement about the retained attempts, not a rate estimate.

## (b) What the code shows

### Only two code paths produce this 503 shape

A 503 carrying the bounded `UNAVAILABLE` envelope can only come from:

1. `src/worker/gateway.ts:53-63` — `unavailableResponse()`, called from the single
   catch at `src/worker/gateway.ts:170-173`. Its headers are content type,
   `Cache-Control`, `X-Content-Type-Options` and `X-Frame-Options` **only**.
2. `src/worker/host.ts:110-124` — the object's own catch, same envelope and status,
   also without the deployment marker (`src/worker/host.ts:133-145` is the host's
   default handler, unreachable through the gateway binding).

### The headers discriminate them, and rule the JWKS path out

* The gateway generates one correlation id per request (`src/worker/gateway.ts:124`),
  forwards it as a header (`:157`), and sets `X-Staging-Correlation-Id` on **every
  forwarded response** returned from the object call (`:166-169`).
* The object sets `X-Staging-Host-Deployed-At` on every response it serves
  (`src/worker/host.ts:103-109`), including error envelopes produced by the read
  API; only its own catch path (`:110-124`) omits it.
* The JWKS/key-set failure is an **object-served** path. `src/worker/staging.ts:215`
  verifies the credential before anything else; on a `SigningKeyError` whose
  `unavailable` flag is set it returns `failure('UNAVAILABLE', …, { reason: 'key-set' })`
  (`src/worker/staging.ts:219-221`). The transport serialises **every** dispatched
  envelope with HTTP 200 (`src/worker/read-api.ts:270-272`; the transport's own catch
  does the same at `:273-276`), and the object adds its marker before returning
  (`src/worker/host.ts:102-109`). A key-set failure therefore reaches the client as
  **200 + envelope + marker + correlation id**, never as a 503 without those headers.

The recorded 503 has the opposite signature (no marker, no correlation id, status
503), which matches only path 1: the gateway's catch, i.e. the cross-script object
dispatch at `src/worker/gateway.ts:166` threw. This is an inference from code plus
headers, and it is independently corroborated by (a): the object recorded no request
for that attempt.

### The three candidate 503 sources, decided one at a time

| Candidate source | What the retained evidence says | Verdict |
| --- | --- | --- |
| (1) key-set mapping at `src/worker/staging.ts:219-221` (`SigningKeyError.unavailable`) | This is an object-served path: it needs an object invocation, the transport serialises it as HTTP **200** (`src/worker/read-api.ts:272`), and the response carries the host marker and the gateway's correlation header. The failing attempt has neither header, and the run's object recorded no request for it. | **excluded** |
| (2) host configuration-error 503 (`src/worker/host.ts:115`; the default handler at `:135`) | `:115` requires the object's `fetch` to run, so a Durable Object invocation, and the response would still carry the correlation header the gateway sets on every forwarded response (`src/worker/gateway.ts:167-169`); `:135` is unreachable through the DO binding. | **excluded** |
| (3) gateway catch-all 503 (`src/worker/gateway.ts:166` → `:170-173`) | The only producer of the bounded `UNAVAILABLE` envelope with **neither** the host marker nor the correlation header, and the only one consistent with the missing object request (no request was served). | **supported** |

None of the three writes a log line that is retained: there is **no Worker-side log
capture at all** in the repository or the private material for either campaign — only
the Wrangler CLI logs are kept, and those record deployments, not served requests.
The absence of `staging verification unavailable`, the host's configuration warning,
or `staging gateway refused` therefore excludes nothing; the discriminating evidence
is the response headers and the object request count, not the missing log lines.

### The failed-load window the task names

`src/worker/google/jwks.ts`:

* `DEFAULT_MIN_RELOAD_INTERVAL_MS = 5_000` (`:21`) bounds both rotation reloads and
  retries after a failed load.
* `performLoad` stamps `lastAttemptAt = nowMs()` **before** the fetch
  (`:105-108`), so an attempt that throws — network failure (`:113`), non-OK
  response (`:115`), unparseable body (`:120`), or a key set with no usable key
  (`:123`) — leaves `entries` empty and the window armed.
* The gate at `:170-172` then throws
  `SigningKeyError('The identity provider key set is not available yet.', true)`
  for any caller that needs keys in the next five seconds while no load is in
  flight; `:132-136` shares one in-flight load; `:180-190` is the separate
  unknown-key-id reload path, whose error is `unavailable = false` and therefore
  maps to `UNAUTHORIZED` at `src/worker/staging.ts:223-224`, not to this event.
* The key store is isolate-scoped (`src/worker/staging.ts:84-93, 131-142`), so the
  window is per isolate and a cold isolate that fails its first load loses the
  requests that arrive inside it: exactly the caveat both archived verdicts carry
  forward.
* The verification call that consumes it is `src/worker/google/id-token.ts:37`.

### What the in-flight-join fix did and did not fix

`d1961cd` ("Join the in-flight key-set load instead of failing concurrent cold
verifiers", 2026-09-28) changed one condition: the gate now fires only when
`pendingLoad === undefined` (`src/worker/google/jwks.ts:170`), so concurrent cold
verifiers `await load()` and share one fetch instead of failing while it is in
flight.

* Fixed: the concurrent-cold failure mode — several first requests in one fresh
  isolate, where all but the loader were refused although a shared load was already
  running.
* Not fixed, by design: the **failed-load** window. A load that actually fails still
  arms `lastAttemptAt` before it fails, so the following five seconds still fail
  closed with no outbound fetch. Both halves are asserted in the retained regression
  test `src/worker/google/auth.test.ts:240-261` (three concurrent callers resolve
  from one load; then a failing load is followed by two gated refusals).
* Neither mode can produce a 503: both surface through `src/worker/staging.ts:221`
  and `src/worker/read-api.ts:272` as HTTP 200 envelopes on an object-served
  request. The dispatch seam itself is `src/worker/dispatch.ts:14-20`; only tests
  import it — the live object composes the same service per request at
  `src/worker/host.ts:88-102`.

## (c) What I infer

1. The failing request never reached the object (a: 41 issued / 40 served, with
   seven exact control runs).
2. Therefore the 503 was produced by the gateway's own catch
   (`src/worker/gateway.ts:166` → `:170-173`), because no other producer can emit
   that envelope without the correlation header and the host marker (b).
3. Therefore the archived verdict's named mechanism — "the documented JWKS
   failed-load window" — is **not supported and is inconsistent with the record**.
   The recorded event is a transient failure of the gateway→object dispatch while
   three other preview requests were in flight in the same object. The nearest
   script-modifying operation was 4.581 s earlier (the second secret upload) and the
   version upload 7.562 s earlier; a redeploy on this topology is three uploads in
   about seven seconds, not one. Version propagation and object instance/class
   refresh are the only mechanisms I can identify that fail one concurrent dispatch
   member and nothing else; the host #4 cycle is the control that keeps this honest —
   its run started 0.128 s after its own second secret upload, the same position in
   the sequence, and lost nothing. The deployment sequence is context, not a
   demonstrated cause. I record this as inference, not measurement.
4. The specific platform error is *not* established: the gateway logs it at
   `src/worker/gateway.ts:172`, but no Worker-side log is retained for any attempt,
   and the retained gateway-script metric window for 2026-09-29 covers only
   07:32:04–07:35:00Z (`staging-local/metrics-gateway-representative-window.json`),
   about six hours earlier. The contract expects exactly those correlation ids and
   start markers in sanitized telemetry (`experiment-contract.md:482-484`); here they
   are absent.

## Classification under the predeclared rules

The contract's own wording, quoted:

* `experiment-contract.md:342-344` — "**Retries:** the measurement path performs
  none. A `429`, `5xx`, timeout or `exceededCpu` is a retained failure, attributed
  to quota or platform, and never silently retried into a success."
* `experiment-contract.md:397` — "Failure rate | Zero **unexpected** failures on the
  representative workload, where "unexpected" means a response that is not a 200
  carrying a parity-matching envelope and is not a deliberately submitted
  negative-path probe or an attributed quota/platform failure. Counts are reported
  per category: `parity-mismatch`, `wrong-status`, `429`, `5xx`, `timeout`,
  `exceededCpu`, `exceededMemory`."
* `experiment-contract.md:400` — "A missed headroom threshold that is not CPU is
  reported as a deviation with its cause, not as a failed run." (This sentence sits
  inside the "Other headroom" row of the single-Worker table; it is not a general
  licence to record any unmet row, and the amendment's reliability row does not
  restate it.)
* `experiment-contract.md:428-435` — the Durable Object amendment "amends and
  extends, never relaxes, the thresholds above"; `:456` — "Reliability | Zero
  unexpected failures, zero quota errors, zero resource-limit errors across all
  workloads"; `:462-464` — "Thresholds are never adjusted after observing results. A
  threshold that cannot be evaluated is reported **not evaluated** and caps the
  verdict at **conditional-go**; an unmet threshold that is not repairable records
  **no-go**."
* Attribution rules: `:468-472` (records attributed explicitly to script, namespace,
  deployment and window; ambiguous attribution "cannot pass a gate"), `:477-479`
  (insufficient coverage cannot pass a gate), `:497-503` (cold sequences use
  individually approved redeployments; every attempt retained; no automatic retries).

**Classification of the event.** Three candidate categories, decided one at a time:

* *Deliberately submitted negative-path probe* — no. The campaign's negative probes
  are separately recorded with `phase: "denial-probe"`
  (`staging-local/do-cold-attempts.jsonl`, the `FORBIDDEN` lines), and the harness
  issued only the positive `admin.schedule.preview` operation.
* *Attributed quota/platform failure* — this is the category the contract's own text
  provides for a retained 5xx (`:342-344`), and it is the category that fits the
  corrected mechanism (a platform dispatch failure 4.581 s after the last
  script-modifying operation of an approved redeploy, deployment and window both
  known). What the retained material
  does **not** provide is the script-level attribution `:468-472` requires: no
  gateway invocation or log record exists for those seconds, and the object recorded
  no request at all. In the category sense the event is a platform failure; in the
  attribution-rule sense it is only partly attributed (deployment and window yes,
  failing script and platform error no).
* *Unexpected failure* — if the corrected attribution is not accepted, this is the
  honest reading: a 503 that is not a 200 with a parity-matching envelope, is not a
  submitted negative-path probe, and is not documented as an attributed
  quota/platform failure.

So the contract's text supports "attributed platform failure" **only in its
category sense**; it does not support the archived verdict's *mechanism*.

**Where the archived verdict is stronger or weaker than the contract's wording.**

* Stronger: it applies the failure-rate carve-out to the **larger** workload, but the
  carve-out is defined in a row scoped to the **representative** workload (`:397`),
  while the amendment's reliability row states the gate "across all workloads"
  (`:456`) without restating the definition. It also reads a "deviation, not a
  failed run" spirit from `:400`, a sentence whose scope is the "Other headroom" row.
* Weaker: it attributes the event to "the documented JWKS failed-load window", a
  mechanism the retained record contradicts (a and b). A retained 5xx is "attributed
  to quota or platform" only when the attribution holds; naming the wrong code path
  is not an attribution, and `:468-472` requires explicit, non-ambiguous attribution
  before a gate can pass. Its "correlation id present" is also not reproducible from
  the attempt records.

**Did the rules require repair?** No — not for this event. `:342-344` requires that a
`5xx` be **retained and attributed, never silently retried into a success**; it does
not require a code fix. `:462-464` forces **no-go** only for an unmet threshold that
is *not repairable*, and it keeps an unevaluated threshold at conditional-go. So
recording an attributed, retained failure was sufficient **provided the attribution
is correct** — and that is exactly what is missing. If the corrected attribution is
accepted, the reliability row is untouched by this event and task 1.6 closes on
documentation. If it is not accepted, the event stands as one unexpected failure on
the larger workload (the archived verdict's count: 1 in 161 larger-fixture burst
attempts), the reliability row is read as unmet on retained evidence, and `:462-464`
then requires either a repair and re-measurement or an explicit not-repairable no-go
— not a "met" label. Stated
without softening: the archived verdict's "met with one attributed failure recorded"
rests on an attribution the private record does not support.

## Repair assessment (not implemented)

* **For the event that was actually recorded** (gateway dispatch failure): code
  cannot remove a platform propagation/restart window. The options are (i) a bounded
  retry of the object dispatch inside the gateway — which would *hide* the failure
  from the reliability gate and sits badly with `:342-344`'s ban on retrying a
  failure into a success, and would break comparability with the archived runs unless
  predeclared as a measurement-path change; or (ii) better observability — a distinct
  `reason`/log line for the dispatch failure plus a retained Worker-side log capture,
  so the next occurrence is attributable under `:468-472`. Option (ii) does not
  eliminate the condition; it makes it classifiable. A third, *operational* candidate
  is to stop re-uploading secrets that have not changed (each host cycle currently
  performs two secret uploads after every version upload, so every redeploy is three
  script-modifying operations); that is a script/edit change outside this session's
  scope and, on the retained evidence, a mitigation hypothesis rather than a
  demonstrated fix — the host #4 cycle in the same position in the sequence was
  clean.
* **For the JWKS failed-load window** (the condition task 1.6 names): the window can
  be narrowed or removed — e.g. stamp `lastAttemptAt` only on a *successful* load, or
  clear it when `performLoad` throws (`src/worker/google/jwks.ts:105-130`), or permit
  one immediate re-attempt after a failed load with jittered backoff while keeping the
  single-reload-per-window rule for unknown key ids (`:180-190`). Trade-off: the
  window is the anti-storm bound documented at `:8-12` and `:163-169` — any caller can
  present a credential, so loosening it multiplies outbound JWKS fetches during a
  Google outage and spends the subrequest headroom the contract fixes at ≤ 3 warm /
  ≤ 5 cold per request (`:400`). Removing the window costs at most one fetch per
  request while the outage lasts at the paced harness rate; a bounded re-attempt costs
  a small multiple. Note that this repair would not have prevented the recorded 503.
* **Evidence a repair would have to produce** under the contract and repo policy: a
  regression demonstrated to fail before the fix (task 1.6's own wording; `AGENTS.md`
  testing policy), then the affected cold/burst workload repeated with every attempt
  retained (`:502`), cold sequences through individually approved redeployments
  (`:497-498`), all thresholds unchanged (`:462`).
* **Cost.** Any such repeat needs individually approved staging redeployments — one
  approval each (`scripts/staging/deploy-staging.mjs:130-131, 142`; `AGENTS.md`;
  `plan.md:37`). That is outside this session's approval scope, and nothing was
  deployed, invoked through `wrangler`, or mutated here.

## Related occurrences

* **2026-09-28, four insights-burst failures** —
  `staging-local/do-measure-larger-admin-insights-read.json.attempts.jsonl`
  lines 27, 28, 31, 32 (2026-09-28T05:25:08.791Z–05:25:09.276Z). Shape: HTTP **200**
  with an `UNAVAILABLE` envelope, a correlation id present, **1–2 recorded Sheets
  reads**, 2–4 in flight; the report records `statuses = {200: 40}` and
  `failures = {5xx: 4}`. They share the *disposition category* with the 2026-09-29
  event (retained, attributed, a single burst, no retry) but **not the mechanism**:
  the key-set path runs before the identity read (`src/worker/staging.ts:215` before
  `:253`), so a key-set failure can never record a Sheets read — and these four did.
  The archived "same attribution" is therefore not corroborated either, and the
  envelope's `details.reason` (the field that names the failing stage) is not
  retained by the harness, which records only the code
  (`scripts/staging/measure-worker.mjs:341`). Their exact cause is not determinable
  from the retained material.
* **2026-09-29, 41 expired-credential attempts** — a separate, already-attributed
  population: the archived execution record (`archive/2026-09-29-accelerate-schedule-preview/execution-record.md`,
  deviation 3) records a credential that expired mid-chain at ~07:40Z, with 41
  attempts retained as `envelope-UNAUTHORIZED` failures, zero domain reads, and no
  `5xx`, quota or resource-limit category. It is not the same failure class as the
  503. One caveat: those 41 records are **not present** in `staging-local/*.attempts.jsonl`
  — a scan of every attempt log finds no `UNAUTHORIZED` line — so their retention
  claim cannot be re-verified from the private material here (the same directory
  discloses one clobbered report/attempt log, deviation 2).
* Also absent from the retained private material: the six "pre-fix cold-burst
  verification failures" the 2026-09-28 verdict cites as attributed and retained
  (`archive/2026-09-29-validate-worker-backend-feasibility/evidence/verdict-2026-09-28.md:32`).
  Consequently the JWKS gate's own signature also has no retained field example in
  `staging-local/`; the only retained evidence for that window is code plus the
  regression test `src/worker/google/auth.test.ts:240-261`.

## Not established

* The thrown error behind the gateway 503. The gateway logs it
  (`src/worker/gateway.ts:172`); no Worker-side log capture exists for any attempt of
  either campaign, and no gateway-script metric window covers 17:47:50–17:48:10Z.
* Whether the two secret uploads in each cycle produce their own propagated versions,
  and if so what the platform does to a Durable Object mid-rollout. The retained CLI
  logs show the operations and their completion times, not the platform's version
  semantics.
* Whether the object was actually invoked and its record dropped, or the dispatch was
  refused before delivery. The 41→40 shortfall proves only that no object request was
  served or recorded for the failing attempt.
* The exact `details.reason` of the 2026-09-28 insights failures (not retained).
* The individual records of the 41 expired-credential attempts and of the six pre-fix
  cold-burst verification failures (described in archived prose, absent from
  `staging-local/`).
* Whether the dispatch failure recurs, and at what rate. The retained later traffic
  (the 15 browser-probe attempts at ~18:01Z and the post-campaign verification at
  18:02Z) shows no recurrence, which is not a rate estimate.
* Whether the JWKS failed-load window has ever been hit in the retained 2026-09-29
  campaign: no retained failure line matches its signature (200 + envelope + marker +
  correlation id + 0 Sheets reads).

## Input needed to close task 1.6

The classification above does not by itself close 1.6, because the retained record
refutes the recorded mechanism and cannot supply the missing platform attribution. A
decision-maker needs exactly one of:

1. **A read-only attribution capture for the event window** — the gateway script's
   per-invocation rows *and*, if the platform still retains them, its Worker-side log
   lines for 2026-09-29T17:47:50–17:48:10Z (the narrowed window the archived
   collector's density guard accepts; the retained credential for the query lives in
   private storage), together with the object namespace rows for the same seconds.
   The decrypting detail is the dispatch error the object call raised, which the
   gateway logs at `src/worker/gateway.ts:172` and which no retained artefact
   currently holds. If it is named there, the event becomes an attributed platform
   failure, the archived classification is corrected in place (mechanism:
   post-redeploy dispatch during the version-upload/secret-upload window, not the
   JWKS window), and 1.6 closes on documentation with no repair. This is a
   collection, not a deployment. If Workers Logs retention has already expired for
   that window, this path is gone and only 2 or 3 remain.
2. **Or approval for the repair path** — a code change to the failed-load window
   (and/or a distinct dispatch-failure reason), a regression shown failing before the
   fix, and the affected cold/burst workload repeated with every attempt retained —
   which requires individually approved staging redeployments, each with its own
   approval, outside this session's scope.
3. **Or an explicit disposition decision** — if neither 1 nor 2 is granted, record
   the 503 as a retained, non-reproducible 5xx whose named mechanism is corrected but
   whose failing script is unattributed. Under `experiment-contract.md:397` that
   reading makes the reliability row unmet on the larger workload (the archived
   verdict's count: 1 in 161 larger-fixture burst attempts), and under `:462-464` the
   gate then stays unmet rather than "met with one attributed failure recorded" until
   a repair or an attribution exists.

## Sanitization

This file contains no correlation ids, response bodies, credential material,
spreadsheet ids, account/namespace/object ids or email addresses. Raw material stays
in ignored private storage and is referenced by relative path only; script names are
used exactly as the archived verdicts already publish them.
