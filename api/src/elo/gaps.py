"""Evidence map: activity x setting x period. Shows where there is direct evidence, only a report, or nothing."""

from __future__ import annotations

from datetime import date

from .contract import Environment, Observation, SourceType
from .packs import Pack
from .summary import ENVIRONMENTS


def evidence_map(observations: list[Observation], pack: Pack, as_of: date | None = None) -> list[dict]:
    obs = [o for o in observations if as_of is None or o.observed_on <= as_of]
    rows = []
    for activity in pack.activities:
        for env in ENVIRONMENTS:
            cell = [o for o in obs if o.activity == activity and o.environment == env]
            direct = [o for o in cell if o.source_type is SourceType.DIRECT_OBSERVATION]
            reports = [o for o in cell if o.source_type is not SourceType.DIRECT_OBSERVATION]
            periods: dict[str, dict[str, int]] = {}
            for o in cell:
                p = periods.setdefault(o.observed_on.strftime("%Y-%m"), {"direct": 0, "report": 0})
                p["direct" if o.is_direct else "report"] += 1
            rows.append({
                "activity": activity,
                "environment": env.value,
                "status": "direct" if direct else "report_only" if reports else "none",
                "direct_count": len(direct),
                "report_count": len(reports),
                "last_direct": max((o.observed_on for o in direct), default=None),
                "last_report": max((o.observed_on for o in reports), default=None),
                "periods": dict(sorted(periods.items())),
            })
    return rows
