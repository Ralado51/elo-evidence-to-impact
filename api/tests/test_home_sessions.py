"""Home-session evidence: three synthetic scenarios (convergent, conflicting, absent) and the API route."""

from datetime import date

import pytest
from fastapi.testclient import TestClient

from elo.api import create_app
from elo.contract import Verdict
from elo.home_sessions import HomeClaim, HomePlan, PatientReport, SensorEvent, check, session_conflict, week_view

PLAN = HomePlan(exercise="open_close_hand", reps_per_session=10, sessions=["mon", "wed", "fri"])
D = date(2026, 11, 17)


def ev(i, s, reps, atypical=0):
    return SensorEvent(id=i, session=s, source="camera", day=D, reps=reps, atypical=atypical)


def rp(i, s, answer):
    return PatientReport(id=i, session=s, day=D, answer=answer)


def claim(**kw):
    return HomeClaim(id=kw.pop("id", "c"), text=kw.pop("text", "x"), **kw)


CONVERGENT = ([ev("e1", "mon", 10), ev("e2", "wed", 10), ev("e3", "fri", 11)],
              [rp("r1", "mon", "done"), rp("r2", "wed", "done"), rp("r3", "fri", "hard")])
CONFLICT = ([ev("e1", "mon", 20), ev("e2", "wed", 10)], [rp("r1", "mon", "not_finished"), rp("r2", "wed", "done")])
ABSENT = ([ev("e1", "mon", 10)], [rp("r1", "mon", "done")])


def verdict(c, data):
    return check(c, PLAN, *data).verdict


@pytest.mark.parametrize("c,data,expected", [
    # convergent
    (claim(kind="sessions_done", level=2, value=3, evidence=["e1", "e2", "e3"]), CONVERGENT, Verdict.SUPPORTED),
    (claim(kind="reps", level=2, value=31, evidence=["e1", "e2", "e3"]), CONVERGENT, Verdict.SUPPORTED),
    (claim(kind="independent", level=3, evidence=["r1", "r2", "r3"]), CONVERGENT, Verdict.SUPPORTED),
    (claim(kind="reps", level=2, value=30, evidence=["e1", "e2", "e3"]), CONVERGENT, Verdict.CONTRADICTED),
    (claim(kind="independent", level=3, evidence=["e1", "e2"]), CONVERGENT, Verdict.INSUFFICIENT_EVIDENCE),
    (claim(kind="progress", level=4, evidence=["e1"]), CONVERGENT, Verdict.NEEDS_REVIEW),
    # conflicting
    (claim(kind="conflict", level=1, session="mon", evidence=["e1", "r1"]), CONFLICT, Verdict.SUPPORTED),
    (claim(kind="sessions_done", level=2, value=2, evidence=["e1", "e2"], flags_conflict=True), CONFLICT, Verdict.SUPPORTED),
    (claim(kind="sessions_done", level=2, value=2, evidence=["e1", "e2"]), CONFLICT, Verdict.NEEDS_REVIEW),
    (claim(kind="conflict", level=1, session="wed", evidence=["e2", "r2"]), CONFLICT, Verdict.CONTRADICTED),
    # absent
    (claim(kind="reps", level=2, value=10, evidence=["e1"]), ABSENT, Verdict.SUPPORTED),
    (claim(kind="not_observed", level=1, session="wed"), ABSENT, Verdict.SUPPORTED),
    (claim(kind="not_done", level=2, session="wed"), ABSENT, Verdict.INSUFFICIENT_EVIDENCE),
    (claim(kind="sessions_done", level=2, value=3, evidence=["e1"]), ABSENT, Verdict.CONTRADICTED),
    (claim(kind="not_observed", level=1, session="mon"), ABSENT, Verdict.CONTRADICTED),
    (claim(kind="reps", level=2, value=10, evidence=["e9"]), ABSENT, Verdict.INSUFFICIENT_EVIDENCE),
])
def test_scenarios(c, data, expected):
    assert verdict(c, data) is expected


def test_reasons_are_bilingual_and_name_the_rule():
    r = check(claim(kind="not_done", level=2, session="wed"), PLAN, *ABSENT)
    assert r.reasons[0]["rule"] == "absence_is_not_no"
    assert "não observado" in r.reasons[0]["pt"] and "not observed" in r.reasons[0]["en"]
    assert not r.deliverable


def test_hard_counts_as_finished_and_sensors_never_reach_level_3():
    assert not session_conflict("fri", PLAN, *CONVERGENT)
    r = check(claim(kind="reps", level=3, value=10, evidence=["e1"]), PLAN, *ABSENT)
    assert any(x["rule"] == "level_above_sources" for x in r.reasons)


def test_week_view_marks_absence_as_not_observed():
    rows = {r["session"]: r for r in week_view(PLAN, [ev("e1", "mon", 7, atypical=1)], [rp("r1", "mon", "done")])}
    assert rows["mon"] == {"session": "mon", "observed": True, "reps": 7, "target": 10, "report": "done",
                           "conflict": True, "atypical": 1}
    assert rows["fri"]["observed"] is False and rows["fri"]["reps"] is None


def test_api_route():
    c = TestClient(create_app(":memory:", client=None, mode="rules"))
    events, reports = CONFLICT
    body = {"plan": PLAN.model_dump(), "events": [e.model_dump(mode="json") for e in events],
            "reports": [r.model_dump(mode="json") for r in reports],
            "claims": [claim(id="a", kind="sessions_done", level=2, value=2, evidence=["e1", "e2"]).model_dump(),
                       claim(id="b", kind="conflict", level=1, session="mon", evidence=["e1", "r1"]).model_dump()]}
    out = c.post("/api/home/verify", json=body).json()
    assert [r["deliverable"] for r in out["results"]] == [False, True]
    assert out["results"][0]["verdict"] == "needs_review"
    assert [w["observed"] for w in out["week"]] == [True, True, False]
