#!/usr/bin/env python
"""Self-test for the Task 5.7 snapshot machinery.

Runs entirely on synthetic in-memory models. It never reads production data and
never writes outside the process, so it is safe to run at any time.
"""
from __future__ import annotations

import datetime as dt
import sys

import pandas as pd

import snapshot_lib

PASSED = 0
FAILED: list[str] = []


def check(name: str, condition: bool) -> None:
    global PASSED
    if condition:
        PASSED += 1
    else:
        FAILED.append(name)


def model(tabs: dict[str, list[dict]]) -> dict:
    built = {"sha256": "x", "tabs": {}}
    for tab, rows in tabs.items():
        key_column = snapshot_lib.KEY_COLUMN[tab]
        built["tabs"][tab] = {
            "keyColumn": key_column,
            "rowCount": len(rows),
            "rows": {str(row[key_column]): row for row in rows},
        }
    for tab in snapshot_lib.EXPECTED_COLUMNS:
        built["tabs"].setdefault(tab, {"keyColumn": snapshot_lib.KEY_COLUMN[tab], "rowCount": 0, "rows": {}})
    return built


def volunteer(identifier: str, **overrides) -> dict:
    row = {
        "id": identifier, "name": f"Volunteer {identifier}", "email": f"{identifier}@example.org",
        "lifecycleStatus": "active", "interviewStatus": "complete", "readinessRank": 1,
        "revision": 1, "source": "manual", "createdAt": "2026-09-01T00:00:00.000Z",
        "updatedAt": "2026-09-01T00:00:00.000Z",
    }
    row.update(overrides)
    return row


def test_canonicalization() -> None:
    check("blank->None", snapshot_lib.canonical_cell("name", float("nan")) is None)
    check("bool preserved", snapshot_lib.canonical_cell("active", True) is True)
    check("integral float->int", snapshot_lib.canonical_cell("value", 3.0) == 3)
    check("int preserved", snapshot_lib.canonical_cell("position", 2) == 2)
    check("date object->iso", snapshot_lib.canonical_cell("date", pd.Timestamp("2026-09-21")) == "2026-09-21")
    check("date string->iso", snapshot_lib.canonical_cell("date", "2026-09-21") == "2026-09-21")
    check("time object->hh:mm", snapshot_lib.canonical_cell("start", dt.time(9, 30)) == "09:30")
    check("time string normalized", snapshot_lib.canonical_cell("start", "9:5") == "09:05")
    check("instant tz->utc", snapshot_lib.canonical_cell("createdAt", "2026-09-01T04:00:00.000Z") == "2026-09-01T04:00:00")
    check("instant naive offset", snapshot_lib.canonical_cell("createdAt", dt.datetime(2026, 9, 1, 4, 0, 0)) == "2026-09-01T04:00:00")
    check("json canonicalized", snapshot_lib.canonical_cell("roles", '[ "admin", "volunteer" ]') == ["admin", "volunteer"])
    check("json key order", snapshot_lib.canonical_cell("before", '{"b":1,"a":2}') == {"b": 1, "a": 2})
    check("plain text kept", snapshot_lib.canonical_cell("name", "  Ada  ") == "Ada")
    check("non-json bracket literal kept", snapshot_lib.canonical_cell("diagnostic", "[not json") == "[not json")


def test_canonicalization_is_idempotent() -> None:
    """A JSON cell decodes to a list or dict; canonicalizing that again must be a no-op."""
    cases = [
        ("roles", '["volunteer"]'),
        ("centerIds", '["center-1", "center-2"]'),
        ("shortfalls", '[{"sessionId":"s1","required":2,"assigned":1,"unfilled":1}]'),
        ("before", '{"b":1,"a":{"c":[1,2]}}'),
        ("diagnostic", "[not json"),
        ("name", "Ada"),
        ("revision", 3),
        ("active", True),
        ("date", "2026-09-25"),
        ("start", "13:00"),
        ("createdAt", "2026-09-21T00:00:00.000Z"),
    ]
    for column, raw in cases:
        once = snapshot_lib.canonical_cell(column, raw)
        twice = snapshot_lib.canonical_cell(column, once)
        check(f"idempotent for {column}={raw!r}", once == twice)
    # An already-decoded container must survive unchanged rather than becoming a repr string.
    check("list input preserved", snapshot_lib.canonical_cell("roles", ["volunteer"]) == ["volunteer"])
    check("dict input preserved", snapshot_lib.canonical_cell("before", {"a": 1}) == {"a": 1})
    check("nested json decodes once", snapshot_lib.canonical_cell("shortfalls", '[{"sessionId":"s1","required":2,"assigned":1,"unfilled":1}]') == [{"sessionId": "s1", "required": 2, "assigned": 1, "unfilled": 1}])
    # An empty string and an empty cell are the same state, in both directions.
    check("empty string is blank", snapshot_lib.canonical_cell("cancellationReason", "") is None)
    check("whitespace is blank", snapshot_lib.canonical_cell("reason", "   ") is None)
    check("empty cell is blank", snapshot_lib.canonical_cell("cancellationReason", float("nan")) is None)
    check("empty string equals empty cell", snapshot_lib.canonical_cell("readinessRank", "") == snapshot_lib.canonical_cell("readinessRank", float("nan")))
    # Exercise the real boundary: normalize_tab canonicalizes, unlike the model() helper.
    columns = snapshot_lib.EXPECTED_COLUMNS["Assignments"]
    blank = pd.DataFrame([["a1", "s1", "v1", 1, "assigned", "2026-09-01T00:00:00.000Z", float("nan"), float("nan")]], columns=columns)
    empty = pd.DataFrame([["a1", "s1", "v1", 1, "assigned", "2026-09-01T00:00:00.000Z", "", ""]], columns=columns)
    check("blank and empty-string cells normalize identically",
          snapshot_lib.normalize_tab("Assignments", blank) == snapshot_lib.normalize_tab("Assignments", empty))


def test_multiset_settings() -> None:
    frame = pd.DataFrame([
        ["workbookSchemaVersion", 1, "2026-09-16T02:51:41.647Z", "initializer"],
        ["workbookSchemaVersion", 3, "2026-09-18T20:37:59.968Z", "initializer"],
        ["workbookSchemaVersion", 3, "2026-09-18T20:40:25.909Z", "initializer"],
    ], columns=["key", "value", "updatedAt", "updatedBy"])
    rows = snapshot_lib.normalize_tab("Settings", frame)
    check("multiset keeps duplicates", len(rows) == 3)
    # Identical projections with differing bookkeeping collapse to the same group.
    frame2 = frame.copy()
    frame2.loc[1, "updatedAt"] = "2099-01-01T00:00:00.000Z"
    rows2 = snapshot_lib.normalize_tab("Settings", frame2)
    check("multiset keys stable under bookkeeping drift", set(rows) == set(rows2))
    # A changed value is a new member, not a silent overwrite.
    frame3 = frame.copy()
    frame3.loc[2, "value"] = 4
    check("multiset detects content change", len(snapshot_lib.normalize_tab("Settings", frame3)) == 3)


def test_keyed_duplicate_refused() -> None:
    frame = pd.DataFrame([["a", 1], ["a", 2]], columns=["id", "revision"])
    try:
        snapshot_lib.normalize_tab("Volunteers", frame)
    except ValueError:
        check("duplicate id refused", True)
    else:
        check("duplicate id refused", False)


def test_schema_mismatch_refused() -> None:
    sheets = {tab: pd.DataFrame(columns=cols) for tab, cols in snapshot_lib.EXPECTED_COLUMNS.items()}
    check("clean schema passes", snapshot_lib.validate_structure(sheets) == [])
    broken = dict(sheets)
    broken["Volunteers"] = pd.DataFrame(columns=["id", "wrong"])
    check("schema mismatch flagged", any("Volunteers" in p for p in snapshot_lib.validate_structure(broken)))
    del broken["Centers"]
    check("missing tab flagged", any("Centers" in p for p in snapshot_lib.validate_structure(broken)))


def test_comparison() -> None:
    base = model({"Volunteers": [volunteer("v1"), volunteer("v2")]})

    check("identical -> zero", snapshot_lib.compare_models(base, model({"Volunteers": [volunteer("v1"), volunteer("v2")]}))["failures"] == [])

    changed = volunteer("v1", lifecycleStatus="graduated")
    report = snapshot_lib.compare_models(base, model({"Volunteers": [changed, volunteer("v2")]}))
    check("changed detected", any("changed=1" in f for f in report["failures"]))
    check("changed names column", any("lifecycleStatus" in f for f in report["failures"]))

    report = snapshot_lib.compare_models(base, model({"Volunteers": [volunteer("v1")]}))
    check("missing detected", any("missing=1" in f for f in report["failures"]))

    report = snapshot_lib.compare_models(base, model({"Volunteers": [volunteer("v1"), volunteer("v2"), volunteer("v3")]}))
    check("extra detected", any("extra=1" in f for f in report["failures"]))

    revised = volunteer("v1", revision=99, updatedAt="2026-09-20T00:00:00.000Z", source="migration")
    report = snapshot_lib.compare_models(base, model({"Volunteers": [revised, volunteer("v2")]}))
    check("revision/bookkeeping ignored", report["failures"] == [])
    check("bookkeeping reported as note", any("revision/bookkeeping" in n for n in report["notes"]))


def test_fixture_tag() -> None:
    base = model({"Volunteers": [volunteer("v1"), volunteer("T57FIXTURE")]})
    restored = model({"Volunteers": [volunteer("v1")]})
    report = snapshot_lib.compare_models(base, restored, fixture_tag="T57FIXTURE")
    check("fixture removed on both sides", report["failures"] == [])
    report = snapshot_lib.compare_models(base, restored)
    check("without tag the fixture is a missing row", any("missing=1" in f for f in report["failures"]))


def assignment(identifier: str, session_id: str, volunteer_id: str, **overrides) -> dict:
    row = {
        "id": identifier, "sessionId": session_id, "volunteerId": volunteer_id, "scheduleRevision": 1,
        "status": "assigned", "createdAt": "2026-09-01T00:00:00.000Z", "cancelledAt": None,
        "cancellationReason": None,
    }
    row.update(overrides)
    return row


def backup(identifier: str, session_id: str, volunteer_id: str, **overrides) -> dict:
    row = {"id": identifier, "sessionId": session_id, "volunteerId": volunteer_id,
           "scheduleRevision": 1, "position": 1, "status": "available"}
    row.update(overrides)
    return row


def exception(identifier: str, volunteer_id: str, **overrides) -> dict:
    row = {"id": identifier, "volunteerId": volunteer_id, "date": "2026-09-25", "kind": "unavailable",
           "start": "13:00", "end": "13:45", "timeZone": "America/New_York", "reason": None,
           "revision": 1, "updatedAt": None}
    row.update(overrides)
    return row


def availability(identifier: str, volunteer_id: str, **overrides) -> dict:
    row = {"id": identifier, "volunteerId": volunteer_id, "weekday": 4, "start": "09:00", "end": "11:00",
           "timeZone": "America/New_York", "revision": 1, "source": "manual", "updatedAt": None}
    row.update(overrides)
    return row


def test_acceptance_generated_rows_are_excluded() -> None:
    """Rows the acceptance flow itself creates carry a tagged id, so the tag filter must drop them."""
    tag = "T57FIXTURE"
    base = model({
        "Volunteers": [volunteer("v1")],
        "Assignments": [assignment("real-a1", "real-s1", "v1")],
        "Backups": [backup("real-b1", "real-s1", "v2")],
        "RecurringAvailability": [availability("real-r1", "v1")],
    })
    after = model({
        "Volunteers": [volunteer("v1"), volunteer(f"{tag}-volunteer")],
        "Assignments": [
            assignment("real-a1", "real-s1", "v1"),
            # fixture assignment, then the app cancels it
            assignment(f"{tag}-assignment-promo", f"{tag}-session-promo", f"{tag}-volunteer",
                       status="cancelled", cancelledAt="2026-09-21T05:00:00.000Z",
                       cancellationReason=f"Task 5.7 acceptance {tag}"),
            # the app-generated promoted assignment: untagged id, tagged session
            assignment("generated-promoted-1", f"{tag}-session-promo", "v2"),
        ],
        "Backups": [
            backup("real-b1", "real-s1", "v2"),
            backup(f"{tag}-backup-promo", f"{tag}-session-promo", "v2", status="promoted"),
        ],
        "RecurringAvailability": [
            availability("real-r1", "v1"),
            # the volunteer's own availability saved through the app: untagged id, tagged volunteer
            availability("generated-avail-1", f"{tag}-volunteer"),
        ],
        "AvailabilityExceptions": [
            # the app-generated cancellation exception: untagged id, tagged volunteer and reason
            exception("generated-exc-1", f"{tag}-volunteer", reason=f"Task 5.7 acceptance {tag}"),
        ],
    })
    report = snapshot_lib.compare_models(base, after, fixture_tag=tag)
    check("every acceptance-generated row is excluded by the tag", report["failures"] == [])
    report = snapshot_lib.compare_models(base, after)
    check("without the tag the same rows are reported", report["failures"] != [])


def test_tag_filter_does_not_hide_real_damage() -> None:
    """The tag must not mask a change to a real row, or the completion gate is worthless."""
    tag = "T57FIXTURE"
    base = model({
        "Assignments": [assignment("real-a1", "real-s1", "v1")],
        "Backups": [backup("real-b1", "real-s1", "v2"), backup("real-b2", "real-s1", "v3", position=2)],
    })
    # A real backup was consumed and a real assignment cancelled — damage unrelated to the fixtures.
    after = model({
        "Assignments": [assignment("real-a1", "real-s1", "v1", status="cancelled",
                                   cancelledAt="2026-09-21T05:00:00.000Z", cancellationReason="mistake")],
        "Backups": [backup("real-b1", "real-s1", "v2", status="promoted"), backup("real-b2", "real-s1", "v3", position=1)],
    })
    report = snapshot_lib.compare_models(base, after, fixture_tag=tag)
    check("real damage still fails with the tag set", report["failures"] != [])
    check("real damage names the assignment status", any("status" in f for f in report["failures"]))
    check("real damage names the backup reorder", any("position" in f or "status" in f for f in report["failures"]))


def test_append_only() -> None:
    base = model({"AuditLog": [{"id": "a1", "entity": "Volunteers", "entityId": "v1", "action": "update", "source": "api", "actorId": "u1", "timestamp": "2026-09-01T00:00:00.000Z", "before": "{}", "after": "{}"}]})
    restored = model({"AuditLog": [
        {"id": "a1", "entity": "Volunteers", "entityId": "v1", "action": "update", "source": "api", "actorId": "u1", "timestamp": "2026-09-01T00:00:00.000Z", "before": "{}", "after": "{}"},
        {"id": "a2", "entity": "Volunteers", "entityId": "v1", "action": "update", "source": "api", "actorId": "u1", "timestamp": "2026-09-02T00:00:00.000Z", "before": "{}", "after": "{}"},
    ]})
    report = snapshot_lib.compare_models(base, restored)
    check("audit growth ignored", report["failures"] == [])
    check("audit growth summarized", any("append-only" in s for s in report["summary"]))


def main() -> int:
    for test in (test_canonicalization, test_multiset_settings, test_keyed_duplicate_refused,
                 test_canonicalization_is_idempotent, test_schema_mismatch_refused, test_comparison, test_fixture_tag,
                 test_acceptance_generated_rows_are_excluded, test_tag_filter_does_not_hide_real_damage,
                 test_append_only):
        test()
    print(f"passed: {PASSED}")
    if FAILED:
        print(f"FAILED: {len(FAILED)}")
        for name in FAILED:
            print(f"  - {name}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
