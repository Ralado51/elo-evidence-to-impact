"""Tests for S0-02: CL06.3 v3 two-profile auth, care-link authorization, and routes.

Covers ACCEPTANCE rows 1-15, 16, and 18 (row 21 is the Verifier's independent HTTP probe).
All test credentials and identifiers are synthetic and generated at test time.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import re
import secrets
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import jsonschema
import pytest
from fastapi.testclient import TestClient

from elo.api import create_app
from elo.v3.authz import ALLOWED_ROLES, POLICY_MATRIX, AuthzScope, CareLinkView, Principal, authorize
from elo.v3.entities import compute_entity_hash, new_id
from elo.v3.errors import EMITTABLE_ERROR_CODES, V3Error, error_response
from elo.v3.store import sha256_token

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACTS_R1 = REPO_ROOT / "contracts" / "CL06_3-r1" / "contracts"
API_CONTRACT_PATH = CONTRACTS_R1 / "api" / "api-contract.v3.json"
MATRIX_PATH = CONTRACTS_R1 / "api" / "authorization-matrix.v3.json"
ERROR_CODES_PATH = CONTRACTS_R1 / "catalogs" / "error-codes.v3.json"
EVENT_CATALOG_PATH = CONTRACTS_R1 / "catalogs" / "event-catalog.v3.json"
REF_PY_PATH = REPO_ROOT / "contracts" / "CL06_3-r1" / "reference" / "python" / "elo_ref.py"

S0_02_ROUTE_IDS = {
    "health",
    "auth.therapist",
    "invites.create",
    "auth.invite",
    "participants.create",
    "care_links.revoke",
}


def _load_ref_module():
    spec = importlib.util.spec_from_file_location("cl06_3_elo_ref", REF_PY_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _assert_error_body(resp, expected_status: int, expected_code: str) -> dict:
    assert resp.status_code == expected_status, f"expected {expected_status}, got {resp.status_code}: {resp.text}"
    body = resp.json()
    assert isinstance(body, dict) and set(body.keys()) == {"error"}, body
    err = body["error"]
    assert isinstance(err, dict)
    assert set(err.keys()).issubset({"code", "message", "details"})
    assert err["code"] == expected_code, f"expected code {expected_code}, got {err}"
    assert isinstance(err["message"], str) and len(err["message"]) > 0
    return body


def _make_seeded_app(monkeypatch, *, data_origin: str | None = None, real_data_gate_open: bool = False):
    monkeypatch.delenv("ELO_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("ELO_V3_THERAPIST_SEEDS", raising=False)
    if data_origin is not None:
        monkeypatch.setenv("ELO_V3_DATA_ORIGIN", data_origin)
    else:
        monkeypatch.delenv("ELO_V3_DATA_ORIGIN", raising=False)
    if real_data_gate_open:
        monkeypatch.setenv("ELO_V3_REAL_DATA_GATE_OPEN", "1")
    else:
        monkeypatch.delenv("ELO_V3_REAL_DATA_GATE_OPEN", raising=False)

    org_a = new_id("o")
    org_b = new_id("o")
    t1_id = new_id("t")
    t2_id = new_id("t")
    t3_id = new_id("t")
    t1_pw = secrets.token_urlsafe(12)
    t2_pw = secrets.token_urlsafe(12)
    t3_pw = secrets.token_urlsafe(12)

    seeds = [
        {"therapist_id": t1_id, "username": "t_alpha", "password": t1_pw, "org_id": org_a, "display_label": "Therapist Alpha"},
        {"therapist_id": t2_id, "username": "t_beta", "password": t2_pw, "org_id": org_a, "display_label": "Therapist Beta"},
        {"therapist_id": t3_id, "username": "t_gamma", "password": t3_pw, "org_id": org_b, "display_label": "Therapist Gamma"},
    ]
    monkeypatch.setenv("ELO_V3_THERAPIST_SEEDS", json.dumps(seeds))
    app = create_app(":memory:")
    client = TestClient(app)
    ctx = {
        "org_a": org_a,
        "org_b": org_b,
        "t1": {"id": t1_id, "username": "t_alpha", "password": t1_pw, "org_id": org_a},
        "t2": {"id": t2_id, "username": "t_beta", "password": t2_pw, "org_id": org_a},
        "t3": {"id": t3_id, "username": "t_gamma", "password": t3_pw, "org_id": org_b},
    }
    return app, client, ctx


def _login_therapist(client: TestClient, t_info: dict) -> str:
    r = client.post("/api/v3/auth/therapist", json={"username": t_info["username"], "password": t_info["password"]})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["token_type"] == "Bearer"
    assert data["principal"] == {"role": "therapist", "id": t_info["id"], "org_id": t_info["org_id"]}
    return data["token"]


def _create_participant_and_login(client: TestClient, t_token: str, alias: str = "Participant One", side: str = "right"):
    r = client.post(
        "/api/v3/participants",
        headers={"Authorization": f"Bearer {t_token}"},
        json={"alias": alias, "side": side},
    )
    assert r.status_code == 201, r.text
    participant = r.json()
    care_link_id = r.headers["X-Elo-Care-Link-Id"]

    inv = client.post(
        "/api/v3/invites",
        headers={"Authorization": f"Bearer {t_token}"},
        json={"participant_id": participant["entity_id"]},
    )
    assert inv.status_code == 201, inv.text
    invite_token = inv.json()["invite_token"]

    redeem = client.post("/api/v3/auth/invite", json={"invite_token": invite_token})
    assert redeem.status_code == 200, redeem.text
    p_token = redeem.json()["token"]
    return participant, care_link_id, invite_token, p_token


def _scan_db_for_substring(conn: sqlite3.Connection, needle: str) -> list[tuple[str, str]]:
    hits = []
    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    for table in tables:
        for row in conn.execute(f'SELECT * FROM "{table}"').fetchall():
            for cell in row:
                if cell is not None and needle in str(cell):
                    hits.append((table, str(cell)))
    return hits


# --- Row 1: Routes match the contract ----------------------------------------------------


def _collect_v3_routes(app) -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path, ops in app.openapi().get("paths", {}).items():
        if path.startswith("/api/v3"):
            for method in ops:
                if method.upper() not in ("HEAD", "OPTIONS"):
                    found.add((method.upper(), path))

    def _walk(routes):
        for route in routes:
            path = getattr(route, "path", "")
            if path.startswith("/api/v3"):
                for method in getattr(route, "methods", set()) or set():
                    if method not in ("HEAD", "OPTIONS"):
                        found.add((method, path))
            orig = getattr(route, "original_router", None)
            if orig is not None:
                _walk(getattr(orig, "routes", ()))

    _walk(app.routes)
    return found


def test_routes_match_api_contract(monkeypatch):
    api_doc = json.loads(API_CONTRACT_PATH.read_text(encoding="utf-8"))
    by_id = {ep["id"]: ep for ep in api_doc["endpoints"]}
    expected_routes = {(by_id[rid]["method"], by_id[rid]["path"]) for rid in S0_02_ROUTE_IDS}

    app, client, ctx = _make_seeded_app(monkeypatch)
    exposed_v3 = _collect_v3_routes(app)

    assert exposed_v3 == expected_routes

    # Role acceptance matches contract for each of the 6 routes
    t1_token = _login_therapist(client, ctx["t1"])
    participant, care_link_id, _, p_token = _create_participant_and_login(client, t1_token)

    # Anonymous routes
    assert client.get("/api/v3/health").status_code == 200
    assert client.post("/api/v3/auth/therapist", json={"username": ctx["t1"]["username"], "password": ctx["t1"]["password"]}).status_code == 200
    inv = client.post("/api/v3/invites", headers={"Authorization": f"Bearer {t1_token}"}, json={"participant_id": participant["entity_id"]})
    assert inv.status_code == 201
    assert client.post("/api/v3/auth/invite", json={"invite_token": inv.json()["invite_token"]}).status_code == 200

    # Therapist-only routes reject participant with 403 FORBIDDEN and anonymous with 401 UNAUTHENTICATED
    therapist_calls = [
        ("POST", "/api/v3/invites", {"participant_id": participant["entity_id"]}),
        ("POST", "/api/v3/participants", {"alias": "Participant Two", "side": "left"}),
        ("POST", f"/api/v3/care-links/{care_link_id}:revoke", {}),
    ]
    for method, path, payload in therapist_calls:
        _assert_error_body(client.request(method, path, json=payload), 401, "UNAUTHENTICATED")
        _assert_error_body(
            client.request(method, path, headers={"Authorization": f"Bearer {p_token}"}, json=payload),
            403,
            "FORBIDDEN",
        )


# --- Row 2: Authentication ---------------------------------------------------------------


def test_authentication_gates(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_token = _login_therapist(client, ctx["t1"])
    participant, care_link_id, _, _ = _create_participant_and_login(client, t1_token)

    # Create an expired token and a revoked token directly in SQLite
    expired_raw = secrets.token_urlsafe(32)
    past = (datetime.now(timezone.utc) - timedelta(seconds=30)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    future = (datetime.now(timezone.utc) + timedelta(seconds=3600)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    app.state.v3_store.db.execute(
        "INSERT INTO v3_tokens (token_hash, role, principal_id, org_id, expires_at, revoked, created_at) VALUES (?,?,?,?,?,0,?)",
        (sha256_token(expired_raw), "therapist", ctx["t1"]["id"], ctx["org_a"], past, past),
    )
    revoked_raw = secrets.token_urlsafe(32)
    app.state.v3_store.db.execute(
        "INSERT INTO v3_tokens (token_hash, role, principal_id, org_id, expires_at, revoked, created_at) VALUES (?,?,?,?,?,1,?)",
        (sha256_token(revoked_raw), "therapist", ctx["t1"]["id"], ctx["org_a"], future, past),
    )
    app.state.v3_store.db.commit()

    bad_headers = [
        {},
        {"Authorization": ""},
        {"Authorization": "Basic dXNlcjpwYXNz"},
        {"Authorization": "Bearer"},
        {"Authorization": "Bearer   "},
        {"Authorization": f"Bearer {secrets.token_urlsafe(32)}"},
        {"Authorization": f"Bearer {expired_raw}"},
        {"Authorization": f"Bearer {revoked_raw}"},
    ]
    authed_calls = [
        ("POST", "/api/v3/invites", {"participant_id": participant["entity_id"]}),
        ("POST", "/api/v3/participants", {"alias": "Participant X", "side": "right"}),
        ("POST", f"/api/v3/care-links/{care_link_id}:revoke", {}),
    ]
    for method, path, payload in authed_calls:
        for hdrs in bad_headers:
            _assert_error_body(client.request(method, path, headers=hdrs, json=payload), 401, "UNAUTHENTICATED")

    # Anonymous routes do not require a token
    r_health = client.get("/api/v3/health")
    assert r_health.status_code == 200
    assert r_health.json() == {"status": "ok", "versions": {"schema": 3, "catalog": "2", "contracts": "3.0.0"}}


# --- Row 3: Principal derived by the server only -----------------------------------------


def test_principal_derived_by_server_only(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_token = _login_therapist(client, ctx["t1"])
    t2_token = _login_therapist(client, ctx["t2"])
    participant, care_link_id, _, p_token = _create_participant_and_login(client, t1_token)

    spoof_query = f"?role=therapist&therapist_id={ctx['t1']['id']}&org_id={ctx['org_a']}&author_id={ctx['t1']['id']}"

    # 1. Participant spoofing therapist fields on all 3 authenticated routes -> still 403 FORBIDDEN
    spoof_headers = {"Authorization": f"Bearer {p_token}"}
    _assert_error_body(
        client.post(
            f"/api/v3/participants{spoof_query}",
            headers=spoof_headers,
            json={
                "alias": "Spoofed",
                "side": "left",
                "role": "therapist",
                "org_id": ctx["org_a"],
                "therapist_id": ctx["t1"]["id"],
                "author": {"role": "therapist", "id": ctx["t1"]["id"]},
            },
        ),
        403,
        "FORBIDDEN",
    )
    _assert_error_body(
        client.post(
            f"/api/v3/invites{spoof_query}",
            headers=spoof_headers,
            json={
                "participant_id": participant["entity_id"],
                "role": "therapist",
                "therapist_id": ctx["t1"]["id"],
                "org_id": ctx["org_a"],
            },
        ),
        403,
        "FORBIDDEN",
    )
    _assert_error_body(
        client.post(
            f"/api/v3/care-links/{care_link_id}:revoke{spoof_query}",
            headers=spoof_headers,
            json={"role": "therapist", "therapist_id": ctx["t1"]["id"], "org_id": ctx["org_a"]},
        ),
        403,
        "FORBIDDEN",
    )

    # 2. Unlinked therapist (t2) spoofing t1 on invites.create and care_links.revoke -> still 403 SCOPE_VIOLATION
    t2_headers = {"Authorization": f"Bearer {t2_token}"}
    _assert_error_body(
        client.post(
            f"/api/v3/invites{spoof_query}",
            headers=t2_headers,
            json={"participant_id": participant["entity_id"], "therapist_id": ctx["t1"]["id"], "author": {"role": "therapist", "id": ctx["t1"]["id"]}},
        ),
        403,
        "SCOPE_VIOLATION",
    )
    _assert_error_body(
        client.post(
            f"/api/v3/care-links/{care_link_id}:revoke{spoof_query}",
            headers=t2_headers,
            json={"therapist_id": ctx["t1"]["id"], "author": {"role": "therapist", "id": ctx["t1"]["id"]}},
        ),
        403,
        "SCOPE_VIOLATION",
    )

    # 3. Therapist t1 creating participant with spoofed org_id/author/therapist_id -> stored entities use server principal
    r = client.post(
        f"/api/v3/participants?org_id={ctx['org_b']}&therapist_id={ctx['t3']['id']}",
        headers={"Authorization": f"Bearer {t1_token}"},
        json={
            "alias": "Clean Alias",
            "side": "right",
            "role": "participant",
            "org_id": ctx["org_b"],
            "therapist_id": ctx["t3"]["id"],
            "author": {"role": "therapist", "id": ctx["t3"]["id"]},
        },
    )
    assert r.status_code == 201, r.text
    p_ent = r.json()
    cl_id = r.headers["X-Elo-Care-Link-Id"]
    cl_ent = app.state.v3_store.get_latest_entity(cl_id)
    assert p_ent["org_id"] == ctx["org_a"]
    assert p_ent["author"] == {"role": "therapist", "id": ctx["t1"]["id"]}
    assert cl_ent is not None
    assert cl_ent["org_id"] == ctx["org_a"]
    assert cl_ent["author"] == {"role": "therapist", "id": ctx["t1"]["id"]}
    assert cl_ent["payload"]["therapist_id"] == ctx["t1"]["id"]


# --- Row 4: Tokens and invites -----------------------------------------------------------


def test_tokens_and_invites_entropy_hashing_lifecycle(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_token = _login_therapist(client, ctx["t1"])
    participant, _, invite_token, p_token = _create_participant_and_login(client, t1_token)

    # Entropy >= 128 bits (base64url decoded >= 16 bytes; implementation uses 32 bytes = 256 bits)
    for raw in (t1_token, invite_token, p_token):
        padded = raw + "=" * (-len(raw) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
        assert len(decoded) >= 16

    # Database holds ONLY sha256 hashes; zero occurrences of raw tokens across all tables
    for raw in (t1_token, invite_token, p_token):
        assert _scan_db_for_substring(app.state.v3_store.db, raw) == []

    # Single-use invite: 2nd redemption fails with 401 INVITE_INVALID
    _assert_error_body(client.post("/api/v3/auth/invite", json={"invite_token": invite_token}), 401, "INVITE_INVALID")

    # Unknown invite -> 401 INVITE_INVALID
    _assert_error_body(
        client.post("/api/v3/auth/invite", json={"invite_token": secrets.token_urlsafe(32)}),
        401,
        "INVITE_INVALID",
    )

    # Expired invite -> 401 INVITE_INVALID
    inv_exp = client.post(
        "/api/v3/invites",
        headers={"Authorization": f"Bearer {t1_token}"},
        json={"participant_id": participant["entity_id"]},
    )
    assert inv_exp.status_code == 201
    exp_raw = inv_exp.json()["invite_token"]
    past = (datetime.now(timezone.utc) - timedelta(seconds=10)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    app.state.v3_store.db.execute("UPDATE v3_invites SET expires_at = ? WHERE invite_hash = ?", (past, sha256_token(exp_raw)))
    app.state.v3_store.db.commit()
    _assert_error_body(client.post("/api/v3/auth/invite", json={"invite_token": exp_raw}), 401, "INVITE_INVALID")

    # Revoked invite -> 401 INVITE_INVALID
    inv_rev = client.post(
        "/api/v3/invites",
        headers={"Authorization": f"Bearer {t1_token}"},
        json={"participant_id": participant["entity_id"]},
    )
    assert inv_rev.status_code == 201
    rev_raw = inv_rev.json()["invite_token"]
    app.state.v3_store.revoke_invite_by_hash(sha256_token(rev_raw))
    _assert_error_body(client.post("/api/v3/auth/invite", json={"invite_token": rev_raw}), 401, "INVITE_INVALID")


# --- Row 5: Credentials ------------------------------------------------------------------


def test_credentials_kdf_salts_and_env_seeding(monkeypatch):
    shared_pw = secrets.token_urlsafe(12)
    org_a = new_id("o")
    seeds = [
        {"therapist_id": new_id("t"), "username": "t_same1", "password": shared_pw, "org_id": org_a, "display_label": "Seed One"},
        {"therapist_id": new_id("t"), "username": "t_same2", "password": shared_pw, "org_id": org_a, "display_label": "Seed Two"},
    ]
    monkeypatch.setenv("ELO_V3_THERAPIST_SEEDS", json.dumps(seeds))
    app = create_app(":memory:")
    client = TestClient(app)

    # Zero plaintext passwords in DB
    assert _scan_db_for_substring(app.state.v3_store.db, shared_pw) == []

    rows = app.state.v3_store.db.execute("SELECT kdf, salt_hex, hash_hex FROM v3_therapist_credentials").fetchall()
    assert len(rows) == 2
    assert rows[0][0].startswith("scrypt:")
    assert rows[1][0].startswith("scrypt:")
    assert len(bytes.fromhex(rows[0][1])) >= 16
    assert rows[0][1] != rows[1][1]  # per-credential salt
    assert rows[0][2] != rows[1][2]  # distinct hashes for identical password

    # Valid login works; wrong password rejected with 401 UNAUTHENTICATED
    assert client.post("/api/v3/auth/therapist", json={"username": "t_same1", "password": shared_pw}).status_code == 200
    _assert_error_body(
        client.post("/api/v3/auth/therapist", json={"username": "t_same1", "password": shared_pw + "_wrong"}),
        401,
        "UNAUTHENTICATED",
    )


# --- Row 6: Only two roles (PD-08) -------------------------------------------------------


@pytest.mark.parametrize("bad_role", ["caregiver", "supervisor", "admin", "", "companion", "acompanhante", "superuser"])
def test_only_two_roles_pd08(monkeypatch, bad_role):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_token = _login_therapist(client, ctx["t1"])
    participant, care_link_id, _, _ = _create_participant_and_login(client, t1_token)

    forged_raw = secrets.token_urlsafe(32)
    future = (datetime.now(timezone.utc) + timedelta(seconds=3600)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    app.state.v3_store.db.execute(
        "INSERT INTO v3_tokens (token_hash, role, principal_id, org_id, expires_at, revoked, created_at) VALUES (?,?,?,?,?,0,?)",
        (sha256_token(forged_raw), bad_role, new_id("t"), ctx["org_a"], future, now),
    )
    app.state.v3_store.db.commit()

    hdrs = {"Authorization": f"Bearer {forged_raw}"}
    _assert_error_body(client.post("/api/v3/invites", headers=hdrs, json={"participant_id": participant["entity_id"]}), 403, "ROLE_NOT_ALLOWED")
    _assert_error_body(client.post("/api/v3/participants", headers=hdrs, json={"alias": "Forged", "side": "left"}), 403, "ROLE_NOT_ALLOWED")
    _assert_error_body(client.post(f"/api/v3/care-links/{care_link_id}:revoke", headers=hdrs, json={}), 403, "ROLE_NOT_ALLOWED")


# --- Row 7: Matrix fully mapped ----------------------------------------------------------


def test_matrix_fully_mapped():
    matrix = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
    rows = matrix["rows"]
    assert len(rows) == 27
    matrix_keys = {(r["resource"], r["action"]) for r in rows}
    assert len(matrix_keys) == len(rows), "duplicate (resource, action) in MATRIX"

    # Every row in MATRIX must be present in POLICY_MATRIX for both roles (and no drift)
    for r in rows:
        key = (r["resource"], r["action"])
        assert key in POLICY_MATRIX, f"Unmapped MATRIX row: {key}"
        assert set(POLICY_MATRIX[key].keys()) == set(ALLOWED_ROLES), f"Missing role entry for {key}"
    assert set(POLICY_MATRIX.keys()) == matrix_keys


# --- Row 8 & Row 18: Policy outcomes for all 27 MATRIX rows ------------------------------

ORG_A = "o_1111111111111111"
ORG_B = "o_2222222222222222"
P_OWN = Principal(role="participant", id="p_1111111111111111", org_id=ORG_A)
P_OTHER = Principal(role="participant", id="p_2222222222222222", org_id=ORG_A)
P_ORG_B = Principal(role="participant", id="p_3333333333333333", org_id=ORG_B)
T_LINKED = Principal(role="therapist", id="t_1111111111111111", org_id=ORG_A)
T_UNLINKED = Principal(role="therapist", id="t_2222222222222222", org_id=ORG_A)
T_ORG_B = Principal(role="therapist", id="t_3333333333333333", org_id=ORG_B)

ACTIVE_LINK = CareLinkView(
    entity_id="cl_1111111111111111",
    org_id=ORG_A,
    participant_id=P_OWN.id,
    therapist_id=T_LINKED.id,
    status="active",
    valid_from="2026-01-10",
    valid_to="2026-12-20",
)
REVOKED_LINK = CareLinkView(
    entity_id="cl_1111111111111111",
    org_id=ORG_A,
    participant_id=P_OWN.id,
    therapist_id=T_LINKED.id,
    status="revoked",
    valid_from="2026-01-10",
    valid_to="2026-12-20",
)
OTHER_ORG_LINK = CareLinkView(
    entity_id="cl_2222222222222222",
    org_id=ORG_B,
    participant_id=P_OWN.id,
    therapist_id=T_LINKED.id,
    status="active",
    valid_from="2026-01-10",
    valid_to="2026-12-20",
)
AS_OF_VALID = date(2026, 6, 15)
AS_OF_BEFORE = date(2026, 1, 9)
AS_OF_AFTER = date(2026, 12, 21)

PARTICIPANT_DENY_ROWS = [
    ("participant (entity)", "create"),
    ("care_link", "create/revoke"),
    ("functional_assessment", "create/revise"),
    ("functional_assessment", "read"),
    ("goal", "create/revise/confirm"),
    ("encounter", "create"),
    ("encounter", "read"),
    ("reassessment", "create/read"),
    ("instrumental_measurement", "create/read"),
    ("prescription", "publish"),
    ("event: prescription/review/summary/evolution/privacy", "append"),
    ("fact", "read/verify/evidence"),
    ("review", "record"),
    ("summary", "publish"),
    ("evolution", "series read / publish"),
    ("timeline", "read"),
]

PARTICIPANT_OWN_ROWS = [
    ("participant (entity)", "read"),
    ("care_link", "read"),
    ("goal", "read"),
    ("prescription", "read"),
    ("summary", "read"),
    ("evolution", "read published"),
]

THERAPIST_LINKED_ROWS = [
    ("participant (entity)", "read"),
    ("care_link", "read"),
    ("functional_assessment", "create/revise"),
    ("functional_assessment", "read"),
    ("goal", "create/revise/confirm"),
    ("goal", "read"),
    ("encounter", "create"),
    ("encounter", "read"),
    ("reassessment", "create/read"),
    ("instrumental_measurement", "create/read"),
    ("prescription", "publish"),
    ("prescription", "read"),
    ("fact", "read/verify/evidence"),
    ("review", "record"),
    ("summary", "publish"),
    ("summary", "read"),
    ("evolution", "series read / publish"),
    ("evolution", "read published"),
    ("timeline", "read"),
]


@pytest.mark.parametrize("resource,action", PARTICIPANT_DENY_ROWS)
def test_policy_participant_deny_rows(resource, action):
    d = authorize(P_OWN, resource, action, AuthzScope(participant_id=P_OWN.id, org_id=ORG_A))
    assert not d.allowed
    assert d.code == "FORBIDDEN"
    assert d.http_status == 403


@pytest.mark.parametrize("resource,action", PARTICIPANT_OWN_ROWS)
def test_policy_participant_own_rows(resource, action):
    # Own -> allow
    d_ok = authorize(P_OWN, resource, action, AuthzScope(participant_id=P_OWN.id, org_id=ORG_A))
    assert d_ok.allowed

    # Other participant -> SCOPE_VIOLATION (list/write) or NOT_FOUND (read by id)
    d_other = authorize(P_OTHER, resource, action, AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, is_read_by_id=False))
    assert not d_other.allowed and d_other.code == "SCOPE_VIOLATION" and d_other.http_status == 403

    d_other_id = authorize(P_OTHER, resource, action, AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, is_read_by_id=True))
    assert not d_other_id.allowed and d_other_id.code == "NOT_FOUND" and d_other_id.http_status == 404

    # Other org -> SCOPE_VIOLATION / NOT_FOUND
    d_org = authorize(P_ORG_B, resource, action, AuthzScope(participant_id=P_ORG_B.id, org_id=ORG_A, is_read_by_id=False))
    assert not d_org.allowed and d_org.code == "SCOPE_VIOLATION"


@pytest.mark.parametrize("resource,action", THERAPIST_LINKED_ROWS)
def test_policy_therapist_linked_rows(resource, action):
    scope_ok = AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, as_of=AS_OF_VALID)
    # Active link in same org within validity window -> allow
    assert authorize(T_LINKED, resource, action, scope_ok, links=[ACTIVE_LINK]).allowed

    # No link -> SCOPE_VIOLATION
    d_none = authorize(T_LINKED, resource, action, scope_ok, links=[])
    assert not d_none.allowed and d_none.code == "SCOPE_VIOLATION" and d_none.http_status == 403

    # Unlinked therapist -> SCOPE_VIOLATION (or NOT_FOUND on read-by-id)
    d_unlinked = authorize(T_UNLINKED, resource, action, scope_ok, links=[ACTIVE_LINK])
    assert not d_unlinked.allowed and d_unlinked.code == "SCOPE_VIOLATION"
    d_unlinked_id = authorize(
        T_UNLINKED,
        resource,
        action,
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, as_of=AS_OF_VALID, is_read_by_id=True),
        links=[ACTIVE_LINK],
    )
    assert not d_unlinked_id.allowed and d_unlinked_id.code == "NOT_FOUND" and d_unlinked_id.http_status == 404

    # Revoked link -> SCOPE_VIOLATION
    d_rev = authorize(T_LINKED, resource, action, scope_ok, links=[REVOKED_LINK])
    assert not d_rev.allowed and d_rev.code == "SCOPE_VIOLATION"

    # Link in another org -> SCOPE_VIOLATION
    d_org_link = authorize(T_LINKED, resource, action, scope_ok, links=[OTHER_ORG_LINK])
    assert not d_org_link.allowed and d_org_link.code == "SCOPE_VIOLATION"
    d_other_org_t = authorize(T_ORG_B, resource, action, scope_ok, links=[ACTIVE_LINK])
    assert not d_other_org_t.allowed and d_other_org_t.code == "SCOPE_VIOLATION"

    # Date outside valid_from / valid_to -> SCOPE_VIOLATION
    d_before = authorize(T_LINKED, resource, action, AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, as_of=AS_OF_BEFORE), links=[ACTIVE_LINK])
    assert not d_before.allowed and d_before.code == "SCOPE_VIOLATION"
    d_after = authorize(T_LINKED, resource, action, AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, as_of=AS_OF_AFTER), links=[ACTIVE_LINK])
    assert not d_after.allowed and d_after.code == "SCOPE_VIOLATION"


def test_policy_special_rows_cover_all_remaining_matrix_entries():
    # Row 1: participant (entity) create -> therapist allow
    assert authorize(T_LINKED, "participant (entity)", "create", AuthzScope(org_id=ORG_A)).allowed

    # Row 3: care_link create/revoke -> therapist party allow; non-party or other org -> SCOPE_VIOLATION
    assert authorize(T_LINKED, "care_link", "create/revoke", AuthzScope(org_id=ORG_A, link_therapist_id=T_LINKED.id)).allowed
    d_non_party = authorize(T_UNLINKED, "care_link", "create/revoke", AuthzScope(org_id=ORG_A, link_therapist_id=T_LINKED.id))
    assert not d_non_party.allowed and d_non_party.code == "SCOPE_VIOLATION"
    d_other_org = authorize(T_ORG_B, "care_link", "create/revoke", AuthzScope(org_id=ORG_A, link_therapist_id=T_ORG_B.id))
    assert not d_other_org.allowed and d_other_org.code == "SCOPE_VIOLATION"

    # Row 15: draft (author-only; participant limited to session_report_proposal)
    assert authorize(
        P_OWN,
        "draft",
        "create/read/confirm/discard",
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, author_id=P_OWN.id, draft_kind="session_report_proposal"),
    ).allowed
    d_bad_kind = authorize(
        P_OWN,
        "draft",
        "create/read/confirm/discard",
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, author_id=P_OWN.id, draft_kind="clinical_note"),
    )
    assert not d_bad_kind.allowed and d_bad_kind.code == "FORBIDDEN"
    d_other_author_p = authorize(
        P_OWN,
        "draft",
        "create/read/confirm/discard",
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, author_id=T_LINKED.id, draft_kind="session_report_proposal", is_read_by_id=True),
    )
    assert not d_other_author_p.allowed and d_other_author_p.code == "NOT_FOUND"

    assert authorize(
        T_LINKED,
        "draft",
        "create/read/confirm/discard",
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, author_id=T_LINKED.id),
        links=[ACTIVE_LINK],
    ).allowed
    d_other_author_t = authorize(
        T_UNLINKED,
        "draft",
        "create/read/confirm/discard",
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, author_id=T_LINKED.id, is_read_by_id=True),
        links=[ACTIVE_LINK],
    )
    assert not d_other_author_t.allowed and d_other_author_t.code == "NOT_FOUND"

    # Row 16: client-authored events -> participant own (actor = principal); therapist -> FORBIDDEN
    assert authorize(
        P_OWN,
        "event: session/capture/report/consent",
        "append",
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, actor_id=P_OWN.id),
    ).allowed
    d_wrong_actor = authorize(
        P_OWN,
        "event: session/capture/report/consent",
        "append",
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, actor_id=P_OTHER.id),
    )
    assert not d_wrong_actor.allowed and d_wrong_actor.code == "SCOPE_VIOLATION"
    d_wrong_pid = authorize(
        P_OTHER,
        "event: session/capture/report/consent",
        "append",
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, actor_id=P_OTHER.id),
    )
    assert not d_wrong_pid.allowed and d_wrong_pid.code == "SCOPE_VIOLATION"
    d_therapist_client_evt = authorize(
        T_LINKED,
        "event: session/capture/report/consent",
        "append",
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, actor_id=T_LINKED.id),
        links=[ACTIVE_LINK],
    )
    assert not d_therapist_client_evt.allowed and d_therapist_client_evt.code == "FORBIDDEN"

    # Row 17: server-authored events -> never client-authored; linked therapist server-authored allow
    assert authorize(
        T_LINKED,
        "event: prescription/review/summary/evolution/privacy",
        "append",
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, client_authored=False, as_of=AS_OF_VALID),
        links=[ACTIVE_LINK],
    ).allowed
    d_client_authored = authorize(
        T_LINKED,
        "event: prescription/review/summary/evolution/privacy",
        "append",
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, client_authored=True, as_of=AS_OF_VALID),
        links=[ACTIVE_LINK],
    )
    assert not d_client_authored.allowed and d_client_authored.code == "FORBIDDEN"
    d_unlinked_srv = authorize(
        T_UNLINKED,
        "event: prescription/review/summary/evolution/privacy",
        "append",
        AuthzScope(participant_id=P_OWN.id, org_id=ORG_A, client_authored=False, as_of=AS_OF_VALID),
        links=[ACTIVE_LINK],
    )
    assert not d_unlinked_srv.allowed and d_unlinked_srv.code == "SCOPE_VIOLATION"

    # Row 25: health -> anonymous, participant, therapist all allowed
    assert authorize(None, "health", "read").allowed
    assert authorize(P_OWN, "health", "read").allowed
    assert authorize(T_LINKED, "health", "read").allowed

    # Row 26: any resource / any (PD-08)
    assert authorize(None, "any resource", "any").code == "UNAUTHENTICATED"
    for bad in ("caregiver", "supervisor", "admin", ""):
        d_bad = authorize(Principal(role=bad, id="x_1111111111111111", org_id=ORG_A), "any resource", "any")
        assert not d_bad.allowed and d_bad.code == "ROLE_NOT_ALLOWED" and d_bad.http_status == 403
    assert authorize(P_OWN, "any resource", "any").allowed
    assert authorize(T_LINKED, "any resource", "any").allowed

    # Row 27: companion / acompanhante -> no profile (FORBIDDEN for allowed roles; ROLE_NOT_ALLOWED for companion role)
    assert authorize(P_OWN, "companion / acompanhante", "any").code == "FORBIDDEN"
    assert authorize(T_LINKED, "companion / acompanhante", "any").code == "FORBIDDEN"
    assert authorize(Principal(role="companion", id="c_1111111111111111", org_id=ORG_A), "companion / acompanhante", "any").code == "ROLE_NOT_ALLOWED"


# --- Row 9: participants.create ----------------------------------------------------------


def test_participants_create(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_token = _login_therapist(client, ctx["t1"])

    # No token -> 401 UNAUTHENTICATED
    _assert_error_body(client.post("/api/v3/participants", json={"alias": "Anon", "side": "left"}), 401, "UNAUTHENTICATED")

    # Therapist creates participant v1 + care_link v1 (status=active, same org, therapist=principal)
    r = client.post(
        "/api/v3/participants",
        headers={"Authorization": f"Bearer {t1_token}"},
        json={"alias": "Participant Alpha", "side": "left"},
    )
    assert r.status_code == 201, r.text
    p_ent = r.json()
    cl_id = r.headers["X-Elo-Care-Link-Id"]
    assert p_ent["entity_type"] == "participant"
    assert p_ent["version"] == 1
    assert p_ent["prev_hash"] is None
    assert p_ent["org_id"] == ctx["org_a"]
    assert p_ent["participant_id"] == p_ent["entity_id"]
    assert p_ent["author"] == {"role": "therapist", "id": ctx["t1"]["id"]}
    assert p_ent["payload"] == {"alias": "Participant Alpha", "side": "left"}

    cl_versions = app.state.v3_store.get_entity_versions(cl_id)
    assert len(cl_versions) == 1
    cl_v1 = cl_versions[0]
    assert cl_v1["entity_type"] == "care_link"
    assert cl_v1["version"] == 1
    assert cl_v1["prev_hash"] is None
    assert cl_v1["org_id"] == ctx["org_a"]
    assert cl_v1["participant_id"] == p_ent["entity_id"]
    assert cl_v1["payload"]["therapist_id"] == ctx["t1"]["id"]
    assert cl_v1["payload"]["status"] == "active"

    # Participant -> 403 FORBIDDEN
    _, _, _, p_token = _create_participant_and_login(client, t1_token)
    _assert_error_body(
        client.post("/api/v3/participants", headers={"Authorization": f"Bearer {p_token}"}, json={"alias": "Blocked", "side": "right"}),
        403,
        "FORBIDDEN",
    )


# --- Row 10: care_links.revoke -----------------------------------------------------------


def test_care_links_revoke(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_token = _login_therapist(client, ctx["t1"])
    t2_token = _login_therapist(client, ctx["t2"])
    t3_token = _login_therapist(client, ctx["t3"])
    participant, care_link_id, _, p_token = _create_participant_and_login(client, t1_token)
    v1 = app.state.v3_store.get_entity_versions(care_link_id)[0]

    # Participant -> 403 FORBIDDEN
    _assert_error_body(
        client.post(f"/api/v3/care-links/{care_link_id}:revoke", headers={"Authorization": f"Bearer {p_token}"}, json={}),
        403,
        "FORBIDDEN",
    )
    # Non-party therapist (same org) -> 403 SCOPE_VIOLATION
    _assert_error_body(
        client.post(f"/api/v3/care-links/{care_link_id}:revoke", headers={"Authorization": f"Bearer {t2_token}"}, json={}),
        403,
        "SCOPE_VIOLATION",
    )
    # Non-party therapist (other org) -> 403 SCOPE_VIOLATION
    _assert_error_body(
        client.post(f"/api/v3/care-links/{care_link_id}:revoke", headers={"Authorization": f"Bearer {t3_token}"}, json={}),
        403,
        "SCOPE_VIOLATION",
    )
    # Unknown care_link -> 404 NOT_FOUND
    _assert_error_body(
        client.post(f"/api/v3/care-links/{new_id('cl')}:revoke", headers={"Authorization": f"Bearer {t1_token}"}, json={}),
        404,
        "NOT_FOUND",
    )

    # Party therapist revokes -> 200 with care_link v2 (status=revoked, prev_hash=v1.hash)
    rev = client.post(f"/api/v3/care-links/{care_link_id}:revoke", headers={"Authorization": f"Bearer {t1_token}"}, json={})
    assert rev.status_code == 200, rev.text
    v2 = rev.json()
    assert v2["entity_id"] == care_link_id
    assert v2["version"] == 2
    assert v2["prev_hash"] == v1["hash"]
    assert v2["payload"]["status"] == "revoked"

    # Both v1 and v2 are preserved in DB
    versions = app.state.v3_store.get_entity_versions(care_link_id)
    assert len(versions) == 2
    assert versions[0]["payload"]["status"] == "active"
    assert versions[1]["payload"]["status"] == "revoked"

    # Afterwards therapist's linked access to the participant is denied (policy AND HTTP invites.create)
    links = app.state.v3_store.latest_care_links(participant_id=participant["entity_id"])
    t1_principal = Principal(role="therapist", id=ctx["t1"]["id"], org_id=ctx["org_a"])
    d = authorize(t1_principal, "participant (entity)", "read", AuthzScope(participant_id=participant["entity_id"], org_id=ctx["org_a"]), links=links)
    assert not d.allowed and d.code == "SCOPE_VIOLATION"
    _assert_error_body(
        client.post("/api/v3/invites", headers={"Authorization": f"Bearer {t1_token}"}, json={"participant_id": participant["entity_id"]}),
        403,
        "SCOPE_VIOLATION",
    )

    # Second revoke -> 409 CONFLICT_IMMUTABLE (documented in REPORT, never 200)
    _assert_error_body(
        client.post(f"/api/v3/care-links/{care_link_id}:revoke", headers={"Authorization": f"Bearer {t1_token}"}, json={}),
        409,
        "CONFLICT_IMMUTABLE",
    )


# --- Row 11: Entities conform to CL06.3 --------------------------------------------------


def test_entities_conform_to_cl06_3(monkeypatch):
    ref = _load_ref_module()
    cat = json.loads(EVENT_CATALOG_PATH.read_text(encoding="utf-8"))
    schemas = {
        et: json.loads((CONTRACTS_R1 / "schemas" / "entities" / f"{et}.schema.json").read_text(encoding="utf-8"))
        for et in ("therapist", "participant", "care_link")
    }

    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_token = _login_therapist(client, ctx["t1"])
    participant, care_link_id, _, _ = _create_participant_and_login(client, t1_token, alias="Conformity P1", side="right")
    r_rev = client.post(f"/api/v3/care-links/{care_link_id}:revoke", headers={"Authorization": f"Bearer {t1_token}"}, json={})
    assert r_rev.status_code == 200

    # Validate every stored participant, therapist, and care_link version against REF + jsonschema
    rows = app.state.v3_store.db.execute("SELECT entity_id, entity_type, data FROM v3_entities ORDER BY entity_id, version").fetchall()
    by_entity: dict[str, list[dict]] = {}
    for eid, etype, raw in rows:
        ent = json.loads(raw)
        by_entity.setdefault(eid, []).append(ent)
        schema = schemas[etype]
        assert ref.validate(schema, ent) == [], f"REF.validate failed for {eid}: {ref.validate(schema, ent)}"
        jsonschema.validate(instance=ent, schema=schema)
        assert ent["hash"] == ref.compute_entity_hash(ent)
        assert ent["hash"] == compute_entity_hash(ent)
        assert ref.check_entity_semantics(ent, cat, real_data_gate_open=False) == []

    # Check ID regex patterns explicitly
    assert re.fullmatch(r"^p_[A-Za-z0-9-]{8,64}$", participant["entity_id"])
    assert re.fullmatch(r"^cl_[A-Za-z0-9-]{8,64}$", care_link_id)

    # Check entity chains via REF
    for eid, versions in by_entity.items():
        assert ref.check_entity_chain(versions) == [], f"chain failed for {eid}"
    assert len(by_entity[care_link_id]) == 2

    # Append-only DB triggers prevent UPDATE/DELETE on v3_entities
    with pytest.raises(sqlite3.IntegrityError):
        app.state.v3_store.db.execute("UPDATE v3_entities SET data = '{}' WHERE entity_id = ?", (care_link_id,))
    with pytest.raises(sqlite3.IntegrityError):
        app.state.v3_store.db.execute("DELETE FROM v3_entities WHERE entity_id = ?", (care_link_id,))


# --- Row 12: data_origin assigned by the server ------------------------------------------


def test_data_origin_server_assigned_and_live_gate(monkeypatch):
    # 1. Request body data_origin="live" is rejected while gate is closed; other body data_origin is ignored
    app, client, ctx = _make_seeded_app(monkeypatch, data_origin="synthetic_fixture", real_data_gate_open=False)
    t1_token = _login_therapist(client, ctx["t1"])
    hdrs = {"Authorization": f"Bearer {t1_token}"}

    _assert_error_body(
        client.post("/api/v3/participants", headers=hdrs, json={"alias": "Live Attempt", "side": "left", "data_origin": "live"}),
        403,
        "REAL_DATA_GATE_CLOSED",
    )
    _assert_error_body(
        client.post("/api/v3/participants", headers=hdrs, json={"payload": {"alias": "Live Nested", "side": "left", "data_origin": "live"}}),
        403,
        "REAL_DATA_GATE_CLOSED",
    )

    # Non-live body data_origin is ignored in favor of server-configured data_origin
    r_ok = client.post(
        "/api/v3/participants",
        headers=hdrs,
        json={"alias": "Ignored Origin", "side": "right", "data_origin": "imported_v1"},
    )
    assert r_ok.status_code == 201
    assert r_ok.json()["data_origin"] == "synthetic_fixture"
    cl_ent = app.state.v3_store.get_latest_entity(r_ok.headers["X-Elo-Care-Link-Id"])
    assert cl_ent is not None and cl_ent["data_origin"] == "synthetic_fixture"

    # 2. Server config data_origin="live" while real-data gate is closed -> rejected with 403 REAL_DATA_GATE_CLOSED
    app_live, client_live, ctx_live = _make_seeded_app(monkeypatch, data_origin="live", real_data_gate_open=False)
    t1_live_token = _login_therapist(client_live, ctx_live["t1"])
    _assert_error_body(
        client_live.post(
            "/api/v3/participants",
            headers={"Authorization": f"Bearer {t1_live_token}"},
            json={"alias": "Config Live", "side": "left"},
        ),
        403,
        "REAL_DATA_GATE_CLOSED",
    )
    # No participant or care_link was persisted
    stored_p = app_live.state.v3_store.db.execute("SELECT COUNT(*) FROM v3_entities WHERE entity_type IN ('participant', 'care_link')").fetchone()[0]
    assert stored_p == 0


# --- Row 13: Error bodies and codes ------------------------------------------------------


def test_error_bodies_and_codes_match_catalog():
    codes_doc = json.loads(ERROR_CODES_PATH.read_text(encoding="utf-8"))
    catalog_map = {code: meta["http"] for code, meta in codes_doc["codes"].items()}

    assert len(EMITTABLE_ERROR_CODES) > 0
    for code, http_status in EMITTABLE_ERROR_CODES.items():
        assert code in catalog_map, f"Emittable code {code} missing from error-codes.v3.json"
        assert catalog_map[code] == http_status, f"HTTP mismatch for {code}: {http_status} != {catalog_map[code]}"
        resp = error_response(V3Error(code, f"Synthetic message for {code}"))
        assert resp.status_code == http_status
        parsed = json.loads(resp.body.decode("utf-8"))
        assert set(parsed.keys()) == {"error"}
        assert parsed["error"]["code"] == code
        assert isinstance(parsed["error"]["message"], str)


# --- Row 14: Legacy v1 ELO_ACCESS_TOKEN coexistence --------------------------------------


def test_legacy_access_token_coexistence(monkeypatch):
    legacy_secret = secrets.token_urlsafe(12)
    monkeypatch.setenv("ELO_ACCESS_TOKEN", legacy_secret)
    monkeypatch.delenv("ELO_V3_THERAPIST_SEEDS", raising=False)
    app = create_app(":memory:")
    client = TestClient(app)

    # Legacy v1 still enforces x-access-token
    assert client.get("/api/cases").status_code == 401
    assert client.get("/api/cases", headers={"x-access-token": legacy_secret}).status_code == 200

    # /api/v3 uses v3 Bearer auth (not legacy x-access-token) and returns v3 error_body
    assert client.get("/api/v3/health").status_code == 200
    _assert_error_body(client.post("/api/v3/participants", json={"alias": "NoAuth", "side": "left"}), 401, "UNAUTHENTICATED")


# --- D-S0-02-3 / F1: unknown entity/participant IDs -> 404 NOT_FOUND ---------------------


def test_unknown_ids_return_404_while_preserving_scope_and_role_denials(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_token = _login_therapist(client, ctx["t1"])
    t2_token = _login_therapist(client, ctx["t2"])
    t3_token = _login_therapist(client, ctx["t3"])
    participant, care_link_id, _, p_token = _create_participant_and_login(client, t1_token)

    before_invites = app.state.v3_store.db.execute("SELECT COUNT(*) FROM v3_invites").fetchone()[0]

    # 1. invites.create with unknown participant_id -> 404 NOT_FOUND (no invite created)
    for unknown_pid in ("p_nonexistent0001", new_id("p")):
        _assert_error_body(
            client.post("/api/v3/invites", headers={"Authorization": f"Bearer {t1_token}"}, json={"participant_id": unknown_pid}),
            404,
            "NOT_FOUND",
        )
    after_invites = app.state.v3_store.db.execute("SELECT COUNT(*) FROM v3_invites").fetchone()[0]
    assert after_invites == before_invites

    # 2. invites.create by participant with unknown participant_id -> still 403 FORBIDDEN
    _assert_error_body(
        client.post("/api/v3/invites", headers={"Authorization": f"Bearer {p_token}"}, json={"participant_id": "p_nonexistent0001"}),
        403,
        "FORBIDDEN",
    )

    # 3. invites.create for existing participant: unlinked (same org) and foreign-org -> 403 SCOPE_VIOLATION
    _assert_error_body(
        client.post("/api/v3/invites", headers={"Authorization": f"Bearer {t2_token}"}, json={"participant_id": participant["entity_id"]}),
        403,
        "SCOPE_VIOLATION",
    )
    _assert_error_body(
        client.post("/api/v3/invites", headers={"Authorization": f"Bearer {t3_token}"}, json={"participant_id": participant["entity_id"]}),
        403,
        "SCOPE_VIOLATION",
    )

    # 4. care_links.revoke with unknown care_link id (or non-care_link entity id) -> 404 NOT_FOUND; participant -> 403 FORBIDDEN
    for unknown_cl in ("cl_nonexistent0001", new_id("cl"), participant["entity_id"]):
        _assert_error_body(
            client.post(f"/api/v3/care-links/{unknown_cl}:revoke", headers={"Authorization": f"Bearer {t1_token}"}, json={}),
            404,
            "NOT_FOUND",
        )
    _assert_error_body(
        client.post("/api/v3/care-links/cl_nonexistent0001:revoke", headers={"Authorization": f"Bearer {p_token}"}, json={}),
        403,
        "FORBIDDEN",
    )

    # 5. Revoked link preserves 403 SCOPE_VIOLATION on invites.create
    assert client.post(f"/api/v3/care-links/{care_link_id}:revoke", headers={"Authorization": f"Bearer {t1_token}"}, json={}).status_code == 200
    _assert_error_body(
        client.post("/api/v3/invites", headers={"Authorization": f"Bearer {t1_token}"}, json={"participant_id": participant["entity_id"]}),
        403,
        "SCOPE_VIOLATION",
    )
