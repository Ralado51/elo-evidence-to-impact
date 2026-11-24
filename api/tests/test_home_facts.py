"""Facts always reach the therapist; repeats are removed; reasons are readable."""
from datetime import date

from fastapi.testclient import TestClient

from elo.api import create_app
from elo.home_sessions import HomeClaim, HomePlan, PatientReport, SensorEvent, check, facts, report_lines

PLAN = HomePlan(exercise="open_close_hand", reps_per_session=10, sessions=["mon", "wed", "fri"])
D = date(2026, 11, 23)


def ev(i, s, reps, atyp=0):
    return SensorEvent(id=i, session=s, source="camera", day=D, reps=reps, atypical=atyp)


def rp(i, s, a):
    return PatientReport(id=i, session=s, day=D, answer=a)


def test_conflicts_and_missing_sessions_are_always_in_the_facts():
    f = facts(PLAN, [ev("e1", "mon", 10), ev("e2", "wed", 3)], [rp("r1", "mon", "not_finished"), rp("r2", "wed", "done")])
    pt = [x["pt"] for x in f]
    assert sum("divergem" in x for x in pt) == 2  # both conflicts, even if a model never mentions them
    assert any("Sexta: não observada" in x for x in pt)
    assert any("Segunda: 10 de 10 repetições" in x for x in pt)


def test_atypical_count_is_shown():
    f = facts(PLAN, [ev("e1", "mon", 10, atyp=4)], [])
    assert any("(4 atípicas)" in x["pt"] for x in f)


def test_report_lines_drop_repeats():
    same = {"pt": "Segunda: o paciente relata que fez (relato, não observação).", "en": "x"}
    lines = report_lines(PLAN, [ev("e1", "mon", 10)], [rp("r1", "mon", "done")], [same, same, same, None])
    assert [x["pt"] for x in lines].count(same["pt"]) == 1  # also equal to the fact line itself: once


def test_missing_number_has_a_readable_reason_and_no_None():
    c = HomeClaim(id="c", text="x", kind="reps", level=2, session="mon", evidence=["e1"])  # no value
    res = check(c, PLAN, [ev("e1", "mon", 10)], [])
    assert not res.deliverable and res.reasons[0]["rule"] == "value_missing"
    assert "None" not in res.reasons[0]["pt"] and "não informa o número" in res.reasons[0]["pt"]


def test_reasons_use_session_names_not_ids():
    c = HomeClaim(id="c", text="x", kind="reps", level=2, value=3, session="wed", evidence=["e2"])
    res = check(c, PLAN, [ev("e2", "wed", 3)], [rp("r2", "wed", "done")])  # 3 reps vs target 10, but "done": hidden conflict
    txt = " ".join(r["pt"] for r in res.reasons)
    assert "quarta" in txt and "wed" not in txt


def test_api_report_has_facts_even_with_no_claims():
    c = TestClient(create_app(data_dir=":memory:"))
    body = {"plan": PLAN.model_dump(mode="json"), "events": [ev("e1", "mon", 10).model_dump(mode="json")],
            "reports": [rp("r1", "mon", "not_finished").model_dump(mode="json")], "claims": []}
    rep = c.post("/api/home/verify", json=body).json()["report"]
    assert any("divergem" in l["pt"] for l in rep) and all(set(l) == {"pt", "en"} for l in rep)
