"""The sentence the therapist reads is built from verified fields, never from the model's wording."""
from datetime import date

from fastapi.testclient import TestClient

from elo.api import create_app
from elo.home_sessions import HomeClaim, HomePlan, PatientReport, SensorEvent, check, render

PLAN = HomePlan(exercise="open_close_hand", reps_per_session=10, sessions=["mon", "wed", "fri"])
D = date(2026, 11, 23)
EV = [SensorEvent(id="e1", session="mon", source="camera", day=D, reps=10)]
RP = [PatientReport(id="r1", session="mon", day=D, answer="done")]
BANNED = ("melhora", "evolução", "progresso", "improvement", "progress", "independ")


def claim(**kw):
    base = dict(id="c", text="x", kind="independent", level=3, evidence=["r1"])
    return HomeClaim(**{**base, **kw})


def test_the_five_real_overreaches_deliver_a_neutral_sentence():
    # exactly what llama3.2:1b produced: harmless fields, overreaching text, and it passed the structural check
    for text in ["O paciente demonstrou uma melhora significativa no movimento do braço.",
                 "O exercício é importante para a independência e a evolução funcional.",
                 "O paciente demonstrou uma melhora significativa no movimento de independência."]:
        c = claim(text=text)
        assert check(c, PLAN, EV, RP).deliverable  # the structure is fine...
        out = render(c, PLAN, EV, RP)
        assert out and not any(w in (out["pt"] + out["en"]).lower() for w in BANNED)  # ...so the wording must not be the model's
        assert "relato" in out["pt"] and "report" in out["en"]
        assert text not in out["pt"]


def test_reps_sessions_conflict_and_not_observed_sentences():
    r = render(claim(kind="reps", level=2, value=10, session="mon", evidence=["e1"]), PLAN, EV, RP)
    assert r["pt"] == "Segunda: 10 repetições contadas pelo sensor." and r["en"] == "Monday: 10 repetitions counted by the sensor."
    assert render(claim(kind="sessions_done", level=2, value=1, evidence=["e1"]), PLAN, EV, RP)["pt"] == "1 de 3 sessões previstas observadas pelo sensor."
    assert "divergem" in render(claim(kind="conflict", level=1, session="mon", evidence=["e1", "r1"]), PLAN, EV, RP)["pt"]
    assert "não observada" in render(claim(kind="not_observed", level=1, session="fri", evidence=[]), PLAN, EV, RP)["pt"]


def test_never_a_sentence_for_not_done_or_progress():
    assert render(claim(kind="not_done", level=2, session="wed", evidence=[]), PLAN, EV, RP) is None
    assert render(claim(kind="progress", level=4), PLAN, EV, RP) is None


def test_api_returns_text_only_for_claims_that_passed():
    c = TestClient(create_app(data_dir=":memory:"))
    body = {"plan": PLAN.model_dump(mode="json"), "events": [e.model_dump(mode="json") for e in EV], "reports": [r.model_dump(mode="json") for r in RP],
            "claims": [claim(id="ok", text="Melhora significativa!").model_dump(mode="json"),
                       claim(id="bad", kind="progress", level=4, text="Evolução funcional").model_dump(mode="json")]}
    res = {r["claim_id"]: r for r in c.post("/api/home/verify", json=body).json()["results"]}
    assert res["ok"]["deliverable"] and "Melhora" not in res["ok"]["deliverable_text"]["pt"]
    assert not res["bad"]["deliverable"] and res["bad"]["deliverable_text"] is None
