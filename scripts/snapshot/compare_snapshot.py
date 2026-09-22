#!/usr/bin/env python
"""Compare a restored workbook snapshot against the private Task 5.7 baseline.

Usage:
  <snapshot-python> scripts/snapshot/compare_snapshot.py \
      <baseline.json> <restored.xlsx> [--fixture-tag TAG] [--strict-bookkeeping]

Exit codes: 0 = zero substantive difference, 1 = substantive difference, 2 = unusable input.

Revision metadata and bookkeeping columns are reported separately and never fail
the run unless --strict-bookkeeping is passed. Reported row identifiers are
truncated SHA-1 digests, so output carries no cell contents or identities.
"""
from __future__ import annotations

import json
import sys

import snapshot_lib


def main() -> int:
    positional = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(positional) < 2:
        print(__doc__)
        return 2
    baseline_path, restored_path = positional[0], positional[1]

    fixture_tag = None
    if "--fixture-tag" in sys.argv:
        fixture_tag = sys.argv[sys.argv.index("--fixture-tag") + 1]
    strict_bookkeeping = "--strict-bookkeeping" in sys.argv

    with open(baseline_path, encoding="utf-8") as handle:
        baseline = json.load(handle)
    try:
        restored = snapshot_lib.build_model(restored_path)
    except ValueError as error:
        print(f"UNUSABLE: {error}")
        return 2

    report = snapshot_lib.compare_models(baseline, restored, fixture_tag=fixture_tag)
    for line in report["summary"]:
        print(line)
    for line in report["notes"]:
        print(f"NOTE {line}")

    failures = list(report["failures"])
    if strict_bookkeeping:
        failures.extend(report["notes"])
    if failures:
        print("SUBSTANTIVE DIFFERENCES")
        for line in failures:
            print(line)
        return 1
    print("OPERATIONAL COMPARISON: ZERO DIFFERENCE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
