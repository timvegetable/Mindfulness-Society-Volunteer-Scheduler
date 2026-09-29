# Release and rollback artefacts — 2026-09-29 (task 5.1)

Prepared from the implemented protocol at branch head. Nothing here authorizes an
action: every production step named below needs its own approval, and the
production-dependent parts of the task stay open until they are performed and
verified. Identifiers, credentials and snapshot paths live in the private
manifests under ignored `staging-local/`; this document names roles and orders,
never values.

## 1. Server release manifest

Source: the branch `dsh/make-workbook-state-portable`. Artifact: the Apps Script
bundle built by `pnpm run build:server` (bundle audit included) pushed from
`dist/apps-script`.

Behavioural deltas a reviewer must accept for this release:

| Area | Delta | Reversible by redeploy |
| --- | --- | --- |
| Schema version | 3 → 4; `WorkbookControl` and `ControlJournal` are created by initialization, and the effective Settings version record is rewritten **in place** | Yes (the tabs stay; older code ignores them) |
| Revision authority | Selected by the `CONTROL_AUTHORITY` Script Property. Absent or `script-properties` is byte-for-byte today's behaviour; `workbook-control` routes revisions through the control record | Yes, before activation: unset the property |
| Write gate | Unchanged: `WRITE_ENABLED` still gates mutations, and portable fencing is an additional, separate check | n/a |
| Import preview | Now classified as a mutation and requires `expectedRevision`; rejected with `INVALID_REQUEST` when omitted, `UNAVAILABLE` when the gate is closed | Yes (redeploy the previous version) |
| Maintenance entrypoints | `initializeWorkbook` and `loadMigrationWorkbook` run under the maintenance fence: script lock held, `WRITE_ENABLED` must be **false**. The loader's interlock is inverted from the previous release | Yes |
| Validation diagnostic | `validateMigrationWorkbook` no longer initializes anything | Yes |

Deployment order (each line is a separate approval):

1. **Client first.** `pnpm run build:client` + the Pages workflow. A new client
   against the old server is safe: the extra `expectedRevision` field is accepted
   and ignored by the old dispatcher, and the old policy is read-only. The reverse
   order would break preview for anyone still on the old client.
2. **Snapshot** both the production workbook and the current Script Property
   revision values, per `docs/operations.md`.
3. **Verify the live write gate**, set it false if the approved procedure
   requires the drained posture, and re-read it. Never infer it from config.
4. **Deploy the server** with `CONTROL_AUTHORITY` absent. Behaviour is unchanged;
   the control record, if present, is ignored.
5. **Initialize the workbook** from the editor under the fence (gate verified
   false): `initializeWorkbook` creates the two control tabs, converges the
   Settings version record, applies the declared data-column protections and
   seeds the empty control record.
6. **Capture and activate** — see section 2.
7. **Verify** — see section 4. Reopening writes is a separate approval.

## 2. Workbook migration manifest

| Step | Exact mutation | Verification |
| --- | --- | --- |
| M1 snapshot | none (export only) | Per-tab digest baseline by stable identifier, plus the workbook export in private storage |
| M2 initialize | creates `WorkbookControl` and `ControlJournal` with their schema headers; rewrites the effective `workbookSchemaVersion` Settings row from 3 to 4 in place; applies protections to every declared protected column of every tab | Tab count +2; Settings row count unchanged; `resolveSchemaVersion` reports 4 with no new row; a second run reports `alreadyInitialized` |
| M3 capture | records the live `DATA_REVISION`, `SCHEDULING_INPUT_REVISION` and every `TAB_REVISION_<Tab>` read from Project Settings into the control record's `operationBaseline`-shaped counters, with `authorityEpoch` + 1, `authority: workbook-control`, `mutationState: idle`, and counters taken as `max(captured, current)` | Record counters equal the captured values, never lower; a control read from the editor reports the same tuple |
| M4 switch | sets `CONTROL_AUTHORITY=workbook-control` on the server deployment and the equivalent binding on any portable reader, with the gate still false | A read through each adapter returns its projection; a mutation returns `UNAVAILABLE` (gate closed); the response revision equals the record's `dataRevision` |

The workbook digest changes by design at M2 (two tabs added, one Settings cell
rewritten). The rehearsal and the production verification therefore compare
**domain rows per tab by stable identifier** against the M1 baseline rather than
comparing whole-workbook digests.

## 3. Rollback

| Point | Rollback | Constraint |
| --- | --- | --- |
| Before M4 | redeploy the previous server version; the workbook keeps two unused tabs and a version-4 Settings row, which the previous version's first-match reader tolerates because the version row was rewritten in place | none |
| After M4, same authority | redeploy the *previous* version **while `CONTROL_AUTHORITY` is unset**: it reads Script Properties, which stopped advancing at M3, so this is only safe if no portable mutation has been admitted | must be verified: the control record's `dataRevision` must equal the captured value |
| After M4 with portable mutations | revert authority to Script Properties under a separately approved stopped-writer reconciliation from the then-current record and any pending journal; copying the M3 numbers back is prohibited | new approval, listed below |
| Forward | the protocol-compatible rollback is the same release with the authority left portable; a future change ships its own rollback version | none |

The rehearsal (task 4.2) exercises the first two rows on synthetic staging,
including a check that a Property-only writer cannot silently reopen writes: with
`CONTROL_AUTHORITY` unset against a record that claims `workbook-control`, the
reader refuses with `AUTHORITY_MISMATCH` rather than serving stale counters —
that is the fail-closed property the rollback boundary rests on.

## 4. Activation verification steps

1. Gate: the live `WRITE_ENABLED` value is exactly `false`, read from the editor
   after the action, not from `production.local.json`.
2. Structure: `checkWorkbookSchema()` reports `{ valid: true, version: 4 }` with
   the record's `schemaVersionRecords` at 1 and `malformed` at 0.
3. Record: the control row's `authority` is `workbook-control`, `mutationState`
   is `idle`, and its counters equal the values captured at M3.
4. Readers: one Schedule read and one Insights read through each adapter; each
   returns its projection with the expected `revision`, `inputRevision` and
   `scheduleRevision`, and the Worker's `X-Staging-Sheets-Reads` shows the
   planned control/Users/domain counts.
5. Rejection paths: with writers drained, a mutation returns `UNAVAILABLE`; a
   temporarily injected pending marker makes reads return `UNAVAILABLE` or
   `STALE_REVISION` and is then recovered with a recorded `not-started` decision.
6. Protections: the declared protected data columns are protected on every tab,
   including both control tabs, and the service identity still reads the
   workbook.
7. Snapshot comparison: the restored workbook compares to the M1 baseline with
   zero differences on domain rows, with the intended structural deltas listed
   explicitly rather than counted as differences.

## 5. Remaining production actions (not authorized by this document)

1. Export the production workbook snapshot and record the live counter values.
2. Deploy the client.
3. Deploy the server with the authority unset.
4. Run the fenced initialization (M2).
5. Run the capture and activation (M3/M4) inside one drained window, with the
   live gate verified false before and after.
6. Perform the activation verification in section 4.
7. Separately authorize reopening writes, and separately authorize any rollback
   that reverts authority after portable mutations have been admitted.
8. Close original tasks 10.24 and 10.25 with their own production evidence, and
   archive this change only after its production verification is recorded.

## 6. What is not prepared here

- The rehearsal results (task 4.1) and the rollback drill results (task 4.2); the
  approval request that accompanies this document covers those.
- Task 2.4's private recovery-manifest contents, which need the private
  `phamily-env` interpreter named in `docs/operations.md`.
- Exact artifact digests: they are recorded at release time in the private
  manifest, from the commit actually deployed, rather than guessed here.
