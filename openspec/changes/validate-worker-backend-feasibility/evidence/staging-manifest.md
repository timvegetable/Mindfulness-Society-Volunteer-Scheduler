# Staging setup, deployment and rollback manifest

Task 3.1 evidence. This is the reviewable plan for the resources, credentials,
deployment, measurement and rollback of the Worker feasibility slice. **Nothing
in this document has been executed.** Provisioning (task 3.2), deployment (3.2)
and every push are separate approvals; the defaults in the change remain
synthetic data only, free hosting only, no production migration.

Read together with [the experiment contract](experiment-contract.md), which fixes
the fixture, the measurement protocol and the acceptance thresholds.

Toolchain (settled 2026-09-27): the repository uses **pnpm** (`packageManager:
pnpm@11.7.0`, `pnpm-lock.yaml`, `pnpm install --frozen-lockfile` in both
workflows) and pins `wrangler@4.141.0`. `package-lock.json` is gone. The bundled
`workerd` still reports compatibility date 2026-03-10, so `wrangler.jsonc` needs
no change.

Supplied resources (2026-09-27), recorded here as the reviewed inventory:

| Resource | Value |
| --- | --- |
| Cloudflare account | "Timothyc2371@gmail.com's Account", account id `868086b4b2dc75413ea149480ae4fe82`, authenticated as `timothyc2371@gmail.com` (`wrangler whoami`) |
| Staging OAuth audience | `716719981089-lqjuqu56n0p46fha286qoo35curo1h9g.apps.googleusercontent.com` (new web client in the existing "Mindfulness Society Website" project) |
| Representative workbook | "mindfulness staging 1", `1QPRWcAhsyy1s032Sj4_kS4hVra9rajph21AKkNu_D0w` — assignment assumed, swappable |
| Larger workbook | "mindfulness staging 2", `1nRq-njNjwNnmZWV49A5Yl74w1vplf3UOfAVfPghp5XI` — assignment assumed, swappable |
| Measurement origin | `http://localhost:8788` (confirmed), allowlisted for the measurement window only |

Still outstanding before provisioning can start: the read-only service-account
key and the one-time loader service-account key, both under `staging-local/`.
The Cloudflare `*.workers.dev` subdomain is assigned by the account and appears in
the first deploy output; it is not needed beforehand because it is the Worker's
own URL, not an entry in the origin allowlist.

## 1. Resource isolation

| Resource | Choice | Why it cannot touch production |
| --- | --- | --- |
| Cloudflare Worker | One Worker, `volunteer-scheduling-staging`, on its `*.workers.dev` hostname, created by the first `wrangler deploy` rather than by a dashboard app | `wrangler.jsonc` declares no `route` and no custom domain, so deploying it cannot take traffic from the Pages client or from Apps Script; a Git-connected dashboard app was deliberately not used because it would rebuild on every push |
| Cloudflare plan | Free | No paid feature, no Durable Object, no KV; `limits.cpu_ms` is not raised |
| Google Cloud project | The existing "Mindfulness Society Website" project, with a **new** OAuth web client created for staging and used as the ID-token audience | Reusing the project shares the Sheets API enablement, not the credentials: the staging client id is distinct from the one the Apps Script client signs in with, so neither audience can authorize against the other |
| Sheets identity | One **read-only** service account, shared on the two synthetic workbooks only, no domain-wide delegation | It cannot read or write anything else, and it is not the deploying user of any production script |
| Workbook | Two synthetic spreadsheets (representative and larger) owned by the account that already owns the Cloudflare account and the project | Generated from documented offsets; no roster, export or production row |
| Fixture loading | A one-time write-capable identity — a second service account shared as Editor on those two workbooks only, or the owner running the loader — used to load the fixture and once more for the denial-variant pass (section 9) | Distinct approval from the read-only account |
| Local secrets | `staging-local/` in the repository root, covered by `.gitignore` | Never committed; the manifest records paths, never values |

Production state is not referenced anywhere in this plan: the slice keeps no
portable state (that is `make-workbook-state-portable`), and revisions, the
workbook id and the time zones are immutable staging configuration.

## 2. Bindings

Set as plain variables (`wrangler.jsonc` `env.staging.vars`) unless marked
secret. Secrets are supplied with `wrangler secret put` and never appear in a
committed file or in a deployment report.

| Binding | Kind | Value |
| --- | --- | --- |
| `STAGING_ALLOWED_ORIGINS` | variable | Exact origins, comma separated: the GitHub Pages staging origin and the loopback origin of the measurement host (`http://localhost:8788`) for the measurement window only |
| `STAGING_OAUTH_AUDIENCE` | variable | The staging OAuth web client id |
| `STAGING_WORKBOOK_ID` | variable | The representative or larger staging spreadsheet id |
| `STAGING_WORKBOOK_TIME_ZONE` | variable | The spreadsheet's own zone, e.g. `America/New_York` |
| `STAGING_TIME_ZONE` | variable | Scheduling zone, deliberately different, e.g. `America/Chicago` |
| `STAGING_DISPLAY_INCREMENT_MINUTES` | variable | `30` |
| `STAGING_OPERATING_HOURS_START` / `_END` | variable | `09:00` / `21:00` |
| `STAGING_DATA_REVISION` | variable | The fixture's pinned global revision |
| `STAGING_SCHEDULING_INPUT_REVISION` | variable | The fixture's pinned scheduling-input revision |
| `STAGING_TAB_REVISIONS` | variable | JSON object of tab name to pinned revision |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | **secret** (not sensitive, but supplied the same way) | The read-only service-account address |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | **secret** | PKCS#8 PEM for that service account |

All plain variables above are present as `REPLACE_…` placeholders in
`wrangler.jsonc`'s `env.staging.vars`, so a deploy cannot omit one by accident and
a placeholder that is not replaced fails validation, making the endpoint refuse
(503) instead of serving with guessed configuration. Section 4 therefore edits
that committed block rather than inventing bindings at deploy time.

Missing or malformed bindings make the endpoint refuse (`UNAVAILABLE`) rather
than serve: configuration is validated before any credential is accepted, and
workbook configuration before any row is read.

## 3. Provisioning procedure (requires approval, task 3.2)

1. **Export the workbook snapshot first.** Before any server deployment or
   production Sheet mutation, follow `docs/operations.md`; for staging, snapshot
   both synthetic workbooks with `scripts/snapshot/build_baseline.py` and store
   the result under `staging-local/`.
2. Create the Cloudflare account/Worker on the Free plan; confirm no paid
   feature is enabled.
3. Create the Google Cloud project, enable the Sheets API, create the OAuth web
   client, and record its client id as `STAGING_OAUTH_AUDIENCE`.
4. Create the read-only service account, download its JSON key into
   `staging-local/`, and share both synthetic workbooks with it as **Viewer**.
5. Create the two synthetic workbooks and load the fixture with the one-time
   loading identity: either the workbook owner running the existing
   `loadMigrationWorkbook` editor path (`src/server/main.ts`, which itself
   requires `WRITE_ENABLED=true`), or a separate write-scoped credential shared
   as Editor on those two workbooks only. It is never used during measurement and
   its access is removed when the fixture is final. Record each workbook's row
   counts and fixture digest in `staging-local/manifest.json`.
6. Add the four supplied test accounts and their `Users` rows to both workbooks,
   as mapped in section 9. The experiment contract's seven-identity mix is
   reduced to four accounts plus a row-edit pass; section 9 records exactly which
   case each account covers and how the three denial variants are still
   exercised.
7. Record the Cloudflare and Google account limits observed at provisioning time
   (the contract's dated figures are a starting point, not a substitute).

## 4. Deployment procedure (requires approval, task 3.2)

```sh
# 0. Export both staging workbook snapshots (docs/operations.md) and record their
#    digests; never deploy a server change without a snapshot in hand.

# 1. Confirm the local gates pass on the exact commit being deployed.
npm test && npm run test:worker && npm run check && npm run build && npm run build:worker

# 2. Replace every REPLACE_ placeholder in wrangler.jsonc env.staging.vars with
#    the recorded staging values (section 2). This edit is part of the reviewed
#    manifest: a placeholder that survives makes the endpoint refuse.

# 3. Set both secrets from the ignored local copies, BEFORE the Worker can serve.
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY --env staging
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL --env staging

# 4. Deploy only this Worker, only this environment.
npx wrangler deploy --env staging

# 5. Verify: an unauthenticated POST must return the bounded 401 envelope and a
#    request to a served operation with no credential must not read the workbook.
```

The deploy command is never run by CI. `wrangler.jsonc` has no route, so the
deployed Worker is reachable only at its own hostname.

## 5. Rollback

Rollback is a single-command removal of a resource that production does not use:

```sh
npx wrangler delete --env staging                      # remove the Worker; nothing serves
npx wrangler versions list --env staging               # find the prior good version id
npx wrangler versions deploy <prior-version-id>@100% --env staging --yes
```

`wrangler versions deploy` with no version spec does **not** roll back: it
chooses a version from the latest uploads, so the rollback path always names the
version id it wants. Only `wrangler delete` actually disables serving.

* Nothing in production depends on the Worker, so rollback has no production
  effect and needs no coordination window.
* Residue after a delete, all deliberate: the OAuth web client id (an identifier
  with no authority by itself), the two synthetic workbooks, the read-only
  service-account key file under `staging-local/`, and the one-time
  fixture-loading identity. Delete the service account to revoke the Worker's
  only credential, delete the key file from `staging-local/`, and remove the
  fixture-loading identity's access to both workbooks if the experiment ends.
* If a measurement run is in progress, stop it first: it performs no retries and
  writes only to `staging-local/`.
* After rollback, re-check that no route or custom domain was created, and that
  the Pages site still serves the Apps Script endpoint from `public/config.json`.

## 6. Pages push triggers and deployment separation

`.github/workflows/pages.yml` previously ran on **every push to any branch** and
deployed the client, so any push was a deployment. Task 3.1 separates the two:

* `validate.yml` runs on every push and pull request: install, `npm test`,
  `npm run test:worker`, `npm run check`, `npm run build`, the Worker dry-run
  build, and strict OpenSpec validation. It needs no secret and deploys nothing.
* `pages.yml` now runs only on `workflow_dispatch`, so publishing the client is a
  deliberate, manual action with its own approval.

Both changes are local until someone pushes; the repository's per-action push
approval is unchanged.

## 7. Supplied identities and the denial-variant pass

Only four Google accounts are available, so the contract's seven identities are
covered by four accounts plus a controlled row-edit pass.

| Account | `Users` row | Roles | Contract cases it covers |
| --- | --- | --- | --- |
| `tcai5958@terpmail.umd.edu` | `synthetic-user-admin` | administrator | Administrator path; a blank `volunteerId` and `centerIds` cell still decode |
| `timothyc2371@gmail.com` | `synthetic-user-multi` | administrator + volunteer + center-contact | Multi-role authorization and the client's primary-role preference. This is also the account that owns the workbooks, the Cloud project and the Cloudflare account |
| `manbob928@gmail.com` | `synthetic-user-volunteer` | volunteer, linked to a volunteer row | Volunteer path on `session.me`, denied on administrator operations |
| `101dimensional@gmail.com` | `synthetic-user-contact` | center-contact scoped to one center | Center scoping; confirmation denial for a non-administrator |

The three denial variants that need a *valid* token with a bad row — blank
`active`, `active=false`, and no `Users` row at all — are exercised in a
**denial-variant pass** after the main measurement: the fixture-loading identity
edits `tcai5958@terpmail.umd.edu`'s row to a blank `active` cell, probes, sets
`active=false`, probes, deletes the row, probes, and restores it. Each variant is
expected to return `UNAUTHORIZED`, and the pass re-records the fixture digest so
the change is visible in the report rather than silent.

Alternative if a fifth and sixth account can be supplied: give them the
blank-`active` and `active=false` rows, and a seventh with no row at all, which
removes the need for any post-measurement write. The denial variants are also
covered in the local differential suite either way; this pass is what makes them
deployed evidence.

## 8. Measurement tooling and procedure

* `scripts/staging/measure-worker.mjs` drives the paced load from the measurement
  host. It refuses to run without an explicit `--confirm-staging` flag, a
  manifest, and a staging-shaped target (a `*.workers.dev` host whose name
  contains `staging`, or a host named with `--allow-host`). It enforces the
  contract's read budget (at most 40 Sheets reads in any 60-second window),
  performs no retries, classifies every failure into the contract's taxonomy,
  separates cold observations (`--cold`, run immediately after an approved
  upload) from warm ones, reads the Worker's own `X-Staging-Sheets-Reads` and
  `X-Staging-Snapshot-Digest` response headers so the read count and fixture
  identity are measured rather than assumed, reports achieved requests/minute,
  reads/minute and observed in-flight concurrency, and appends every attempt to
  `<report>.attempts.jsonl` as it completes so an aborted run still keeps its
  evidence. `--plan` validates everything and prints the workload without
  contacting anything.
* `scripts/staging/fixture.mjs`, `google-auth.mjs`, `workbook.mjs` and
  `load-fixture.mjs` generate the synthetic fixture, authenticate as the one-time
  loader identity, create the tabs and headers from the repository's own workbook
  schema, write the rows, then read them back with the Worker's exact
  `values:batchGet` request and record the resulting row counts and fixture digest
  in `staging-local/loaded-<size>.json`. The generator is pinned to the contract's
  dimensions by `staging-fixture.contract.test.ts`, so the deployed fixture cannot
  drift from the predeclared one.
* `scripts/staging/browser-probe.html` and `browser-probe.js` run in a real
  browser from an allowlisted origin, sign in with Google Identity Services, and
  record direct-response/CORS facts (status, `type === 'cors'`, `redirected`,
  response URL, content type, `cf-ray` point of presence) plus per-operation wall
  time. They drive four requests in flight, which is what the contract's
  wall-time threshold requires, refuse any target that is not a
  staging-shaped `*.workers.dev` host, and display aggregates only.
* Worker CPU, memory and invocation statuses come from the Cloudflare dashboard
  quantile series and the invocation-status breakdown, per the contract; the
  browser probe supplies the wall-time and transport evidence that the platform
  does not.
* Every attempt is retained in the report, including failures, and the report is
  the input to the verdict in task 4.2. Local loopback timings from the prototype
  are never mixed into it.

## 9. Pre-deployment checklist

- [ ] Approval recorded for provisioning and for the deployment itself.
- [ ] Workbook snapshots exported to `staging-local/` before any deployment.
- [ ] `npm test`, `npm run test:worker`, `npm run check`, `npm run build`,
      `npm run build:worker` and `openspec validate --strict` all pass on the
      exact commit (the Node suite is 35 files / 203 tests; the Worker suite is
      6 files / 99 tests).
- [ ] `STAGING_ALLOWED_ORIGINS` names the real staging origin only.
- [ ] Secrets set with `wrangler secret put`; `git status` shows nothing under
      `staging-local/`.
- [ ] No route, no custom domain, no paid feature, no `limits.cpu_ms` override.
- [ ] The fixture digest and revision tuple in `staging-local/manifest.json`
      match the ones the measurement report will record.
- [ ] `wrangler.jsonc` still targets the `staging` environment for the deploy.
