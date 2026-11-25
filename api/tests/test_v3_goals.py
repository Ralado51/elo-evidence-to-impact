"""Tests for S1a-02: Goals (RN014) on the S1a-01 versioned clinical-entity service.

Covers ACCEPTANCE rows 1-9 (row 13 is the Verifier's independent HTTP probe).
All credentials, tokens, and goal payloads are synthetic and generated at test time.
"""

from __future__ import annotations

import ast
import copy
import importlib.util
import json
import re
import secrets
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import elo.api as elo_api
from elo.api import create_app
from elo.v3.clinical import DEFAULT_CLINICAL_REGISTRY
from elo.v3.entities import build_entity, load_event_catalog, new_id
from elo.v3.errors import EMITTABLE_ERROR_CODES, V3Error
from elo.v3.store import sha256_token

REPO_ROOT = Path(__file__).resolve().parents[2]
PKG = REPO_ROOT / "contracts" / "CL06_3-r1"
CONTRACTS = PKG / "contracts"
API_CONTRACT_PATH = CONTRACTS / "api" / "api-contract.v3.json"
GOAL_SCHEMA_PATH = CONTRACTS / "schemas" / "entities" / "goal.schema.json"
REF_PY_PATH = PKG / "reference" / "python" / "elo_ref.py"

ISO_MS_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$")

PARTICIPANT_GOAL_KEYS = {
    "entity_id",
    "version",
    "goal_text",
    "body_segment",
    "target",
    "status",
    "confirmed_at",
}

S1A_02_ROUTE_IDS = {
    "health",
    "auth.therapist",
    "invites.create",
    "auth.invite",
    "participants.create",
    "care_links.revoke",
    "events.batch",
    "entities.versions",
    "assessments.create",
    "assessments.revise",
    "assessments.list",
    "goals.create",
    "goals.revise",
    "goals.list",
    "encounters.create",
    "encounters.list",
    "reassessments.create",
    "instrumental.create",
    "prescriptions.publish",
    "prescriptions.current",
    "prescriptions.history",
}


def _load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _load_ref():
    spec = importlib.util.spec_from_file_location("s1a_02_cl06_3_elo_ref", REF_PY_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _valid_goal_payload(
    *,
    goal_text: str = "Synthetic goal: open and close hand steadily.",
    body_segment: str = "hand",
    target: dict | None = None,
    status: str = "active",
    confirmed_by: str | None = None,
    confirmed_at: str | None = None,
    include_confirmation_keys: bool = True,
) -> dict:
    p = {
        "goal_text": goal_text,
        "body_segment": body_segment,
        "target": target
        if target is not None
        else {"kind": "descriptive_text", "value": None, "unit": None},
        "status": status,
    }
    if include_confirmation_keys:
        p["confirmed_by"] = confirmed_by
        p["confirmed_at"] = confirmed_at
    return p


def _assert_error(resp, expected_status: int, expected_code: str) -> dict:
    assert resp.status_code == expected_status, f"expected {expected_status}, got {resp.status_code}: {resp.text}"
    body = resp.json()
    assert isinstance(body, dict) and set(body.keys()) == {"error"}, body
    err = body["error"]
    assert err["code"] == expected_code, f"expected {expected_code}, got {err}"
    assert err["code"] in EMITTABLE_ERROR_CODES
    assert isinstance(err["message"], str) and len(err["message"]) > 0
    return body


def _make_seeded_app(monkeypatch):
    monkeypatch.delenv("ELO_ACCESS_TOKEN", raising=False)
    monkeypatch.setenv("ELO_V3_DATA_ORIGIN", "synthetic_fixture")
    monkeypatch.delenv("ELO_V3_REAL_DATA_GATE_OPEN", raising=False)

    org_a = new_id("o")
    org_b = new_id("o")
    t1_id, t2_id, t3_id = new_id("t"), new_id("t"), new_id("t")
    t1_pw, t2_pw, t3_pw = secrets.token_urlsafe(12), secrets.token_urlsafe(12), secrets.token_urlsafe(12)
    seeds = [
        {"therapist_id": t1_id, "username": "t_g1", "password": t1_pw, "org_id": org_a, "display_label": "Therapist G1"},
        {"therapist_id": t2_id, "username": "t_g2", "password": t2_pw, "org_id": org_a, "display_label": "Therapist G2"},
        {"therapist_id": t3_id, "username": "t_g3", "password": t3_pw, "org_id": org_b, "display_label": "Therapist G3"},
    ]
    monkeypatch.setenv("ELO_V3_THERAPIST_SEEDS", json.dumps(seeds))
    app = create_app(":memory:")
    client = TestClient(app)

    def login(u: str, p: str) -> str:
        r = client.post("/api/v3/auth/therapist", json={"username": u, "password": p})
        assert r.status_code == 200
        return r.json()["token"]

    t1_tok = login("t_g1", t1_pw)
    t2_tok = login("t_g2", t2_pw)
    t3_tok = login("t_g3", t3_pw)

    def mk_participant(therapist_tok: str, alias: str):
        rp = client.post("/api/v3/participants", headers={"Authorization": f"Bearer {therapist_tok}"}, json={"alias": alias, "side": "right"})
        assert rp.status_code == 201
        p = rp.json()
        cl_id = rp.headers["X-Elo-Care-Link-Id"]
        ri = client.post("/api/v3/invites", headers={"Authorization": f"Bearer {therapist_tok}"}, json={"participant_id": p["entity_id"]})
        assert ri.status_code == 201
        p_tok = client.post("/api/v3/auth/invite", json={"invite_token": ri.json()["invite_token"]}).json()["token"]
        return p, cl_id, p_tok

    p1, cl1_id, p1_tok = mk_participant(t1_tok, "Goal P1")
    p2, cl2_id, p2_tok = mk_participant(t2_tok, "Goal P2")

    return app, client, {
        "org_a": org_a,
        "org_b": org_b,
        "t1_id": t1_id,
        "t2_id": t2_id,
        "t3_id": t3_id,
        "t1_tok": t1_tok,
        "t2_tok": t2_tok,
        "t3_tok": t3_tok,
        "p1": p1,
        "p1_id": p1["entity_id"],
        "p1_tok": p1_tok,
        "cl1_id": cl1_id,
        "p2": p2,
        "p2_id": p2["entity_id"],
        "p2_tok": p2_tok,
        "cl2_id": cl2_id,
    }


def _collect_v3_routes(app) -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path, ops in app.openapi().get("paths", {}).items():
        if path.startswith("/api/v3"):
            for method in ops:
                if method.upper() not in ("HEAD", "OPTIONS"):
                    found.add((method.upper(), path))
    return found


# --- Row 1 & Row 2: Routes match contract & uses generic service registry ----------------


def test_goal_routes_match_api_contract_and_use_generic_registry(monkeypatch):
    api_doc = _load_json(API_CONTRACT_PATH)
    by_id = {ep["id"]: ep for ep in api_doc["endpoints"]}
    expected_routes = {(by_id[rid]["method"], by_id[rid]["path"]) for rid in S1A_02_ROUTE_IDS}

    app, _, _ = _make_seeded_app(monkeypatch)
    assert _collect_v3_routes(app) == expected_routes

    assert by_id["goals.create"]["method"] == "POST"
    assert by_id["goals.create"]["path"] == "/api/v3/participants/{participant_id}/goals"
    assert by_id["goals.create"]["roles"] == ["therapist"]

    assert by_id["goals.revise"]["method"] == "POST"
    assert by_id["goals.revise"]["path"] == "/api/v3/goals/{entity_id}/versions"
    assert by_id["goals.revise"]["roles"] == ["therapist"]

    assert by_id["goals.list"]["method"] == "GET"
    assert by_id["goals.list"]["path"] == "/api/v3/participants/{participant_id}/goals"
    assert by_id["goals.list"]["roles"] == ["therapist", "participant"]

    # Row 2: goal registered in DEFAULT_CLINICAL_REGISTRY; ClinicalEntityService has no entity-type branching
    assert "goal" in DEFAULT_CLINICAL_REGISTRY
    assert DEFAULT_CLINICAL_REGISTRY["goal"].id_prefix == "gl"
    clinical_src = (REPO_ROOT / "api" / "src" / "elo" / "v3" / "clinical.py").read_text(encoding="utf-8")
    tree = ast.parse(clinical_src)
    cls_node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "ClinicalEntityService")
    for node in ast.walk(cls_node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            assert node.value not in ("functional_assessment", "goal")


# --- Row 3: Create and revise, REF parity, earlier versions byte-identical ---------------


@pytest.mark.parametrize("wrapped", [False, True])
def test_create_and_revise_goal_ref_parity_and_immutability(monkeypatch, wrapped):
    ref = _load_ref()
    goal_schema = _load_json(GOAL_SCHEMA_PATH)
    cat = load_event_catalog()

    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    p1 = _valid_goal_payload(
        goal_text="Synthetic goal: grasp cup cleanly",
        target={"kind": "repetitions", "value": 10, "unit": "reps"},
        status="active",
    )
    r1 = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/goals",
        headers=hdrs,
        json={"payload": p1} if wrapped else p1,
    )
    assert r1.status_code == 201, r1.text
    v1 = r1.json()
    gid = v1["entity_id"]
    assert gid.startswith("gl_")
    assert v1["entity_type"] == "goal"
    assert v1["version"] == 1
    assert v1["prev_hash"] is None
    assert v1["author"] == {"role": "therapist", "id": ctx["t1_id"]}
    assert v1["participant_id"] == ctx["p1_id"]
    assert v1["org_id"] == ctx["org_a"]
    assert v1["data_origin"] == "synthetic_fixture"
    assert v1["hash"] == ref.compute_entity_hash(v1)
    assert ref.validate(goal_schema, v1) == []
    assert ref.check_entity_semantics(v1, cat, real_data_gate_open=False) == []

    raw_v1_before = app.state.v3_store.db.execute(
        "SELECT data FROM v3_entities WHERE entity_id=? AND version=1", (gid,)
    ).fetchone()[0]

    p2 = _valid_goal_payload(
        goal_text="Synthetic goal: grasp cup cleanly",
        target={"kind": "repetitions", "value": 10, "unit": "reps"},
        status="achieved_confirmed",
        include_confirmation_keys=False,
    )
    r2 = client.post(
        f"/api/v3/goals/{gid}/versions",
        headers=hdrs,
        json={"payload": p2} if wrapped else p2,
    )
    assert r2.status_code == 201, r2.text
    v2 = r2.json()
    assert v2["entity_id"] == gid
    assert v2["version"] == 2
    assert v2["prev_hash"] == v1["hash"]
    assert v2["hash"] == ref.compute_entity_hash(v2)
    assert ref.validate(goal_schema, v2) == []
    assert ref.check_entity_semantics(v2, cat, real_data_gate_open=False) == []

    raw_v1_after = app.state.v3_store.db.execute(
        "SELECT data FROM v3_entities WHERE entity_id=? AND version=1", (gid,)
    ).fetchone()[0]
    assert raw_v1_after == raw_v1_before

    versions = app.state.v3_store.get_entity_versions(gid)
    assert versions == [v1, v2]
    assert ref.check_entity_chain(versions) == []

    # entities.versions returns full history for linked therapist
    r_hist = client.get(f"/api/v3/entities/{gid}/versions", headers=hdrs)
    assert r_hist.status_code == 200
    assert r_hist.json() == [v1, v2]


# --- Row 4: RN014 server-set confirmation (D-S1a-02-1(a)) --------------------------------


def test_rn014_server_sets_and_clears_confirmation_fields(monkeypatch):
    ref = _load_ref()
    goal_schema = _load_json(GOAL_SCHEMA_PATH)
    cat = load_event_catalog()

    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    spoof_therapist = ctx["t2_id"]
    spoof_time = "2000-01-01T00:00:00.000Z"

    # 1. Create active goal with spoofed confirmed_by & confirmed_at -> both stored as None
    r1 = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/goals",
        headers=hdrs,
        json=_valid_goal_payload(status="active", confirmed_by=spoof_therapist, confirmed_at=spoof_time),
    )
    assert r1.status_code == 201
    v1 = r1.json()
    gid = v1["entity_id"]
    assert v1["payload"]["status"] == "active"
    assert v1["payload"]["confirmed_by"] is None
    assert v1["payload"]["confirmed_at"] is None
    assert ref.validate(goal_schema, v1) == []
    assert ref.check_entity_semantics(v1, cat, real_data_gate_open=False) == []

    # 2. Revise to achieved_confirmed with spoofed confirmed_by & confirmed_at -> server overwrites both
    r2 = client.post(
        f"/api/v3/goals/{gid}/versions",
        headers=hdrs,
        json=_valid_goal_payload(status="achieved_confirmed", confirmed_by=spoof_therapist, confirmed_at=spoof_time),
    )
    assert r2.status_code == 201
    v2 = r2.json()
    assert v2["payload"]["status"] == "achieved_confirmed"
    assert v2["payload"]["confirmed_by"] == ctx["t1_id"]
    assert v2["payload"]["confirmed_by"] != spoof_therapist
    assert isinstance(v2["payload"]["confirmed_at"], str) and ISO_MS_RE.fullmatch(v2["payload"]["confirmed_at"])
    assert v2["payload"]["confirmed_at"] != spoof_time
    assert ref.validate(goal_schema, v2) == []
    assert ref.check_entity_semantics(v2, cat, real_data_gate_open=False) == []

    # 3. Leaving achieved_confirmed for active in v3 clears both confirmed_by and confirmed_at
    r3 = client.post(
        f"/api/v3/goals/{gid}/versions",
        headers=hdrs,
        json=_valid_goal_payload(status="active", confirmed_by=ctx["t1_id"], confirmed_at=v2["payload"]["confirmed_at"]),
    )
    assert r3.status_code == 201
    v3 = r3.json()
    assert v3["payload"]["status"] == "active"
    assert v3["payload"]["confirmed_by"] is None
    assert v3["payload"]["confirmed_at"] is None
    assert ref.validate(goal_schema, v3) == []
    assert ref.check_entity_semantics(v3, cat, real_data_gate_open=False) == []

    # 4. Discontinued also stores both null even if client sends values
    r4 = client.post(
        f"/api/v3/goals/{gid}/versions",
        headers=hdrs,
        json=_valid_goal_payload(status="discontinued", confirmed_by=ctx["t1_id"], confirmed_at=spoof_time),
    )
    assert r4.status_code == 201
    v4 = r4.json()
    assert v4["payload"]["status"] == "discontinued"
    assert v4["payload"]["confirmed_by"] is None
    assert v4["payload"]["confirmed_at"] is None
    assert ref.validate(goal_schema, v4) == []
    assert ref.check_entity_semantics(v4, cat, real_data_gate_open=False) == []

    # 5. Creating directly as achieved_confirmed with null/omitted confirmation sets server values
    r_direct = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/goals",
        headers=hdrs,
        json=_valid_goal_payload(status="achieved_confirmed", confirmed_by=None, confirmed_at=None),
    )
    assert r_direct.status_code == 201
    gd = r_direct.json()
    assert gd["payload"]["confirmed_by"] == ctx["t1_id"]
    assert ISO_MS_RE.fullmatch(gd["payload"]["confirmed_at"])
    assert ref.check_entity_semantics(gd, cat, real_data_gate_open=False) == []

    assert ref.check_entity_chain([v1, v2, v3, v4]) == []


# --- Row 5: Only the therapist confirms (HTTP + store-level forged non-therapist) --------


def test_only_therapist_can_confirm_http_and_store_level(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    p1_hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}

    r1 = client.post(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=t1_hdrs, json=_valid_goal_payload())
    assert r1.status_code == 201
    gid = r1.json()["entity_id"]

    # Participant cannot create or revise (including with achieved_confirmed) -> 403 FORBIDDEN
    _assert_error(
        client.post(
            f"/api/v3/participants/{ctx['p1_id']}/goals",
            headers=p1_hdrs,
            json=_valid_goal_payload(status="achieved_confirmed"),
        ),
        403,
        "FORBIDDEN",
    )
    _assert_error(
        client.post(
            f"/api/v3/goals/{gid}/versions",
            headers=p1_hdrs,
            json=_valid_goal_payload(status="achieved_confirmed"),
        ),
        403,
        "FORBIDDEN",
    )

    # Store-level test: forged goal authored by a participant with achieved_confirmed is rejected
    forged_gid = new_id("gl")
    forged = build_entity(
        entity_type="goal",
        entity_id=forged_gid,
        version=1,
        prev_hash=None,
        org_id=ctx["org_a"],
        participant_id=ctx["p1_id"],
        author_role="participant",
        author_id=ctx["p1_id"],
        data_origin="synthetic_fixture",
        payload=_valid_goal_payload(
            status="achieved_confirmed",
            confirmed_by=ctx["t1_id"],
            confirmed_at="2026-11-25T10:00:00.000Z",
        ),
    )
    with pytest.raises(V3Error) as exc_info:
        app.state.v3_store.insert_entity_version(forged, existing=[])
    assert exc_info.value.code in ("GOAL_CONFIRMATION_REQUIRED", "ROLE_NOT_ALLOWED")
    assert app.state.v3_store.get_entity_versions(forged_gid) == []


# --- Row 6 & Row 7: Participant simplified view vs Therapist view & full authz matrix ----


def test_participant_simplified_view_and_therapist_authz_matrix(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    t2_hdrs = {"Authorization": f"Bearer {ctx['t2_tok']}"}  # unlinked to p1, same org
    t3_hdrs = {"Authorization": f"Bearer {ctx['t3_tok']}"}  # other org
    p1_hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}
    p2_hdrs = {"Authorization": f"Bearer {ctx['p2_tok']}"}

    # Create two goals for p1 and revise the first to achieved_confirmed
    g1_v1 = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/goals",
        headers=t1_hdrs,
        json=_valid_goal_payload(goal_text="Goal 1 active", status="active"),
    ).json()
    time.sleep(0.005)
    g2_v1 = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/goals",
        headers=t1_hdrs,
        json=_valid_goal_payload(
            goal_text="Goal 2 reps",
            body_segment="wrist",
            target={"kind": "repetitions", "value": 12, "unit": "reps"},
            status="active",
        ),
    ).json()
    time.sleep(0.005)
    g1_v2 = client.post(
        f"/api/v3/goals/{g1_v1['entity_id']}/versions",
        headers=t1_hdrs,
        json=_valid_goal_payload(goal_text="Goal 1 achieved", status="achieved_confirmed"),
    ).json()

    # 1. Participant self view: exact 7 keys per goal, latest version values, no internal/author/hash/confirmed_by
    r_p1 = client.get(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=p1_hdrs)
    assert r_p1.status_code == 200
    p1_items = r_p1.json()
    assert len(p1_items) == 2
    for item in p1_items:
        assert set(item.keys()) == PARTICIPANT_GOAL_KEYS
        for forbidden_key in ("author", "org_id", "participant_id", "hash", "prev_hash", "created_at", "data_origin", "confirmed_by", "payload", "entity_type"):
            assert forbidden_key not in item

    assert p1_items[0] == {
        "entity_id": g2_v1["entity_id"],
        "version": 1,
        "goal_text": "Goal 2 reps",
        "body_segment": "wrist",
        "target": {"kind": "repetitions", "value": 12, "unit": "reps"},
        "status": "active",
        "confirmed_at": None,
    }
    assert p1_items[1] == {
        "entity_id": g1_v2["entity_id"],
        "version": 2,
        "goal_text": "Goal 1 achieved",
        "body_segment": "hand",
        "target": {"kind": "descriptive_text", "value": None, "unit": None},
        "status": "achieved_confirmed",
        "confirmed_at": g1_v2["payload"]["confirmed_at"],
    }

    # 2. Participant reading another participant (or unknown participant) -> 403 SCOPE_VIOLATION
    _assert_error(client.get(f"/api/v3/participants/{ctx['p2_id']}/goals", headers=p1_hdrs), 403, "SCOPE_VIOLATION")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=p2_hdrs), 403, "SCOPE_VIOLATION")
    _assert_error(client.get(f"/api/v3/participants/{new_id('p')}/goals", headers=p1_hdrs), 403, "SCOPE_VIOLATION")

    # 3. Linked therapist view: full latest entities ordered by (created_at, entity_id)
    r_t1 = client.get(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=t1_hdrs)
    assert r_t1.status_code == 200
    assert r_t1.json() == [g2_v1, g1_v2]

    # 4. Anonymous -> 401 on all 3 routes
    _assert_error(client.post(f"/api/v3/participants/{ctx['p1_id']}/goals", json=_valid_goal_payload()), 401, "UNAUTHENTICATED")
    _assert_error(client.post(f"/api/v3/goals/{g1_v1['entity_id']}/versions", json=_valid_goal_payload()), 401, "UNAUTHENTICATED")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/goals"), 401, "UNAUTHENTICATED")

    # 5. Forged stored role -> 403 ROLE_NOT_ALLOWED on all 3 routes
    future = (datetime.now(timezone.utc) + timedelta(seconds=3600)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    for forged_role in ("caregiver", "supervisor", "admin"):
        raw = secrets.token_urlsafe(32)
        app.state.v3_store.db.execute(
            "INSERT INTO v3_tokens (token_hash, role, principal_id, org_id, expires_at, revoked, created_at) VALUES (?,?,?,?,?,0,?)",
            (sha256_token(raw), forged_role, ctx["t1_id"], ctx["org_a"], future, now),
        )
        app.state.v3_store.db.commit()
        f_hdrs = {"Authorization": f"Bearer {raw}"}
        _assert_error(client.post(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=f_hdrs, json=_valid_goal_payload()), 403, "ROLE_NOT_ALLOWED")
        _assert_error(client.post(f"/api/v3/goals/{g1_v1['entity_id']}/versions", headers=f_hdrs, json=_valid_goal_payload()), 403, "ROLE_NOT_ALLOWED")
        _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=f_hdrs), 403, "ROLE_NOT_ALLOWED")

    # 6. Unknown participant -> 404 for therapist; unknown or wrong-type entity on revise -> 404
    unknown_pid = new_id("p")
    _assert_error(client.post(f"/api/v3/participants/{unknown_pid}/goals", headers=t1_hdrs, json=_valid_goal_payload()), 404, "NOT_FOUND")
    _assert_error(client.get(f"/api/v3/participants/{unknown_pid}/goals", headers=t1_hdrs), 404, "NOT_FOUND")
    _assert_error(client.post(f"/api/v3/goals/{new_id('gl')}/versions", headers=t1_hdrs, json=_valid_goal_payload()), 404, "NOT_FOUND")
    _assert_error(client.post(f"/api/v3/goals/{ctx['p1_id']}/versions", headers=t1_hdrs, json=_valid_goal_payload()), 404, "NOT_FOUND")

    # 7. Unlinked same-org therapist (t2) & other-org therapist (t3)
    #    -> 403 SCOPE_VIOLATION on create/list; 404 NOT_FOUND on revise of invisible goal
    for other_hdrs in (t2_hdrs, t3_hdrs):
        _assert_error(client.post(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=other_hdrs, json=_valid_goal_payload()), 403, "SCOPE_VIOLATION")
        _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=other_hdrs), 403, "SCOPE_VIOLATION")
        _assert_error(client.post(f"/api/v3/goals/{g1_v1['entity_id']}/versions", headers=other_hdrs, json=_valid_goal_payload()), 404, "NOT_FOUND")

    # 8. Revoked-link therapist -> 403 SCOPE_VIOLATION on create/list; 404 NOT_FOUND on revise
    assert client.post(f"/api/v3/care-links/{ctx['cl1_id']}:revoke", headers=t1_hdrs, json={}).status_code == 200
    _assert_error(client.post(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=t1_hdrs, json=_valid_goal_payload()), 403, "SCOPE_VIOLATION")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=t1_hdrs), 403, "SCOPE_VIOLATION")
    _assert_error(client.post(f"/api/v3/goals/{g1_v1['entity_id']}/versions", headers=t1_hdrs, json=_valid_goal_payload()), 404, "NOT_FOUND")


# --- Row 8: 50 barrier-synchronised concurrent revise races on one goal ------------------


def test_50_concurrent_revise_races_on_one_goal(monkeypatch):
    monkeypatch.setattr(elo_api, "RATE_LIMIT", (100_000, 60))
    ref = _load_ref()
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    p1_hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}

    r1 = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/goals",
        headers=t1_hdrs,
        json=_valid_goal_payload(goal_text="Goal race base v1"),
    )
    assert r1.status_code == 201
    v1 = r1.json()
    gid = v1["entity_id"]
    store = app.state.v3_store
    raw_v1_before = store.db.execute(
        "SELECT data FROM v3_entities WHERE entity_id=? AND version=1", (gid,)
    ).fetchone()[0]

    orig_insert = store.insert_entity_version
    state = {"target_version": 2, "barrier": threading.Barrier(2)}

    def racing_insert(ent, *, existing):
        if ent["entity_id"] == gid and ent["version"] == state["target_version"]:
            state["barrier"].wait(timeout=5.0)
        return orig_insert(ent, existing=existing)

    monkeypatch.setattr(store, "insert_entity_version", racing_insert)

    num_races = 50
    payload_a = _valid_goal_payload(goal_text="Race writer A", status="active")
    payload_b = _valid_goal_payload(goal_text="Race writer B", status="achieved_confirmed")

    with ThreadPoolExecutor(max_workers=4) as pool:
        for i in range(num_races):
            expected_v = i + 2
            state["target_version"] = expected_v
            state["barrier"] = threading.Barrier(2)

            f_w1 = pool.submit(client.post, f"/api/v3/goals/{gid}/versions", headers=t1_hdrs, json=payload_a)
            f_w2 = pool.submit(client.post, f"/api/v3/goals/{gid}/versions", headers=t1_hdrs, json=payload_b)
            f_p = pool.submit(client.get, f"/api/v3/participants/{ctx['p1_id']}/goals", headers=p1_hdrs)
            f_t = pool.submit(client.get, f"/api/v3/participants/{ctx['p1_id']}/goals", headers=t1_hdrs)

            w_resps = [f_w1.result(timeout=10), f_w2.result(timeout=10)]
            r_p = f_p.result(timeout=10)
            r_t = f_t.result(timeout=10)

            assert sorted(r.status_code for r in w_resps) == [201, 409]
            winner = next(r for r in w_resps if r.status_code == 201)
            loser = next(r for r in w_resps if r.status_code == 409)
            assert winner.json()["version"] == expected_v
            _assert_error(loser, 409, "ENTITY_VERSION_CONFLICT")
            assert r_p.status_code == 200 and set(r_p.json()[0].keys()) == PARTICIPANT_GOAL_KEYS
            assert r_t.status_code == 200 and len(r_t.json()) == 1

    versions = store.get_entity_versions(gid)
    assert len(versions) == num_races + 1
    assert versions[0] == v1
    assert ref.check_entity_chain(versions) == []

    raw_v1_after = store.db.execute(
        "SELECT data FROM v3_entities WHERE entity_id=? AND version=1", (gid,)
    ).fetchone()[0]
    assert raw_v1_after == raw_v1_before


# --- Row 9: Schema validation; nothing stored on failure ---------------------------------


def test_goal_validation_rejects_invalid_payloads_and_stores_nothing(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    def mut(fn):
        p = _valid_goal_payload()
        fn(p)
        return p

    cases = [
        ("empty_goal_text", mut(lambda p: p.__setitem__("goal_text", "")), "LENGTH"),
        ("goal_text_too_long", mut(lambda p: p.__setitem__("goal_text", "g" * 301)), "LENGTH"),
        ("missing_goal_text", mut(lambda p: p.pop("goal_text")), "MISSING_FIELD"),
        ("missing_status", mut(lambda p: p.pop("status")), "MISSING_FIELD"),
        ("bad_status_enum", mut(lambda p: p.__setitem__("status", "completed")), "ENUM"),
        ("bad_body_segment_enum", mut(lambda p: p.__setitem__("body_segment", "elbow")), "ENUM"),
        ("bad_target_kind", mut(lambda p: p["target"].__setitem__("kind", "score")), "ENUM"),
        ("target_value_negative", mut(lambda p: p["target"].__setitem__("value", -1)), "OUT_OF_RANGE"),
        ("target_value_too_large", mut(lambda p: p["target"].__setitem__("value", 100001)), "OUT_OF_RANGE"),
        ("target_unit_bad_pattern", mut(lambda p: p["target"].__setitem__("unit", "BAD UNIT!")), "PATTERN"),
        ("unknown_payload_field", mut(lambda p: p.__setitem__("diagnosis", "nope")), "UNKNOWN_FIELD"),
        ("unknown_target_field", mut(lambda p: p["target"].__setitem__("extra", 1)), "UNKNOWN_FIELD"),
        ("null_target", mut(lambda p: p.__setitem__("target", None)), "NULL_NOT_ALLOWED"),
        ("wrong_type_goal_text", mut(lambda p: p.__setitem__("goal_text", 123)), "TYPE"),
    ]

    for _, bad_payload, expected_code in cases:
        r = client.post(
            f"/api/v3/participants/{ctx['p1_id']}/goals",
            headers=hdrs,
            json=bad_payload,
        )
        _assert_error(r, 400, expected_code)

    assert app.state.v3_store.list_latest_entities("goal", ctx["p1_id"]) == []

    # Invalid revise leaves v1 untouched
    r_ok = client.post(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=hdrs, json=_valid_goal_payload())
    assert r_ok.status_code == 201
    gid = r_ok.json()["entity_id"]
    _assert_error(
        client.post(f"/api/v3/goals/{gid}/versions", headers=hdrs, json=mut(lambda p: p.__setitem__("goal_text", ""))),
        400,
        "LENGTH",
    )
    assert len(app.state.v3_store.get_entity_versions(gid)) == 1
