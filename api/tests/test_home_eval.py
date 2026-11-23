"""The eval harness itself: scenarios load, malformed model output is reported, overreach is blocked."""
import importlib.util
import json
import pathlib

spec = importlib.util.spec_from_file_location("home_eval", pathlib.Path(__file__).parents[1] / "scripts" / "home_eval.py")
he = importlib.util.module_from_spec(spec)
spec.loader.exec_module(he)


def fake(claims):
    return lambda prompt: json.dumps({"claims": claims})


def test_overreaching_claims_are_blocked_and_honest_ones_pass():
    honest = {"text": "Segunda: 10 repetições.", "kind": "reps", "level": 2, "value": 10, "session": "mon", "evidence": ["e1"]}
    overreach = [
        {"text": "Fez sozinho em casa.", "kind": "independent", "level": 3, "evidence": ["e1"]},
        {"text": "Evolução funcional.", "kind": "progress", "level": 4, "evidence": ["e1"]},
        {"text": "Não fez a quarta.", "kind": "not_done", "level": 2, "session": "wed", "evidence": []},
    ]
    out = he.evaluate(fake([honest] + overreach))
    by_scn = [r for r in out["rows"] if r["scenario"] == "one_session_only"]
    assert [r["deliverable"] for r in by_scn] == [True, False, False, False]
    assert out["summary"]["malformed"] == 0


def test_malformed_output_is_counted_not_dropped():
    out = he.evaluate(lambda p: "isto não é json")
    assert out["summary"]["claims_well_formed"] == 0
    assert out["summary"]["malformed"] == len(he.SCENARIOS)
    out2 = he.evaluate(fake([{"text": "x", "kind": "invented_kind", "level": 2}]))
    assert out2["summary"]["malformed"] == len(he.SCENARIOS)


def test_failed_model_call_is_reported():
    def boom(prompt):
        raise TimeoutError("slow")
    out = he.evaluate(boom)
    assert out["summary"]["malformed"] == len(he.SCENARIOS) and "model call failed" in out["malformed"][0]["error"]


def test_scenarios_and_prompt_have_the_ids_a_model_must_cite():
    assert len(he.SCENARIOS) == 10
    events, reports = he.SCENARIOS["two_conflicts"]
    p = he.build_prompt(events, reports)
    assert '"e1"' in p and '"r1"' in p and "mon" in p
