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

## Cache authorization rule

Neither browser route snapshots nor server caches may become authority.

- Browser snapshots are memory-only, keyed by authenticated email, primary role, and route, and cleared when identity changes.
- Token caches store verified claims only within credential expiry and still require a fresh Users lookup for authorization.
- Insight caches are revision-keyed derived data, not permissions.
- Every mutation resubmits the credential and is re-authorized, revision-checked, and locked on the server.

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

