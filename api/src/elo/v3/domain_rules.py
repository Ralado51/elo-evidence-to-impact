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
