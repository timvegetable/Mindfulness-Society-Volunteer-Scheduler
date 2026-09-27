# Security

## Trust boundaries

The GitHub Pages client and every request value are untrusted. The Apps Script URL and OAuth client ID are public. Authority comes only from a server-verified Google ID credential combined with an active `Users` row and operation-specific server policy.

The server must never accept client-supplied roles, volunteer ownership, center scope, Sheet names, ranges, formulas, or queries as authority. New operations belong in both the client and dispatcher allowlists, require a strict payload schema, and must use least-privilege projections.

## Public and private configuration

Private configuration includes the Sheet ID and owner, administrator recipients, OAuth audience, environment, scheduling settings, and deployment write posture. Store it only in an administrator-controlled secret or gitignored `*.local.json` file.

The public projection contains only:

- Apps Script `/exec` URL;
- Google OAuth client ID/audience;
- scheduling time zone.

`scripts/render-public-config.mjs` creates the projection. `scripts/deployment-check.mjs` rejects private filenames, credential markers, and private configuration keys in the client artifact. An OAuth client ID and Apps Script URL are identifiers, not secrets; OAuth client secrets, refresh tokens, roster data, and Sheet exports are secret/private.

Never commit `.env*`, `*.local.json`, `.clasp.json`, `migration-output/`, `scrubbed_exports/`, credentials, or exported workbooks. Never store secrets in Mnemosyne memory.

## Authentication and authorization

The browser loads Google Identity Services from the fixed Google URL and treats the returned credential as opaque. The server validates issuer, audience, expiry, subject, verified email, and the current `Users` row. Failed/expired credentials are never cached as successful claims. The default server and Users directory are rebuilt per request.

Role and ownership enforcement is server-side:

- volunteers receive their own dashboard records and may mutate only their linked volunteer;
- center contacts can read and edit candidate intervals only for their allowed centers and cannot confirm them;
- administrators can use aggregate/confirmation operations.

Response projections are part of the security boundary. Avoid returning full workbook records when a narrower projection exists.

### Staging Worker identity (separate from production)

The feasibility slice at
`openspec/changes/validate-worker-backend-feasibility/` verifies Google ID tokens
itself: the RS256 signature is checked against Google's published key set, the
algorithm is pinned rather than taken from the token, and the same shared claim
validator the Apps Script path uses then checks issuer, audience, expiry,
`email_verified` and subject. Key sets and service-account access tokens are
cached only as expiring optimisations, with bounded reloads so a forged key id
cannot turn requests into outbound fetches. That slice holds a **read-only**
service account, separately from a one-time loader identity whose access is
removed after the fixture is loaded, and it never uses the Apps Script deploying
account or domain-wide delegation.

### Recorded disclosure: the Users row count in a rejected sign-in

Follow-up from the milestone 4 review, recorded here with its measured evidence
and an explicit decision. `AuthenticationError.detail` in
`src/server/integration/auth.ts` includes `(directory holds N row(s))`, and
`mapUnknownError` copies that detail into `details.detail` of the `UNAUTHORIZED`
envelope returned to the caller. Precondition: the caller must already hold a
valid Google ID token for the configured audience, so it is not reachable
anonymously. The disclosed value is the number of rows in the `Users` tab — a
count, never a row, an address or a credential. The same detail is pinned for the
Apps Script path by `src/server/integration/dispatcher.contract.test.ts`.

Decision: **accepted for now**, because the value is a count behind a valid
credential and the detail is what lets an operator diagnose a misconfigured
deployment without server log access. Removing it would change the shared
envelope for both runtimes and belongs with a deliberate change to that
contract, not with the feasibility experiment.

## Cache authorization rule

Neither browser route snapshots nor server caches may become authority.

- Browser snapshots are memory-only, keyed by authenticated email, primary role, and route, and cleared when identity changes.
- Token caches store verified claims only within credential expiry and still require a fresh Users lookup for authorization.
- Insight caches are revision-keyed derived data, not permissions.
- Declared API mutations resubmit the credential and use server authorization, supplied-revision checks and a lock. Known enforcement gaps (missing revision presence checks and misclassified import staging) are recorded in [integration](subsystems/integration.md#request-contract); do not infer stronger protection from the policy flags.

## Sheet-write hazards

Direct Sheets API writes, manual edits, and migration tooling outside repository operations can bypass:

- `TAB_REVISION_*` counters;
- `SCHEDULING_INPUT_REVISION` and `DATA_REVISION`;
- optimistic concurrency;
- audit records;
- schedule/insight stale detection;
- domain validation and ownership checks.

Use the application's operation and repository paths whenever possible. If an exceptional direct write is explicitly approved, follow [operations.md](operations.md): verify the live write posture, export a snapshot, define exact cells/rows, record before/after evidence without private data, and reconcile revision-dependent outputs afterward.

## Deployment surface

The Apps Script web app is intentionally reachable by anyone at the platform layer (`ANYONE_ANONYMOUS`) so a static cross-origin client can call it without a Google browser session. This is not anonymous application access: the dispatcher requires and verifies the Google credential for every operation. An account-restricted Apps Script deployment breaks the browser transport before application authentication runs.

The app executes as the deploying user and therefore has the owner's Sheet and mail authority. Least-privilege manifest scopes, a narrow operation API, protected tabs, write gating, and explicit deployment review compensate for that high-privilege execution model.

The approved Schedule/Insights trial enables the Sheets v4 advanced service and requests `https://www.googleapis.com/auth/spreadsheets.readonly`, while retaining `spreadsheets.currentonly` for existing workbook operations. The read-only scope is broader than the adapter's bound-workbook range allowlist: it grants the deploying user read access to other spreadsheets they can access. The adapter always uses the active bound workbook ID and schema-derived ranges, and no browser field can select either. Review and authorize that added scope as the deploying owner before a separately approved server deployment; source configuration or enabling the GCP API does not prove consent or deployment.

Scope selection is part of that compensation, and it has to agree with the code. `src/server/appsscript.json` declares `https://www.googleapis.com/auth/script.send_mail`, which authorizes `MailApp` and grants sending only. The notification mailer therefore reads `MailApp` (`resolveMailer` in `src/server/runtime.ts`) and must not read `GmailApp`: every `GmailApp` method requires the full-mailbox `https://mail.google.com/` scope. That distinction matters more here than in a script serving a single signed-in user, because execution is as the deploying user for callers who may be anonymous at the platform layer — a mailbox-wide scope would put the owner's entire mail store within reach of any code path an anonymous request can reach, whereas send-only scope would not. Reading a service the manifest does not authorize throws at runtime and leaves no trace in the repository, so treat an undeclared service as a defect rather than a configuration choice, and verify a scope change by observing the effect rather than by reading the manifest.
