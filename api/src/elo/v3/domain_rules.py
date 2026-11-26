"""ValidationRegistry (ARQ-03 / CMP-05): write-time domain rules for clinical entities (contract A2, candidate 3.2.0).

Rules are registered per entity type and run ONLY on new writes (hook in ``ClinicalEntityService._build_validated_entity``).
Reads, idempotent replay and legacy records are never revalidated (P-06/P-08). Errors reuse existing v3 codes and add a
structured ``details {rule, path}`` (A2-06); no new error code exists.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from elo.v3.entities import REPO_ROOT
from elo.v3.errors import V3Error

A2_CONTRACTS = REPO_ROOT / "contracts" / "CL06_3-A2" / "contracts"


@dataclass(frozen=True)
class Violation:
    rule: str  # rule id from rules-registry.v1 (e.g. ``goal.count_floor``)
    path: str  # JSON path inside the entity (e.g. ``$.payload.target.value``)
    message: str


Rule = Callable[[dict[str, Any]], list[Violation]]


@lru_cache(maxsize=8)
def load_a2_catalog(relpath: str) -> dict[str, Any]:
    """Load a catalog/registry from the A2 candidate package (generic loader, cached)."""
    return json.loads((A2_CONTRACTS / relpath).read_text(encoding="utf-8"))


def rule_code(rule_id: str) -> str:
    """Existing v3 error code bound to a rule id by ``rules-registry.v1``."""
    for r in load_a2_catalog("catalogs/rules-registry.v1.json")["rules"]:
        if r["id"] == rule_id:
            return r["code"]
    raise KeyError(rule_id)


class RuleRegistry:
    """Ordered rule sets keyed by entity type. Stateless; safe to share."""

    def __init__(self) -> None:
        self._rules: dict[str, list[Rule]] = {}

    def register(self, entity_type: str, rule: Rule) -> None:
        self._rules.setdefault(entity_type, []).append(rule)

    def evaluate(self, entity_type: str, entity: dict[str, Any]) -> list[Violation]:
        out: list[Violation] = []
        for rule in self._rules.get(entity_type, ()):
            out.extend(rule(entity))
        return out

    def enforce(self, entity_type: str, entity: dict[str, Any]) -> None:
        """Raise the first violation as a ``V3Error`` (existing code + ``details {rule, path}``)."""
        violations = self.evaluate(entity_type, entity)
        if violations:
            v = violations[0]
            raise V3Error(rule_code(v.rule), v.message, details={"rule": v.rule, "path": v.path})


DOMAIN_RULES = RuleRegistry()


# ---------------------------------------------------------------------------------------------------------------------
# A2-02 goal target rules (goal-target-rules.v1). Write-only; ``measure_value`` has no new rule (D-04).
# ---------------------------------------------------------------------------------------------------------------------
_TV = "$.payload.target.value"
_TU = "$.payload.target.unit"


def goal_target_rules(entity: dict[str, Any]) -> list[Violation]:
    target = (entity.get("payload") or {}).get("target") or {}
    kind, value, unit = target.get("kind"), target.get("value"), target.get("unit")
    spec = load_a2_catalog("catalogs/goal-target-rules.v1.json")["kinds"].get(kind)
    if spec is None or "unit" not in spec:
        return []  # measure_value (or unknown kind, left to the schema): no A2 rule
    if kind == "descriptive_text":
        if value is not None or unit is not None:
            return [Violation("goal.descriptive_no_numeric", _TV if value is not None else _TU, "A descriptive goal carries no numeric value or unit.")]
        return []
    vs = spec["value"]
    if value is None:
        return [Violation("goal.count_value_required", _TV, f"A {kind} goal requires a value.")]
    is_int = isinstance(value, int) and not isinstance(value, bool) or (isinstance(value, float) and value.is_integer())
    if isinstance(value, bool) or not is_int:
        return [Violation("goal.count_integer", _TV, f"A {kind} goal value must be a whole number.")]
    if value < vs["min"]:
        return [Violation("goal.count_floor", _TV, f"A {kind} goal value must be at least {vs['min']}.")]
    if unit not in spec["unit"]["allowed"]:
        return [Violation("goal.count_unit_compatible", _TU, f"The unit of a {kind} goal must be empty or '{spec['unit']['derived']}'.")]
    return []


DOMAIN_RULES.register("goal", goal_target_rules)
