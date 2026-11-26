"""F2: the registry is wired but registers no rule for the existing behaviour -> hook is a proven no-op."""
import pytest
from elo.v3.domain_rules import DOMAIN_RULES, RuleRegistry, Violation, rule_code
from elo.v3.errors import V3Error


def test_enforce_without_rules_is_noop():
    assert RuleRegistry().evaluate("goal", {"payload": {}}) == []
    RuleRegistry().enforce("goal", {"payload": {}})


def test_enforce_raises_existing_code_with_details():
    reg = RuleRegistry()
    reg.register("goal", lambda e: [Violation("goal.count_floor", "$.payload.target.value", "msg")])
    with pytest.raises(V3Error) as ei:
        reg.enforce("goal", {})
    assert ei.value.code == "OUT_OF_RANGE" and ei.value.http_status == 400
    assert ei.value.details == {"rule": "goal.count_floor", "path": "$.payload.target.value"}


def test_every_registered_rule_id_has_a_code():
    from elo.v3.domain_rules import load_a2_catalog
    for r in load_a2_catalog("catalogs/rules-registry.v1.json")["rules"]:
        assert rule_code(r["id"]) == r["code"]
    assert DOMAIN_RULES is not None
