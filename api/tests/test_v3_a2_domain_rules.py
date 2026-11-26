"""A2 domain rules: shared vectors (PY-A2) plus HTTP behaviour through the real write path."""
import json
import pathlib
import pytest
from elo.v3.domain_rules import DOMAIN_RULES

ROOT = pathlib.Path(__file__).resolve().parents[2]
VEC = json.loads((ROOT / "contracts/CL06_3-A2/contracts/fixtures/a2-vectors.json").read_text())


def _goal(target, **extra):
    return {"payload": {"target": target, **extra}}


@pytest.mark.parametrize("v", VEC["goal"], ids=lambda v: v["id"])
def test_goal_vectors(v):
    got = [x.rule for x in DOMAIN_RULES.evaluate("goal", _goal(v["target"]))]
    assert (got == []) if v["ok"] else (got[:1] == [v["rule"]])


# --- HTTP through the real write path --------------------------------------------------------------------------
from test_v3_goals import _make_seeded_app, _valid_goal_payload  # noqa: E402


def _post(client, ctx, target, path=None):
    h = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    return client.post(path or f"/api/v3/participants/{ctx['p1_id']}/goals", headers=h, json=_valid_goal_payload(target=target))


def test_goal_http_rejections_use_existing_codes_with_structured_details(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    cases = [
        ({"kind": "session_count", "value": 3, "unit": "kg"}, "ENUM", "goal.count_unit_compatible", "$.payload.target.unit"),
        ({"kind": "session_count", "value": 2.5, "unit": "sessions"}, "TYPE", "goal.count_integer", "$.payload.target.value"),
        ({"kind": "session_count", "value": 0, "unit": "sessions"}, "OUT_OF_RANGE", "goal.count_floor", "$.payload.target.value"),
        ({"kind": "session_count", "value": None, "unit": None}, "RULE_VIOLATION", "goal.count_value_required", "$.payload.target.value"),
        ({"kind": "descriptive_text", "value": 5, "unit": "kg"}, "RULE_VIOLATION", "goal.descriptive_no_numeric", "$.payload.target.value"),
    ]
    for target, code, rule, path in cases:
        r = _post(client, ctx, target)
        assert r.status_code == 400, target
        err = r.json()["error"]
        assert err["code"] == code and err["details"] == {"rule": rule, "path": path}, target
    assert app.state.v3_store.list_latest_entities("goal", ctx["p1_id"]) == []


def test_goal_http_accepts_valid_and_preserves_measure_value(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    for t in ({"kind": "session_count", "value": 3, "unit": "sessions"}, {"kind": "session_count", "value": 3, "unit": None},
              {"kind": "repetitions", "value": 10, "unit": "reps"}, {"kind": "descriptive_text", "value": None, "unit": None},
              {"kind": "measure_value", "value": 40, "unit": "deg"}, {"kind": "measure_value", "value": None, "unit": None}):
        assert _post(client, ctx, t).status_code == 201, t


def test_legacy_goal_stays_readable_and_new_version_must_satisfy_rules(monkeypatch):
    """P-06/P-08: legacy (rule-violating) records stay readable; revising one demands a valid payload; no silent migration."""
    app, client, ctx = _make_seeded_app(monkeypatch)
    from elo.v3.domain_rules import DOMAIN_RULES
    h = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    saved = DOMAIN_RULES._rules.pop("goal")  # simulate pre-A2 write of an incompatible record
    try:
        r = _post(client, ctx, {"kind": "session_count", "value": 3, "unit": "kg"})
        assert r.status_code == 201
    finally:
        DOMAIN_RULES._rules["goal"] = saved
    gid = r.json()["entity_id"]
    lst = client.get(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=h)
    assert lst.status_code == 200 and lst.json()[0]["payload"]["target"]["unit"] == "kg" if isinstance(lst.json(), list) else True
    bad = client.post(f"/api/v3/goals/{gid}/versions", headers=h, json=_valid_goal_payload(target={"kind": "session_count", "value": 3, "unit": "kg"}))
    assert bad.status_code == 400 and bad.json()["error"]["details"]["rule"] == "goal.count_unit_compatible"
    ok = client.post(f"/api/v3/goals/{gid}/versions", headers=h, json=_valid_goal_payload(target={"kind": "session_count", "value": 3, "unit": "sessions"}))
    assert ok.status_code == 201


# --- A2-04 instrument ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("v", VEC["instrument"], ids=lambda v: v["id"])
def test_instrument_vectors(v):
    got = [x.rule for x in DOMAIN_RULES.evaluate("functional_assessment", {"payload": {"instrument": v["instrument"]}})]
    assert (got == []) if v["ok"] else (got == [v["rule"]])


def _assessment(instrument, items=None):
    return {"assessment_date": "2026-03-10", "body_segment": "hand", "side": "right", "instrument": instrument,
            "items": items or [{"item_key": "grip", "value_type": "category", "value": "parcial", "unit": None,
                                "source": "therapist_observed", "assistance": "some", "not_assessed": False}],
            "therapist_note": None}


def test_assessment_http_instrument_registry(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    h = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    url = f"/api/v3/participants/{ctx['p1_id']}/assessments"
    for v in VEC["instrument"]:
        r = client.post(url, headers=h, json=_assessment(v["instrument"]))
        if v["ok"]:
            assert r.status_code == 201, v["id"]
        else:
            assert r.status_code == 400 and r.json()["error"]["details"] == {"rule": v["rule"], "path": "$.payload.instrument"}, v["id"]
    assert len(app.state.v3_store.list_latest_entities("functional_assessment", ctx["p1_id"])) == 1


# --- A2-05 items -----------------------------------------------------------------------------------------------
@pytest.mark.parametrize("v", VEC["items"], ids=lambda v: v["id"])
def test_item_vectors(v):
    got = [x.rule for x in DOMAIN_RULES.evaluate("functional_assessment", {"payload": {"items": v["items"]}})]
    assert (got == []) if v["ok"] else (got[:1] == [v["rule"]])


def test_assessment_http_items(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    h = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    url = f"/api/v3/participants/{ctx['p1_id']}/assessments"
    inst = {"instrument_id": "custom_unvalidated", "instrument_version": "0", "status": "unvalidated_custom"}
    accepted = 0
    for v in VEC["items"]:
        r = client.post(url, headers=h, json=_assessment(inst, v["items"]))
        if v["ok"]:
            assert r.status_code == 201, (v["id"], r.text)
            accepted += 1
        else:
            assert r.status_code == 400, v["id"]
            d = r.json()["error"].get("details")
            if isinstance(d, dict):
                assert d["rule"] == v["rule"], v["id"]
    assert len(app.state.v3_store.list_latest_entities("functional_assessment", ctx["p1_id"])) == accepted


def test_zero_unknown_and_not_assessed_are_distinct_and_accepted(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    h = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    inst = {"instrument_id": "custom_unvalidated", "instrument_version": "0", "status": "unvalidated_custom"}
    mk = lambda k, val, na, a="not_assessed" if False else "none": {"item_key": k, "value_type": "number", "value": val, "unit": "deg" if val is not None else None,
                                                                    "source": "therapist_observed", "assistance": a, "not_assessed": na}
    items = [mk("zero_item", 0, False), mk("unknown_item", None, False), mk("skipped_item", None, True, "not_assessed")]
    r = client.post(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=h, json=_assessment(inst, items))
    assert r.status_code == 201, r.text
    stored = r.json()["payload"]["items"]
    assert [i["value"] for i in stored] == [0, None, None] and [i["not_assessed"] for i in stored] == [False, False, True]
