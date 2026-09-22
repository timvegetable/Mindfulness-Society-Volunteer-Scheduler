#!/usr/bin/env python
"""Build the private Task 5.7 baseline from a workbook snapshot.

Usage:
  <snapshot-python> scripts/snapshot/build_baseline.py <snapshot.xlsx> <baseline.json>

Prints only tab names, row counts, and file digests. Never prints cell values.
Refuses to write a baseline when the snapshot has a missing tab, a schema
mismatch, or a duplicate/blank stable identifier.
"""
from __future__ import annotations

import json
import sys

import snapshot_lib


def main() -> int:
    source, destination = sys.argv[1], sys.argv[2]
    try:
        model = snapshot_lib.build_model(source)
    except ValueError as error:
        print(f"REFUSED: {error}")
        return 2
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(model, handle, ensure_ascii=False, indent=1, sort_keys=True)
    print(f"snapshot sha256: {model['sha256']}")
    for tab, payload in model["tabs"].items():
        print(f"  {tab}: key={payload['keyColumn']} rows={payload['rowCount']}")
    print(f"baseline written: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
