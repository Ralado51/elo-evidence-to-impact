"""Attendance and adherence, with the counting rule stated explicitly.

Rule: a session the service could not hold (``not_held``: for example a clinical event on the day)
is not offered to the family, so it is left out of both sides. Adherence = attended / offered, where
offered = attended + absent + absent_justified. The therapist sees the rule and the counts, and
can override the number in the report.
"""

from __future__ import annotations

STATUSES = ("attended", "absent", "absent_justified", "not_held")


def adherence(records: list[dict]) -> dict:
    count = {s: sum(1 for r in records if r["status"] == s) for s in STATUSES}
    offered = count["attended"] + count["absent"] + count["absent_justified"]
    return {
        "attended": count["attended"],
        "absent": count["absent"],
        "absent_justified": count["absent_justified"],
        "not_held": count["not_held"],
        "offered": offered,
        "rate": round(count["attended"] / offered, 3) if offered else None,
        "rule": "offered = attended + absent + absent_justified; sessions not held are excluded",
    }
