"""Civil dates (``YYYY-MM-DD``): the single owner of calendar validation for the v3 backend (ARQ-01 / CMP-04).

A *civil date* is a calendar day with no time of day and no time zone (assessment date, prescription validity,
reporting period). An *instant* (``created_at``, event ``occurred_at``) is a different type and is never validated
here. Rules (V2.2 DT-01):

* Only the canonical representation is accepted: four digits, two digits, two digits, ASCII, nothing else.
* The text must name a real day of the Gregorian calendar (leap years included) and round-trip exactly.
* Invalid input is rejected. It is never corrected, clamped or normalized to another day.
* No business limit (future dates, minimum year) is applied: those are PO decisions not yet ratified.

The contract schemas only fix the *syntax* (``pattern``); this module adds the *calendar* check without touching
the frozen CL06.3-r1 contract or the ported reference validator (``entities.validate``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Any

# Syntax used by the CL06.3 civil-date fields. A field is a civil date if and only if its schema uses this pattern.
CIVIL_DATE_SCHEMA_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
_CANONICAL = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")  # used with fullmatch: no trailing newline, no spaces

# Sibling fields that form an inclusive interval inside one object: (start, end).
RANGE_PAIRS: tuple[tuple[str, str], ...] = (("valid_from", "valid_to"), ("period_from", "period_to"))

REASON_INVALID = "invalid_calendar_date"
REASON_INVERTED = "range_inverted"


def parse_civil_date(value: Any) -> date | None:
    """Return the real date named by ``value`` or ``None``. Never raises, never normalizes."""
    if not isinstance(value, str) or not _CANONICAL.fullmatch(value):
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.isoformat() == value else None


def is_civil_date(value: Any) -> bool:
    return parse_civil_date(value) is not None


def is_range_inverted(start: Any, end: Any) -> bool:
    """True only when both bounds are valid civil dates and ``end`` is before ``start`` (inclusive interval)."""
    d_start, d_end = parse_civil_date(start), parse_civil_date(end)
    return d_start is not None and d_end is not None and d_end < d_start


@dataclass(frozen=True)
class CivilDateIssue:
    path: str  # dotted path inside the checked object, e.g. ``payload.assessment_date``
    reason: str  # REASON_INVALID | REASON_INVERTED

    @property
    def field(self) -> str:
        return self.path.rsplit(".", 1)[-1]


def civil_date_paths(schema: dict[str, Any], prefix: str = "") -> list[str]:
    """Paths of every civil-date property declared by a JSON schema (derived, so new entities are covered automatically)."""
    found: list[str] = []
    for name, sub in (schema.get("properties") or {}).items():
        path = f"{prefix}{name}"
        if sub.get("pattern") == CIVIL_DATE_SCHEMA_PATTERN:
            found.append(path)
        found.extend(civil_date_paths(sub, f"{path}."))
    return found


def check_entity_civil_dates(schema: dict[str, Any], entity: dict[str, Any]) -> list[CivilDateIssue]:
    """Calendar and interval check for a schema-valid entity. Absent/``None`` values are left to the schema."""
    issues: list[CivilDateIssue] = []
    for path in civil_date_paths(schema):
        node: Any = entity
        for part in path.split("."):
            node = node.get(part) if isinstance(node, dict) else None
        if isinstance(node, str) and not is_civil_date(node):
            issues.append(CivilDateIssue(path, REASON_INVALID))
    for start_name, end_name in RANGE_PAIRS:
        for path in civil_date_paths(schema):
            if not path.endswith("." + end_name) and path != end_name:
                continue
            parent = path[: -len(end_name)]
            start_path = parent + start_name
            if start_path not in civil_date_paths(schema):
                continue
            values = []
            for p in (start_path, path):
                node = entity
                for part in p.split("."):
                    node = node.get(part) if isinstance(node, dict) else None
                values.append(node)
            if is_range_inverted(values[0], values[1]):
                issues.append(CivilDateIssue(path, REASON_INVERTED))
    return issues
