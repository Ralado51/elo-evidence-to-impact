"""Tests for S1b-03: reviews bound to content hash, publication gate, immutable summaries, and V3-S7..S10.

Covers ACCEPTANCE rows 1–10 and 12 (mutation sensitivity) per D-S1b-03-1, D-S0-02-1/-3, and D-S0-04-1/-2.
All credentials and identifiers are synthetic and generated at runtime.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import random
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import elo.api as elo_api
from elo.api import create_app
from elo.canonical import compute_event_hash, compute_event_id, hash_canonical
from elo.v3.entities import load_event_catalog, new_id
from elo.v3.errors import EMITTABLE_ERROR_CODES, ITEM_WARNING_CODES, VERIFIER_RESULT_CODES
from elo.v3.store import sha256_token
from elo.v3.validation import load_limits_catalog, validate_event
from elo.v3.verifier import compute_content_hash

REPO_ROOT = Path(__file__).resolve().parents[2]
PKG = REPO_ROOT / "contracts" / "CL06_3-r1"
CONTRACTS = PKG / "contracts"
API_CONTRACT_PATH = CONTRACTS / "api" / "api-contract.v3.json"
ERROR_CODES_PATH = CONTRACTS / "catalogs" / "error-codes.v3.json"
REVIEW_SCHEMA_PATH = CONTRACTS / "schemas" / "events" / "review.recorded.schema.json"
SUMMARY_SCHEMA_PATH = CONTRACTS / "schemas" / "events" / "summary.published.schema.json"
CASES_PATH = PKG / "fixtures" / "adversarial" / "cases.v3.json"
LEGACY_LEDGER_PATH = PKG / "legacy_cl06_1_reference" / "ledger.json"
REF_PY_PATH = PKG / "reference" / "python" / "elo_ref.py"

S1B_03_ROUTE_IDS = {
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
}


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_ref():
    spec = importlib.util.spec_from_file_location("s1b_03_cl06_3_elo_ref", REF_PY_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _rehash(ev: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(ev)
    out["event_id"] = compute_event_id(out["stream_id"], out["seq"])
    out["hash"] = compute_event_hash(out)
    return out


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _insert_raw_token(store, *, role: str, principal_id: str, org_id: str) -> str:
    raw = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    created_at = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    exp = now + timedelta(hours=1)
    expires_at = exp.strftime("%Y-%m-%dT%H:%M:%S.") + f"{exp.microsecond // 1000:03d}Z"
    store.db.execute(
        """INSERT INTO v3_tokens (token_hash, role, principal_id, org_id, expires_at, revoked, created_at)
           VALUES (?,?,?,?,?,0,?)""",
        (sha256_token(raw), role, principal_id, org_id, expires_at, created_at),
    )
    store.db.commit()
    return raw


def _make_camera_session_events(
    *,
    org_id: str,
    participant_id: str,
    session_id: str,
    rx_id: str,
    rx_rev: int = 1,
    target: int = 4,
    assistance: str = "some",
    execution: str = "complete",
    include_measurement: bool = True,
) -> list[dict[str, Any]]:
    """Build a valid CL06.3 camera session stream that derives F01, F02, F03, F04, F06, F09, and F10."""
    sid = f"session:{session_id}"
    scope = {
        "org_id": org_id,
        "participant_id": participant_id,
        "session_id": session_id,
        "prescription_id": rx_id,
        "prescription_revision": rx_rev,
        "exercise_id": "organizar-a-mesa",
    }
    cam_src = {"type": "camera", "algorithm_version": "c05-hand-2", "device_hint": "desktop-chrome"}
    rep_src = {"type": "participant_report"}
    actor = {"role": "participant", "id": participant_id}

    events: list[dict[str, Any]] = []

    def add(ev_type: str, payload: dict[str, Any], *, src=cam_src, t_mono: int | None = None, sec: int = 0) -> dict[str, Any]:
        seq = len(events) + 1
        prev_hash = events[-1]["hash"] if events else None
        ev: dict[str, Any] = {
            "event_id": "",
            "schema_version": 3,
            "type": ev_type,
            "stream_id": sid,
            "seq": seq,
            "prev_hash": prev_hash,
            "occurred_at": f"2026-11-25T10:{sec // 60:02d}:{sec % 60:02d}.000Z",
            "actor": actor,
            "scope": scope,
            "source": src,
            "execution_mode": "camera",
            "data_origin": "synthetic_fixture",
            "payload": payload,
        }
        if t_mono is not None:
            ev["t_mono_ms"] = t_mono
        ev = _rehash(ev)
        events.append(ev)
        return ev

    add(
        "session.started",
        {
            "source_mode": "camera",
            "prescription_id": rx_id,
            "prescription_revision": rx_rev,
            "capture_context": {"device_hint": "desktop-chrome", "frame_width": 640, "frame_height": 480},
        },
        t_mono=0,
        sec=1,
    )
    a1 = add(
        "calibration.attempted",
        {"attempt": 1, "posture": "open", "n_samples": 33, "median": 1.9, "mad": 0.02, "accepted": True, "reason": None},
        t_mono=100,
        sec=2,
    )
    a2 = add(
        "calibration.attempted",
        {"attempt": 2, "posture": "closed", "n_samples": 33, "median": 0.8, "mad": 0.02, "accepted": True, "reason": None},
        t_mono=200,
        sec=3,
    )
    cal_id = new_id("cal")
    add(
        "calibration.applied",
        {
            "calibration_id": cal_id,
            "open": 1.9,
            "closed": 0.8,
            "span": 1.1,
            "open_samples": 33,
            "closed_samples": 33,
            "attempt_refs": sorted([a1["event_id"], a2["event_id"]]),
            "min_span_required": None,
        },
        t_mono=300,
        sec=4,
    )
    add("session.control", {"action": "start", "interrupt_reason": None}, t_mono=400, sec=5)
    for idx in range(1, target + 1):
        add(
            "cycle.accepted",
            {
                "cycle_index": idx,
                "calibration_id": cal_id,
                "open_peak_n": 0.9,
                "closed_trough_n": 0.04,
                "armed_to_close_ms": 620,
                "frames": 30,
                "usable_frames": 30,
                "handedness": {"label": "right", "score": 0.97},
            },
            t_mono=1000 * idx,
            sec=5 + idx,
        )
    add("session.completed", {"accepted": target, "target": target}, t_mono=1000 * target + 100, sec=20)
    add(
        "session.capture_summary",
        {"frames_total": 360, "fps_mean": 24.1, "fps_min": 11.2, "usable_fraction": 0.87, "lost_events": 1},
        t_mono=1000 * target + 200,
        sec=21,
    )
    if include_measurement:
        add(
            "measurement.recorded",
            {
                "measurement_id": new_id("ms"),
                "measure_kind": "opening_index",
                "value": 1.1,
                "unit": "1",
                "method": "landmark_ratio_v1",
                "quality": "usable",
                "quality_reason": None,
                "protocol_id": None,
                "limitation_codes": ["L10", "L18"],
                "experimental": True,
                "body_segment": "hand",
            },
            t_mono=1000 * target + 300,
            sec=22,
        )
    add(
        "report.submitted",
        {"execution": execution, "assistance": assistance, "reporter_role": "participant"},
        src=rep_src,
        sec=23,
    )
    return events


def _setup_world(tmp_path: Path):
    """Create isolated app + store with therapists, participants, care links, prescription, and camera session."""
    app = create_app(data_dir=str(tmp_path))
    client = TestClient(app)
    store = app.state.v3_store

    pw1 = secrets.token_urlsafe(12)
    pw2 = secrets.token_urlsafe(12)
    pw_other = secrets.token_urlsafe(12)
    org1 = "o_revorg-0001"
    org2 = "o_revorg-0002"
    t1_id = "t_revth1-0001"
    t2_id = "t_revth2-0002"
    t_other_id = "t_revoth-0003"

    store.seed_therapist(therapist_id=t1_id, username="t1_rev", password=pw1, org_id=org1, display_label="Therapist 1")
    store.seed_therapist(therapist_id=t2_id, username="t2_rev", password=pw2, org_id=org1, display_label="Therapist 2")
    store.seed_therapist(
        therapist_id=t_other_id, username="t3_rev", password=pw_other, org_id=org2, display_label="Therapist Other"
    )

    t1_tok = client.post("/api/v3/auth/therapist", json={"username": "t1_rev", "password": pw1}).json()["token"]
    t2_tok = client.post("/api/v3/auth/therapist", json={"username": "t2_rev", "password": pw2}).json()["token"]
    t_other_tok = client.post("/api/v3/auth/therapist", json={"username": "t3_rev", "password": pw_other}).json()[
        "token"
    ]

    # Create participant P1 linked to T1
    r_p1 = client.post("/api/v3/participants", headers=_headers(t1_tok), json={"alias": "P1 Synth", "side": "right"})
    assert r_p1.status_code == 201
    p1_id = r_p1.json()["entity_id"]
    cl1_id = r_p1.headers["X-Elo-Care-Link-Id"]

    inv1 = client.post("/api/v3/invites", headers=_headers(t1_tok), json={"participant_id": p1_id}).json()["invite_token"]
    p1_tok = client.post("/api/v3/auth/invite", json={"invite_token": inv1}).json()["token"]

    # Create participant P2 linked to T2 (different participant in same org)
    r_p2 = client.post("/api/v3/participants", headers=_headers(t2_tok), json={"alias": "P2 Synth", "side": "left"})
    assert r_p2.status_code == 201
    p2_id = r_p2.json()["entity_id"]
    inv2 = client.post("/api/v3/invites", headers=_headers(t2_tok), json={"participant_id": p2_id}).json()["invite_token"]
    p2_tok = client.post("/api/v3/auth/invite", json={"invite_token": inv2}).json()["token"]

    # Publish prescription for P1
    r_rx = client.post(
        "/api/v3/prescriptions",
        headers=_headers(t1_tok),
        json={
            "participant_id": p1_id,
            "exercise_id": "organizar-a-mesa",
            "permitted_movement": "hand_open_close",
            "side": "right",
            "target_sets": 1,
            "target_repetitions": 4,
            "sessions_per_week": 5,
            "valid_from": "2026-11-23",
            "valid_to": "2026-12-21",
            "timezone": "America/Sao_Paulo",
            "min_calibration_span": None,
            "instructions_ptbr": "Abra e feche a mão no seu ritmo.",
        },
    )
    assert r_rx.status_code == 201, r_rx.text
    rx_id = r_rx.json()["prescription_id"]

    # Participant accepts camera consent & appends a complete camera session
    consent_ev = _rehash(
        {
            "event_id": "",
            "schema_version": 3,
            "type": "consent.accepted",
            "stream_id": f"consent:{p1_id}",
            "seq": 1,
            "prev_hash": None,
            "occurred_at": "2026-11-25T10:00:00.000Z",
            "actor": {"role": "participant", "id": p1_id},
            "scope": {"org_id": org1, "participant_id": p1_id},
            "source": {"type": "participant_report"},
            "execution_mode": "not_applicable",
            "data_origin": "synthetic_fixture",
            "payload": {"consent_version": "consent-2026-11-23-v1", "scopes": ["camera"]},
        }
    )
    s1_id = "s_revses-0001"
    s1_events = _make_camera_session_events(org_id=org1, participant_id=p1_id, session_id=s1_id, rx_id=rx_id)
    batch_events = sorted([consent_ev, *s1_events], key=lambda e: (e["stream_id"], e["seq"]))
    r_batch = client.post("/api/v3/events:batch", headers=_headers(p1_tok), json={"events": batch_events})
    assert r_batch.status_code == 200
    assert all(it["status"] == "stored" for it in r_batch.json()["results"]), r_batch.json()

    r_facts = client.get(f"/api/v3/participants/{p1_id}/facts", headers=_headers(t1_tok))
    assert r_facts.status_code == 200
    facts_list = r_facts.json()["facts"]
    by_type = {f["type"]: f for f in facts_list}
    hashes_by_type = {ft: compute_content_hash(f) for ft, f in by_type.items()}

    return {
        "app": app,
        "client": client,
        "store": store,
        "org1": org1,
        "org2": org2,
        "t1_id": t1_id,
        "t2_id": t2_id,
        "t_other_id": t_other_id,
        "t1_tok": t1_tok,
        "t2_tok": t2_tok,
        "t_other_tok": t_other_tok,
        "p1_id": p1_id,
        "p1_tok": p1_tok,
        "cl1_id": cl1_id,
        "p2_id": p2_id,
        "p2_tok": p2_tok,
        "rx_id": rx_id,
        "s1_id": s1_id,
        "s1_events": s1_events,
        "facts_by_type": by_type,
        "hashes_by_type": hashes_by_type,
    }


def _assert_valid_review_or_summary_event(ev: dict[str, Any], schema: dict[str, Any], stream_events: list[dict[str, Any]]) -> None:
    ref = _load_ref()
    cat = load_event_catalog()
    limits = load_limits_catalog()
    assert validate_event(ev, gate_open=False) == []
    assert ref.validate(schema, ev) == []
    assert ref.check_event_semantics(ev, cat, limits) == []
    assert ref.check_event_integrity(ev) == []
    assert ref.check_stream_chain(stream_events) == []


# ---------------------------------------------------------------------------
# Row 1: Routes match API contract (+3 exact) & error codes match catalog
# ---------------------------------------------------------------------------


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


def test_routes_match_api_contract_and_error_codes(tmp_path: Path):
    app = create_app(data_dir=str(tmp_path))
    api_contract = _load_json(API_CONTRACT_PATH)
    by_id = {ep["id"]: ep for ep in api_contract["endpoints"]}

    expected_routes = {(by_id[eid]["method"], by_id[eid]["path"]) for eid in S1B_03_ROUTE_IDS}
    actual_routes = _collect_v3_routes(app)
    assert actual_routes == expected_routes
    assert len(actual_routes) == 27

    assert (by_id["reviews.record"]["method"], by_id["reviews.record"]["path"], by_id["reviews.record"]["roles"]) == (
        "POST",
        "/api/v3/reviews",
        ["therapist"],
    )
    assert (
        by_id["summaries.publish"]["method"],
        by_id["summaries.publish"]["path"],
        by_id["summaries.publish"]["roles"],
    ) == ("POST", "/api/v3/summaries", ["therapist"])
    assert (by_id["summaries.get"]["method"], by_id["summaries.get"]["path"], by_id["summaries.get"]["roles"]) == (
        "GET",
        "/api/v3/summaries/{summary_id}",
        ["participant", "therapist"],
    )

    err_catalog = _load_json(ERROR_CODES_PATH)["codes"]
    for code, http_status in EMITTABLE_ERROR_CODES.items():
        assert code in err_catalog
        assert err_catalog[code]["http"] == http_status
    for code, http_status in ITEM_WARNING_CODES.items():
        assert code in err_catalog and err_catalog[code]["http"] == http_status
    for code, http_status in VERIFIER_RESULT_CODES.items():
        assert code in err_catalog and err_catalog[code]["http"] == http_status


# ---------------------------------------------------------------------------
# Rows 2 & 3: Review event integrity, server-owned fields, content_hash binding
# ---------------------------------------------------------------------------


def test_review_record_event_integrity_and_content_hash_binding(tmp_path: Path):
    w = _setup_world(tmp_path)
    client = w["client"]
    store = w["store"]
    review_schema = _load_json(REVIEW_SCHEMA_PATH)

    f01 = w["facts_by_type"]["F01"]
    f01_id = f01["fact_id"]
    f01_hash = w["hashes_by_type"]["F01"]

    # Approve with spoofed server fields -> server overrides actor, ids, timestamps, envelope
    r1 = client.post(
        "/api/v3/reviews",
        headers=_headers(w["t1_tok"]),
        json={
            "fact_id": f01_id,
            "content_hash": f01_hash,
            "decision": "approve",
            "note": "Revisado com evidencia completa.",
            # Attempt to spoof server-owned fields:
            "actor": {"role": "participant", "id": w["p1_id"]},
            "event_id": "0" * 64,
            "seq": 999,
            "stream_id": "review:spoofed.stream",
            "occurred_at": "2020-01-01T00:00:00.000Z",
            "data_origin": "live",
        },
    )
    assert r1.status_code == 201, r1.text
    body1 = r1.json()
    assert set(body1.keys()) == {"event_id", "review"}
    ev1 = body1["review"]
    assert body1["event_id"] == ev1["event_id"]
    assert ev1["type"] == "review.recorded"
    assert ev1["seq"] == 1
    assert ev1["prev_hash"] is None
    assert ev1["stream_id"] == f"review:{w['t1_id']}.{w['p1_id']}"
    assert ev1["actor"] == {"role": "therapist", "id": w["t1_id"]}
    assert ev1["scope"] == {"org_id": w["org1"], "participant_id": w["p1_id"]}
    assert ev1["source"] == {"type": "therapist"}
    assert ev1["execution_mode"] == "not_applicable"
    assert ev1["data_origin"] == "synthetic_fixture"
    assert ev1["payload"] == {
        "fact_id": f01_id,
        "content_hash": f01_hash,
        "decision": "approve",
        "note": "Revisado com evidencia completa.",
    }
    stream_evs = store.get_stream_events(ev1["stream_id"])
    _assert_valid_review_or_summary_event(ev1, review_schema, stream_evs)

    # Annotate and reject also work and chain cleanly on the review stream
    r2 = client.post(
        "/api/v3/reviews",
        headers=_headers(w["t1_tok"]),
        json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "annotate", "note": "Nota complementar."},
    )
    assert r2.status_code == 201
    ev2 = r2.json()["review"]
    assert ev2["seq"] == 2 and ev2["prev_hash"] == ev1["hash"]
    _assert_valid_review_or_summary_event(ev2, review_schema, store.get_stream_events(ev1["stream_id"]))

    # Wrong/stale content_hash -> 409 CONTENT_HASH_STALE, nothing stored
    before_count = len(store.get_participant_reviews(w["p1_id"]))
    r_stale = client.post(
        "/api/v3/reviews",
        headers=_headers(w["t1_tok"]),
        json={"fact_id": f01_id, "content_hash": "0" * 64, "decision": "approve", "note": None},
    )
    assert r_stale.status_code == 409
    assert r_stale.json()["error"]["code"] == "CONTENT_HASH_STALE"
    assert len(store.get_participant_reviews(w["p1_id"])) == before_count

    # Unknown fact_id -> 404 NOT_FOUND, nothing stored
    r_unk = client.post(
        "/api/v3/reviews",
        headers=_headers(w["t1_tok"]),
        json={"fact_id": "f_" + "a" * 64, "content_hash": "b" * 64, "decision": "approve", "note": None},
    )
    assert r_unk.status_code == 404
    assert r_unk.json()["error"]["code"] == "NOT_FOUND"
    assert len(store.get_participant_reviews(w["p1_id"])) == before_count

    # Currently unverifiable fact_id (superseded report makes old F04 disappear) -> 404 NOT_FOUND, nothing stored
    old_f04 = w["facts_by_type"]["F04"]
    old_f04_id = old_f04["fact_id"]
    old_f04_hash = w["hashes_by_type"]["F04"]
    last_ev = w["s1_events"][-1]
    rep2 = _rehash(
        {
            "event_id": "",
            "schema_version": 3,
            "type": "report.submitted",
            "stream_id": last_ev["stream_id"],
            "seq": last_ev["seq"] + 1,
            "prev_hash": last_ev["hash"],
            "occurred_at": "2026-11-25T10:01:00.000Z",
            "actor": {"role": "participant", "id": w["p1_id"]},
            "scope": copy.deepcopy(last_ev["scope"]),
            "source": {"type": "participant_report"},
            "execution_mode": "camera",
            "data_origin": "synthetic_fixture",
            "payload": {"execution": "complete", "assistance": "full", "reporter_role": "participant"},
        }
    )
    rb = client.post("/api/v3/events:batch", headers=_headers(w["p1_tok"]), json={"events": [rep2]})
    assert rb.status_code == 200 and rb.json()["results"][0]["status"] == "stored"

    r_unverif = client.post(
        "/api/v3/reviews",
        headers=_headers(w["t1_tok"]),
        json={"fact_id": old_f04_id, "content_hash": old_f04_hash, "decision": "approve", "note": None},
    )
    assert r_unverif.status_code == 404
    assert r_unverif.json()["error"]["code"] == "NOT_FOUND"
    assert len(store.get_participant_reviews(w["p1_id"])) == before_count

    # Invalid decision / empty note / unknown field -> 400, nothing stored
    r_bad_dec = client.post(
        "/api/v3/reviews",
        headers=_headers(w["t1_tok"]),
        json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "maybe", "note": None},
    )
    assert r_bad_dec.status_code == 400 and r_bad_dec.json()["error"]["code"] == "ENUM"
    r_bad_note = client.post(
        "/api/v3/reviews",
        headers=_headers(w["t1_tok"]),
        json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "approve", "note": ""},
    )
    assert r_bad_note.status_code == 400 and r_bad_note.json()["error"]["code"] == "LENGTH"
    assert len(store.get_participant_reviews(w["p1_id"])) == before_count


# ---------------------------------------------------------------------------
# Rows 4 & 5: Publication gate, effective review semantics, stale after change
# ---------------------------------------------------------------------------


def test_effective_review_publication_gate_and_stale_after_change(tmp_path: Path):
    w = _setup_world(tmp_path)
    client = w["client"]
    store = w["store"]
    summary_schema = _load_json(SUMMARY_SCHEMA_PATH)

    f01_id, f01_hash = w["facts_by_type"]["F01"]["fact_id"], w["hashes_by_type"]["F01"]
    f02_id, f02_hash = w["facts_by_type"]["F02"]["fact_id"], w["hashes_by_type"]["F02"]
    f04_id, f04_hash = w["facts_by_type"]["F04"]["fact_id"], w["hashes_by_type"]["F04"]
    f09_id, f09_hash = w["facts_by_type"]["F09"]["fact_id"], w["hashes_by_type"]["F09"]
    f10_id, f10_hash = w["facts_by_type"]["F10"]["fact_id"], w["hashes_by_type"]["F10"]

    def _summary_event_count() -> int:
        return sum(1 for e in store.get_participant_events(w["p1_id"]) if e["type"] == "summary.published")

    # 1. Unreviewed fact -> 422 FACT_NOT_APPROVED, nothing published
    r = client.post("/api/v3/summaries", headers=_headers(w["t1_tok"]), json={"participant_id": w["p1_id"], "fact_ids": [f01_id]})
    assert r.status_code == 422 and r.json()["error"]["code"] == "FACT_NOT_APPROVED"
    assert _summary_event_count() == 0

    # 2. Annotate-only does NOT approve -> 422 FACT_NOT_APPROVED, nothing published
    assert (
        client.post(
            "/api/v3/reviews",
            headers=_headers(w["t1_tok"]),
            json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "annotate", "note": "Observacao inicial"},
        ).status_code
        == 201
    )
    r = client.post("/api/v3/summaries", headers=_headers(w["t1_tok"]), json={"participant_id": w["p1_id"], "fact_ids": [f01_id]})
    assert r.status_code == 422 and r.json()["error"]["code"] == "FACT_NOT_APPROVED"
    assert _summary_event_count() == 0

    # 3. Approve then annotate -> annotate never changes status -> publish SUCCEEDS (201)
    assert (
        client.post(
            "/api/v3/reviews",
            headers=_headers(w["t1_tok"]),
            json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "approve", "note": None},
        ).status_code
        == 201
    )
    assert (
        client.post(
            "/api/v3/reviews",
            headers=_headers(w["t1_tok"]),
            json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "annotate", "note": "Nota pos-aprovacao"},
        ).status_code
        == 201
    )
    r_pub1 = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period_from": "2026-11-25",
            "period_to": "2026-11-25",
            "items": [{"fact_id": f01_id, "content_hash": f01_hash}],
            "note_refs": [],
        },
    )
    assert r_pub1.status_code == 201, r_pub1.text
    assert set(r_pub1.json().keys()) == {"summary_id", "content_hash", "event_id"}
    assert _summary_event_count() == 1

    # Validate stored summary.published event against S0-03 & REF
    stream_evs = store.get_stream_events(f"review:{w['t1_id']}.{w['p1_id']}")
    sum_ev = next(e for e in stream_evs if e["event_id"] == r_pub1.json()["event_id"])
    _assert_valid_review_or_summary_event(sum_ev, summary_schema, stream_evs)
    p = sum_ev["payload"]
    assert p["content_hash"] == hash_canonical({k: v for k, v in p.items() if k != "content_hash"})
    assert r_pub1.json()["content_hash"] == p["content_hash"]

    # Also test D-S1b-03-2 items with stale item content_hash -> 409 CONTENT_HASH_STALE
    r_bad_item_hash = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={
            "period_from": "2026-11-25",
            "period_to": "2026-11-25",
            "items": [{"fact_id": f01_id, "content_hash": "0" * 64}],
            "note_refs": [],
        },
    )
    assert r_bad_item_hash.status_code == 409 and r_bad_item_hash.json()["error"]["code"] == "CONTENT_HASH_STALE"

    # Also test D-S1b-03-2 note_refs validation: unsorted -> 400 NOT_SORTED; unknown ref -> 400 RULE_VIOLATION; valid sorted -> 201
    rev_evs = store.get_participant_reviews(w["p1_id"])
    two_rev_ids = sorted([rev_evs[0]["event_id"], rev_evs[1]["event_id"]])
    r_unsorted = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period_from": "2026-11-25",
            "period_to": "2026-11-25",
            "items": [{"fact_id": f01_id, "content_hash": f01_hash}],
            "note_refs": list(reversed(two_rev_ids)),
        },
    )
    assert r_unsorted.status_code == 400 and r_unsorted.json()["error"]["code"] == "NOT_SORTED"
    r_bad_ref = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period_from": "2026-11-25",
            "period_to": "2026-11-25",
            "items": [{"fact_id": f01_id, "content_hash": f01_hash}],
            "note_refs": ["e" * 64],
        },
    )
    assert r_bad_ref.status_code == 400 and r_bad_ref.json()["error"]["code"] == "RULE_VIOLATION"
    r_good_ref = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={
            "period_from": "2026-11-25",
            "period_to": "2026-11-25",
            "items": [{"fact_id": f01_id, "content_hash": f01_hash}],
            "note_refs": two_rev_ids,
        },
    )
    assert r_good_ref.status_code == 201
    assert _summary_event_count() == 2

    # 4. Mixed set [approved F01, unreviewed F02] -> 422 FACT_NOT_APPROVED, nothing published
    r_mix = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={"participant_id": w["p1_id"], "fact_ids": [f01_id, f02_id]},
    )
    assert r_mix.status_code == 422 and r_mix.json()["error"]["code"] == "FACT_NOT_APPROVED"
    assert _summary_event_count() == 2

    # 5. Approve F02 then reject F02 -> effective decision is reject -> 422 FACT_NOT_APPROVED
    assert (
        client.post(
            "/api/v3/reviews",
            headers=_headers(w["t1_tok"]),
            json={"fact_id": f02_id, "content_hash": f02_hash, "decision": "approve", "note": None},
        ).status_code
        == 201
    )
    assert (
        client.post(
            "/api/v3/reviews",
            headers=_headers(w["t1_tok"]),
            json={"fact_id": f02_id, "content_hash": f02_hash, "decision": "reject", "note": "Revisar"},
        ).status_code
        == 201
    )
    r_rej = client.post(
        "/api/v3/summaries", headers=_headers(w["t1_tok"]), json={"participant_id": w["p1_id"], "fact_ids": [f02_id]}
    )
    assert r_rej.status_code == 422 and r_rej.json()["error"]["code"] == "FACT_NOT_APPROVED"
    assert _summary_event_count() == 2

    # 6. Never-seen & not-derivable fact_id -> 404 NOT_FOUND, nothing published
    r_unk = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={"participant_id": w["p1_id"], "fact_ids": ["f_" + "9" * 64]},
    )
    assert r_unk.status_code == 404 and r_unk.json()["error"]["code"] == "NOT_FOUND"
    assert _summary_event_count() == 2

    # 7. Non-summary-eligible facts (F09, F10) -> 422 FACT_NOT_SUMMARY_ELIGIBLE (both before and after review per D-S1b-03-2)
    for fid, fh in [(f09_id, f09_hash), (f10_id, f10_hash)]:
        r_inelig_pre = client.post(
            "/api/v3/summaries", headers=_headers(w["t1_tok"]), json={"participant_id": w["p1_id"], "fact_ids": [fid]}
        )
        assert r_inelig_pre.status_code == 422 and r_inelig_pre.json()["error"]["code"] == "FACT_NOT_SUMMARY_ELIGIBLE"
        assert (
            client.post(
                "/api/v3/reviews",
                headers=_headers(w["t1_tok"]),
                json={"fact_id": fid, "content_hash": fh, "decision": "approve", "note": None},
            ).status_code
            == 201
        )
        r_inelig = client.post(
            "/api/v3/summaries", headers=_headers(w["t1_tok"]), json={"participant_id": w["p1_id"], "fact_ids": [fid]}
        )
        assert r_inelig.status_code == 422 and r_inelig.json()["error"]["code"] == "FACT_NOT_SUMMARY_ELIGIBLE"
    assert _summary_event_count() == 2

    # 8. Row 4: Approve F04, then append new report.submitted changing ledger -> old F04 approval is STALE (409)
    assert (
        client.post(
            "/api/v3/reviews",
            headers=_headers(w["t1_tok"]),
            json={"fact_id": f04_id, "content_hash": f04_hash, "decision": "approve", "note": None},
        ).status_code
        == 201
    )
    last_ev = w["s1_events"][-1]
    rep2 = _rehash(
        {
            "event_id": "",
            "schema_version": 3,
            "type": "report.submitted",
            "stream_id": last_ev["stream_id"],
            "seq": last_ev["seq"] + 1,
            "prev_hash": last_ev["hash"],
            "occurred_at": "2026-11-25T10:02:00.000Z",
            "actor": {"role": "participant", "id": w["p1_id"]},
            "scope": copy.deepcopy(last_ev["scope"]),
            "source": {"type": "participant_report"},
            "execution_mode": "camera",
            "data_origin": "synthetic_fixture",
            "payload": {"execution": "complete", "assistance": "none", "reporter_role": "participant"},
        }
    )
    rb = client.post("/api/v3/events:batch", headers=_headers(w["p1_tok"]), json={"events": [rep2]})
    assert rb.status_code == 200 and rb.json()["results"][0]["status"] == "stored"

    r_stale_pub = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={"participant_id": w["p1_id"], "fact_ids": [f01_id, f04_id]},
    )
    assert r_stale_pub.status_code == 409
    assert r_stale_pub.json()["error"]["code"] == "CONTENT_HASH_STALE"
    assert _summary_event_count() == 2

    # 9. Also test same-fact_id stale content_hash directly (e.g. review event cites outdated content_hash)
    stale_rev_stream = f"review:{w['t1_id']}.{w['p1_id']}"
    store.append_review_event(
        stale_rev_stream,
        lambda seq, prev_hash: _rehash(
            {
                "event_id": "",
                "schema_version": 3,
                "type": "review.recorded",
                "stream_id": stale_rev_stream,
                "seq": seq,
                "prev_hash": prev_hash,
                "occurred_at": "2026-11-25T10:03:00.000Z",
                "actor": {"role": "therapist", "id": w["t1_id"]},
                "scope": {"org_id": w["org1"], "participant_id": w["p1_id"]},
                "source": {"type": "therapist"},
                "execution_mode": "not_applicable",
                "data_origin": "synthetic_fixture",
                "payload": {
                    "fact_id": f02_id,
                    "content_hash": "1" * 64,
                    "decision": "approve",
                    "note": None,
                },
            }
        ),
    )
    r_stale_hash = client.post(
        "/api/v3/summaries", headers=_headers(w["t1_tok"]), json={"participant_id": w["p1_id"], "fact_ids": [f02_id]}
    )
    assert r_stale_hash.status_code == 409
    assert r_stale_hash.json()["error"]["code"] == "CONTENT_HASH_STALE"
    assert _summary_event_count() == 2


# ---------------------------------------------------------------------------
# Rows 6 & 7: Immutable summaries, idempotency, therapist full & participant simplified views
# ---------------------------------------------------------------------------


def test_immutable_summaries_idempotency_and_get_views(tmp_path: Path):
    w = _setup_world(tmp_path)
    client = w["client"]
    store = w["store"]
    summary_schema = _load_json(SUMMARY_SCHEMA_PATH)

    f01_id, f01_hash = w["facts_by_type"]["F01"]["fact_id"], w["hashes_by_type"]["F01"]
    f04_id, f04_hash = w["facts_by_type"]["F04"]["fact_id"], w["hashes_by_type"]["F04"]
    f01_rendered = w["facts_by_type"]["F01"]["rendered"]
    f04_rendered = w["facts_by_type"]["F04"]["rendered"]

    for fid, fh in [(f01_id, f01_hash), (f04_id, f04_hash)]:
        assert (
            client.post(
                "/api/v3/reviews",
                headers=_headers(w["t1_tok"]),
                json={"fact_id": fid, "content_hash": fh, "decision": "approve", "note": "Aprovado"},
            ).status_code
            == 201
        )

    sum_id = "sum_immut-0001"
    r_first = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={"participant_id": w["p1_id"], "fact_ids": [f01_id], "summary_id": sum_id},
    )
    assert r_first.status_code == 201
    ev_id_1 = r_first.json()["event_id"]
    chash_1 = r_first.json()["content_hash"]

    # Same summary_id with identical content -> 200 idempotent, no duplicate event
    r_idem = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={"participant_id": w["p1_id"], "fact_ids": [f01_id], "summary_id": sum_id},
    )
    assert r_idem.status_code == 200
    assert r_idem.json() == {"summary_id": sum_id, "content_hash": chash_1, "event_id": ev_id_1}

    # Same summary_id with DIFFERENT content -> 409 CONFLICT_IMMUTABLE
    r_conf = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={"participant_id": w["p1_id"], "fact_ids": [f01_id, f04_id], "summary_id": sum_id},
    )
    assert r_conf.status_code == 409
    assert r_conf.json()["error"]["code"] == "CONFLICT_IMMUTABLE"

    # SQLite triggers block direct UPDATE/DELETE on v3_summaries
    with pytest.raises(sqlite3.IntegrityError):
        store.db.execute("UPDATE v3_summaries SET content_hash = '0' WHERE summary_id = ?", (sum_id,))
    with pytest.raises(sqlite3.IntegrityError):
        store.db.execute("DELETE FROM v3_summaries WHERE summary_id = ?", (sum_id,))

    # Therapist gets full summary.published event
    r_t = client.get(f"/api/v3/summaries/{sum_id}", headers=_headers(w["t1_tok"]))
    assert r_t.status_code == 200
    t_body = r_t.json()
    assert t_body["type"] == "summary.published"
    assert t_body["event_id"] == ev_id_1
    assert t_body["payload"]["summary_id"] == sum_id
    assert t_body["payload"]["items"] == [{"fact_id": f01_id, "content_hash": f01_hash}]
    _assert_valid_review_or_summary_event(t_body, summary_schema, store.get_stream_events(t_body["stream_id"]))

    # Participant gets simplified own view: ONLY summary_id, published_at, period, rendered_facts
    r_p = client.get(f"/api/v3/summaries/{sum_id}", headers=_headers(w["p1_tok"]))
    assert r_p.status_code == 200
    p_body = r_p.json()
    assert set(p_body.keys()) == {"summary_id", "published_at", "period", "rendered_facts"}
    assert p_body["summary_id"] == sum_id
    assert p_body["published_at"] == t_body["occurred_at"]
    assert p_body["period"] == {"from": t_body["payload"]["period_from"], "to": t_body["payload"]["period_to"]}
    assert p_body["rendered_facts"] == [
        {"text_ptbr": f01_rendered["text_ptbr"], "limitations_ptbr": f01_rendered["limitations_ptbr"]}
    ]
    for forbidden_key in ("actor", "event_id", "hash", "scope", "note_refs", "content_hash", "stream_id"):
        assert forbidden_key not in p_body

    # Publish a second summary containing F04, then mutate the session ledger: published summary remains immutable!
    r_s2 = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={"participant_id": w["p1_id"], "fact_ids": [f04_id], "summary_id": "sum_immut-0002"},
    )
    assert r_s2.status_code == 201
    last_ev = w["s1_events"][-1]
    rep2 = _rehash(
        {
            "event_id": "",
            "schema_version": 3,
            "type": "report.submitted",
            "stream_id": last_ev["stream_id"],
            "seq": last_ev["seq"] + 1,
            "prev_hash": last_ev["hash"],
            "occurred_at": "2026-11-25T10:04:00.000Z",
            "actor": {"role": "participant", "id": w["p1_id"]},
            "scope": copy.deepcopy(last_ev["scope"]),
            "source": {"type": "participant_report"},
            "execution_mode": "camera",
            "data_origin": "synthetic_fixture",
            "payload": {"execution": "complete", "assistance": "full", "reporter_role": "participant"},
        }
    )
    assert client.post("/api/v3/events:batch", headers=_headers(w["p1_tok"]), json={"events": [rep2]}).status_code == 200

    r_p_after = client.get("/api/v3/summaries/sum_immut-0002", headers=_headers(w["p1_tok"]))
    assert r_p_after.status_code == 200
    assert r_p_after.json()["rendered_facts"] == [
        {"text_ptbr": f04_rendered["text_ptbr"], "limitations_ptbr": f04_rendered["limitations_ptbr"]}
    ]


# ---------------------------------------------------------------------------
# Rows 8 & 10: Server-authored only & complete authorization matrix
# ---------------------------------------------------------------------------


def test_server_authored_only_and_authorization_matrix(tmp_path: Path):
    w = _setup_world(tmp_path)
    client = w["client"]
    store = w["store"]

    f01_id, f01_hash = w["facts_by_type"]["F01"]["fact_id"], w["hashes_by_type"]["F01"]

    # Approve F01 and publish a summary for get-authz checks
    assert (
        client.post(
            "/api/v3/reviews",
            headers=_headers(w["t1_tok"]),
            json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "approve", "note": None},
        ).status_code
        == 201
    )
    sum_id = client.post(
        "/api/v3/summaries", headers=_headers(w["t1_tok"]), json={"participant_id": w["p1_id"], "fact_ids": [f01_id]}
    ).json()["summary_id"]

    # Row 8: review.recorded & summary.published sent through events:batch stay FORBIDDEN
    client_review_ev = _rehash(
        {
            "event_id": "",
            "schema_version": 3,
            "type": "review.recorded",
            "stream_id": f"review:{w['t1_id']}.{w['p1_id']}",
            "seq": 99,
            "prev_hash": "a" * 64,
            "occurred_at": "2026-11-25T10:10:00.000Z",
            "actor": {"role": "therapist", "id": w["t1_id"]},
            "scope": {"org_id": w["org1"], "participant_id": w["p1_id"]},
            "source": {"type": "therapist"},
            "execution_mode": "not_applicable",
            "data_origin": "synthetic_fixture",
            "payload": {"fact_id": f01_id, "content_hash": f01_hash, "decision": "approve", "note": None},
        }
    )
    sum_payload_wo = {
        "summary_id": "sum_forged-0001",
        "period_from": "2026-11-25",
        "period_to": "2026-11-25",
        "items": [{"fact_id": f01_id, "content_hash": f01_hash}],
        "note_refs": [],
    }
    client_summary_ev = _rehash(
        {
            "event_id": "",
            "schema_version": 3,
            "type": "summary.published",
            "stream_id": f"review:{w['t1_id']}.{w['p1_id']}",
            "seq": 100,
            "prev_hash": client_review_ev["hash"],
            "occurred_at": "2026-11-25T10:11:00.000Z",
            "actor": {"role": "therapist", "id": w["t1_id"]},
            "scope": {"org_id": w["org1"], "participant_id": w["p1_id"]},
            "source": {"type": "therapist"},
            "execution_mode": "not_applicable",
            "data_origin": "synthetic_fixture",
            "payload": {**sum_payload_wo, "content_hash": hash_canonical(sum_payload_wo)},
        }
    )
    r_forged_batch = client.post(
        "/api/v3/events:batch",
        headers=_headers(w["p1_tok"]),
        json={"events": [client_review_ev, client_summary_ev]},
    )
    assert r_forged_batch.status_code == 200
    for item in r_forged_batch.json()["results"]:
        assert item["status"] == "rejected"
        assert "FORBIDDEN" in item["codes"]
    assert store.get_summary_record("sum_forged-0001") is None

    # Row 10: No token -> 401 UNAUTHENTICATED
    assert client.post("/api/v3/reviews", json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "approve"}).status_code == 401
    assert client.post("/api/v3/summaries", json={"participant_id": w["p1_id"], "fact_ids": [f01_id]}).status_code == 401
    assert client.get(f"/api/v3/summaries/{sum_id}").status_code == 401

    # Row 10: Forged role (caregiver, supervisor) -> 403 ROLE_NOT_ALLOWED
    for bad_role in ("caregiver", "supervisor"):
        tok = _insert_raw_token(store, role=bad_role, principal_id="t_forged-0001", org_id=w["org1"])
        for resp in (
            client.post("/api/v3/reviews", headers=_headers(tok), json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "approve"}),
            client.post("/api/v3/summaries", headers=_headers(tok), json={"participant_id": w["p1_id"], "fact_ids": [f01_id]}),
            client.get(f"/api/v3/summaries/{sum_id}", headers=_headers(tok)),
        ):
            assert resp.status_code == 403 and resp.json()["error"]["code"] == "ROLE_NOT_ALLOWED"

    # Row 10: Participant on reviews.record / summaries.publish -> 403 FORBIDDEN
    r_p_rev = client.post(
        "/api/v3/reviews",
        headers=_headers(w["p1_tok"]),
        json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "approve", "note": None},
    )
    assert r_p_rev.status_code == 403 and r_p_rev.json()["error"]["code"] == "FORBIDDEN"
    r_p_pub = client.post(
        "/api/v3/summaries",
        headers=_headers(w["p1_tok"]),
        json={"participant_id": w["p1_id"], "fact_ids": [f01_id]},
    )
    assert r_p_pub.status_code == 403 and r_p_pub.json()["error"]["code"] == "FORBIDDEN"

    # Row 10 & Row 7: Unlinked therapist (T2) and other-org therapist (T_other)
    for tok in (w["t2_tok"], w["t_other_tok"]):
        r_rev = client.post(
            "/api/v3/reviews",
            headers=_headers(tok),
            json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "approve", "note": None},
        )
        assert r_rev.status_code == 403 and r_rev.json()["error"]["code"] == "SCOPE_VIOLATION"
        r_pub = client.post(
            "/api/v3/summaries",
            headers=_headers(tok),
            json={"participant_id": w["p1_id"], "fact_ids": [f01_id]},
        )
        assert r_pub.status_code == 403 and r_pub.json()["error"]["code"] == "SCOPE_VIOLATION"
        # summaries.get is read-by-id -> 404 NOT_FOUND (D-S0-02-1)
        r_get = client.get(f"/api/v3/summaries/{sum_id}", headers=_headers(tok))
        assert r_get.status_code == 404 and r_get.json()["error"]["code"] == "NOT_FOUND"

    # Other participant (P2) on summaries.get -> 404 NOT_FOUND; unknown summary_id -> 404 NOT_FOUND
    assert client.get(f"/api/v3/summaries/{sum_id}", headers=_headers(w["p2_tok"])).status_code == 404
    assert client.get("/api/v3/summaries/sum_unknown-9999", headers=_headers(w["t1_tok"])).status_code == 404

    # Revoked care_link therapist (T1 after revoking CL1)
    assert client.post(f"/api/v3/care-links/{w['cl1_id']}:revoke", headers=_headers(w["t1_tok"])).status_code == 200
    r_rev_after = client.post(
        "/api/v3/reviews",
        headers=_headers(w["t1_tok"]),
        json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "approve", "note": None},
    )
    assert r_rev_after.status_code == 403 and r_rev_after.json()["error"]["code"] == "SCOPE_VIOLATION"
    r_pub_after = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={"participant_id": w["p1_id"], "fact_ids": [f01_id]},
    )
    assert r_pub_after.status_code == 403 and r_pub_after.json()["error"]["code"] == "SCOPE_VIOLATION"
    r_get_after = client.get(f"/api/v3/summaries/{sum_id}", headers=_headers(w["t1_tok"]))
    assert r_get_after.status_code == 404 and r_get_after.json()["error"]["code"] == "NOT_FOUND"


# ---------------------------------------------------------------------------
# Row 9: Service adversarial cases V3-S7..V3-S10 iterated from cases.v3.json
# ---------------------------------------------------------------------------


def test_service_cases_v3_s7_to_s10_iterated_from_cases_file(tmp_path: Path):
    w = _setup_world(tmp_path)
    client = w["client"]
    store = w["store"]

    cases_doc = _load_json(CASES_PATH)["cases"]
    target_ids = {"V3-S7", "V3-S8", "V3-S9", "V3-S10"}
    selected_cases = [c for c in cases_doc if c["id"] in target_ids]
    assert {c["id"] for c in selected_cases} == target_ids
    assert all(c["layer"] == "service" for c in selected_cases)

    f01_id, f01_hash = w["facts_by_type"]["F01"]["fact_id"], w["hashes_by_type"]["F01"]

    for case in selected_cases:
        cid = case["id"]
        expected_code = case["expect"]["code"]

        if cid == "V3-S7":
            expected_parts = {part.strip() for part in expected_code.split("/")}
            assert expected_parts == {"FORBIDDEN", "ROLE_NOT_ALLOWED"}

            # Sub-case 1: participant calls therapist-only routes -> FORBIDDEN
            for resp in (
                client.post(
                    "/api/v3/reviews",
                    headers=_headers(w["p1_tok"]),
                    json={"fact_id": f01_id, "content_hash": f01_hash, "decision": "approve", "note": None},
                ),
                client.post(
                    "/api/v3/summaries",
                    headers=_headers(w["p1_tok"]),
                    json={"participant_id": w["p1_id"], "fact_ids": [f01_id]},
                ),
                client.get(f"/api/v3/participants/{w['p1_id']}/facts", headers=_headers(w["p1_tok"])),
            ):
                assert resp.status_code == 403
                assert resp.json()["error"]["code"] == "FORBIDDEN"

            # Sub-case 2: principal with role caregiver / supervisor -> ROLE_NOT_ALLOWED
            for bad_role in ("caregiver", "supervisor"):
                tok = _insert_raw_token(store, role=bad_role, principal_id="t_s7role-0001", org_id=w["org1"])
                resp = client.get(f"/api/v3/participants/{w['p1_id']}/facts", headers=_headers(tok))
                assert resp.status_code == 403
                assert resp.json()["error"]["code"] == "ROLE_NOT_ALLOWED"

        elif cid == "V3-S8":
            # Therapist without active care_link reads participant -> SCOPE_VIOLATION
            resp = client.get(f"/api/v3/participants/{w['p1_id']}/facts", headers=_headers(w["t2_tok"]))
            assert resp.status_code == 403
            assert resp.json()["error"]["code"] == expected_code

        elif cid == "V3-S9":
            # events.batch with data_origin=live while real-data gate is closed -> REAL_DATA_GATE_CLOSED
            live_ev = _rehash(
                {
                    "event_id": "",
                    "schema_version": 3,
                    "type": "consent.accepted",
                    "stream_id": f"consent:{w['p1_id']}",
                    "seq": 2,
                    "prev_hash": store.get_stream_events(f"consent:{w['p1_id']}")[-1]["hash"],
                    "occurred_at": "2026-11-25T10:15:00.000Z",
                    "actor": {"role": "participant", "id": w["p1_id"]},
                    "scope": {"org_id": w["org1"], "participant_id": w["p1_id"]},
                    "source": {"type": "participant_report"},
                    "execution_mode": "not_applicable",
                    "data_origin": "live",
                    "payload": {"consent_version": "consent-2026-11-23-v1", "scopes": ["camera"]},
                }
            )
            resp = client.post("/api/v3/events:batch", headers=_headers(w["p1_tok"]), json={"events": [live_ev]})
            assert resp.status_code == 200
            item = resp.json()["results"][0]
            assert item["status"] == "rejected"
            assert expected_code in item["codes"]

        elif cid == "V3-S10":
            # Append v3 event to a legacy schema_version 2 stream -> LEGACY_STREAM_READ_ONLY
            legacy_events = _load_json(LEGACY_LEDGER_PATH)["events"]
            legacy_consent = next(e for e in legacy_events if e["type"] == "consent.accepted")
            legacy_pid = legacy_consent["scope"]["participant_id"]
            legacy_org = legacy_consent["scope"]["org_id"]
            store.import_legacy_events([legacy_consent])

            legacy_p_tok = _insert_raw_token(store, role="participant", principal_id=legacy_pid, org_id=legacy_org)
            v3_on_legacy = _rehash(
                {
                    "event_id": "",
                    "schema_version": 3,
                    "type": "consent.accepted",
                    "stream_id": legacy_consent["stream_id"],
                    "seq": legacy_consent["seq"] + 1,
                    "prev_hash": legacy_consent["hash"],
                    "occurred_at": "2026-11-25T10:20:00.000Z",
                    "actor": {"role": "participant", "id": legacy_pid},
                    "scope": {"org_id": legacy_org, "participant_id": legacy_pid},
                    "source": {"type": "participant_report"},
                    "execution_mode": "not_applicable",
                    "data_origin": "synthetic_fixture",
                    "payload": {"consent_version": "consent-2026-11-23-v1", "scopes": ["camera"]},
                }
            )
            resp = client.post("/api/v3/events:batch", headers=_headers(legacy_p_tok), json={"events": [v3_on_legacy]})
            assert resp.status_code == 200
            item = resp.json()["results"][0]
            assert item["status"] == "rejected"
            assert expected_code in item["codes"]

        else:
            raise AssertionError(f"Unhandled case {cid}")


# ---------------------------------------------------------------------------
# Seeded differential rehearsal (120 operations across approve/reject/annotate/stale/publish)
# ---------------------------------------------------------------------------


def test_seeded_review_publish_sequences_against_oracle(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(elo_api, "RATE_LIMIT", (10000, 60.0))
    w = _setup_world(tmp_path)
    client = w["client"]
    rng = random.Random(2026112503)

    eligible_types = ["F01", "F02", "F03", "F04", "F06"]
    current_facts = {ft: w["facts_by_type"][ft]["fact_id"] for ft in eligible_types}
    current_hashes = {w["facts_by_type"][ft]["fact_id"]: w["hashes_by_type"][ft] for ft in eligible_types}
    known_fids = list(current_facts.values())

    # Independent oracle state: effective_decision[fid] = (decision, approved_hash)
    seen: set[str] = set()
    effective: dict[str, tuple[str, str]] = {}
    published: dict[str, set[str]] = {}
    last_s1_ev = w["s1_events"][-1]
    report_counter = 0

    for step in range(120):
        action = rng.choice(["review_ok", "review_stale", "publish", "publish", "republish", "mutate_report"])

        if action == "mutate_report" and report_counter < 3:
            report_counter += 1
            new_assist = ["none", "full", "some"][report_counter % 3]
            new_rep = _rehash(
                {
                    "event_id": "",
                    "schema_version": 3,
                    "type": "report.submitted",
                    "stream_id": last_s1_ev["stream_id"],
                    "seq": last_s1_ev["seq"] + 1,
                    "prev_hash": last_s1_ev["hash"],
                    "occurred_at": f"2026-11-25T11:{report_counter:02d}:00.000Z",
                    "actor": {"role": "participant", "id": w["p1_id"]},
                    "scope": copy.deepcopy(last_s1_ev["scope"]),
                    "source": {"type": "participant_report"},
                    "execution_mode": "camera",
                    "data_origin": "synthetic_fixture",
                    "payload": {"execution": "complete", "assistance": new_assist, "reporter_role": "participant"},
                }
            )
            rb = client.post("/api/v3/events:batch", headers=_headers(w["p1_tok"]), json={"events": [new_rep]})
            assert rb.status_code == 200 and rb.json()["results"][0]["status"] == "stored"
            last_s1_ev = new_rep

            refreshed = client.get(f"/api/v3/participants/{w['p1_id']}/facts", headers=_headers(w["t1_tok"])).json()["facts"]
            by_t = {f["type"]: f for f in refreshed}
            current_facts = {ft: by_t[ft]["fact_id"] for ft in eligible_types}
            current_hashes = {by_t[ft]["fact_id"]: compute_content_hash(by_t[ft]) for ft in eligible_types}
            for fid in current_facts.values():
                if fid not in known_fids:
                    known_fids.append(fid)
            continue

        if action == "review_ok":
            fid = rng.choice(list(current_facts.values()))
            dec = rng.choice(["approve", "reject", "annotate"])
            resp = client.post(
                "/api/v3/reviews",
                headers=_headers(w["t1_tok"]),
                json={"fact_id": fid, "content_hash": current_hashes[fid], "decision": dec, "note": f"step-{step}"},
            )
            assert resp.status_code == 201
            seen.add(fid)
            if dec in ("approve", "reject"):
                effective[fid] = (dec, current_hashes[fid])

        elif action == "review_stale":
            fid = rng.choice(list(current_facts.values()))
            resp = client.post(
                "/api/v3/reviews",
                headers=_headers(w["t1_tok"]),
                json={"fact_id": fid, "content_hash": "f" * 64, "decision": "approve", "note": None},
            )
            assert resp.status_code == 409 and resp.json()["error"]["code"] == "CONTENT_HASH_STALE"

        elif action == "republish" and published:
            sid = rng.choice(list(published.keys()))
            orig_set = published[sid]
            # Only test republish when all facts in orig_set are still currently approved
            if all(fid in current_hashes and effective.get(fid) == ("approve", current_hashes[fid]) for fid in orig_set):
                if rng.random() < 0.5:
                    # Identical content -> 200 idempotent
                    r_id = client.post(
                        "/api/v3/summaries",
                        headers=_headers(w["t1_tok"]),
                        json={"participant_id": w["p1_id"], "fact_ids": sorted(orig_set), "summary_id": sid},
                    )
                    assert r_id.status_code == 200 and r_id.json()["summary_id"] == sid
                else:
                    # Find another approved fact to form a different set -> 409 CONFLICT_IMMUTABLE
                    other_approved = [
                        fid
                        for fid in current_hashes
                        if fid not in orig_set and effective.get(fid) == ("approve", current_hashes[fid])
                    ]
                    if other_approved:
                        diff_set = sorted(orig_set | {other_approved[0]})
                        r_cf = client.post(
                            "/api/v3/summaries",
                            headers=_headers(w["t1_tok"]),
                            json={"participant_id": w["p1_id"], "fact_ids": diff_set, "summary_id": sid},
                        )
                        assert r_cf.status_code == 409 and r_cf.json()["error"]["code"] == "CONFLICT_IMMUTABLE"

        else:
            # Publish a subset of known_fids and compare with independent oracle
            k = rng.randint(1, min(3, len(known_fids)))
            chosen = rng.sample(known_fids, k)
            expected_status = 201
            expected_err: str | None = None
            for fid in chosen:
                eff = effective.get(fid)
                if fid not in current_hashes:
                    if eff is not None and eff[0] == "approve":
                        expected_status, expected_err = 409, "CONTENT_HASH_STALE"
                    elif eff is not None or fid in seen:
                        expected_status, expected_err = 422, "FACT_NOT_APPROVED"
                    else:
                        expected_status, expected_err = 404, "NOT_FOUND"
                    break
                if eff is None or eff[0] != "approve":
                    expected_status, expected_err = 422, "FACT_NOT_APPROVED"
                    break
                if eff[1] != current_hashes[fid]:
                    expected_status, expected_err = 409, "CONTENT_HASH_STALE"
                    break

            resp = client.post(
                "/api/v3/summaries",
                headers=_headers(w["t1_tok"]),
                json={"participant_id": w["p1_id"], "fact_ids": chosen},
            )
            assert resp.status_code == expected_status, (step, chosen, resp.status_code, resp.text)
            if expected_err is not None:
                assert resp.json()["error"]["code"] == expected_err
            else:
                published[resp.json()["summary_id"]] = set(chosen)
