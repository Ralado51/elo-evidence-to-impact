"""Tests for S1a-01: Generic versioned clinical-entity service and functional assessments routes.

Covers ACCEPTANCE rows 1-10 (row 14 is the Verifier's independent HTTP probe).
All credentials, tokens, and clinical payloads are synthetic and generated at test time.
"""

from __future__ import annotations

import ast
import copy
import importlib.util
import json
import secrets
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from elo.api import create_app
from elo.v3.authz import Principal
from elo.v3.clinical import ClinicalEntityService, ClinicalEntitySpec
from elo.v3.entities import ENTITY_PREFIX, build_entity, load_entity_schema, load_event_catalog, new_id
from elo.v3.errors import EMITTABLE_ERROR_CODES, V3Error
from elo.v3.store import V3Store, sha256_token

REPO_ROOT = Path(__file__).resolve().parents[2]
PKG = REPO_ROOT / "contracts" / "CL06_3-r1"
CONTRACTS = PKG / "contracts"
API_CONTRACT_PATH = CONTRACTS / "api" / "api-contract.v3.json"
FA_SCHEMA_PATH = CONTRACTS / "schemas" / "entities" / "functional_assessment.schema.json"
VALID_ENTITIES_PATH = PKG / "fixtures" / "valid" / "entities.v3.json"
INVALID_PATH = PKG / "fixtures" / "invalid" / "contract-invalid.v3.json"
REF_PY_PATH = PKG / "reference" / "python" / "elo_ref.py"

S1A_01_ROUTE_IDS = {
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
}


def _load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _load_ref():
    spec = importlib.util.spec_from_file_location("s1a_01_cl06_3_elo_ref", REF_PY_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _valid_fa_payload(*, note: str | None = None, date_str: str = "2026-11-23", side: str = "right") -> dict:
    return {
        "assessment_date": date_str,
        "body_segment": "hand",
        "side": side,
        "instrument": {
            "instrument_id": "custom_unvalidated",
            "instrument_version": "0",
            "status": "unvalidated_custom",
        },
        "items": [
            {
                "item_key": "grip_open_close_free",
                "value_type": "category",
                "value": "with_difficulty",
                "unit": None,
                "source": "therapist_observed",
                "assistance": "some",
                "not_assessed": False,
            },
            {
                "item_key": "wrist_extension",
                "value_type": "number",
                "value": None,
                "unit": "deg",
                "source": "therapist_instrumental",
                "assistance": "not_assessed",
                "not_assessed": True,
            },
        ],
        "therapist_note": note,
    }


def _assert_error(resp, expected_status: int, expected_code: str) -> dict:
    assert resp.status_code == expected_status, f"expected {expected_status}, got {resp.status_code}: {resp.text}"
    body = resp.json()
    assert isinstance(body, dict) and set(body.keys()) == {"error"}, body
    err = body["error"]
    assert err["code"] == expected_code, f"expected {expected_code}, got {err}"
    assert err["code"] in EMITTABLE_ERROR_CODES
    assert isinstance(err["message"], str) and len(err["message"]) > 0
    return body


def _make_seeded_app(
    monkeypatch,
    *,
    db_path: str = ":memory:",
    data_origin: str = "synthetic_fixture",
    real_data_gate_open: bool = False,
):
    monkeypatch.delenv("ELO_ACCESS_TOKEN", raising=False)
    monkeypatch.setenv("ELO_V3_DATA_ORIGIN", data_origin)
    if real_data_gate_open:
        monkeypatch.setenv("ELO_V3_REAL_DATA_GATE_OPEN", "1")
    else:
        monkeypatch.delenv("ELO_V3_REAL_DATA_GATE_OPEN", raising=False)

    org_a = new_id("o")
    org_b = new_id("o")
    t1_id, t2_id, t3_id = new_id("t"), new_id("t"), new_id("t")
    t1_pw, t2_pw, t3_pw = secrets.token_urlsafe(12), secrets.token_urlsafe(12), secrets.token_urlsafe(12)
    seeds = [
        {"therapist_id": t1_id, "username": "t_fa1", "password": t1_pw, "org_id": org_a, "display_label": "Therapist FA1"},
        {"therapist_id": t2_id, "username": "t_fa2", "password": t2_pw, "org_id": org_a, "display_label": "Therapist FA2"},
        {"therapist_id": t3_id, "username": "t_fa3", "password": t3_pw, "org_id": org_b, "display_label": "Therapist FA3"},
    ]
    monkeypatch.setenv("ELO_V3_THERAPIST_SEEDS", json.dumps(seeds))
    app = create_app(db_path)
    client = TestClient(app)

    def login(u: str, p: str) -> str:
        r = client.post("/api/v3/auth/therapist", json={"username": u, "password": p})
        assert r.status_code == 200
        return r.json()["token"]

    t1_tok = login("t_fa1", t1_pw)
    t2_tok = login("t_fa2", t2_pw)
    t3_tok = login("t_fa3", t3_pw)

    # Only seed participant + invite when store origin is allowed (or gate open)
    ctx = {
        "org_a": org_a,
        "org_b": org_b,
        "t1_id": t1_id,
        "t2_id": t2_id,
        "t3_id": t3_id,
        "t1_tok": t1_tok,
        "t2_tok": t2_tok,
        "t3_tok": t3_tok,
    }
    if data_origin != "live" or real_data_gate_open:
        rp = client.post("/api/v3/participants", headers={"Authorization": f"Bearer {t1_tok}"}, json={"alias": "FA P1", "side": "right"})
        assert rp.status_code == 201
        p1 = rp.json()
        cl1_id = rp.headers["X-Elo-Care-Link-Id"]

        ri = client.post("/api/v3/invites", headers={"Authorization": f"Bearer {t1_tok}"}, json={"participant_id": p1["entity_id"]})
        assert ri.status_code == 201
        p1_tok = client.post("/api/v3/auth/invite", json={"invite_token": ri.json()["invite_token"]}).json()["token"]

        ctx.update({"p1": p1, "p1_id": p1["entity_id"], "p1_tok": p1_tok, "cl1_id": cl1_id})
    return app, client, ctx


def _collect_v3_routes(app) -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path, ops in app.openapi().get("paths", {}).items():
        if path.startswith("/api/v3"):
            for method in ops:
                if method.upper() not in ("HEAD", "OPTIONS"):
                    found.add((method.upper(), path))
    return found


# --- Row 1: Routes match the contract ----------------------------------------------------


def test_routes_match_api_contract_exact_set(monkeypatch):
    api_doc = _load_json(API_CONTRACT_PATH)
    by_id = {ep["id"]: ep for ep in api_doc["endpoints"]}
    expected_routes = {(by_id[rid]["method"], by_id[rid]["path"]) for rid in S1A_01_ROUTE_IDS}

    app, _, _ = _make_seeded_app(monkeypatch)
    assert _collect_v3_routes(app) == expected_routes

    assert by_id["assessments.create"]["method"] == "POST"
    assert by_id["assessments.create"]["path"] == "/api/v3/participants/{participant_id}/assessments"
    assert by_id["assessments.create"]["roles"] == ["therapist"]

    assert by_id["assessments.revise"]["method"] == "POST"
    assert by_id["assessments.revise"]["path"] == "/api/v3/assessments/{entity_id}/versions"
    assert by_id["assessments.revise"]["roles"] == ["therapist"]

    assert by_id["assessments.list"]["method"] == "GET"
    assert by_id["assessments.list"]["path"] == "/api/v3/participants/{participant_id}/assessments"
    assert by_id["assessments.list"]["roles"] == ["therapist"]


# --- Row 2: Create v1 and REF parity -----------------------------------------------------


@pytest.mark.parametrize("wrapped", [False, True])
def test_create_functional_assessment_matches_ref(monkeypatch, wrapped):
    ref = _load_ref()
    fa_schema = _load_json(FA_SCHEMA_PATH)
    cat = load_event_catalog()

    app, client, ctx = _make_seeded_app(monkeypatch)
    payload = _valid_fa_payload()
    body = {"payload": payload} if wrapped else payload

    r = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/assessments",
        headers={"Authorization": f"Bearer {ctx['t1_tok']}"},
        json=body,
    )
    assert r.status_code == 201, r.text
    ent = r.json()

    assert ent["entity_id"].startswith("fa_")
    assert ent["entity_type"] == "functional_assessment"
    assert ent["version"] == 1
    assert ent["prev_hash"] is None
    assert ent["author"] == {"role": "therapist", "id": ctx["t1_id"]}
    assert ent["participant_id"] == ctx["p1_id"]
    assert ent["org_id"] == ctx["org_a"]
    assert ent["data_origin"] == "synthetic_fixture"
    assert ent["payload"] == payload
    assert ent["hash"] == ref.compute_entity_hash(ent)
    assert ref.validate(fa_schema, ent) == []
    assert ref.check_entity_semantics(ent, cat, real_data_gate_open=False) == []


# --- Row 3: Server-owned fields never reach stored entity --------------------------------


@pytest.mark.parametrize("wrapped", [False, True])
def test_server_owned_fields_never_reach_stored_entity(monkeypatch, wrapped):
    ref = _load_ref()
    fa_schema = _load_json(FA_SCHEMA_PATH)
    cat = load_event_catalog()

    app, client, ctx = _make_seeded_app(monkeypatch)
    payload = _valid_fa_payload()
    spoof = {
        "entity_id": "fa_spoofed-9999",
        "entity_type": "goal",
        "version": 99,
        "prev_hash": "a" * 64,
        "author": {"role": "participant", "id": ctx["p1_id"]},
        "org_id": ctx["org_b"],
        "participant_id": "p_other-9999",
        "data_origin": "live",
        "hash": "b" * 64,
        "created_at": "2000-01-01T00:00:00.000Z",
    }
    body = {"payload": payload, **spoof} if wrapped else {**payload, **spoof}

    r = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/assessments",
        headers={"Authorization": f"Bearer {ctx['t1_tok']}"},
        json=body,
    )
    assert r.status_code == 201, r.text
    ent = r.json()
    stored = app.state.v3_store.get_entity_versions(ent["entity_id"])[0]
    assert stored == ent

    assert stored["entity_id"] != spoof["entity_id"] and stored["entity_id"].startswith("fa_")
    assert stored["entity_type"] == "functional_assessment"
    assert stored["version"] == 1
    assert stored["prev_hash"] is None
    assert stored["author"] == {"role": "therapist", "id": ctx["t1_id"]}
    assert stored["org_id"] == ctx["org_a"]
    assert stored["participant_id"] == ctx["p1_id"]
    assert stored["data_origin"] == "synthetic_fixture"
    assert stored["hash"] == ref.compute_entity_hash(stored) != spoof["hash"]
    assert stored["created_at"] != spoof["created_at"]
    assert ref.validate(fa_schema, stored) == []
    assert ref.check_entity_semantics(stored, cat, real_data_gate_open=False) == []

    # Same spoof protection on revise
    rev_payload = _valid_fa_payload(note="Revised cleanly")
    rev_body = {"payload": rev_payload, **spoof} if wrapped else {**rev_payload, **spoof}
    r2 = client.post(
        f"/api/v3/assessments/{ent['entity_id']}/versions",
        headers={"Authorization": f"Bearer {ctx['t1_tok']}"},
        json=rev_body,
    )
    assert r2.status_code == 201, r2.text
    v2 = r2.json()
    assert v2["entity_id"] == ent["entity_id"]
    assert v2["version"] == 2
    assert v2["prev_hash"] == ent["hash"]
    assert v2["author"] == {"role": "therapist", "id": ctx["t1_id"]}
    assert v2["org_id"] == ctx["org_a"]
    assert v2["participant_id"] == ctx["p1_id"]
    assert v2["data_origin"] == "synthetic_fixture"
    assert v2["created_at"] != spoof["created_at"]
    assert v2["hash"] == ref.compute_entity_hash(v2) != spoof["hash"]

    # Server-owned fields placed INSIDE wrapped payload object are rejected with 400 UNKNOWN_FIELD
    r_bad = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/assessments",
        headers={"Authorization": f"Bearer {ctx['t1_tok']}"},
        json={"payload": {**payload, "version": 42}},
    )
    _assert_error(r_bad, 400, "UNKNOWN_FIELD")


# --- Row 4: Revise v+1, chain integrity, and immutability (RN004) ------------------------


def test_revise_preserves_immutability_and_ref_chain(monkeypatch):
    ref = _load_ref()
    fa_schema = _load_json(FA_SCHEMA_PATH)
    cat = load_event_catalog()

    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    r1 = client.post(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=hdrs, json=_valid_fa_payload(note=None))
    assert r1.status_code == 201
    v1 = r1.json()
    eid = v1["entity_id"]
    raw_v1_before = app.state.v3_store.db.execute(
        "SELECT data FROM v3_entities WHERE entity_id=? AND version=1", (eid,)
    ).fetchone()[0]

    r2 = client.post(f"/api/v3/assessments/{eid}/versions", headers=hdrs, json=_valid_fa_payload(note="Revision 2"))
    assert r2.status_code == 201
    v2 = r2.json()
    assert v2["version"] == 2
    assert v2["prev_hash"] == v1["hash"]
    assert v2["hash"] == ref.compute_entity_hash(v2)
    raw_v2_before = app.state.v3_store.db.execute(
        "SELECT data FROM v3_entities WHERE entity_id=? AND version=2", (eid,)
    ).fetchone()[0]

    r3 = client.post(f"/api/v3/assessments/{eid}/versions", headers=hdrs, json=_valid_fa_payload(note="Revision 3"))
    assert r3.status_code == 201
    v3 = r3.json()
    assert v3["version"] == 3
    assert v3["prev_hash"] == v2["hash"]
    assert v3["hash"] == ref.compute_entity_hash(v3)

    # Earlier versions are byte-identical in SQLite before and after subsequent revisions
    raw_v1_after = app.state.v3_store.db.execute(
        "SELECT data FROM v3_entities WHERE entity_id=? AND version=1", (eid,)
    ).fetchone()[0]
    raw_v2_after = app.state.v3_store.db.execute(
        "SELECT data FROM v3_entities WHERE entity_id=? AND version=2", (eid,)
    ).fetchone()[0]
    assert raw_v1_after == raw_v1_before
    assert raw_v2_after == raw_v2_before

    # REF validates every version and the entire chain
    versions = app.state.v3_store.get_entity_versions(eid)
    assert len(versions) == 3
    for ver in versions:
        assert ref.validate(fa_schema, ver) == []
        assert ref.check_entity_semantics(ver, cat, real_data_gate_open=False) == []
    assert ref.check_entity_chain(versions) == []

    # Append-only triggers block UPDATE and DELETE on stored assessment rows
    with pytest.raises(sqlite3.IntegrityError):
        app.state.v3_store.db.execute("UPDATE v3_entities SET data='{}' WHERE entity_id=? AND version=1", (eid,))
    with pytest.raises(sqlite3.IntegrityError):
        app.state.v3_store.db.execute("DELETE FROM v3_entities WHERE entity_id=? AND version=1", (eid,))


# --- Row 5: Concurrent revision race -> exactly one succeeds, other 409 conflict ---------


def test_concurrent_revise_race_at_store_boundary(monkeypatch):
    ref = _load_ref()
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    r1 = client.post(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=hdrs, json=_valid_fa_payload(note="Base v1"))
    assert r1.status_code == 201
    v1 = r1.json()
    eid = v1["entity_id"]
    raw_v1_before = app.state.v3_store.db.execute(
        "SELECT data FROM v3_entities WHERE entity_id=? AND version=1", (eid,)
    ).fetchone()[0]

    # Force two HTTP revisions to read the exact same base v1 before either inserts v2
    store = app.state.v3_store
    orig_insert = store.insert_entity_version
    barrier = threading.Barrier(2)

    def racing_insert(ent, *, existing):
        if ent["entity_id"] == eid and ent["version"] == 2:
            barrier.wait(timeout=5.0)
        return orig_insert(ent, existing=existing)

    monkeypatch.setattr(store, "insert_entity_version", racing_insert)

    def do_revise(label: str):
        return client.post(
            f"/api/v3/assessments/{eid}/versions",
            headers=hdrs,
            json=_valid_fa_payload(note=f"Race {label}"),
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        f_a = pool.submit(do_revise, "A")
        f_b = pool.submit(do_revise, "B")
        resps = [f_a.result(timeout=10), f_b.result(timeout=10)]

    statuses = sorted(r.status_code for r in resps)
    assert statuses == [201, 409], [(r.status_code, r.text) for r in resps]

    winner = next(r for r in resps if r.status_code == 201)
    loser = next(r for r in resps if r.status_code == 409)
    _assert_error(loser, 409, "ENTITY_VERSION_CONFLICT")

    versions = store.get_entity_versions(eid)
    assert len(versions) == 2
    assert versions[0] == v1
    assert versions[1] == winner.json()
    assert ref.check_entity_chain(versions) == []

    raw_v1_after = store.db.execute(
        "SELECT data FROM v3_entities WHERE entity_id=? AND version=1", (eid,)
    ).fetchone()[0]
    assert raw_v1_after == raw_v1_before


def test_concurrent_revise_race_two_sqlite_connections(tmp_path):
    """Also verify uniqueness enforcement across two independent SQLite connections."""
    db_file = str(tmp_path / "race.db")
    store_a = V3Store(db_file)
    store_b = V3Store(db_file)

    org_id = new_id("o")
    t_id = new_id("t")
    p_id = new_id("p")
    cl_id = new_id("cl")
    store_a.seed_therapist(therapist_id=t_id, username="t_race", password=secrets.token_urlsafe(12), org_id=org_id)
    now = "2026-11-25T10:00:00.000Z"
    store_a.save_entities_atomic(
        [
            (
                build_entity(
                    entity_type="participant",
                    entity_id=p_id,
                    version=1,
                    prev_hash=None,
                    org_id=org_id,
                    participant_id=p_id,
                    author_role="therapist",
                    author_id=t_id,
                    data_origin="synthetic_fixture",
                    payload={"alias": "Race P", "side": "right"},
                    created_at=now,
                ),
                [],
            ),
            (
                build_entity(
                    entity_type="care_link",
                    entity_id=cl_id,
                    version=1,
                    prev_hash=None,
                    org_id=org_id,
                    participant_id=p_id,
                    author_role="therapist",
                    author_id=t_id,
                    data_origin="synthetic_fixture",
                    payload={"therapist_id": t_id, "status": "active", "valid_from": "2026-11-20", "valid_to": None},
                    created_at=now,
                ),
                [],
            ),
        ]
    )

    principal = Principal(role="therapist", id=t_id, org_id=org_id)
    svc_a = ClinicalEntityService(store_a)
    svc_b = ClinicalEntityService(store_b)

    v1 = svc_a.create("functional_assessment", p_id, _valid_fa_payload(note="v1"), principal)
    eid = v1["entity_id"]

    # Both connections construct v2 from the same v1 base and race at insert_entity_version
    v2_a = svc_a._build_validated_entity(
        entity_type="functional_assessment",
        entity_id=eid,
        version=2,
        prev_hash=v1["hash"],
        org_id=org_id,
        participant_id=p_id,
        principal=principal,
        payload=_valid_fa_payload(note="conn A"),
        existing=[v1],
    )
    v2_b = svc_b._build_validated_entity(
        entity_type="functional_assessment",
        entity_id=eid,
        version=2,
        prev_hash=v1["hash"],
        org_id=org_id,
        participant_id=p_id,
        principal=principal,
        payload=_valid_fa_payload(note="conn B"),
        existing=[v1],
    )

    store_a.insert_entity_version(v2_a, existing=[v1])
    with pytest.raises(V3Error) as exc_info:
        store_b.insert_entity_version(v2_b, existing=[v1])
    assert exc_info.value.code == "ENTITY_VERSION_CONFLICT"
    assert exc_info.value.http_status == 409
    assert len(store_a.get_entity_versions(eid)) == 2


# --- Row 6: List latest versions ordered by (created_at, entity_id) + entities.versions --


def test_list_latest_versions_ordering_and_entities_versions_trail(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    # Empty list initially
    r_empty = client.get(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=hdrs)
    assert r_empty.status_code == 200
    assert r_empty.json() == []

    # Create assessment A, sleep briefly so created_at differs, create B, then revise A so A v2 is newer than B v1
    r_a1 = client.post(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=hdrs, json=_valid_fa_payload(note="A v1"))
    assert r_a1.status_code == 201
    a1 = r_a1.json()
    time.sleep(0.005)

    r_b1 = client.post(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=hdrs, json=_valid_fa_payload(note="B v1"))
    assert r_b1.status_code == 201
    b1 = r_b1.json()
    time.sleep(0.005)

    r_a2 = client.post(f"/api/v3/assessments/{a1['entity_id']}/versions", headers=hdrs, json=_valid_fa_payload(note="A v2"))
    assert r_a2.status_code == 201
    a2 = r_a2.json()

    # Also test tie-break by entity_id when created_at is identical
    fixed_ts = "2026-11-25T00:00:00.001Z"
    tie_hi = build_entity(
        entity_type="functional_assessment",
        entity_id="fa_zzzzzzzz0002",
        version=1,
        prev_hash=None,
        org_id=ctx["org_a"],
        participant_id=ctx["p1_id"],
        author_role="therapist",
        author_id=ctx["t1_id"],
        data_origin="synthetic_fixture",
        payload=_valid_fa_payload(note="Tie hi"),
        created_at=fixed_ts,
    )
    tie_lo = build_entity(
        entity_type="functional_assessment",
        entity_id="fa_aaaaaaaa0001",
        version=1,
        prev_hash=None,
        org_id=ctx["org_a"],
        participant_id=ctx["p1_id"],
        author_role="therapist",
        author_id=ctx["t1_id"],
        data_origin="synthetic_fixture",
        payload=_valid_fa_payload(note="Tie lo"),
        created_at=fixed_ts,
    )
    app.state.v3_store.insert_entity_version(tie_hi, existing=[])
    app.state.v3_store.insert_entity_version(tie_lo, existing=[])

    r_list = client.get(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=hdrs)
    assert r_list.status_code == 200
    listed = r_list.json()
    assert len(listed) == 4
    expected_order = sorted([tie_lo, tie_hi, b1, a2], key=lambda e: (e["created_at"], e["entity_id"]))
    assert [e["entity_id"] for e in listed] == [e["entity_id"] for e in expected_order]
    assert [e["version"] for e in listed] == [e["version"] for e in expected_order]
    # Specifically tie_lo comes before tie_hi, and b1 comes before a2
    assert listed[0]["entity_id"] == "fa_aaaaaaaa0001"
    assert listed[1]["entity_id"] == "fa_zzzzzzzz0002"
    assert listed[2]["entity_id"] == b1["entity_id"] and listed[2]["version"] == 1
    assert listed[3]["entity_id"] == a2["entity_id"] and listed[3]["version"] == 2

    # entities.versions returns the full history of A
    r_hist = client.get(f"/api/v3/entities/{a1['entity_id']}/versions", headers=hdrs)
    assert r_hist.status_code == 200
    assert r_hist.json() == [a1, a2]


# --- Row 7: Authorization matrix across all three routes ---------------------------------


def test_authorization_all_three_routes(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    t2_hdrs = {"Authorization": f"Bearer {ctx['t2_tok']}"}  # unlinked same org
    t3_hdrs = {"Authorization": f"Bearer {ctx['t3_tok']}"}  # other org
    p1_hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}

    # Linked therapist creates v1
    r1 = client.post(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=t1_hdrs, json=_valid_fa_payload())
    assert r1.status_code == 201
    fa_id = r1.json()["entity_id"]

    unknown_pid = new_id("p")
    unknown_fa = new_id("fa")
    valid_body = _valid_fa_payload()

    # 1. Anonymous (no token) -> 401 UNAUTHENTICATED on all three routes
    _assert_error(client.post(f"/api/v3/participants/{ctx['p1_id']}/assessments", json=valid_body), 401, "UNAUTHENTICATED")
    _assert_error(client.post(f"/api/v3/assessments/{fa_id}/versions", json=valid_body), 401, "UNAUTHENTICATED")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/assessments"), 401, "UNAUTHENTICATED")

    # 2. Forged stored role -> 403 ROLE_NOT_ALLOWED on all three routes
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
        _assert_error(client.post(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=f_hdrs, json=valid_body), 403, "ROLE_NOT_ALLOWED")
        _assert_error(client.post(f"/api/v3/assessments/{fa_id}/versions", headers=f_hdrs, json=valid_body), 403, "ROLE_NOT_ALLOWED")
        _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=f_hdrs), 403, "ROLE_NOT_ALLOWED")

    # 3. Participant -> 403 FORBIDDEN on all three routes (including unknown ids)
    _assert_error(client.post(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=p1_hdrs, json=valid_body), 403, "FORBIDDEN")
    _assert_error(client.post(f"/api/v3/participants/{unknown_pid}/assessments", headers=p1_hdrs, json=valid_body), 403, "FORBIDDEN")
    _assert_error(client.post(f"/api/v3/assessments/{fa_id}/versions", headers=p1_hdrs, json=valid_body), 403, "FORBIDDEN")
    _assert_error(client.post(f"/api/v3/assessments/{unknown_fa}/versions", headers=p1_hdrs, json=valid_body), 403, "FORBIDDEN")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=p1_hdrs), 403, "FORBIDDEN")
    _assert_error(client.get(f"/api/v3/participants/{unknown_pid}/assessments", headers=p1_hdrs), 403, "FORBIDDEN")

    # 4. Unknown participant -> 404 NOT_FOUND on create & list; unknown or wrong-type entity -> 404 NOT_FOUND on revise
    _assert_error(client.post(f"/api/v3/participants/{unknown_pid}/assessments", headers=t1_hdrs, json=valid_body), 404, "NOT_FOUND")
    _assert_error(client.get(f"/api/v3/participants/{unknown_pid}/assessments", headers=t1_hdrs), 404, "NOT_FOUND")
    _assert_error(client.post(f"/api/v3/assessments/{unknown_fa}/versions", headers=t1_hdrs, json=valid_body), 404, "NOT_FOUND")
    _assert_error(client.post(f"/api/v3/assessments/{ctx['p1_id']}/versions", headers=t1_hdrs, json=valid_body), 404, "NOT_FOUND")

    # 5. Unlinked same-org therapist (t2) & other-org therapist (t3)
    #    -> 403 SCOPE_VIOLATION on create and list; 404 NOT_FOUND on revise of invisible entity
    for other_hdrs in (t2_hdrs, t3_hdrs):
        _assert_error(client.post(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=other_hdrs, json=valid_body), 403, "SCOPE_VIOLATION")
        _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=other_hdrs), 403, "SCOPE_VIOLATION")
        _assert_error(client.post(f"/api/v3/assessments/{fa_id}/versions", headers=other_hdrs, json=valid_body), 404, "NOT_FOUND")

    # 6. Revoked-link therapist (t1 after revoking care_link)
    #    -> 403 SCOPE_VIOLATION on create and list; 404 NOT_FOUND on revise
    r_rev = client.post(f"/api/v3/care-links/{ctx['cl1_id']}:revoke", headers=t1_hdrs, json={})
    assert r_rev.status_code == 200
    _assert_error(client.post(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=t1_hdrs, json=valid_body), 403, "SCOPE_VIOLATION")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=t1_hdrs), 403, "SCOPE_VIOLATION")
    _assert_error(client.post(f"/api/v3/assessments/{fa_id}/versions", headers=t1_hdrs, json=valid_body), 404, "NOT_FOUND")


# --- Row 8: Schema and semantic validation; nothing stored on failure --------------------


def test_validation_rejects_invalid_payloads_and_stores_nothing(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    def mut(fn):
        p = _valid_fa_payload()
        fn(p)
        return p

    cases = [
        ("missing_required_assessment_date", mut(lambda p: p.pop("assessment_date")), "MISSING_FIELD"),
        ("missing_item_field", mut(lambda p: p["items"][0].pop("assistance")), "MISSING_FIELD"),
        ("empty_items", mut(lambda p: p.__setitem__("items", [])), "LENGTH"),
        (
            "too_many_items",
            mut(lambda p: p.__setitem__("items", [copy.deepcopy(p["items"][0]) for _ in range(201)])),
            "LENGTH",
        ),
        ("bad_body_segment_enum", mut(lambda p: p.__setitem__("body_segment", "shoulder")), "ENUM"),
        ("bad_side_enum", mut(lambda p: p.__setitem__("side", "both")), "ENUM"),
        ("bad_item_source_enum", mut(lambda p: p["items"][0].__setitem__("source", "ai_inferred")), "ENUM"),
        ("value_string_too_long", mut(lambda p: p["items"][0].__setitem__("value", "x" * 81)), "LENGTH"),
        ("therapist_note_too_long", mut(lambda p: p.__setitem__("therapist_note", "n" * 2001)), "LENGTH"),
        ("bad_date_pattern", mut(lambda p: p.__setitem__("assessment_date", "23-11-2026")), "PATTERN"),
        ("unknown_payload_field", mut(lambda p: p.__setitem__("diagnosis", "not_allowed")), "UNKNOWN_FIELD"),
        ("unknown_item_field", mut(lambda p: p["items"][0].__setitem__("extra", 1)), "UNKNOWN_FIELD"),
        ("null_not_allowed_items", mut(lambda p: p.__setitem__("items", None)), "NULL_NOT_ALLOWED"),
        ("wrong_type_not_assessed", mut(lambda p: p["items"][0].__setitem__("not_assessed", "yes")), "TYPE"),
    ]

    for name, bad_payload, expected_code in cases:
        r = client.post(
            f"/api/v3/participants/{ctx['p1_id']}/assessments",
            headers=hdrs,
            json=bad_payload,
        )
        _assert_error(r, 400, expected_code)

    # Non-finite JSON literal -> 400 NON_FINITE
    r_nan = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/assessments",
        headers={**hdrs, "Content-Type": "application/json"},
        content=json.dumps(_valid_fa_payload()).replace("null", "NaN", 1),
    )
    _assert_error(r_nan, 400, "NON_FINITE")

    # Verify nothing was stored
    assert app.state.v3_store.list_latest_entities("functional_assessment", ctx["p1_id"]) == []

    # Create one valid v1, then verify invalid revise stores nothing and leaves v1 untouched
    r_ok = client.post(f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=hdrs, json=_valid_fa_payload())
    assert r_ok.status_code == 201
    eid = r_ok.json()["entity_id"]
    r_bad_rev = client.post(
        f"/api/v3/assessments/{eid}/versions",
        headers=hdrs,
        json=mut(lambda p: p.__setitem__("items", [])),
    )
    _assert_error(r_bad_rev, 400, "LENGTH")
    assert len(app.state.v3_store.get_entity_versions(eid)) == 1

    # Verify semantic RULE_VIOLATION via service validation (e.g. wrong entity_id prefix)
    svc = ClinicalEntityService(app.state.v3_store)
    principal = Principal(role="therapist", id=ctx["t1_id"], org_id=ctx["org_a"])
    with pytest.raises(V3Error) as exc_info:
        svc._build_validated_entity(
            entity_type="functional_assessment",
            entity_id=new_id("gl"),  # wrong prefix for functional_assessment
            version=1,
            prev_hash=None,
            org_id=ctx["org_a"],
            participant_id=ctx["p1_id"],
            principal=principal,
            payload=_valid_fa_payload(),
            existing=[],
        )
    assert exc_info.value.http_status == 400
    assert "RULE_VIOLATION" in (exc_info.value.details or [exc_info.value.code])


# --- Row 9: Real-data gate closed prevents producing data_origin: live -------------------


def test_real_data_gate_closed_cannot_produce_live(monkeypatch):
    # 1. Server configured with ELO_V3_DATA_ORIGIN=live while gate closed -> 403 REAL_DATA_GATE_CLOSED, nothing stored
    app, client, ctx = _make_seeded_app(monkeypatch, data_origin="live", real_data_gate_open=False)
    # Seed participant + active care_link directly as synthetic_fixture so authz passes and hits gate check
    p_id = new_id("p")
    cl_id = new_id("cl")
    now = "2026-11-25T10:00:00.000Z"
    app.state.v3_store.save_entities_atomic(
        [
            (
                build_entity(
                    entity_type="participant",
                    entity_id=p_id,
                    version=1,
                    prev_hash=None,
                    org_id=ctx["org_a"],
                    participant_id=p_id,
                    author_role="therapist",
                    author_id=ctx["t1_id"],
                    data_origin="synthetic_fixture",
                    payload={"alias": "Gate P", "side": "right"},
                    created_at=now,
                ),
                [],
            ),
            (
                build_entity(
                    entity_type="care_link",
                    entity_id=cl_id,
                    version=1,
                    prev_hash=None,
                    org_id=ctx["org_a"],
                    participant_id=p_id,
                    author_role="therapist",
                    author_id=ctx["t1_id"],
                    data_origin="synthetic_fixture",
                    payload={"therapist_id": ctx["t1_id"], "status": "active", "valid_from": "2026-11-20", "valid_to": None},
                    created_at=now,
                ),
                [],
            ),
        ]
    )

    r_live = client.post(
        f"/api/v3/participants/{p_id}/assessments",
        headers={"Authorization": f"Bearer {ctx['t1_tok']}"},
        json=_valid_fa_payload(),
    )
    _assert_error(r_live, 403, "REAL_DATA_GATE_CLOSED")
    assert app.state.v3_store.list_latest_entities("functional_assessment", p_id) == []

    # 2. Default server (synthetic_fixture, gate closed) receiving data_origin="live" in body never produces "live"
    app2, client2, ctx2 = _make_seeded_app(monkeypatch, data_origin="synthetic_fixture", real_data_gate_open=False)
    r_spoof = client2.post(
        f"/api/v3/participants/{ctx2['p1_id']}/assessments",
        headers={"Authorization": f"Bearer {ctx2['t1_tok']}"},
        json={**_valid_fa_payload(), "data_origin": "live"},
    )
    assert r_spoof.status_code == 201
    assert r_spoof.json()["data_origin"] == "synthetic_fixture"


# --- Row 10: Reusable generic service with a second registered type in-test only ---------


def test_reusable_service_generic_second_type_without_new_service_code(monkeypatch):
    ref = _load_ref()
    cat = load_event_catalog()
    goal_schema = load_entity_schema("goal")
    valid_fixtures = _load_json(VALID_ENTITIES_PATH)["entities"]

    # Static check: no functional_assessment-specific branching inside ClinicalEntityService methods
    clinical_src = (REPO_ROOT / "api" / "src" / "elo" / "v3" / "clinical.py").read_text(encoding="utf-8")
    tree = ast.parse(clinical_src)
    cls_node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "ClinicalEntityService")
    for node in ast.walk(cls_node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            assert "functional_assessment" not in node.value

    app, _, ctx = _make_seeded_app(monkeypatch)
    service = ClinicalEntityService(app.state.v3_store)

    # Register a second type from ENTITY_PREFIX ("goal") in-test only, without touching service code
    service.register(
        ClinicalEntitySpec(
            entity_type="goal",
            id_prefix=ENTITY_PREFIX["goal"],
            create_resource="goal",
            create_action="create/revise/confirm",
            revise_resource="goal",
            revise_action="create/revise/confirm",
            read_resource="goal",
            read_action="read",
            allow_revise=True,
        )
    )

    therapist = Principal(role="therapist", id=ctx["t1_id"], org_id=ctx["org_a"])
    goal_v1_payload = copy.deepcopy(valid_fixtures["goal"]["payload"])
    goal_v1 = service.create("goal", ctx["p1_id"], goal_v1_payload, therapist)
    assert goal_v1["entity_id"].startswith("gl_")
    assert goal_v1["entity_type"] == "goal"
    assert goal_v1["version"] == 1
    assert goal_v1["prev_hash"] is None
    assert goal_v1["hash"] == ref.compute_entity_hash(goal_v1)
    assert ref.validate(goal_schema, goal_v1) == []
    assert ref.check_entity_semantics(goal_v1, cat, real_data_gate_open=False) == []

    # Revise goal to v2 (achieved_confirmed by therapist)
    goal_v2_payload = copy.deepcopy(goal_v1_payload)
    goal_v2_payload["status"] = "achieved_confirmed"
    goal_v2_payload["confirmed_by"] = ctx["t1_id"]
    goal_v2_payload["confirmed_at"] = "2026-11-25T10:30:00.000Z"
    goal_v2 = service.revise(goal_v1["entity_id"], goal_v2_payload, therapist)
    assert goal_v2["entity_id"] == goal_v1["entity_id"]
    assert goal_v2["version"] == 2
    assert goal_v2["prev_hash"] == goal_v1["hash"]
    assert goal_v2["hash"] == ref.compute_entity_hash(goal_v2)
    assert ref.validate(goal_schema, goal_v2) == []
    assert ref.check_entity_semantics(goal_v2, cat, real_data_gate_open=False) == []
    assert ref.check_entity_chain([goal_v1, goal_v2]) == []

    # Semantic error on second type works through the same generic service (no goal-specific service code)
    bad_goal = copy.deepcopy(goal_v1_payload)
    bad_goal["status"] = "achieved_confirmed"
    bad_goal["confirmed_by"] = None
    bad_goal["confirmed_at"] = None
    with pytest.raises(V3Error) as exc_info:
        service.revise(goal_v1["entity_id"], bad_goal, therapist)
    assert exc_info.value.code == "GOAL_CONFIRMATION_REQUIRED"
    assert exc_info.value.http_status == 400

    # List returns latest version (v2)
    listed_goals = service.list("goal", ctx["p1_id"], therapist)
    assert listed_goals == [goal_v2]


# --- F1 / D-S1a-01-2 stress test: >= 200 concurrent revise races + authenticated reads ---


def test_stress_200_concurrent_revise_races_and_authenticated_reads(monkeypatch):
    import elo.api as elo_api

    monkeypatch.setattr(elo_api, "RATE_LIMIT", (100_000, 60))
    ref = _load_ref()
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    r1 = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/assessments",
        headers=hdrs,
        json=_valid_fa_payload(note="Stress base v1"),
    )
    assert r1.status_code == 201
    v1 = r1.json()
    eid = v1["entity_id"]
    store = app.state.v3_store
    raw_v1_before = store.db.execute(
        "SELECT data FROM v3_entities WHERE entity_id=? AND version=1", (eid,)
    ).fetchone()[0]

    orig_insert = store.insert_entity_version
    state = {"target_version": 2, "barrier": threading.Barrier(2)}

    def racing_insert(ent, *, existing):
        if ent["entity_id"] == eid and ent["version"] == state["target_version"]:
            state["barrier"].wait(timeout=5.0)
        return orig_insert(ent, existing=existing)

    monkeypatch.setattr(store, "insert_entity_version", racing_insert)

    num_races = 200
    payload_a = _valid_fa_payload(note="Stress writer A")
    payload_b = _valid_fa_payload(note="Stress writer B")

    with ThreadPoolExecutor(max_workers=4) as pool:
        for i in range(num_races):
            expected_v = i + 2
            state["target_version"] = expected_v
            state["barrier"] = threading.Barrier(2)

            f_w1 = pool.submit(client.post, f"/api/v3/assessments/{eid}/versions", headers=hdrs, json=payload_a)
            f_w2 = pool.submit(client.post, f"/api/v3/assessments/{eid}/versions", headers=hdrs, json=payload_b)
            f_list = pool.submit(client.get, f"/api/v3/participants/{ctx['p1_id']}/assessments", headers=hdrs)
            f_hist = pool.submit(client.get, f"/api/v3/entities/{eid}/versions", headers=hdrs)

            w_resps = [f_w1.result(timeout=10), f_w2.result(timeout=10)]
            r_list = f_list.result(timeout=10)
            r_hist = f_hist.result(timeout=10)

            assert sorted(r.status_code for r in w_resps) == [201, 409], (
                f"round {i}: {[(r.status_code, r.text) for r in w_resps]}"
            )
            winner = next(r for r in w_resps if r.status_code == 201)
            loser = next(r for r in w_resps if r.status_code == 409)
            assert winner.json()["version"] == expected_v
            _assert_error(loser, 409, "ENTITY_VERSION_CONFLICT")

            assert r_list.status_code == 200 and len(r_list.json()) == 1
            assert r_hist.status_code == 200 and len(r_hist.json()) >= expected_v - 1

    versions = store.get_entity_versions(eid)
    assert len(versions) == num_races + 1
    assert versions[0] == v1
    assert ref.check_entity_chain(versions) == []

    raw_v1_after = store.db.execute(
        "SELECT data FROM v3_entities WHERE entity_id=? AND version=1", (eid,)
    ).fetchone()[0]
    assert raw_v1_after == raw_v1_before

