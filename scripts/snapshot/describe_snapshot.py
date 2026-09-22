#!/usr/bin/env python
"""Describe the structure of a workbook snapshot without reading cell values.

Usage:
  <snapshot-python> scripts/snapshot/describe_snapshot.py <snapshot.xlsx>

Prints worksheet names, row counts, and whether each header matches
`src/server/workbook/schema.ts`. Never prints cell values. Exits non-zero when a
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

    unexpected = sorted(name for name in sheets if name not in snapshot_lib.EXPECTED_COLUMNS)
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
