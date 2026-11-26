"""Tests for the read-only console views (/api/console/v1). Synthetic data only."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from elo.api import create_app


def _h(tok: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {tok}"}


def _world(tmp_path: Path):
    app = create_app(data_dir=str(tmp_path))
    store = app.state.v3_store
    for tid, user, org in (("t_con-0001", "con_one", "o_con-0001"), ("t_con-0002", "con_two", "o_con-0001"), ("t_con-0003", "con_three", "o_con-0002")):
        store.seed_therapist(therapist_id=tid, username=user, password="synthetic-pass", org_id=org, display_label=user)
    c = TestClient(app)
    tok = {u: c.post("/api/v3/auth/therapist", json={"username": u, "password": "synthetic-pass"}).json()["token"] for u in ("con_one", "con_two", "con_three")}
    return app, c, tok


def _mk(c, tok, alias):
    r = c.post("/api/v3/participants", headers=_h(tok), json={"alias": alias, "side": "right"})
    assert r.status_code == 201, r.text
    return r.json()["entity_id"], r.headers["X-Elo-Care-Link-Id"]


def test_list_only_own_linked_participants_and_search(tmp_path):
    _, c, tok = _world(tmp_path)
    a, _ = _mk(c, tok["con_one"], "Caso Alfa")
    b, _ = _mk(c, tok["con_one"], "Caso Beta")
    other, _ = _mk(c, tok["con_two"], "Caso Gama")
    r = c.get("/api/console/v1/participants", headers=_h(tok["con_one"]))
    assert r.status_code == 200
    ids = [p["participant_id"] for p in r.json()["participants"]]
    assert ids == [a, b] and other not in ids
    r = c.get("/api/console/v1/participants?q=beta", headers=_h(tok["con_one"]))
    assert [p["participant_id"] for p in r.json()["participants"]] == [b]
    r = c.get("/api/console/v1/participants?q=zzz", headers=_h(tok["con_one"]))
    assert r.json()["participants"] == [] and r.json()["total"] == 0
    # other therapist in same org does not see participants of the first
    r = c.get("/api/console/v1/participants", headers=_h(tok["con_three"]))
    assert r.json()["participants"] == []


def test_revoked_link_disappears_from_list(tmp_path):
    _, c, tok = _world(tmp_path)
    a, cl = _mk(c, tok["con_one"], "Caso Revogado")
    assert c.post(f"/api/v3/care-links/{cl}:revoke", headers=_h(tok["con_one"]), json={}).status_code == 200
    assert c.get("/api/console/v1/participants", headers=_h(tok["con_one"])).json()["participants"] == []


def test_list_requires_therapist_and_auth(tmp_path):
    _, c, tok = _world(tmp_path)
    p, _ = _mk(c, tok["con_one"], "Caso Auth")
    assert c.get("/api/console/v1/participants").status_code == 401
    inv = c.post("/api/v3/invites", headers=_h(tok["con_one"]), json={"participant_id": p}).json()["invite_token"]
    ptok = c.post("/api/v3/auth/invite", json={"invite_token": inv}).json()["token"]
    assert c.get("/api/console/v1/participants", headers=_h(ptok)).status_code == 403
    assert c.get("/api/console/v1/participants?q=" + "x" * 41, headers=_h(tok["con_one"])).status_code in (400, 422)


def test_publications_isolated_per_participant(tmp_path):
    _, c, tok = _world(tmp_path)
    p1, _ = _mk(c, tok["con_one"], "Caso Um")
    p2, _ = _mk(c, tok["con_one"], "Caso Dois")
    inv = c.post("/api/v3/invites", headers=_h(tok["con_one"]), json={"participant_id": p1}).json()["invite_token"]
    ptok = c.post("/api/v3/auth/invite", json={"invite_token": inv}).json()["token"]
    r = c.get(f"/api/console/v1/participants/{p1}/publications", headers=_h(ptok))
    assert r.status_code == 200 and r.json()["publications"] == []
    assert c.get(f"/api/console/v1/participants/{p2}/publications", headers=_h(ptok)).status_code == 403
    assert c.get(f"/api/console/v1/participants/{p1}/publications", headers=_h(tok["con_one"])).status_code == 200
    assert c.get(f"/api/console/v1/participants/{p1}/publications", headers=_h(tok["con_three"])).status_code in (403, 404)
    assert c.get("/api/console/v1/participants/p_nonexistent00/publications", headers=_h(tok["con_one"])).status_code == 404


def test_contract_route_set_unchanged_by_console(tmp_path):
    app, _, _ = _world(tmp_path)
    paths = {p for p in app.openapi()["paths"] if p.startswith("/api/v3")}
    assert not any("console" in p for p in paths)
