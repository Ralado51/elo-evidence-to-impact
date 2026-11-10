import json

import pytest
from fastapi.testclient import TestClient

from elo.api import create_app


class SpyClient:
    """Records exactly what would be sent to a model."""
    def __init__(self):
        self.sent = []
        self.model = "spy"

    def complete_json(self, system, user):
        self.sent.append(system + "\n" + user)
        return json.dumps({"observations": []})


@pytest.fixture
def ctx():
    spy = SpyClient()
    c = TestClient(create_app(":memory:", client=spy, mode="llm"))
    c.post("/api/cases", json={"id": "c1", "label": "Paciente A"})
    c.post("/api/patients", json={"role": "patient", "full_name": "Davi Moreira", "pseudonym": "Paciente A", "aliases": ["Davi"]})
    return c, spy


def note(c, text, day="2026-09-01"):
    return c.post("/api/cases/c1/notes", json={"text": text, "session_date": day, "observed_by": "Raquel"})


def test_health_meta_and_no_names_listed(ctx):
    c, _ = ctx
    assert c.get("/api/health").json() == {"status": "ok"}
    m = c.get("/api/meta").json()
    assert "en" in m["notice"] and m["model_configured"] is True
    assert "Moreira" not in c.get("/api/patients").text and "Davi" not in c.get("/api/patients").text


def test_name_never_reaches_the_model(ctx):
    c, spy = ctx
    r = note(c, "Davi vestiu a camiseta na clínica com ajuda física parcial.")
    assert r.status_code == 200
    assert spy.sent and all("Davi" not in s and "Moreira" not in s for s in spy.sent)
    assert "Paciente A" in r.json()["sanitized_text"]


def test_unregistered_data_is_blocked_with_kinds_only(ctx):
    c, spy = ctx
    r = note(c, "Telefone da mãe (11) 98888-7777; Davi vestiu a camiseta.")
    assert r.status_code == 422
    body = r.text
    assert "98888" not in body and r.json()["kinds"]
    assert spy.sent == []


def test_full_flow_rules_mode_and_review_rules():
    c = TestClient(create_app(":memory:", client=None))
    c.post("/api/cases", json={"id": "c1", "label": "Paciente A"})
    c.post("/api/patients", json={"role": "patient", "full_name": "Davi Moreira", "pseudonym": "Paciente A", "aliases": ["Davi"]})
    r = note(c, "Davi vestiu a camiseta na clínica com dicas gestuais.")
    assert r.json()["mode_used"].startswith("rules") and len(r.json()["observations"]) == 1
    note(c, "A mãe relatou que em casa Davi vestiu a camiseta sozinho.", "2026-09-08")
    made = c.post("/api/cases/c1/claims/from-observations").json()
    assert len(made) == 2 and c.post("/api/cases/c1/claims/from-observations").json() == []
    by_env = {m["claim"]["environment"]: m for m in made}
    assert by_env["clinic"]["verdict"]["verdict"] == "supported"
    assert by_env["home"]["verdict"]["verdict"] != "supported"
    # a report-only claim cannot be approved
    bad = c.post(f"/api/claims/{by_env['home']['claim']['id']}/approve", json={"actor": "Raquel"})
    assert bad.status_code == 409
    ok = c.post(f"/api/claims/{by_env['clinic']['claim']['id']}/approve", json={"actor": "Raquel"})
    assert ok.json()["claim"]["review_state"] == "approved"
    assert c.post(f"/api/claims/{by_env['clinic']['claim']['id']}/reject", json={"actor": "Raquel", "reason": "x"}).status_code == 409
    s = c.get("/api/cases/c1/summary?locale=en").json()
    assert len(s["lines"]) == 1 and "Moreira" not in s["text"]
    assert c.get("/api/cases/c1/summary?locale=fr").status_code == 422
    assert len(c.get(f"/api/claims/{by_env['clinic']['claim']['id']}/audit").json()) == 2
    g = {(r["activity"], r["environment"]): r for r in c.get("/api/cases/c1/gaps").json()}
    assert g[("dressing_upper", "clinic")]["status"] == "direct" and g[("dressing_upper", "home")]["status"] == "report_only"


def test_goal_check_assessment_and_attendance():
    c = TestClient(create_app(":memory:", client=None))
    c.post("/api/cases", json={"id": "c1", "label": "Paciente A"})
    gid = c.post("/api/cases/c1/goals", json={"activity": "dressing_upper", "environment": "home", "assistance": "verbal_prompt",
                                              "measure": "observed at home", "start_date": "2026-09-01", "review_date": "2026-12-01"}).json()["id"]
    chk = c.get(f"/api/goals/{gid}/check?as_of=2026-10-01&locale=en").json()
    assert chk["check"]["verdict"] != "supported" and chk["text"]
    assert c.post(f"/api/goals/{gid}/assessment", json={"actor": "R", "gas_rating": 3, "comment": "x", "as_of": "2026-10-01"}).status_code == 422
    assert c.post(f"/api/goals/{gid}/assessment", json={"actor": "R", "gas_rating": 0, "comment": "x", "as_of": "2026-10-01"}).status_code == 201
    for d, st in [("2026-09-01", "attended"), ("2026-09-08", "attended"), ("2026-09-15", "absent_justified"), ("2026-09-22", "not_held")]:
        assert c.post("/api/cases/c1/attendance", json={"day": d, "status": st, "actor": "R"}).status_code == 201
    a = c.get("/api/cases/c1/attendance").json()["adherence"]
    assert (a["offered"], a["rate"]) == (3, 0.667)
    assert c.post("/api/cases/c1/attendance", json={"day": "2026-09-29", "status": "x", "actor": "R"}).status_code == 409


def test_limits_and_unknowns():
    c = TestClient(create_app(":memory:", client=None))
    assert c.get("/api/cases/nope/gaps").status_code == 404
    c.post("/api/cases", json={"id": "c1", "label": "A"})
    assert c.post("/api/cases/c1/notes", json={"text": "x" * 5000, "session_date": "2026-09-01"}).status_code == 422
    assert c.post("/api/cases", json={"id": "bad id!", "label": "A"}).status_code == 422
    assert c.post("/api/cases/c1/claims", json={"text": "t", "activity": "flying", "environment": "home", "assistance": "independent"}).status_code == 422


def test_model_down_is_reported_not_hidden():
    class Down:
        model = "x"
        def complete_json(self, s, u):
            raise OSError("down")
    c = TestClient(create_app(":memory:", client=Down(), mode="llm"))
    c.post("/api/cases", json={"id": "c1", "label": "A"})
    r = c.post("/api/cases/c1/notes", json={"text": "A criança vestiu a camiseta.", "session_date": "2026-09-01"})
    assert r.status_code == 502 and c.get("/api/cases/c1/observations").json() == []


def test_persistence_across_restart(tmp_path):
    d = str(tmp_path)
    c = TestClient(create_app(d, client=None))
    c.post("/api/cases", json={"id": "c1", "label": "A"})
    c.post("/api/patients", json={"role": "patient", "full_name": "Davi Moreira", "pseudonym": "Paciente A"})
    c2 = TestClient(create_app(d, client=None))
    assert c2.get("/api/cases").json()[0]["id"] == "c1" and c2.get("/api/patients").json()[0]["pseudonym"] == "Paciente A"
