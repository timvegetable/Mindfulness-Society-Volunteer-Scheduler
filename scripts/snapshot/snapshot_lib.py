#!/usr/bin/env python
"""Shared snapshot loading, canonicalization and comparison for Task 5.7.

Pure with respect to the repository: nothing here writes cell contents into the
repository, and nothing prints values. Callers decide what to persist and must
keep artifacts outside the repository.

Run only with the documented snapshot interpreter (the `phamily-env` environment,
which provides pandas and python-calamine). See `docs/operations.md`.
"""
from __future__ import annotations

import collections
import datetime as dt
import hashlib
import json
import math
from typing import Any

import pandas as pd

# Tab -> stable key column. `Settings` has no synthetic id; its natural key is `key`.
KEY_COLUMN: dict[str, str] = {
    "Volunteers": "id",
    "RecurringAvailability": "id",
    "AvailabilityExceptions": "id",
    "Sessions": "id",
    "Assignments": "id",
    "Backups": "id",
    "SchedulingRuns": "id",
    "Imports": "id",
    "ImportMappings": "id",
    "ImportedAvailability": "id",
    "Users": "id",
    "Settings": "key",
    "AuditLog": "id",
    "Centers": "id",
    "CandidateSchedules": "id",
}

# Tabs whose rows are not uniquely identified by their key column. `Settings` is
# an append-history tab: `initializeWorkbook` appends a `workbookSchemaVersion`
# row whenever the first matching row's value differs from the current schema
# version, so the same key may repeat. These tabs are compared as a multiset.
MULTISET_TABS = {"Settings"}

# Expected column order, mirrored from src/server/workbook/schema.ts.
EXPECTED_COLUMNS: dict[str, list[str]] = {
    "Volunteers": ["id", "name", "email", "lifecycleStatus", "interviewStatus", "readinessRank", "revision", "source", "createdAt", "updatedAt"],
    "RecurringAvailability": ["id", "volunteerId", "weekday", "start", "end", "timeZone", "revision", "source", "updatedAt"],
    "AvailabilityExceptions": ["id", "volunteerId", "date", "kind", "start", "end", "timeZone", "reason", "revision", "updatedAt"],
    "Sessions": ["id", "kind", "centerId", "title", "date", "start", "end", "timeZone", "requiredStaffCount", "status", "sourceCandidateId", "revision", "createdAt", "updatedAt"],
    "Assignments": ["id", "sessionId", "volunteerId", "scheduleRevision", "status", "createdAt", "cancelledAt", "cancellationReason"],
    "Backups": ["id", "sessionId", "volunteerId", "scheduleRevision", "position", "status"],
    "SchedulingRuns": ["id", "inputRevision", "outputRevision", "status", "startedAt", "completedAt", "assignmentIds", "backupIds", "shortfalls", "diagnostic"],
    "Imports": ["id", "source", "contentHash", "status", "startedAt", "completedAt", "actorId", "resultId", "participantCount", "matchedCount", "unmatched", "stagedAvailability", "diagnostic", "promotedAt", "promotedBy"],
    "ImportMappings": ["id", "source", "sourceParticipantId", "sourceEmail", "sourceName", "volunteerId", "createdAt", "updatedAt", "updatedBy"],
    "ImportedAvailability": ["id", "volunteerId", "sourceParticipantId", "source", "weekday", "start", "end", "timeZone", "importedAt", "importRunId"],
    "Users": ["id", "email", "roles", "volunteerId", "centerIds", "active", "revision"],
    "Settings": ["key", "value", "updatedAt", "updatedBy"],
    "AuditLog": ["id", "entity", "entityId", "action", "source", "actorId", "timestamp", "before", "after"],
    "Centers": ["id", "name", "active", "revision", "createdAt", "updatedAt"],
    "CandidateSchedules": ["id", "centerId", "weekday", "start", "end", "timeZone", "requestedStaffCount", "status", "createdBy", "revision", "createdAt", "updatedAt"],
}

# Columns holding a calendar date, a wall-clock time, or an absolute instant.
DATE_COLUMNS = {"date"}
TIME_COLUMNS = {"start", "end"}
INSTANT_COLUMNS = {"createdAt", "updatedAt", "cancelledAt", "startedAt", "completedAt", "promotedAt", "importedAt", "timestamp"}

# Columns whose value is a JSON document encoded as text.
JSON_COLUMNS = {"roles", "centerIds", "assignmentIds", "backupIds", "shortfalls", "stagedAvailability", "unmatched", "diagnostic", "before", "after"}

# Differences the reviewed procedure explicitly permits.
#   * revision metadata advances monotonically during restoration and is never reset;
#   * bookkeeping (instants and provenance) is rewritten by a restore.
REVISION_COLUMNS = {"revision", "scheduleRevision", "inputRevision", "outputRevision"}
BOOKKEEPING_COLUMNS = {
    "createdAt", "updatedAt", "startedAt", "completedAt", "promotedAt",
    "importedAt", "timestamp", "cancelledAt", "source", "actorId",
    "promotedBy", "updatedBy", "createdBy",
}
COMPARISON_IGNORE = REVISION_COLUMNS | BOOKKEEPING_COLUMNS

# Rows are preserved, not compared, on append-only tabs.
APPEND_ONLY_TABS = {"AuditLog"}


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def _time_text(value: Any) -> str | None:
    if isinstance(value, (dt.datetime, dt.time)):
        return f"{value.hour:02d}:{value.minute:02d}"
    text = str(value).strip()
    parts = text.split(":")
    if len(parts) >= 2 and parts[0].strip().isdigit() and parts[1].strip().isdigit():
        return f"{int(parts[0]):02d}:{int(parts[1]):02d}"
    return text or None


def _date_text(value: Any) -> str | None:
    if isinstance(value, dt.datetime):
        return value.date().isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    parsed = pd.to_datetime(str(value).strip(), errors="coerce")
    if parsed is not None and not pd.isna(parsed):
        return parsed.date().isoformat()
    return str(value).strip() or None


def _instant_text(value: Any) -> str | None:
    if isinstance(value, dt.datetime):
        moment = value
    else:
        parsed = pd.to_datetime(str(value).strip(), errors="coerce")
        if parsed is None or pd.isna(parsed):
            return str(value).strip() or None
        moment = parsed.to_pydatetime()
    if moment.tzinfo is not None:
        moment = moment.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return moment.isoformat(timespec="milliseconds").rstrip("0").rstrip(".")


def canonical_cell(column: str, value: Any) -> Any:
    """Map one cell to a stable, JSON-serializable canonical value.

    Idempotent: canonicalizing an already-canonical value returns it unchanged. A
    JSON-valued column decodes to a list or dict, and re-stringifying that with
    Python's repr would produce a value that no longer parses as JSON, so containers
    are handled before the scalar paths.
    """
    if isinstance(value, (list, tuple)):
        return [canonical_cell(column, item) for item in value]
    if isinstance(value, dict):
        return {str(key): canonical_cell(column, item) for key, item in value.items()}
    # A whitespace-only cell and a truly empty cell mean the same thing here: every
    # optional cell helper in src/server/workbook/sheet-values.ts treats blank as absent,
    # and the codecs write '' for an absent value. Without this, a row the application
    # rewrote with '' would differ from a baseline blank and a clean restore would look broken.
    if isinstance(value, str) and value.strip() == "":
        return None
    if _is_blank(value):
        return None
    if column in DATE_COLUMNS:
        return _date_text(value)
    if column in TIME_COLUMNS:
        return _time_text(value)
    if column in INSTANT_COLUMNS:
        return _instant_text(value)
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else value
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    text = str(value).strip()
    if column in JSON_COLUMNS and text and text[0] in "[{":
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text
    return text


def load_sheets(path: str) -> dict[str, pd.DataFrame]:
    return pd.read_excel(path, sheet_name=None, engine="calamine", header=0)


def validate_structure(sheets: dict[str, pd.DataFrame]) -> list[str]:
    """Return a list of structural problems; empty means the snapshot is usable."""
    problems: list[str] = []
    for tab, columns in EXPECTED_COLUMNS.items():
        frame = sheets.get(tab)
        if frame is None:
            problems.append(f"missing worksheet: {tab}")
            continue
        actual = [str(c) for c in frame.columns]
        if actual != columns:
            problems.append(f"schema mismatch on {tab}: {actual} != {columns}")
    return problems


def _projection(columns: list[str], canonical: dict[str, list[Any]], index: int) -> str:
    payload = [canonical[column][index] for column in columns if column not in COMPARISON_IGNORE]
    return hashlib.sha1(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:8]


def normalize_tab(tab: str, frame: pd.DataFrame) -> dict[str, dict[str, Any]]:
    """Return {stable_identifier: {column: canonical_value}} for one tab.

    Raises ValueError on a duplicate or blank stable identifier in a keyed tab.
    """
    canonical = {
        str(column): [canonical_cell(str(column), value) for value in frame[column].tolist()]
        for column in frame.columns
    }
    columns = [str(column) for column in frame.columns]
    key_column = KEY_COLUMN[tab]
    rows: dict[str, dict[str, Any]] = {}
    duplicates: list[str] = []

    if tab in MULTISET_TABS:
        seen: collections.Counter[str] = collections.Counter()
        for index in range(len(frame)):
            raw_key = canonical[key_column][index]
            key_text = "<blank>" if raw_key is None else str(raw_key)
            projection = _projection(columns, canonical, index)
            occurrence = seen[projection]
            seen[projection] += 1
            identifier = f"{key_text}#{projection}#{occurrence}"
            rows[identifier] = {column: canonical[column][index] for column in columns}
        return rows

    for index in range(len(frame)):
        raw_key = canonical[key_column][index]
        if raw_key is None:
            duplicates.append(f"<blank:{index}>")
            continue
        identifier = str(raw_key)
        if identifier in rows:
            duplicates.append(identifier)
            continue
        rows[identifier] = {column: canonical[column][index] for column in columns}
    if duplicates:
        raise ValueError(f"duplicate or blank stable identifiers on {tab}: {len(duplicates)}")
    return rows


def build_model(path: str) -> dict[str, Any]:
    sheets = load_sheets(path)
    problems = validate_structure(sheets)
    if problems:
        raise ValueError("; ".join(problems))
    model: dict[str, Any] = {"sha256": sha256_file(path), "tabs": {}}
    for tab in EXPECTED_COLUMNS:
        rows = normalize_tab(tab, sheets[tab])
        model["tabs"][tab] = {"keyColumn": KEY_COLUMN[tab], "rowCount": len(rows), "rows": rows}
    return model


def _digest(identifier: str) -> str:
    return hashlib.sha1(identifier.encode("utf-8")).hexdigest()[:8]


def _contains_tag(row: dict[str, Any], tag: str) -> bool:
    needle = tag.casefold()
    return any(isinstance(v, str) and needle in v.casefold() for v in row.values())


def _differing(left: dict[str, Any], right: dict[str, Any], ignore: set[str]) -> list[str]:
    return sorted(c for c in left if c not in ignore and left.get(c) != right.get(c))


def compare_models(
    baseline: dict[str, Any],
    restored: dict[str, Any],
    fixture_tag: str | None = None,
) -> dict[str, Any]:
    """Compare two models. Returns {failures, notes, summary} without leaking values."""
    failures: list[str] = []
    notes: list[str] = []
    summary: list[str] = []

    for tab in EXPECTED_COLUMNS:
        key_column = KEY_COLUMN[tab]
        before = baseline["tabs"][tab]["rows"]
        after = restored["tabs"][tab]["rows"]
        if fixture_tag:
            before = {k: v for k, v in before.items() if not _contains_tag(v, fixture_tag)}
            after = {k: v for k, v in after.items() if not _contains_tag(v, fixture_tag)}

        if tab in APPEND_ONLY_TABS:
            summary.append(
                f"{tab}: append-only; rows {len(before)} -> {len(after)} "
                f"(delta {len(after) - len(before):+d}); content differences ignored by policy"
            )
            continue

        missing = sorted(set(before) - set(after))
        extra = sorted(set(after) - set(before))
        changed: list[tuple[str, list[str]]] = []
        bookkeeping_only = 0
        for identifier in sorted(set(before) & set(after)):
            substantive = _differing(before[identifier], after[identifier], REVISION_COLUMNS)
            if not substantive:
                continue
            remaining = _differing(before[identifier], after[identifier], COMPARISON_IGNORE)
            if remaining:
                changed.append((identifier, substantive))
            else:
                bookkeeping_only += 1

        if missing or extra or changed:
            failures.append(f"{tab}: missing={len(missing)} extra={len(extra)} changed={len(changed)}")
            failures.extend(f"    missing row {_digest(i)}" for i in missing)
            failures.extend(f"    extra row {_digest(i)}" for i in extra)
            failures.extend(f"    changed row {_digest(i)}: {','.join(cols)}" for i, cols in changed)
        if bookkeeping_only:
            notes.append(f"{tab}: {bookkeeping_only} row(s) differ only in revision/bookkeeping columns")
        if not missing and not extra and not changed:
            summary.append(f"{tab}: key={key_column} rows={len(after)} identical")

    return {"failures": failures, "notes": notes, "summary": summary}
