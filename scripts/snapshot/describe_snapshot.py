#!/usr/bin/env python
"""Describe the structure of a workbook snapshot without reading cell values.

Usage:
  <snapshot-python> scripts/snapshot/describe_snapshot.py <snapshot.xlsx>

Prints worksheet names, row counts, and whether each header matches
`src/server/workbook/schema.ts`, plus the portable control state (tabs present,
header agreement, whether the record reads, its authority and mutation state, and
the retained journal row count). Never prints cell values. Exits non-zero when a
required worksheet is missing or its header does not match, so a snapshot that
cannot be trusted as a restoration reference is rejected before use.
"""
from __future__ import annotations

import sys

import snapshot_lib


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    sheets = snapshot_lib.load_sheets(path)

    known = set(snapshot_lib.EXPECTED_COLUMNS) | {snapshot_lib.CONTROL_TAB, snapshot_lib.JOURNAL_TAB}
    unexpected = sorted(name for name in sheets if name not in known)
    print(f"sha256: {snapshot_lib.sha256_file(path)}")
    print(f"worksheets: {len(sheets)}")
    for name in snapshot_lib.EXPECTED_COLUMNS:
        frame = sheets.get(name)
        if frame is None:
            print(f"  {name}: MISSING")
            continue
        print(f"  {name}: rows={len(frame)} columns={len(frame.columns)}")
    for name in unexpected:
        print(f"  {name}: not part of the workbook schema (ignored), rows={len(sheets[name])}")

    control = snapshot_lib.read_control_state(sheets)
    if not control.get("present"):
        print("  control: no control tabs (the workbook is not initialized)")
    else:
        print(f"  WorkbookControl: present, header={'ok' if control.get('headerMatches') else 'MISMATCH'}")
        print(f"  ControlJournal: present={control.get('journalPresent')} rows={control.get('journalEntries')}")
        if control.get("record"):
            print(f"  control record: reads (authority={control['authority']}, state={control['mutationState']})")
        else:
            print(f"  control record: UNUSABLE ({control.get('reason', 'unknown reason')})")

    problems = snapshot_lib.validate_structure(sheets)
    if problems:
        print("STRUCTURE REJECTED")
        for problem in problems:
            print(f"  {problem}")
        return 1
    print("STRUCTURE OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
