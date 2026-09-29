# Snapshot control-state evidence — 2026-09-29 (task 2.4)

Task 2.4 required the snapshot/schema validation and the private recovery
manifests to include portable control state without committing private exports or
journal contents.

**Correction to an earlier claim in this campaign.** The release artefacts and the
execution record said this half was blocked on "the private `phamily-env`
interpreter, which this session cannot invoke". That was wrong: the environment
exists at `/home/timb/miniforge3/envs/phamily-env/bin/python`, its self-test runs,
and this task is therefore fully verifiable here. The earlier statement is
corrected rather than quietly dropped, because it appeared in committed evidence.

## What changed

`scripts/snapshot/snapshot_lib.py`:

- Control tabs are named and their columns mirrored. They stay outside
  `EXPECTED_COLUMNS`: protocol metadata is not a domain row, and the operational
  comparison must not treat it as one. A workbook with no control tabs is *not*
  structurally damaged — it is simply not initialized.
- `validate_structure` now also rejects a control tab whose header drifted from
  the schema, when the tab is present.
- `read_control_state` reduces the control tab to a bounded summary: tab presence,
  header agreement, journal row count, and — when the record reads — authority,
  epoch, generation, completed generation, mutation state, the global and
  scheduling-input counters and the per-tab map. A record that cannot be read
  yields a **reason that names the field and never echoes its value**, because an
  unusable cell may hold anything the Sheet happens to contain.
- `compare_models` compares the control summary under the protocol's own rules.
  Failures: a global, scheduling-input or per-tab counter that decreased; a
  generation that decreased; a usable record that became unusable; a control tab
  that vanished; a control header that drifted. Notes: an authority switch (with
  its epochs), a shrinking journal (the writer prunes oldest-first at its ceiling)
  and a pending marker, each of which a maintenance window may legitimately leave.
  Counter *values* are never printed, consistent with the tooling's promise.

`describe_snapshot.py` and `build_baseline.py` report the control status line;
`compare_snapshot.py` documents the control rules in its usage.

`docs/operations.md` pins the private manifest fields a maintenance window must
record before and after a batch, and states what it must never record (journal
contents, operation ids, the cell values of an unusable record).

## Verification

**Self-test: 82 checks pass** (`phamily-env/bin/python scripts/snapshot/selftest.py`,
was 56). The 26 new checks cover a valid record, an absent tab, an empty tab,
duplicate records, an unsupported protocol version, a non-integral counter, an
idle generation mismatch, unparseable tab counters, a drifted header, journal
counting without contents, and the comparison rules in both directions (each
failure case and each note case, including "absent in both" and "a vanished tab").

**End to end against a real workbook.** The representative staging workbook — the
one whose baseline digest matches the archived campaign's pin — was exported to
`migration-output/rehearsal-representative.xlsx` (private, ignored) and run
through the tooling:

- `describe_snapshot.py` → `STRUCTURE OK` with 15 domain tabs, and
  `WorkbookControl: present, header=ok`, `ControlJournal: present rows=11`,
  `control record: reads (authority=workbook-control, state=idle)`.
- `build_baseline.py` → baseline written with
  `control state: record reads (authority=workbook-control), journal rows=11`.
- `compare_snapshot.py <that baseline> <same snapshot>` → `OPERATIONAL
  COMPARISON: ZERO DIFFERENCE` and `control state: authority=workbook-control
  state=idle journalRows=11 (counters monotonic; contents not compared)`.
- A baseline whose `dataRevision` was raised by five (a counter that moved
  backwards relative to the workbook) → `SUBSTANTIVE DIFFERENCES` with
  `control state: dataRevision decreased`, exit code **1**.
- A baseline whose control summary was replaced with an unusable record → the
  comparison reports `the baseline holds no usable record; monotonicity not
  assessed` as a note rather than a failure, which is the intended asymmetry: a
  broken baseline is a bookkeeping problem, a broken *restored* record is damage.

The two synthetic baselines are private and derived from synthetic data; they stay
in `migration-output/`.

## Not covered here

- The "usable record became unusable in the restored workbook" path is covered by
  the self-test at the model level but not end to end, because producing an XLSX
  with a deliberately corrupted control record needs an Excel writer, and the
  documented environment provides the calamine *reader* only (`openpyxl` is not
  installed). The first real production snapshot that hits that case will exercise
  the same code path the self-test pins.
- The larger staging workbook was not re-exported: it carries the same control
  structure and the tooling's behaviour does not depend on fixture size.
