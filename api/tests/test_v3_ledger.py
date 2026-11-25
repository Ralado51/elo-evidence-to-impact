"""Tests for S0-04: CL06.3 append-only event ledger, events:batch, and entities.versions.

Covers ACCEPTANCE rows 1-19 (row 20 is the Verifier's independent ledger differential harness).
All test credentials and identifiers are synthetic and generated at runtime.
"""

from __future__ import annotations

import ast
import copy
import importlib.util
import json
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from elo.api import create_app
from elo.canonical import canonicalize, compute_event_hash, compute_event_id
from elo.v3.entities import build_entity, new_id
from elo.v3.errors import EMITTABLE_ERROR_CODES
from elo.v3.store import V3Store, sha256_token

REPO_ROOT = Path(__file__).resolve().parents[2]
PKG = REPO_ROOT / "contracts" / "CL06_3-r1"
CONTRACTS = PKG / "contracts"
API_CONTRACT_PATH = CONTRACTS / "api" / "api-contract.v3.json"
ERROR_CODES_PATH = CONTRACTS / "catalogs" / "error-codes.v3.json"
LEDGER_PATH = PKG / "fixtures" / "valid" / "ledger.v3.json"
INVALID_PATH = PKG / "fixtures" / "invalid" / "contract-invalid.v3.json"
LEGACY_PATH = PKG / "legacy_cl06_1_reference" / "ledger.json"
REF_PY_PATH = PKG / "reference" / "python" / "elo_ref.py"

S0_04_ROUTE_IDS = {
    "health",
    "auth.therapist",
    "invites.create",
    "auth.invite",
    "participants.create",
    "care_links.revoke",
    "events.batch",
    "entities.versions",
}


def _load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _load_ref():
    spec = importlib.util.spec_from_file_location("s0_04_cl06_3_elo_ref", REF_PY_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _rehash(ev: dict) -> dict:
    e = copy.deepcopy(ev)
    e["event_id"] = compute_event_id(e["stream_id"], e["seq"])
    e["hash"] = compute_event_hash(e)
    return e


def _make_consent_event(
    *,
    org_id: str,
    participant_id: str,
    seq: int,
    prev_hash: str | None,
    kind: str = "consent.accepted",
    scopes: list[str] | None = None,
    data_origin: str = "synthetic_fixture",
    occurred_at: str = "2026-11-25T10:00:00.000Z",
    origin_ref: str | None = None,
    execution_mode: str = "not_applicable",
    actor_role: str = "participant",
    actor_id: str | None = None,
    scope_participant_id: str | None = None,
    scope_org_id: str | None = None,
) -> dict:
    spid = scope_participant_id or participant_id
    ev = {
        "event_id": "",
        "schema_version": 3,
        "type": kind,
        "stream_id": f"consent:{spid}",
        "seq": seq,
        "prev_hash": prev_hash,
        "occurred_at": occurred_at,
        "actor": {"role": actor_role, "id": actor_id or participant_id},
        "scope": {"org_id": scope_org_id or org_id, "participant_id": spid},
        "source": {"type": "participant_report"},
        "execution_mode": execution_mode,
        "data_origin": data_origin,
        "payload": {
            "consent_version": "consent-2026-11-25-v1",
            "scopes": scopes if scopes is not None else ["camera"],
        },
    }
    if origin_ref is not None:
        ev["origin_ref"] = origin_ref
    return _rehash(ev)


def _make_session_start(
    *,
    org_id: str,
    participant_id: str,
    session_id: str,
    prescription_id: str = "rx_fixture-0001",
    prescription_revision: int = 1,
    execution_mode: str = "camera",
    data_origin: str = "synthetic_fixture",
) -> dict:
    src_type = {"camera": "camera", "simulation": "simulation", "report_only": "participant_report"}[execution_mode]
    source: dict = {"type": src_type}
    if src_type in ("camera", "simulation"):
        source["algorithm_version"] = "c05-hand-2"
        source["device_hint"] = "desktop-chrome"
    capture_ctx = (
        None
        if execution_mode == "report_only"
        else {"device_hint": "desktop-chrome", "frame_width": 640, "frame_height": 480}
    )
    ev = {
        "event_id": "",
        "schema_version": 3,
        "type": "session.started",
        "stream_id": f"session:{session_id}",
        "seq": 1,
        "prev_hash": None,
        "occurred_at": "2026-11-25T10:01:00.000Z",
        "actor": {"role": "participant", "id": participant_id},
        "scope": {
            "org_id": org_id,
            "participant_id": participant_id,
            "session_id": session_id,
            "prescription_id": prescription_id,
            "prescription_revision": prescription_revision,
            "exercise_id": "organizar-a-mesa",
        },
        "source": source,
        "execution_mode": execution_mode,
        "data_origin": data_origin,
        "payload": {
            "source_mode": execution_mode,
            "prescription_id": prescription_id,
            "prescription_revision": prescription_revision,
            "capture_context": capture_ctx,
        },
    }
    return _rehash(ev)


def _make_seeded_app(monkeypatch):
    monkeypatch.delenv("ELO_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("ELO_V3_REAL_DATA_GATE_OPEN", raising=False)
    monkeypatch.setenv("ELO_V3_DATA_ORIGIN", "synthetic_fixture")

    org_a = new_id("o")
    org_b = new_id("o")
    t1_id, t2_id, t3_id = new_id("t"), new_id("t"), new_id("t")
    t1_pw, t2_pw, t3_pw = secrets.token_urlsafe(12), secrets.token_urlsafe(12), secrets.token_urlsafe(12)
    seeds = [
        {"therapist_id": t1_id, "username": "t_l1", "password": t1_pw, "org_id": org_a, "display_label": "Therapist L1"},
        {"therapist_id": t2_id, "username": "t_l2", "password": t2_pw, "org_id": org_a, "display_label": "Therapist L2"},
        {"therapist_id": t3_id, "username": "t_l3", "password": t3_pw, "org_id": org_b, "display_label": "Therapist L3"},
    ]
    monkeypatch.setenv("ELO_V3_THERAPIST_SEEDS", json.dumps(seeds))
    app = create_app(":memory:")
    client = TestClient(app)

    def login(u, p):
        r = client.post("/api/v3/auth/therapist", json={"username": u, "password": p})
        assert r.status_code == 200
        return r.json()["token"]

    t1_tok = login("t_l1", t1_pw)
    t2_tok = login("t_l2", t2_pw)
    t3_tok = login("t_l3", t3_pw)

    rp = client.post("/api/v3/participants", headers={"Authorization": f"Bearer {t1_tok}"}, json={"alias": "Ledger P1", "side": "right"})
    assert rp.status_code == 201
    p1 = rp.json()
    cl1_id = rp.headers["X-Elo-Care-Link-Id"]

    ri = client.post("/api/v3/invites", headers={"Authorization": f"Bearer {t1_tok}"}, json={"participant_id": p1["entity_id"]})
    assert ri.status_code == 201
    p1_tok = client.post("/api/v3/auth/invite", json={"invite_token": ri.json()["invite_token"]}).json()["token"]

    return app, client, {
        "org_a": org_a,
        "org_b": org_b,
        "t1_id": t1_id,
        "t1_tok": t1_tok,
        "t2_tok": t2_tok,
        "t3_tok": t3_tok,
        "p1": p1,
        "p1_id": p1["entity_id"],
        "p1_tok": p1_tok,
        "cl1_id": cl1_id,
    }


def _collect_v3_routes(app) -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path, ops in app.openapi().get("paths", {}).items():
        if path.startswith("/api/v3"):
            for method in ops:
                if method.upper() not in ("HEAD", "OPTIONS"):
                    found.add((method.upper(), path))
    return found


# --- Row 1: Append-only storage triggers -------------------------------------------------


def test_append_only_triggers_on_events_and_entities():
    store = V3Store(":memory:")
    ledger = _load_json(LEDGER_PATH)["events"]
    res = store.append(ledger[:2])
    assert [r["status"] for r in res] == ["stored", "stored"]

    with pytest.raises(sqlite3.IntegrityError):
        store.db.execute("UPDATE v3_events SET data = '{}' WHERE event_id = ?", (ledger[0]["event_id"],))
    with pytest.raises(sqlite3.IntegrityError):
        store.db.execute("DELETE FROM v3_events WHERE event_id = ?", (ledger[0]["event_id"],))

    store.seed_therapist(therapist_id=new_id("t"), username="t_ap", password=secrets.token_urlsafe(12), org_id=new_id("o"))
    eid = store.db.execute("SELECT entity_id FROM v3_entities LIMIT 1").fetchone()[0]
    with pytest.raises(sqlite3.IntegrityError):
        store.db.execute("UPDATE v3_entities SET data = '{}' WHERE entity_id = ?", (eid,))
    with pytest.raises(sqlite3.IntegrityError):
        store.db.execute("DELETE FROM v3_entities WHERE entity_id = ?", (eid,))


# --- Row 2: Valid ledger reproduced byte-for-byte ----------------------------------------


def test_valid_ledger_reproduced_byte_for_byte():
    ref = _load_ref()
    ledger = _load_json(LEDGER_PATH)["events"]
    assert len(ledger) == 22

    store = V3Store(":memory:")
    results = store.append(ledger)
    assert len(results) == 22
    assert all(r["status"] == "stored" and r["codes"] == [] for r in results), results

    expected_by_stream: dict[str, list[dict]] = {}
    for ev in ledger:
        expected_by_stream.setdefault(ev["stream_id"], []).append(ev)

    for sid, expected_evs in expected_by_stream.items():
        expected_sorted = sorted(expected_evs, key=lambda e: e["seq"])
        stored = store.get_stream_events(sid)
        assert len(stored) == len(expected_sorted)
        for got, exp in zip(stored, expected_sorted, strict=True):
            assert canonicalize(got) == canonicalize(exp)
        assert ref.check_stream_chain(stored) == []
        assert store.is_stream_incomplete(sid) is False


# --- Row 3: Integrity on append (INVALID integrity + streams + named tests) --------------


def test_integrity_on_append_and_invalid_streams():
    inv = _load_json(INVALID_PATH)
    ledger = _load_json(LEDGER_PATH)["events"]

    # INVALID.integrity (4 cases)
    assert len(inv["integrity"]) == 4
    for case in inv["integrity"]:
        store = V3Store(":memory:")
        res = store.append([case["event"]])[0]
        assert res["status"] == "rejected"
        assert case["expect"] in res["codes"], f"{case['id']}: {res}"

    # INVALID.streams (2 cases: chain_broken, conflicting_duplicate_seq)
    assert len(inv["streams"]) == 2
    for case in inv["streams"]:
        store = V3Store(":memory:")
        # Seed prescription & consent so session events evaluate purely on chain/conflict
        store.append([ledger[0], ledger[1]])
        results = store.append(case["events"])
        all_codes = {c for r in results for c in r["codes"]}
        for exp in case["expect"]:
            assert exp in all_codes, f"{case['id']}: expected {exp} in {all_codes}"

    # Named tests: EVENT_ID_INVALID, HASH_INVALID, GENESIS_INVALID, CHAIN_BROKEN, HASH_CONFLICT, DUPLICATE, SEQ_GAP
    org_id, pid = new_id("o"), new_id("p")
    e1 = _make_consent_event(org_id=org_id, participant_id=pid, seq=1, prev_hash=None)
    e2 = _make_consent_event(org_id=org_id, participant_id=pid, seq=2, prev_hash=e1["hash"], kind="consent.revoked")

    store = V3Store(":memory:")
    assert store.append([e1])[0] == {"event_id": e1["event_id"], "status": "stored", "codes": []}

    # DUPLICATE -> no-op, status='duplicate'
    dup_res = store.append([e1])[0]
    assert dup_res == {"event_id": e1["event_id"], "status": "duplicate", "codes": ["DUPLICATE"]}

    # HASH_CONFLICT -> rejected, stored row unchanged
    e1_conflict = _make_consent_event(org_id=org_id, participant_id=pid, seq=1, prev_hash=None, scopes=["camera", "microphone"])
    assert e1_conflict["event_id"] == e1["event_id"] and e1_conflict["hash"] != e1["hash"]
    conf_res = store.append([e1_conflict])[0]
    assert conf_res["status"] == "rejected" and "HASH_CONFLICT" in conf_res["codes"]
    assert store.get_stream_events(e1["stream_id"])[0]["hash"] == e1["hash"]

    # CHAIN_BROKEN (prev_hash != stored seq-1 hash)
    e2_bad_prev = _make_consent_event(org_id=org_id, participant_id=pid, seq=2, prev_hash="f" * 64, kind="consent.revoked")
    cb_res = store.append([e2_bad_prev])[0]
    assert cb_res["status"] == "rejected" and "CHAIN_BROKEN" in cb_res["codes"]

    # EVENT_ID_INVALID & HASH_INVALID & GENESIS_INVALID
    bad_eid = copy.deepcopy(e2)
    bad_eid["event_id"] = "0" * 64
    assert "EVENT_ID_INVALID" in store.append([bad_eid])[0]["codes"]

    bad_hash = copy.deepcopy(e2)
    bad_hash["hash"] = "0" * 64
    assert "HASH_INVALID" in store.append([bad_hash])[0]["codes"]

    bad_gen = _make_consent_event(org_id=org_id, participant_id=pid, seq=2, prev_hash=None, kind="consent.revoked")
    assert "GENESIS_INVALID" in store.append([bad_gen])[0]["codes"]

    # SEQ_GAP across batches -> stored with warning code and stream marked incomplete
    e4_gap = _make_consent_event(org_id=org_id, participant_id=pid, seq=4, prev_hash="a" * 64, kind="consent.accepted")
    gap_res = store.append([e4_gap])[0]
    assert gap_res == {"event_id": e4_gap["event_id"], "status": "stored", "codes": ["SEQ_GAP"]}
    assert store.is_stream_incomplete(e1["stream_id"]) is True


# --- Row 4: One validation path (all 33 INVALID.events rejected via append) --------------


def test_one_validation_path_and_invalid_events_rejected():
    cases = _load_json(INVALID_PATH)["events"]
    assert len(cases) == 33
    for case in cases:
        store = V3Store(":memory:")
        res = store.append([case["event"]])[0]
        assert res["status"] == "rejected", f"{case['id']} was not rejected: {res}"
        assert case["expect"] in res["codes"], f"{case['id']}: expected {case['expect']} in {res['codes']}"

    # Verify ledger.py calls validate_event and defines zero duplicate REF functions
    ledger_src = (REPO_ROOT / "api" / "src" / "elo" / "v3" / "ledger.py").read_text(encoding="utf-8")
    assert "validate_event(" in ledger_src
    ref_tree = ast.parse(REF_PY_PATH.read_text(encoding="utf-8"))
    ref_funcs = {n.name for n in ref_tree.body if isinstance(n, ast.FunctionDef)}
    ledger_tree = ast.parse(ledger_src)
    ledger_funcs = {n.name for n in ledger_tree.body if isinstance(n, ast.FunctionDef)}
    assert (ref_funcs & ledger_funcs) == set()


# --- Row 5: events:batch access and exact 8-route contract -------------------------------


def test_events_batch_access_and_contract_routes(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    api_doc = _load_json(API_CONTRACT_PATH)
    by_id = {ep["id"]: ep for ep in api_doc["endpoints"]}
    expected_routes = {(by_id[rid]["method"], by_id[rid]["path"]) for rid in S0_04_ROUTE_IDS}
    assert _collect_v3_routes(app) == expected_routes

    ev = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None)

    # Anonymous -> 401 UNAUTHENTICATED
    r_anon = client.post("/api/v3/events:batch", json={"events": [ev]})
    assert r_anon.status_code == 401 and r_anon.json()["error"]["code"] == "UNAUTHENTICATED"

    # Therapist -> 403 FORBIDDEN
    r_th = client.post("/api/v3/events:batch", headers={"Authorization": f"Bearer {ctx['t1_tok']}"}, json={"events": [ev]})
    assert r_th.status_code == 403 and r_th.json()["error"]["code"] == "FORBIDDEN"

    # Forged stored roles -> 403 ROLE_NOT_ALLOWED
    future = (datetime.now(timezone.utc) + timedelta(seconds=3600)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    for bad_role in ("caregiver", "supervisor", "admin", ""):
        raw = secrets.token_urlsafe(32)
        app.state.v3_store.db.execute(
            "INSERT INTO v3_tokens (token_hash, role, principal_id, org_id, expires_at, revoked, created_at) VALUES (?,?,?,?,?,0,?)",
            (sha256_token(raw), bad_role, ctx["p1_id"], ctx["org_a"], future, now),
        )
        app.state.v3_store.db.commit()
        r_bad = client.post("/api/v3/events:batch", headers={"Authorization": f"Bearer {raw}"}, json={"events": [ev]})
        assert r_bad.status_code == 403 and r_bad.json()["error"]["code"] == "ROLE_NOT_ALLOWED"

    # Participant -> 200 stored
    r_ok = client.post("/api/v3/events:batch", headers={"Authorization": f"Bearer {ctx['p1_tok']}"}, json={"events": [ev]})
    assert r_ok.status_code == 200
    assert r_ok.json() == {"results": [{"event_id": ev["event_id"], "status": "stored", "codes": []}]}


# --- Row 6: Batch-level errors store nothing ---------------------------------------------


def test_batch_level_errors_store_nothing(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}

    # 1. 0 events -> 400 LENGTH
    r0 = client.post("/api/v3/events:batch", headers=hdrs, json={"events": []})
    assert r0.status_code == 400 and r0.json()["error"]["code"] == "LENGTH"

    # 2. 501 events -> 413 BATCH_TOO_LARGE
    e1 = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None)
    r501 = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [e1] * 501})
    assert r501.status_code == 413 and r501.json()["error"]["code"] == "BATCH_TOO_LARGE"

    # 3. Body > 2 MiB -> 413 BATCH_TOO_LARGE
    oversize_raw = b'{"events":[' + (b" " * (2097152 + 64)) + b"]}"
    r2m = client.post("/api/v3/events:batch", headers={**hdrs, "Content-Type": "application/json"}, content=oversize_raw)
    assert r2m.status_code == 413 and r2m.json()["error"]["code"] == "BATCH_TOO_LARGE"

    # 4. Unordered by (stream_id, seq) -> 400 BATCH_UNORDERED
    e2 = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=2, prev_hash=e1["hash"], kind="consent.revoked")
    runord = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [e2, e1]})
    assert runord.status_code == 400 and runord.json()["error"]["code"] == "BATCH_UNORDERED"

    # Nothing was stored across all 4 batch-level failures
    assert app.state.v3_store.get_all_events() == []


# --- Row 7: Per-event results & same-batch stream poison (D-S0-04-2) ---------------------


def test_per_event_results_and_same_batch_stream_poison(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}

    # Build a bad seq=1 consent event, followed by seq=2 on the SAME consent stream,
    # plus an independent session stream event (different stream_id).
    c1_bad = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None)
    c1_bad["hash"] = "0" * 64  # HASH_INVALID
    c2_after_bad = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=2, prev_hash=c1_bad["hash"], kind="consent.revoked")

    # Independent stream (session:...) fails only with PRESCRIPTION_NOT_FOUND, NOT poisoned by consent stream
    s1 = _make_session_start(org_id=ctx["org_a"], participant_id=ctx["p1_id"], session_id=new_id("s"), execution_mode="report_only")

    r = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [c1_bad, c2_after_bad, s1]})
    assert r.status_code == 200
    items = r.json()["results"]
    assert [it["event_id"] for it in items] == [c1_bad["event_id"], c2_after_bad["event_id"], s1["event_id"]]
    assert items[0]["status"] == "rejected" and "HASH_INVALID" in items[0]["codes"]
    assert items[1]["status"] == "rejected" and "CHAIN_BROKEN" in items[1]["codes"]
    assert "SEQ_GAP" not in items[1]["codes"]
    assert items[2]["status"] == "rejected" and items[2]["codes"] == ["PRESCRIPTION_NOT_FOUND"]

    # Also verify a rejected event on another stream does NOT stop a valid event on consent stream
    c1_good = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None)
    r2 = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [c1_good, s1]})
    assert r2.status_code == 200
    items2 = r2.json()["results"]
    assert items2[0] == {"event_id": c1_good["event_id"], "status": "stored", "codes": []}
    assert items2[1]["status"] == "rejected" and items2[1]["codes"] == ["PRESCRIPTION_NOT_FOUND"]


# --- Row 8: Client-authored types only ---------------------------------------------------


def test_server_authored_types_rejected_for_participant(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    ledger = _load_json(LEDGER_PATH)["events"]

    rx_ev = copy.deepcopy(next(e for e in ledger if e["type"] == "prescription.published"))
    rev_ev = copy.deepcopy(next(e for e in ledger if e["type"] == "review.recorded"))
    evo_ev = copy.deepcopy(next(e for e in ledger if e["type"] == "evolution.published"))

    sum_ev = copy.deepcopy(rev_ev)
    sum_ev["type"] = "summary.published"
    sum_ev["seq"] = 3
    sum_ev["prev_hash"] = "a" * 64
    sum_ev["payload"] = {
        "summary_id": "sum_fixture-0001",
        "period_from": "2026-11-23",
        "period_to": "2026-11-25",
        "items": [{"fact_id": "f_" + "a" * 64, "content_hash": "b" * 64}],
        "note_refs": [],
        "content_hash": "c" * 64,
    }
    sum_ev = _rehash(sum_ev)

    priv_ev = {
        "event_id": "",
        "schema_version": 3,
        "type": "privacy.erasure",
        "stream_id": f"privacy:{ctx['p1_id']}",
        "seq": 1,
        "prev_hash": None,
        "occurred_at": "2026-11-25T10:00:00.000Z",
        "actor": {"role": "system", "id": "sys_erasure01"},
        "scope": {"org_id": ctx["org_a"], "participant_id": ctx["p1_id"]},
        "source": {"type": "system"},
        "execution_mode": "not_applicable",
        "data_origin": "synthetic_fixture",
        "payload": {"erased_event_types": ["report.submitted"], "requested_at": "2026-11-25T10:00:00.000Z"},
    }
    priv_ev = _rehash(priv_ev)

    server_events = [rx_ev, rev_ev, sum_ev, evo_ev, priv_ev]
    for ev in server_events:
        r = client.post("/api/v3/events:batch", headers={"Authorization": f"Bearer {ctx['p1_tok']}"}, json={"events": [ev]})
        assert r.status_code == 200
        item = r.json()["results"][0]
        assert item["status"] == "rejected"
        assert "FORBIDDEN" in item["codes"], f"{ev['type']}: {item}"
    assert app.state.v3_store.get_all_events() == []


# --- Row 9: Actor = principal & spoofed fields -------------------------------------------


def test_actor_equals_principal_and_body_spoofing(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    other_pid = new_id("p")
    other_org = new_id("o")

    bad_actor_id = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None, actor_id=other_pid)
    bad_actor_role = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None, actor_role="therapist", actor_id=ctx["t1_id"])
    bad_scope_pid = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None, scope_participant_id=other_pid)
    bad_scope_org = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None, scope_org_id=other_org)

    for label, ev in [
        ("actor_id", bad_actor_id),
        ("actor_role", bad_actor_role),
        ("scope_pid", bad_scope_pid),
        ("scope_org", bad_scope_org),
    ]:
        r = client.post(
            f"/api/v3/events:batch?role=therapist&participant_id={other_pid}&org_id={other_org}",
            headers={"Authorization": f"Bearer {ctx['p1_tok']}"},
            json={"events": [ev], "role": "therapist", "principal": {"role": "participant", "id": other_pid}},
        )
        assert r.status_code == 200
        item = r.json()["results"][0]
        assert item["status"] == "rejected" and "SCOPE_VIOLATION" in item["codes"], f"{label}: {item}"
    assert app.state.v3_store.get_all_events() == []


# --- Row 10: Consent on append (same batch & across batches) -----------------------------


def test_consent_on_append_same_batch_and_across_batches(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}

    # Import a matching prescription at store level so session events test pure consent behavior
    ledger = _load_json(LEDGER_PATH)["events"]
    rx = copy.deepcopy(next(e for e in ledger if e["type"] == "prescription.published"))
    rx["scope"]["org_id"] = ctx["org_a"]
    rx["scope"]["participant_id"] = ctx["p1_id"]
    rx["payload"]["participant_id"] = ctx["p1_id"]
    rx = _rehash(rx)
    assert app.state.v3_store.append([rx])[0]["status"] == "stored"

    # 1. Camera session event without consent -> CONSENT_REQUIRED
    s_cam1 = _make_session_start(org_id=ctx["org_a"], participant_id=ctx["p1_id"], session_id=new_id("s"), execution_mode="camera")
    r1 = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [s_cam1]})
    assert r1.status_code == 200
    assert r1.json()["results"][0]["status"] == "rejected"
    assert r1.json()["results"][0]["codes"] == ["CONSENT_REQUIRED"]

    # 2. report_only session event without consent -> stored (D-S0-03-2)
    s_rep = _make_session_start(org_id=ctx["org_a"], participant_id=ctx["p1_id"], session_id=new_id("s"), execution_mode="report_only")
    r_rep = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [s_rep]})
    assert r_rep.status_code == 200 and r_rep.json()["results"][0]["status"] == "stored"

    # 3. consent.accepted earlier in the SAME batch enables camera session event
    c1 = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None, kind="consent.accepted", scopes=["camera"])
    s_cam2 = _make_session_start(org_id=ctx["org_a"], participant_id=ctx["p1_id"], session_id=new_id("s"), execution_mode="camera")
    r_same = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [c1, s_cam2]})
    assert r_same.status_code == 200
    assert [it["status"] for it in r_same.json()["results"]] == ["stored", "stored"]

    # 4. After consent.revoked -> camera session event returns CONSENT_REQUIRED again
    c2 = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=2, prev_hash=c1["hash"], kind="consent.revoked", scopes=["camera"])
    s_cam3 = _make_session_start(org_id=ctx["org_a"], participant_id=ctx["p1_id"], session_id=new_id("s"), execution_mode="camera")
    r_rev = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [c2, s_cam3]})
    assert r_rev.status_code == 200
    res_rev = r_rev.json()["results"]
    assert res_rev[0]["status"] == "stored"
    assert res_rev[1]["status"] == "rejected" and res_rev[1]["codes"] == ["CONSENT_REQUIRED"]


# --- Row 11: Gate and provenance item codes ----------------------------------------------


def test_gate_and_provenance_item_codes(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}

    c_live = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None, data_origin="live")
    r_live = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [c_live]})
    assert r_live.status_code == 200
    assert r_live.json()["results"][0]["status"] == "rejected"
    assert "REAL_DATA_GATE_CLOSED" in r_live.json()["results"][0]["codes"]

    c_exp = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None, data_origin="experimental_capture")
    r_exp = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [c_exp]})
    assert "ORIGIN_REF_REQUIRED" in r_exp.json()["results"][0]["codes"]

    c_bad_em = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None, execution_mode="camera")
    r_em = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [c_bad_em]})
    assert "EXECUTION_MODE_MISMATCH" in r_em.json()["results"][0]["codes"]


# --- Row 12: Legacy v2 streams read-only -------------------------------------------------


def test_legacy_v2_streams_read_only(monkeypatch):
    legacy = _load_json(LEGACY_PATH)["events"]
    assert len(legacy) == 21

    # Store-level check
    store = V3Store(":memory:")
    assert store.import_legacy_events(legacy) == 21
    v3_on_legacy = _make_consent_event(
        org_id="o_fixture-0001",
        participant_id="p_fixture-0001",
        seq=2,
        prev_hash=legacy[1]["hash"],
        kind="consent.revoked",
    )
    res = store.append([v3_on_legacy])[0]
    assert res["status"] == "rejected" and "LEGACY_STREAM_READ_ONLY" in res["codes"]
    assert len(store.get_stream_events("consent:p_fixture-0001")) == 1

    # HTTP-level check
    app, client, ctx = _make_seeded_app(monkeypatch)
    # Build a legacy v2 consent event for p1
    leg_c1 = copy.deepcopy(next(e for e in legacy if e["type"] == "consent.accepted"))
    leg_c1["stream_id"] = f"consent:{ctx['p1_id']}"
    leg_c1["actor"]["id"] = ctx["p1_id"]
    leg_c1["scope"]["org_id"] = ctx["org_a"]
    leg_c1["scope"]["participant_id"] = ctx["p1_id"]
    leg_c1 = _rehash(leg_c1)
    app.state.v3_store.import_legacy_events([leg_c1])

    v3_c2 = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=2, prev_hash=leg_c1["hash"], kind="consent.revoked")
    r = client.post("/api/v3/events:batch", headers={"Authorization": f"Bearer {ctx['p1_tok']}"}, json={"events": [v3_c2]})
    assert r.status_code == 200
    assert r.json()["results"][0]["status"] == "rejected"
    assert "LEGACY_STREAM_READ_ONLY" in r.json()["results"][0]["codes"]
    assert len(app.state.v3_store.get_stream_events(f"consent:{ctx['p1_id']}")) == 1


# --- Row 13: Prescription-dependent rules & handedness -----------------------------------


def test_prescription_dependent_rules(monkeypatch):
    # 1. Through API without stored prescription -> PRESCRIPTION_NOT_FOUND
    app, client, ctx = _make_seeded_app(monkeypatch)
    s1 = _make_session_start(org_id=ctx["org_a"], participant_id=ctx["p1_id"], session_id=new_id("s"), execution_mode="report_only")
    r = client.post("/api/v3/events:batch", headers={"Authorization": f"Bearer {ctx['p1_tok']}"}, json={"events": [s1]})
    assert r.status_code == 200
    assert r.json()["results"][0] == {"event_id": s1["event_id"], "status": "rejected", "codes": ["PRESCRIPTION_NOT_FOUND"]}

    # 2. At store level with LEDGER prescription + consent, INVALID.stream_rules are enforced
    inv = _load_json(INVALID_PATH)
    ledger = _load_json(LEDGER_PATH)["events"]
    for case in inv["stream_rules"]:
        store = V3Store(":memory:")
        assert [r["status"] for r in store.append([ledger[0], ledger[1]])] == ["stored", "stored"]
        results = store.append(case["events"])
        all_codes = {c for r in results for c in r["codes"]}
        for exp in case["expect"]:
            assert exp in all_codes, f"{case['id']}: expected {exp} in {all_codes}"


# --- Row 14: entities.versions -----------------------------------------------------------


def test_entities_versions_endpoint(monkeypatch):
    ref = _load_ref()
    app, client, ctx = _make_seeded_app(monkeypatch)

    # Create a second version of participant p1 directly in store (audit trail v1 + v2)
    p1_v1 = app.state.v3_store.get_entity_versions(ctx["p1_id"])[0]
    p1_v2 = build_entity(
        entity_type="participant",
        entity_id=ctx["p1_id"],
        version=2,
        prev_hash=p1_v1["hash"],
        org_id=ctx["org_a"],
        participant_id=ctx["p1_id"],
        author_role="therapist",
        author_id=ctx["t1_id"],
        data_origin="synthetic_fixture",
        payload={"alias": "Ledger P1 Updated", "side": "right"},
    )
    app.state.v3_store.save_entities_atomic([(p1_v2, [p1_v1])])

    # Linked therapist gets all participant versions in order, passing REF hash & chain
    r_p = client.get(f"/api/v3/entities/{ctx['p1_id']}/versions", headers={"Authorization": f"Bearer {ctx['t1_tok']}"})
    assert r_p.status_code == 200
    p_versions = r_p.json()
    assert [v["version"] for v in p_versions] == [1, 2]
    for v in p_versions:
        assert v["hash"] == ref.compute_entity_hash(v)
    assert ref.check_entity_chain(p_versions) == []

    # Linked therapist also gets care_link entity versions
    r_cl = client.get(f"/api/v3/entities/{ctx['cl1_id']}/versions", headers={"Authorization": f"Bearer {ctx['t1_tok']}"})
    assert r_cl.status_code == 200
    cl_versions = r_cl.json()
    assert [v["version"] for v in cl_versions] == [1]
    assert cl_versions[0]["hash"] == ref.compute_entity_hash(cl_versions[0])
    assert ref.check_entity_chain(cl_versions) == []

    # Participant -> 403 FORBIDDEN
    r_part = client.get(f"/api/v3/entities/{ctx['p1_id']}/versions", headers={"Authorization": f"Bearer {ctx['p1_tok']}"})
    assert r_part.status_code == 403 and r_part.json()["error"]["code"] == "FORBIDDEN"

    # Anonymous -> 401 UNAUTHENTICATED
    r_anon = client.get(f"/api/v3/entities/{ctx['p1_id']}/versions")
    assert r_anon.status_code == 401 and r_anon.json()["error"]["code"] == "UNAUTHENTICATED"

    # Unlinked therapist (same org) & foreign-org therapist & unknown id -> 404 NOT_FOUND
    for tok in (ctx["t2_tok"], ctx["t3_tok"]):
        r_un = client.get(f"/api/v3/entities/{ctx['p1_id']}/versions", headers={"Authorization": f"Bearer {tok}"})
        assert r_un.status_code == 404 and r_un.json()["error"]["code"] == "NOT_FOUND"
    r_unk = client.get(f"/api/v3/entities/{new_id('p')}/versions", headers={"Authorization": f"Bearer {ctx['t1_tok']}"})
    assert r_unk.status_code == 404 and r_unk.json()["error"]["code"] == "NOT_FOUND"

    # After revoking care_link, therapist without active link -> 404 NOT_FOUND
    assert client.post(f"/api/v3/care-links/{ctx['cl1_id']}:revoke", headers={"Authorization": f"Bearer {ctx['t1_tok']}"}, json={}).status_code == 200
    r_after_rev = client.get(f"/api/v3/entities/{ctx['p1_id']}/versions", headers={"Authorization": f"Bearer {ctx['t1_tok']}"})
    assert r_after_rev.status_code == 404 and r_after_rev.json()["error"]["code"] == "NOT_FOUND"


# --- Row 15: Codes and HTTP status catalog alignment -------------------------------------


def test_codes_http_statuses_and_warning_items_only_in_200(monkeypatch):
    catalog = {code: meta["http"] for code, meta in _load_json(ERROR_CODES_PATH)["codes"].items()}
    for code, status in EMITTABLE_ERROR_CODES.items():
        assert code in catalog and catalog[code] == status
    assert "SEQ_GAP" not in EMITTABLE_ERROR_CODES
    assert "DUPLICATE" not in EMITTABLE_ERROR_CODES
    assert catalog["SEQ_GAP"] == 200 and catalog["DUPLICATE"] == 200

    # Verify SEQ_GAP and DUPLICATE appear as item codes in HTTP 200 responses
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}
    c1 = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None)
    assert client.post("/api/v3/events:batch", headers=hdrs, json={"events": [c1]}).status_code == 200

    r_dup = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [c1]})
    assert r_dup.status_code == 200
    assert r_dup.json()["results"][0] == {"event_id": c1["event_id"], "status": "duplicate", "codes": ["DUPLICATE"]}

    c3_gap = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=3, prev_hash="a" * 64)
    r_gap = client.post("/api/v3/events:batch", headers=hdrs, json={"events": [c3_gap]})
    assert r_gap.status_code == 200
    assert r_gap.json()["results"][0] == {"event_id": c3_gap["event_id"], "status": "stored", "codes": ["SEQ_GAP"]}
