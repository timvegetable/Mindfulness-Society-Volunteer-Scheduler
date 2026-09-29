# Control metadata foundation evidence — 2026-09-29 (tasks 2.3, 2.4)

Task 2.3: control metadata codecs, revision provider and idempotent
initialization, with tests for malformed, missing, duplicate and unsupported
records. The physical schema and the failure taxonomy are the ones task 1.2
pinned in `design.md`.

## Schema

`src/server/workbook/schema.ts` gains `WORKBOOK_CONTROL_TABS` with
`WorkbookControl` (one row, fifteen columns, every column protected) and
`ControlJournal` (append-only, bounded retention), and the schema version moves
3 → 4. `WORKBOOK_SCHEMA.tabs` and `tabDefinition` cover the domain tabs plus the
control tabs, so initialization creates and protects them and readers derive
their ranges from the same schema.

The control tabs are deliberately **not** in `WORKBOOK_TABS`. The fixture
identity digest is computed over `WORKBOOK_TABS` and is pinned to the deployed
staging workbooks
(`DEPLOYED_FIXTURE_DIGESTS`, `preview-parity.contract.test.ts`: "regenerates the
deployed workbooks digest for digest"). Adding protocol metadata to that list
would silently redefine the identity every archived campaign quoted as
correctness evidence — the pinned digest test fails immediately when it is done
that way, which is how this was caught. Control tabs stay out of the digest,
which is a statement about domain rows, and enter the workbook through
initialization (the task 4.1 rehearsal's "initialization twice" step).

## Codec, provider and initialization

`src/server/workbook/control.ts`:

- Typed failures — `MISSING`, `DUPLICATE`, `MALFORMED`, `UNSUPPORTED`,
  `AUTHORITY_MISMATCH`, `PENDING`, `GENERATION_CHANGED` — with
  `controlFailureCode` mapping them onto the API error codes the design pins
  (`UNAVAILABLE`, `STALE_REVISION`, and `CONFLICT` for a write against a pending
  mutation). Nothing resolves to revision zero: a reader that cannot validate the
  record fails closed.
- `parseControlRow` validates every field: non-negative safe-integer counters,
  closed enums, schema-known tab names in the JSON maps, byte ceilings on the
  serialized maps, and the pending/idle invariants (`completedGeneration` equals
  `generation` while idle; a pending record carries an operation id and at least
  one affected tab; an idle record carries neither).
- `serializeControlRecord` maps the record onto the schema columns with a
  mapped type, so a column added to the schema without a serializer fails the
  type check. Empty maps and lists serialize as blank cells, not `{}`/`[]`.
- `readControlRecord` distinguishes a missing record, a duplicated one (more
  than one non-blank data row) and a malformed one, and a trailing blank row is
  not a duplicate.
- `initializeControlRecord` is idempotent: it writes the empty record only when
  none exists. The empty record has protocol version 1, authority
  `script-properties`, epoch 0 and every counter zero — initialization never
  invents a revision or claims authority. A malformed, duplicated or unsupported
  record is never overwritten; that is a recovery decision.
- `portableRevisionProvider` exposes the read-side tuple (generation,
  completed generation, global, scheduling-input and per-consumed-tab revisions)
  and `assertCompletedGeneration` enforces the completed-snapshot rule: both
  observations must be idle and the tuple must be identical, so an abort that
  advances the generation without moving a counter still invalidates a snapshot.
  A tab the reader did not consume does not invalidate it.

`src/server/workbook/in-memory-sheet.ts` now models an initialized workbook
(domain plus control tabs), and its `setValue` writes one cell rather than
replacing the row, matching `Range.setValue`.

## Tests

`src/server/workbook/control.contract.test.ts`, 25 tests:

- round trip of an idle and of a pending record, including map key ordering and
  blank-cell serialization;
- twelve malformed shapes rejected individually (negative, fractional and
  numeric-string counters; unknown authority and mutation state; a completed
  generation ahead of the generation; unparseable counters; unknown tab name; a
  pending state without an operation id or affected tabs; an idle state keeping
  an operation id; an oversized raw cell beyond the byte ceiling);
- unsupported protocol version, missing record, duplicate record, and
  initialization refusing to overwrite each of them;
- idempotent initialization: one row, second call reports `created: false` and
  leaves `updatedAt` untouched;
- provider tuples, generation/tuple change detection, pending rejection,
  authority mismatch, and the API error-code mapping for every failure code.

Regression character: these tests assert behaviour that did not exist before
(no control module existed), so they are new coverage rather than
bug-regressions. The two bug-regressions in this change are the initializer
tests recorded in `workbook-foundation-2026-09-29.md`.

## Task 2.4

The snapshot and schema validation work in task 2.4 extends
`scripts/snapshot/` and the recovery manifests to control state. It is not done
here: the snapshot tooling requires the private conda interpreter
(`phamily-env`) named in `docs/operations.md`, which this session cannot invoke
without the operator's environment, and the manifest format is owned by the
task 5.1 release artefacts. The requirement it must satisfy is unchanged and
recorded in the design: recovery manifests include control state, and no private
export or journal content is committed.

Verification at this commit: `pnpm test` 43 files / 298 tests passed;
`pnpm run check` clean; `pnpm run test:worker` and the three Worker dry-run
builds recorded in the execution record.
