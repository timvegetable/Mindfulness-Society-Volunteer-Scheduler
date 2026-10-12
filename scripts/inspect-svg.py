"""Summarize SVG artwork without printing embedded provenance metadata."""

import argparse
from collections import Counter
import json
from pathlib import Path
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("path", type=Path)
args = parser.parse_args()
root = ET.parse(args.path).getroot()
if root.tag != "{http://www.w3.org/2000/svg}svg":
    parser.error("Expected an SVG document")

elements = Counter()
colors = set()
metadata_bytes = 0


def inspect(node):
    global metadata_bytes
    tag = node.tag.rsplit("}", 1)[-1]
    if tag == "metadata":
        metadata_bytes += len(ET.tostring(node, encoding="utf-8"))
        return
    elements[tag] += 1
    for attribute in ("fill", "stroke"):
        value = node.get(attribute)
        if value and value != "none":
            colors.add(value)
    for child in node:
        inspect(child)


inspect(root)
print(json.dumps({
    "bytes": args.path.stat().st_size,
    "viewBox": root.get("viewBox"),
    "width": root.get("width"),
    "height": root.get("height"),
    "elements": dict(elements),
    "colors": sorted(colors)[:16],
    "colorCount": len(colors),
    "metadataBytes": metadata_bytes,
}, indent=2))
