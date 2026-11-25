"""Tests for S1a-04: Prescriptions (server-authored prescription.published) and unlocking session events.

Covers ACCEPTANCE rows 1-12 (row 16 is the Verifier's independent HTTP probe).
All credentials, tokens, prescriptions, and events are synthetic and generated at test time.
"""

from __future__ import annotations

import importlib.util
import json
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import elo.api as elo_api
from elo.api import create_app
from elo.canonical import compute_event_hash, compute_event_id
from elo.v3.entities import load_event_catalog, new_id
from elo.v3.errors import EMITTABLE_ERROR_CODES
from elo.v3.store import sha256_token
from elo.v3.validation import load_limits_catalog, validate_event

REPO_ROOT = Path(__file__).resolve().parents[2]
PKG = REPO_ROOT / "contracts" / "CL06_3-r1"
CONTRACTS = PKG / "contracts"
API_CONTRACT_PATH = CONTRACTS / "api" / "api-contract.v3.json"
RX_SCHEMA_PATH = CONTRACTS / "schemas" / "events" / "prescription.published.schema.json"
ENCOUNTER_SCHEMA_PATH = CONTRACTS / "schemas" / "entities" / "encounter.schema.json"
REF_PY_PATH = PKG / "reference" / "python" / "elo_ref.py"

S1A_04_ROUTE_IDS = {
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
    "facts.list",
    "facts.evidence",
    "facts.verify",
    "reviews.record",
    "summaries.publish",
    "summaries.get",
    "evolution.series",
    "evolution.publish",
    "evolution.get",
    "timeline.get",
}


def _load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _load_ref():
    spec = importlib.util.spec_from_file_location("s1a_04_cl06_3_elo_ref", REF_PY_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _valid_rx_draft(
    participant_id: str,
    *,
    exercise_id: str = "organizar-a-mesa",
    permitted_movement: str = "hand_open_close",
    side: str = "right",
    target_sets: int = 2,
    target_repetitions: int = 10,
    sessions_per_week: int = 5,
    valid_from: str = "2026-11-23",
    valid_to: str | None = "2026-12-23",
    timezone_str: str = "America/Sao_Paulo",
    min_calibration_span: float | None = 0.35,
    instructions_ptbr: str = "Abra e feche a mão no seu ritmo. Pare se doer.",
) -> dict:
    return {
        "participant_id": participant_id,
        "exercise_id": exercise_id,
        "permitted_movement": permitted_movement,
        "side": side,
        "target_sets": target_sets,
        "target_repetitions": target_repetitions,
        "sessions_per_week": sessions_per_week,
        "valid_from": valid_from,
        "valid_to": valid_to,
        "timezone": timezone_str,
        "min_calibration_span": min_calibration_span,
        "instructions_ptbr": instructions_ptbr,
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


def _make_seeded_app(monkeypatch):
    monkeypatch.delenv("ELO_ACCESS_TOKEN", raising=False)
    monkeypatch.setenv("ELO_V3_DATA_ORIGIN", "synthetic_fixture")
    monkeypatch.delenv("ELO_V3_REAL_DATA_GATE_OPEN", raising=False)

    org_a = new_id("o")
    org_b = new_id("o")
    t1_id, t2_id, t3_id = new_id("t"), new_id("t"), new_id("t")
    t1_pw, t2_pw, t3_pw = secrets.token_urlsafe(12), secrets.token_urlsafe(12), secrets.token_urlsafe(12)
    seeds = [
        {"therapist_id": t1_id, "username": "t_rx_1", "password": t1_pw, "org_id": org_a, "display_label": "Therapist RX1"},
        {"therapist_id": t2_id, "username": "t_rx_2", "password": t2_pw, "org_id": org_a, "display_label": "Therapist RX2"},
        {"therapist_id": t3_id, "username": "t_rx_3", "password": t3_pw, "org_id": org_b, "display_label": "Therapist RX3"},
    ]
    monkeypatch.setenv("ELO_V3_THERAPIST_SEEDS", json.dumps(seeds))
    app = create_app(":memory:")
    client = TestClient(app)

    def login(u: str, p: str) -> str:
        r = client.post("/api/v3/auth/therapist", json={"username": u, "password": p})
        assert r.status_code == 200
        return r.json()["token"]

    t1_tok = login("t_rx_1", t1_pw)
    t2_tok = login("t_rx_2", t2_pw)
    t3_tok = login("t_rx_3", t3_pw)

    def mk_participant(therapist_tok: str, alias: str):
        rp = client.post(
            "/api/v3/participants",
            headers={"Authorization": f"Bearer {therapist_tok}"},
            json={"alias": alias, "side": "right"},
        )
        assert rp.status_code == 201
        p = rp.json()
        cl_id = rp.headers["X-Elo-Care-Link-Id"]
        ri = client.post(
            "/api/v3/invites",
            headers={"Authorization": f"Bearer {therapist_tok}"},
            json={"participant_id": p["entity_id"]},
        )
        assert ri.status_code == 201
        p_tok = client.post("/api/v3/auth/invite", json={"invite_token": ri.json()["invite_token"]}).json()["token"]
        return p, cl_id, p_tok

    p1, cl1_id, p1_tok = mk_participant(t1_tok, "RX P1")
    p2, cl2_id, p2_tok = mk_participant(t2_tok, "RX P2")

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


def _build_signed_event(
    *,
    event_type: str,
    stream_id: str,
    seq: int,
    prev_hash: str | None,
    actor: dict,
    scope: dict,
    source: dict,
    execution_mode: str,
    payload: dict,
    occurred_at: str = "2026-11-25T11:00:00.000Z",
    t_mono_ms: int | None = None,
) -> dict:
    ev: dict = {
        "event_id": compute_event_id(stream_id, seq),
        "schema_version": 3,
        "type": event_type,
        "stream_id": stream_id,
        "seq": seq,
        "prev_hash": prev_hash,
        "occurred_at": occurred_at,
        "actor": actor,
        "scope": scope,
        "source": source,
        "execution_mode": execution_mode,
        "data_origin": "synthetic_fixture",
        "payload": payload,
    }
    if t_mono_ms is not None:
        ev["t_mono_ms"] = t_mono_ms
    ev["hash"] = compute_event_hash(ev)
    return ev


# --- Row 1: Routes match API contract ----------------------------------------------------


def test_prescription_routes_match_api_contract(monkeypatch):
    api_doc = _load_json(API_CONTRACT_PATH)
    by_id = {ep["id"]: ep for ep in api_doc["endpoints"]}
    expected_routes = {(by_id[rid]["method"], by_id[rid]["path"]) for rid in S1A_04_ROUTE_IDS}

    app, _, _ = _make_seeded_app(monkeypatch)
    assert _collect_v3_routes(app) == expected_routes

    assert by_id["prescriptions.publish"]["method"] == "POST"
    assert by_id["prescriptions.publish"]["path"] == "/api/v3/prescriptions"
    assert by_id["prescriptions.publish"]["roles"] == ["therapist"]

    assert by_id["prescriptions.current"]["method"] == "GET"
    assert by_id["prescriptions.current"]["path"] == "/api/v3/participants/{participant_id}/prescription/current"
    assert by_id["prescriptions.current"]["roles"] == ["participant", "therapist"]

    assert by_id["prescriptions.history"]["method"] == "GET"
    assert by_id["prescriptions.history"]["path"] == "/api/v3/participants/{participant_id}/prescriptions"
    assert by_id["prescriptions.history"]["roles"] == ["therapist"]


# --- Rows 2, 3, 4: Publish rev 1 & later revisions, REF parity, server-owned fields ------


@pytest.mark.parametrize("shape", ["flat", "draft", "payload"])
def test_publish_revisions_ref_parity_immutability_and_server_fields(monkeypatch, shape):
    ref = _load_ref()
    rx_schema = _load_json(RX_SCHEMA_PATH)
    cat = load_event_catalog()
    limits = load_limits_catalog()

    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    spoof_server_payload = {
        "prescription_id": "rx_spoofed000001",
        "revision": 77,
        "supersedes_revision": 76,
        "created_by": ctx["t2_id"],
        "created_at": "2000-01-01T00:00:00.000Z",
        "limits_version": "limits-v99",
    }
    spoof_envelope = {
        "event_id": "a" * 64,
        "schema_version": 2,
        "type": "session.started",
        "stream_id": "prescription:rx_spoofed000001",
        "seq": 77,
        "prev_hash": "b" * 64,
        "occurred_at": "2000-01-01T00:00:00.000Z",
        "actor": {"role": "participant", "id": ctx["p1_id"]},
        "source": {"type": "camera"},
        "scope": {"org_id": ctx["org_b"], "participant_id": ctx["p2_id"]},
        "execution_mode": "camera",
        "data_origin": "live",
        "hash": "c" * 64,
    }

    def wrap_body(draft: dict) -> dict:
        polluted = {**draft, **spoof_server_payload}
        if shape == "flat":
            return {**spoof_envelope, **polluted}
        if shape == "draft":
            return {**spoof_envelope, "draft": polluted}
        return {**spoof_envelope, "payload": polluted}

    # Revision 1
    r1 = client.post("/api/v3/prescriptions", headers=hdrs, json=wrap_body(_valid_rx_draft(ctx["p1_id"], target_sets=2, target_repetitions=10)))
    assert r1.status_code == 201, r1.text
    res1 = r1.json()
    assert set(res1.keys()) == {"prescription_id", "revision", "event_id"}
    rx_id = res1["prescription_id"]
    assert rx_id.startswith("rx_") and rx_id != "rx_spoofed000001"
    assert res1["revision"] == 1

    stream_id = f"prescription:{rx_id}"
    stored = app.state.v3_store.get_stream_events(stream_id)
    assert len(stored) == 1
    ev1 = stored[0]
    assert ev1["event_id"] == res1["event_id"]
    assert ev1["seq"] == 1
    assert ev1["prev_hash"] is None
    assert ev1["type"] == "prescription.published"
    assert ev1["execution_mode"] == "not_applicable"
    assert ev1["data_origin"] == "synthetic_fixture"
    assert ev1["actor"] == {"role": "therapist", "id": ctx["t1_id"]}
    assert ev1["source"] == {"type": "therapist"}
    assert ev1["scope"] == {
        "org_id": ctx["org_a"],
        "participant_id": ctx["p1_id"],
        "prescription_id": rx_id,
        "prescription_revision": 1,
        "exercise_id": "organizar-a-mesa",
    }
    assert ev1["payload"]["prescription_id"] == rx_id
    assert ev1["payload"]["revision"] == 1
    assert ev1["payload"]["supersedes_revision"] is None
    assert ev1["payload"]["created_by"] == ctx["t1_id"]
    assert ev1["payload"]["created_at"] != "2000-01-01T00:00:00.000Z"
    assert ev1["payload"]["limits_version"] == limits["limits_version"]

    # Validate rev 1 with S0-03 validate_event AND REF
    assert validate_event(ev1, gate_open=False) == []
    assert ref.validate(rx_schema, ev1) == []
    assert ref.check_event_semantics(ev1, cat, limits, real_data_gate_open=False) == []
    assert ref.check_event_integrity(ev1) == []

    raw_rev1_before = app.state.v3_store.db.execute(
        "SELECT data FROM v3_events WHERE stream_id = ? AND seq = 1", (stream_id,)
    ).fetchone()[0]

    # Revision 2 for same (participant, exercise_id)
    r2 = client.post(
        "/api/v3/prescriptions",
        headers=hdrs,
        json=wrap_body(_valid_rx_draft(ctx["p1_id"], side="left", target_sets=3, target_repetitions=15)),
    )
    assert r2.status_code == 201, r2.text
    res2 = r2.json()
    assert res2["prescription_id"] == rx_id
    assert res2["revision"] == 2

    # Revision 3
    r3 = client.post(
        "/api/v3/prescriptions",
        headers=hdrs,
        json=wrap_body(_valid_rx_draft(ctx["p1_id"], side="left", target_sets=4, target_repetitions=20)),
    )
    assert r3.status_code == 201, r3.text
    res3 = r3.json()
    assert res3["prescription_id"] == rx_id
    assert res3["revision"] == 3

    chain = app.state.v3_store.get_stream_events(stream_id)
    assert len(chain) == 3
    ev1_after, ev2, ev3 = chain
    assert ev2["seq"] == 2
    assert ev2["prev_hash"] == ev1["hash"]
    assert ev2["payload"]["supersedes_revision"] == 1
    assert ev3["seq"] == 3
    assert ev3["prev_hash"] == ev2["hash"]
    assert ev3["payload"]["supersedes_revision"] == 2

    for ev in chain:
        assert validate_event(ev, gate_open=False) == []
        assert ref.validate(rx_schema, ev) == []
        assert ref.check_event_semantics(ev, cat, limits, real_data_gate_open=False) == []
        assert ref.check_event_integrity(ev) == []
    assert ref.check_stream_chain(chain) == []

    # Revision 1 raw bytes unchanged
    raw_rev1_after = app.state.v3_store.db.execute(
        "SELECT data FROM v3_events WHERE stream_id = ? AND seq = 1", (stream_id,)
    ).fetchone()[0]
    assert raw_rev1_after == raw_rev1_before
    assert ev1_after == ev1


# --- Row 5: Technical limits (limits.v1.json) --------------------------------------------


def test_prescription_limits_enforcement_and_boundaries(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    limits = load_limits_catalog()

    # Violations -> 400 LIMITS_EXCEEDED, nothing stored
    bad_limit_cases = [
        (limits["max_sets"] + 1, 1),          # sets > max_sets (11 * 1)
        (1, limits["max_repetitions"] + 1),   # reps > max_repetitions (1 * 101)
        (2, 51),                              # product 102 > 100
        (5, 21),                              # product 105 > 100
        (10, 11),                             # product 110 > 100
    ]
    for sets_val, reps_val in bad_limit_cases:
        r = client.post(
            "/api/v3/prescriptions",
            headers=hdrs,
            json=_valid_rx_draft(ctx["p1_id"], target_sets=sets_val, target_repetitions=reps_val),
        )
        _assert_error(r, 400, "LIMITS_EXCEEDED")

    assert app.state.v3_store.list_prescriptions(ctx["p1_id"]) == []

    # Exact boundaries (product == max_product == 100) accepted
    for rev_idx, (sets_val, reps_val) in enumerate([(10, 10), (1, 100), (5, 20)], start=1):
        r = client.post(
            "/api/v3/prescriptions",
            headers=hdrs,
            json=_valid_rx_draft(ctx["p1_id"], target_sets=sets_val, target_repetitions=reps_val),
        )
        assert r.status_code == 201, r.text
        assert r.json()["revision"] == rev_idx


# --- Row 6: Cross-field rules and schema validation; nothing stored ----------------------


def test_prescription_cross_field_and_schema_validation(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    def mut(fn):
        d = _valid_rx_draft(ctx["p1_id"])
        fn(d)
        return d

    # Cross-field rules -> RULE_VIOLATION
    cross_field_cases = [
        ("valid_to_before_valid_from", mut(lambda d: (d.__setitem__("valid_from", "2026-12-10"), d.__setitem__("valid_to", "2026-12-09"))), "RULE_VIOLATION"),
        ("invalid_calendar_valid_from", mut(lambda d: d.__setitem__("valid_from", "2026-02-30")), "RULE_VIOLATION"),
        ("invalid_calendar_valid_to", mut(lambda d: d.__setitem__("valid_to", "2026-04-31")), "RULE_VIOLATION"),
    ]
    for _, draft, code in cross_field_cases:
        r = client.post("/api/v3/prescriptions", headers=hdrs, json=draft)
        _assert_error(r, 400, code)

    # Top-level vs draft participant_id mismatch -> RULE_VIOLATION
    r_mismatch = client.post(
        "/api/v3/prescriptions",
        headers=hdrs,
        json={"participant_id": ctx["p2_id"], "draft": _valid_rx_draft(ctx["p1_id"])},
    )
    _assert_error(r_mismatch, 400, "RULE_VIOLATION")

    # Schema violations -> S0-03 codes
    schema_cases = [
        ("bad_exercise_id", mut(lambda d: d.__setitem__("exercise_id", "other-exercise")), "LITERAL"),
        ("bad_permitted_movement", mut(lambda d: d.__setitem__("permitted_movement", "wrist_flex")), "LITERAL"),
        ("bad_side", mut(lambda d: d.__setitem__("side", "both")), "ENUM"),
        ("sets_zero", mut(lambda d: d.__setitem__("target_sets", 0)), "OUT_OF_RANGE"),
        ("reps_zero", mut(lambda d: d.__setitem__("target_repetitions", 0)), "OUT_OF_RANGE"),
        ("sessions_per_week_high", mut(lambda d: d.__setitem__("sessions_per_week", 15)), "OUT_OF_RANGE"),
        ("bad_valid_from_pattern", mut(lambda d: d.__setitem__("valid_from", "23/11/2026")), "PATTERN"),
        ("bad_timezone", mut(lambda d: d.__setitem__("timezone", "UTC")), "ENUM"),
        ("min_cal_span_low", mut(lambda d: d.__setitem__("min_calibration_span", 0.1)), "OUT_OF_RANGE"),
        ("instructions_too_long", mut(lambda d: d.__setitem__("instructions_ptbr", "x" * 501)), "LENGTH"),
        ("missing_side", mut(lambda d: d.pop("side")), "MISSING_FIELD"),
        ("missing_participant_id", mut(lambda d: d.pop("participant_id")), "MISSING_FIELD"),
        ("unknown_field", mut(lambda d: d.__setitem__("clinical_diagnosis", "no")), "UNKNOWN_FIELD"),
        ("bad_sets_type", mut(lambda d: d.__setitem__("target_sets", True)), "TYPE"),
    ]
    for _, draft, code in schema_cases:
        r = client.post("/api/v3/prescriptions", headers=hdrs, json=draft)
        _assert_error(r, 400, code)

    # Non-finite float rejected with 400 NON_FINITE
    raw_nan = json.dumps(_valid_rx_draft(ctx["p1_id"])).replace("0.35", "NaN")
    r_nan = client.post(
        "/api/v3/prescriptions",
        headers={**hdrs, "Content-Type": "application/json"},
        content=raw_nan,
    )
    _assert_error(r_nan, 400, "NON_FINITE")

    assert app.state.v3_store.list_prescriptions(ctx["p1_id"]) == []

    # Same-day valid_to == valid_from and valid_to == None are accepted
    assert client.post(
        "/api/v3/prescriptions",
        headers=hdrs,
        json=_valid_rx_draft(ctx["p1_id"], valid_from="2026-11-25", valid_to="2026-11-25"),
    ).status_code == 201
    assert client.post(
        "/api/v3/prescriptions",
        headers=hdrs,
        json=_valid_rx_draft(ctx["p1_id"], valid_from="2026-11-25", valid_to=None),
    ).status_code == 201


# --- Row 7: 50 barrier-synchronised concurrent publish races -----------------------------


def test_50_concurrent_publish_races_immutable_and_contiguous(monkeypatch):
    monkeypatch.setattr(elo_api, "RATE_LIMIT", (100_000, 60))
    ref = _load_ref()
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    p1_hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}
    store = app.state.v3_store

    orig_insert = store.insert_prescription_revision
    state = {"target_rev": 1, "barrier": threading.Barrier(2)}

    def racing_insert(ev, *, is_new_stream):
        if ev["payload"]["participant_id"] == ctx["p1_id"] and ev["seq"] == state["target_rev"]:
            state["barrier"].wait(timeout=5.0)
        return orig_insert(ev, is_new_stream=is_new_stream)

    monkeypatch.setattr(store, "insert_prescription_revision", racing_insert)

    # First: race on revision 1 itself (must create strictly one prescription stream)
    draft_a = _valid_rx_draft(ctx["p1_id"], target_sets=2, target_repetitions=8)
    draft_b = _valid_rx_draft(ctx["p1_id"], target_sets=3, target_repetitions=8)

    with ThreadPoolExecutor(max_workers=4) as pool:
        # Race 1..50 (revision 1 through revision 50, 50 barrier-synchronised races!)
        rx_id: str | None = None
        raw_rev1_before: str | None = None
        for rev in range(1, 51):
            state["target_rev"] = rev
            state["barrier"] = threading.Barrier(2)

            f1 = pool.submit(client.post, "/api/v3/prescriptions", headers=t1_hdrs, json=draft_a)
            f2 = pool.submit(client.post, "/api/v3/prescriptions", headers=t1_hdrs, json=draft_b)
            resps = [f1.result(timeout=10), f2.result(timeout=10)]

            assert sorted(r.status_code for r in resps) == [201, 409], [r.text for r in resps]
            winner = next(r for r in resps if r.status_code == 201)
            loser = next(r for r in resps if r.status_code == 409)
            w_body = winner.json()
            assert w_body["revision"] == rev
            _assert_error(loser, 409, "CONFLICT_IMMUTABLE")

            if rev == 1:
                rx_id = w_body["prescription_id"]
                raw_rev1_before = store.db.execute(
                    "SELECT data FROM v3_events WHERE stream_id = ? AND seq = 1", (f"prescription:{rx_id}",)
                ).fetchone()[0]
            else:
                assert w_body["prescription_id"] == rx_id

            # Concurrent read sanity check
            rc = client.get(f"/api/v3/participants/{ctx['p1_id']}/prescription/current", headers=p1_hdrs)
            assert rc.status_code == 200 and rc.json()["payload"]["revision"] == rev

    assert rx_id is not None
    chain = store.get_stream_events(f"prescription:{rx_id}")
    assert len(chain) == 50
    assert [e["seq"] for e in chain] == list(range(1, 51))
    assert [e["payload"]["revision"] for e in chain] == list(range(1, 51))
    assert ref.check_stream_chain(chain) == []
    assert store.list_prescriptions(ctx["p1_id"]) == chain

    raw_rev1_after = store.db.execute(
        "SELECT data FROM v3_events WHERE stream_id = ? AND seq = 1", (f"prescription:{rx_id}",)
    ).fetchone()[0]
    assert raw_rev1_after == raw_rev1_before


# --- Rows 8 & 9: Current, History, and full Authorization Matrix -------------------------


def test_current_history_and_full_authorization_matrix(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    t2_hdrs = {"Authorization": f"Bearer {ctx['t2_tok']}"}  # unlinked same org
    t3_hdrs = {"Authorization": f"Bearer {ctx['t3_tok']}"}  # other org
    p1_hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}
    p2_hdrs = {"Authorization": f"Bearer {ctx['p2_tok']}"}

    # No prescription yet: current -> 404 NOT_FOUND for both participant self & linked therapist; history -> []
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/prescription/current", headers=p1_hdrs), 404, "NOT_FOUND")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/prescription/current", headers=t1_hdrs), 404, "NOT_FOUND")
    r_empty_hist = client.get(f"/api/v3/participants/{ctx['p1_id']}/prescriptions", headers=t1_hdrs)
    assert r_empty_hist.status_code == 200 and r_empty_hist.json() == []

    # Publish two revisions for p1
    r1 = client.post("/api/v3/prescriptions", headers=t1_hdrs, json=_valid_rx_draft(ctx["p1_id"], target_repetitions=6))
    assert r1.status_code == 201
    r2 = client.post("/api/v3/prescriptions", headers=t1_hdrs, json=_valid_rx_draft(ctx["p1_id"], target_repetitions=12))
    assert r2.status_code == 201

    # Current returns latest (rev 2) for both participant self and linked therapist
    cur_p1 = client.get(f"/api/v3/participants/{ctx['p1_id']}/prescription/current", headers=p1_hdrs)
    cur_t1 = client.get(f"/api/v3/participants/{ctx['p1_id']}/prescription/current", headers=t1_hdrs)
    assert cur_p1.status_code == 200 and cur_t1.status_code == 200
    assert cur_p1.json() == cur_t1.json()
    assert cur_p1.json()["payload"]["revision"] == 2
    assert cur_p1.json()["payload"]["target_repetitions"] == 12

    # History returns [rev1, rev2] in order for linked therapist
    hist_t1 = client.get(f"/api/v3/participants/{ctx['p1_id']}/prescriptions", headers=t1_hdrs)
    assert hist_t1.status_code == 200
    hist = hist_t1.json()
    assert [e["payload"]["revision"] for e in hist] == [1, 2]
    assert hist[-1] == cur_t1.json()

    # Anonymous -> 401 on all 3 routes
    _assert_error(client.post("/api/v3/prescriptions", json=_valid_rx_draft(ctx["p1_id"])), 401, "UNAUTHENTICATED")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/prescription/current"), 401, "UNAUTHENTICATED")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/prescriptions"), 401, "UNAUTHENTICATED")

    # Forged roles -> 403 ROLE_NOT_ALLOWED on all 3 routes
    future = (datetime.now(timezone.utc) + timedelta(seconds=3600)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    for forged_role in ("caregiver", "supervisor", "admin"):
        raw = secrets.token_urlsafe(32)
        app.state.v3_store.db.execute(
            "INSERT INTO v3_tokens (token_hash, role, principal_id, org_id, expires_at, revoked, created_at) VALUES (?,?,?,?,?,0,?)",
            (sha256_token(raw), forged_role, ctx["t1_id"], ctx["org_a"], future, now),
        )
        app.state.v3_store.db.commit()
        fh = {"Authorization": f"Bearer {raw}"}
        _assert_error(client.post("/api/v3/prescriptions", headers=fh, json=_valid_rx_draft(ctx["p1_id"])), 403, "ROLE_NOT_ALLOWED")
        _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/prescription/current", headers=fh), 403, "ROLE_NOT_ALLOWED")
        _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/prescriptions", headers=fh), 403, "ROLE_NOT_ALLOWED")

    # Participant on publish & history -> 403 FORBIDDEN; on another participant's current -> 403 SCOPE_VIOLATION
    unknown_pid = new_id("p")
    _assert_error(client.post("/api/v3/prescriptions", headers=p1_hdrs, json=_valid_rx_draft(ctx["p1_id"])), 403, "FORBIDDEN")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/prescriptions", headers=p1_hdrs), 403, "FORBIDDEN")
    _assert_error(client.get(f"/api/v3/participants/{unknown_pid}/prescriptions", headers=p1_hdrs), 403, "FORBIDDEN")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/prescription/current", headers=p2_hdrs), 403, "SCOPE_VIOLATION")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p2_id']}/prescription/current", headers=p1_hdrs), 403, "SCOPE_VIOLATION")
    _assert_error(client.get(f"/api/v3/participants/{unknown_pid}/prescription/current", headers=p1_hdrs), 403, "SCOPE_VIOLATION")

    # Unknown participant (therapist caller) -> 404 NOT_FOUND on all 3 routes
    _assert_error(client.post("/api/v3/prescriptions", headers=t1_hdrs, json=_valid_rx_draft(unknown_pid)), 404, "NOT_FOUND")
    _assert_error(client.get(f"/api/v3/participants/{unknown_pid}/prescription/current", headers=t1_hdrs), 404, "NOT_FOUND")
    _assert_error(client.get(f"/api/v3/participants/{unknown_pid}/prescriptions", headers=t1_hdrs), 404, "NOT_FOUND")

    # Unlinked (t2) and other-org (t3) therapist -> 403 SCOPE_VIOLATION on all 3 routes
    for other_hdrs in (t2_hdrs, t3_hdrs):
        _assert_error(client.post("/api/v3/prescriptions", headers=other_hdrs, json=_valid_rx_draft(ctx["p1_id"])), 403, "SCOPE_VIOLATION")
        _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/prescription/current", headers=other_hdrs), 403, "SCOPE_VIOLATION")
        _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/prescriptions", headers=other_hdrs), 403, "SCOPE_VIOLATION")

    # Revoked-link therapist -> 403 SCOPE_VIOLATION on all 3 routes
    assert client.post(f"/api/v3/care-links/{ctx['cl1_id']}:revoke", headers=t1_hdrs, json={}).status_code == 200
    _assert_error(client.post("/api/v3/prescriptions", headers=t1_hdrs, json=_valid_rx_draft(ctx["p1_id"])), 403, "SCOPE_VIOLATION")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/prescription/current", headers=t1_hdrs), 403, "SCOPE_VIOLATION")
    _assert_error(client.get(f"/api/v3/participants/{ctx['p1_id']}/prescriptions", headers=t1_hdrs), 403, "SCOPE_VIOLATION")


# --- Row 10 & Row 12: Session events unlocked & prescription.published server-only -------


def test_session_events_unlocked_handedness_checked_and_server_authored_only(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    t2_hdrs = {"Authorization": f"Bearer {ctx['t2_tok']}"}
    p1_hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}
    p2_hdrs = {"Authorization": f"Bearer {ctx['p2_tok']}"}

    # Publish prescriptions for p1 (right) and p2 (left)
    rx1 = client.post("/api/v3/prescriptions", headers=t1_hdrs, json=_valid_rx_draft(ctx["p1_id"], side="right")).json()
    rx2 = client.post("/api/v3/prescriptions", headers=t2_hdrs, json=_valid_rx_draft(ctx["p2_id"], side="left")).json()

    # 1. Grant camera consent for p1 via events:batch
    c_stream = f"consent:{ctx['p1_id']}"
    c1 = _build_signed_event(
        event_type="consent.accepted",
        stream_id=c_stream,
        seq=1,
        prev_hash=None,
        actor={"role": "participant", "id": ctx["p1_id"]},
        scope={"org_id": ctx["org_a"], "participant_id": ctx["p1_id"]},
        source={"type": "participant_report"},
        execution_mode="not_applicable",
        payload={"consent_version": "consent-2026-11-23-v1", "scopes": ["camera"]},
    )
    rc = client.post("/api/v3/events:batch", headers=p1_hdrs, json={"events": [c1]})
    assert rc.status_code == 200
    assert rc.json()["results"][0]["status"] == "stored"

    # 2. Session stream citing p1's stored prescription (side=right)
    s_id = new_id("s")
    s_stream = f"session:{s_id}"
    s_scope = {
        "org_id": ctx["org_a"],
        "participant_id": ctx["p1_id"],
        "session_id": s_id,
        "prescription_id": rx1["prescription_id"],
        "prescription_revision": rx1["revision"],
        "exercise_id": "organizar-a-mesa",
    }
    s1 = _build_signed_event(
        event_type="session.started",
        stream_id=s_stream,
        seq=1,
        prev_hash=None,
        actor={"role": "participant", "id": ctx["p1_id"]},
        scope=s_scope,
        source={"type": "camera", "algorithm_version": "c05-hand-2", "device_hint": "desktop-chrome"},
        execution_mode="camera",
        t_mono_ms=100,
        payload={
            "source_mode": "camera",
            "prescription_id": rx1["prescription_id"],
            "prescription_revision": rx1["revision"],
            "capture_context": {
                "device_hint": "desktop-chrome",
                "frame_width": 640,
                "frame_height": 480,
            },
        },
    )
    # Calibrate and start the capture session before emitting cycles (S1b-01 phase rules)
    s2_open = _build_signed_event(
        event_type="calibration.attempted",
        stream_id=s_stream,
        seq=2,
        prev_hash=s1["hash"],
        actor={"role": "participant", "id": ctx["p1_id"]},
        scope=s_scope,
        source={"type": "camera", "algorithm_version": "c05-hand-2", "device_hint": "desktop-chrome"},
        execution_mode="camera",
        t_mono_ms=200,
        occurred_at="2026-11-25T11:00:01.000Z",
        payload={"attempt": 1, "posture": "open", "n_samples": 30, "median": 1.8, "mad": 0.02, "accepted": True, "reason": None},
    )
    s3_closed = _build_signed_event(
        event_type="calibration.attempted",
        stream_id=s_stream,
        seq=3,
        prev_hash=s2_open["hash"],
        actor={"role": "participant", "id": ctx["p1_id"]},
        scope=s_scope,
        source={"type": "camera", "algorithm_version": "c05-hand-2", "device_hint": "desktop-chrome"},
        execution_mode="camera",
        t_mono_ms=300,
        occurred_at="2026-11-25T11:00:02.000Z",
        payload={"attempt": 2, "posture": "closed", "n_samples": 30, "median": 0.7, "mad": 0.02, "accepted": True, "reason": None},
    )
    s4_cal = _build_signed_event(
        event_type="calibration.applied",
        stream_id=s_stream,
        seq=4,
        prev_hash=s3_closed["hash"],
        actor={"role": "participant", "id": ctx["p1_id"]},
        scope=s_scope,
        source={"type": "camera", "algorithm_version": "c05-hand-2", "device_hint": "desktop-chrome"},
        execution_mode="camera",
        t_mono_ms=400,
        occurred_at="2026-11-25T11:00:03.000Z",
        payload={
            "calibration_id": "cal_synth0001",
            "open": 1.8,
            "closed": 0.7,
            "span": 1.1,
            "open_samples": 30,
            "closed_samples": 30,
            "attempt_refs": sorted([s2_open["event_id"], s3_closed["event_id"]]),
            "min_span_required": None,
        },
    )
    s5_start = _build_signed_event(
        event_type="session.control",
        stream_id=s_stream,
        seq=5,
        prev_hash=s4_cal["hash"],
        actor={"role": "participant", "id": ctx["p1_id"]},
        scope=s_scope,
        source={"type": "camera", "algorithm_version": "c05-hand-2", "device_hint": "desktop-chrome"},
        execution_mode="camera",
        t_mono_ms=500,
        occurred_at="2026-11-25T11:00:04.000Z",
        payload={"action": "start", "interrupt_reason": None},
    )
    # Matching handedness (right) -> stored!
    s6_ok = _build_signed_event(
        event_type="cycle.accepted",
        stream_id=s_stream,
        seq=6,
        prev_hash=s5_start["hash"],
        actor={"role": "participant", "id": ctx["p1_id"]},
        scope=s_scope,
        source={"type": "camera", "algorithm_version": "c05-hand-2", "device_hint": "desktop-chrome"},
        execution_mode="camera",
        t_mono_ms=900,
        occurred_at="2026-11-25T11:00:05.000Z",
        payload={
            "cycle_index": 1,
            "calibration_id": "cal_synth0001",
            "open_peak_n": 0.9,
            "closed_trough_n": 0.05,
            "armed_to_close_ms": 620,
            "frames": 30,
            "usable_frames": 30,
            "handedness": {"label": "right", "score": 0.95},
        },
    )
    # Wrong handedness (left != prescribed right) -> HANDEDNESS_INCOMPATIBLE_ACCEPTED!
    s7_bad_hand = _build_signed_event(
        event_type="cycle.accepted",
        stream_id=s_stream,
        seq=7,
        prev_hash=s6_ok["hash"],
        actor={"role": "participant", "id": ctx["p1_id"]},
        scope=s_scope,
        source={"type": "camera", "algorithm_version": "c05-hand-2", "device_hint": "desktop-chrome"},
        execution_mode="camera",
        t_mono_ms=1700,
        occurred_at="2026-11-25T11:00:06.000Z",
        payload={
            "cycle_index": 2,
            "calibration_id": "cal_synth0001",
            "open_peak_n": 0.9,
            "closed_trough_n": 0.05,
            "armed_to_close_ms": 620,
            "frames": 30,
            "usable_frames": 30,
            "handedness": {"label": "left", "score": 0.95},
        },
    )
    r_sess = client.post(
        "/api/v3/events:batch",
        headers=p1_hdrs,
        json={"events": [s1, s2_open, s3_closed, s4_cal, s5_start, s6_ok, s7_bad_hand]},
    )
    assert r_sess.status_code == 200
    items = r_sess.json()["results"]
    for idx, ev in enumerate([s1, s2_open, s3_closed, s4_cal, s5_start, s6_ok]):
        assert items[idx] == {"event_id": ev["event_id"], "status": "stored", "codes": []}
    assert items[6] == {
        "event_id": s7_bad_hand["event_id"],
        "status": "rejected",
        "codes": ["HANDEDNESS_INCOMPATIBLE_ACCEPTED"],
    }

    # 3. report_only session event for p2 needs no camera consent and resolves against p2's published prescription
    s2_id = new_id("s")
    s2_ev = _build_signed_event(
        event_type="session.started",
        stream_id=f"session:{s2_id}",
        seq=1,
        prev_hash=None,
        actor={"role": "participant", "id": ctx["p2_id"]},
        scope={
            "org_id": ctx["org_a"],
            "participant_id": ctx["p2_id"],
            "session_id": s2_id,
            "prescription_id": rx2["prescription_id"],
            "prescription_revision": rx2["revision"],
            "exercise_id": "organizar-a-mesa",
        },
        source={"type": "participant_report"},
        execution_mode="report_only",
        t_mono_ms=50,
        payload={
            "source_mode": "report_only",
            "prescription_id": rx2["prescription_id"],
            "prescription_revision": rx2["revision"],
            "capture_context": None,
        },
    )
    r_p2 = client.post("/api/v3/events:batch", headers=p2_hdrs, json={"events": [s2_ev]})
    assert r_p2.status_code == 200
    assert r_p2.json()["results"][0] == {"event_id": s2_ev["event_id"], "status": "stored", "codes": []}

    # 4. Unknown revision or another participant's prescription still -> PRESCRIPTION_NOT_FOUND
    for bad_rx_id, bad_rev in [(rx1["prescription_id"], 99), (rx2["prescription_id"], rx2["revision"]), (new_id("rx"), 1)]:
        sid_x = new_id("s")
        ev_x = _build_signed_event(
            event_type="session.started",
            stream_id=f"session:{sid_x}",
            seq=1,
            prev_hash=None,
            actor={"role": "participant", "id": ctx["p1_id"]},
            scope={
                "org_id": ctx["org_a"],
                "participant_id": ctx["p1_id"],
                "session_id": sid_x,
                "prescription_id": bad_rx_id,
                "prescription_revision": bad_rev,
                "exercise_id": "organizar-a-mesa",
            },
            source={"type": "participant_report"},
            execution_mode="report_only",
            t_mono_ms=50,
            payload={
                "source_mode": "report_only",
                "prescription_id": bad_rx_id,
                "prescription_revision": bad_rev,
                "capture_context": None,
            },
        )
        r_bad = client.post("/api/v3/events:batch", headers=p1_hdrs, json={"events": [ev_x]})
        assert r_bad.status_code == 200
        assert r_bad.json()["results"][0] == {
            "event_id": ev_x["event_id"],
            "status": "rejected",
            "codes": ["PRESCRIPTION_NOT_FOUND"],
        }

    # 5. Row 12: prescription.published is still rejected on events:batch with FORBIDDEN
    fake_rx_id = new_id("rx")
    fake_rx_ev = _build_signed_event(
        event_type="prescription.published",
        stream_id=f"prescription:{fake_rx_id}",
        seq=1,
        prev_hash=None,
        actor={"role": "therapist", "id": ctx["t1_id"]},
        scope={
            "org_id": ctx["org_a"],
            "participant_id": ctx["p1_id"],
            "prescription_id": fake_rx_id,
            "prescription_revision": 1,
            "exercise_id": "organizar-a-mesa",
        },
        source={"type": "therapist"},
        execution_mode="not_applicable",
        payload={
            **_valid_rx_draft(ctx["p1_id"]),
            "prescription_id": fake_rx_id,
            "revision": 1,
            "supersedes_revision": None,
            "created_by": ctx["t1_id"],
            "created_at": "2026-11-25T11:00:00.000Z",
            "limits_version": "limits-v1",
        },
    )
    r_forbid = client.post("/api/v3/events:batch", headers=p1_hdrs, json={"events": [fake_rx_ev]})
    assert r_forbid.status_code == 200
    res_f = r_forbid.json()["results"][0]
    assert res_f["status"] == "rejected"
    assert "FORBIDDEN" in res_f["codes"]
    assert app.state.v3_store.get_stream_events(f"prescription:{fake_rx_id}") == []


# --- Row 11: encounter.prescription_ref unlocked against published prescriptions ---------


def test_encounter_prescription_ref_resolves_against_published_prescriptions(monkeypatch):
    ref = _load_ref()
    en_schema = _load_json(ENCOUNTER_SCHEMA_PATH)
    cat = load_event_catalog()

    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    t2_hdrs = {"Authorization": f"Bearer {ctx['t2_tok']}"}

    rx_p1 = client.post("/api/v3/prescriptions", headers=t1_hdrs, json=_valid_rx_draft(ctx["p1_id"])).json()
    rx_p2 = client.post("/api/v3/prescriptions", headers=t2_hdrs, json=_valid_rx_draft(ctx["p2_id"])).json()

    def mk_encounter_body(rx_ref):
        return {
            "encounter_date": "2026-11-25",
            "modality": "remote_external",
            "duration_min": 30,
            "prescription_ref": rx_ref,
            "assessment_ref": None,
            "therapist_note": "Synthetic encounter citing prescription.",
        }

    # 1. Valid same-participant published prescription -> 201
    r_ok = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/encounters",
        headers=t1_hdrs,
        json=mk_encounter_body({"prescription_id": rx_p1["prescription_id"], "revision": rx_p1["revision"]}),
    )
    assert r_ok.status_code == 201, r_ok.text
    en_ok = r_ok.json()
    assert en_ok["payload"]["prescription_ref"] == {
        "prescription_id": rx_p1["prescription_id"],
        "revision": rx_p1["revision"],
    }
    assert ref.validate(en_schema, en_ok) == []
    assert ref.check_entity_semantics(en_ok, cat, real_data_gate_open=False) == []

    # 2. Null prescription_ref still accepted -> 201
    r_null = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/encounters",
        headers=t1_hdrs,
        json=mk_encounter_body(None),
    )
    assert r_null.status_code == 201

    # 3. Unknown prescription, unknown revision, or another participant's prescription -> 400 RULE_VIOLATION
    bad_refs = [
        {"prescription_id": new_id("rx"), "revision": 1},
        {"prescription_id": rx_p1["prescription_id"], "revision": 2},
        {"prescription_id": rx_p2["prescription_id"], "revision": rx_p2["revision"]},
    ]
    for bad_ref in bad_refs:
        r_bad = client.post(
            f"/api/v3/participants/{ctx['p1_id']}/encounters",
            headers=t1_hdrs,
            json=mk_encounter_body(bad_ref),
        )
        _assert_error(r_bad, 400, "RULE_VIOLATION")

    assert len(app.state.v3_store.list_latest_entities("encounter", ctx["p1_id"])) == 2
