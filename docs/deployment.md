# Deployment and rollback

Every push and deployment requires explicit one-time approval. A server deployment and a client deployment are separate actions. Do not infer approval for one from approval for the other.

## Release prerequisites

From the repository root:

```sh
npm ci
npm test
npm run check
npm run build
openspec validate volunteer-session-scheduling --strict
```

Then:

1. review `git status` and exclude private/unrelated files;
2. validate `production.local.json` and render `public/config.json`;
3. run the deployment check against both built artifacts;
4. export and securely retain a timestamped workbook snapshot;
5. record the current Pages artifact, pinned Apps Script deployment ID/version, and current accepted schedule revision;
6. verify the live `WRITE_ENABLED` Script Property is false through `describeSignIn`.

Example local checks:

```sh
node scripts/validate-config.mjs --config production.local.json --public-config public/config.json
node scripts/deployment-check.mjs --config production.local.json --public-config public/config.json --dist dist/client --server-dist dist/apps-script --report dist/deployment-report.json
```

Reports are scrubbed but remain local artifacts. They do not prove live write-gate state.

## Workbook snapshot

Export the complete workbook before a server deploy or any production Sheet mutation. Store it out of version control with restricted permissions and an immutable timestamp. One supported local mechanism is:

```sh
gdrive files export <sheet-id> <timestamped-snapshot.xlsx>
```

Confirm the export exists, opens, and contains all tabs. Do not commit it or place it in a published artifact.

## Apps Script server

Build first, verify `dist/apps-script/Code.js` and `appsscript.json`, and ensure no `MigrationPayload.gs` remains. `.clasp.json` must point at the reviewed `dist/apps-script` directory.

After explicit deployment approval, use the guarded script:

```sh
node scripts/deploy-apps-script.mjs \
  --config production.local.json \
  --server-dist dist/apps-script \
  --report dist/apps-script-deploy-report.json \
  --deployment-id <pinned-deployment-id> \
  --execute \
  --confirm DEPLOY_APPS_SCRIPT_WITH_WRITES_DISABLED
```

The script requires local `writeEnabled=false`, confirms the clasp root, uses `clasp push --force`, checks clasp's success text, and updates the pinned deployment when an ID is supplied. It still cannot verify the live Script Property. Updating a separate new deployment does not move the URL already configured in the client.

Verify while writes remain disabled:

```sh
node scripts/probe-service.mjs --config production.local.json
```

Then browser-check sign-in, role isolation, read routes, preview behavior, stale-revision rejection, and mutation refusal. Only an approved follow-up may enable writes; repeat the intended write flow and verify revisions/audit results after doing so.

## GitHub Pages client

The Pages workflow is `workflow_dispatch` only and deploys the checked-out ref. After explicit push approval, push the reviewed commit. After separate explicit client-deployment approval, dispatch `.github/workflows/pages.yml` for that ref.

The workflow renders public config from `SCHEDULING_PRIVATE_CONFIG_JSON`, builds `dist/client`, runs the fail-closed deployment check, and uploads the Pages artifact. It does not run tests, typecheck, lint, server build, or OpenSpec validation; those must already be green locally.

Verify the deployed page loads the intended hashed client asset and safe `config.json`, signs in with intended test roles, reaches the pinned Apps Script URL, and renders no private configuration or cross-role data.

## Rollback

`scripts/rollback.mjs` is deliberately a checklist generator, not an automatic rollback. Prepare it with the prior schedule revision, snapshot, and static artifact:

```sh
node scripts/rollback.mjs \
  --config production.local.json \
  --previous-revision <revision> \
  --sheet-export <snapshot.xlsx> \
  --static-artifact <prior-client-artifact> \
  --report dist/rollback-report.json
```

An administrator then reviews and performs the rollback:

1. disable and verify live Apps Script writes;
2. return the pinned Apps Script deployment to the prior known-good version if server code caused the incident;
3. switch to the last internally consistent schedule revision through the protected application/Apps Script path;
4. restore exported Sheet tabs only when schema/data review shows it is necessary;
5. restore the previous Pages artifact;
6. probe the endpoint and browser-verify volunteer isolation, administrator controls, revision/status, and failed-write behavior;
7. re-enable writes only under separate approval.

Preserve incident artifacts and reports outside the public bundle. Never overwrite the only workbook snapshot.

