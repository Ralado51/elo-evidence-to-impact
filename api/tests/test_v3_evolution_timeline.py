"""CL06.3 v3 evolution and timeline API tests (S1-01, ACCEPTANCE v2 Rows 1–12).

Covers D-S1-01-1..7 (DECISIONS-E3.md) and R1..R14 (DECISIONS-E3-rev2.md):
- Row 1: exact contract routes (evolution.series, evolution.publish, evolution.get, timeline.get)
- Row 2: review gate (GET omits unreviewed/rejected/stale; series_keys selects approved only;
         explicit publish enforces D-S1-01-3 1..6 precedence, storing nothing on error)
- Row 3: comparability rules (cmp-v1 14-field key reproducing ledger fixture 452121f7...6576,
         split notices, context_changes, COMPARABILITY_VIOLATION on mixed points/origins)
- Row 4: unreported-assistance barrier (R2/R11, helper NO_TRANSITION_PRODUCED, publish succeeds)
- Row 5: published evolution.published event valid per S0-03 validate_event & CL06.3 REF
- Row 6: immutability, R7 historical snapshot, R12 replay fingerprint, 409 CONFLICT_IMMUTABLE
- Row 7: origin & execution_mode preserved everywhere (series_key, participant view, timeline)
- Row 8: therapist full view vs participant simplified view (no hashes/note_refs/actors); 404 by id
- Row 9: timeline.get unified entities + published events in R3/R4 total order
- Row 10: evolution.published via events:batch stays FORBIDDEN
- Row 11: adversarial service cases V3-S1..V3-S4 iterated from cases.v3.json
- Row 12: authorization matrix (401 UNAUTHENTICATED, 403 FORBIDDEN / SCOPE_VIOLATION / ROLE_NOT_ALLOWED)
"""

from __future__ import annotations

import copy
import importlib.util
import json
import random
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import elo.api as elo_api
from elo.api import create_app
from elo.canonical import compute_event_hash, compute_event_id, hash_canonical
from elo.v3.authz import Principal
from elo.v3.evolution import (
    NO_TRANSITION_PRODUCED,
    build_series_key,
    check_series_comparability,
    compute_assistance_transition,
    origin_label_for,
)
from elo.v3.validation import validate_event

REPO_ROOT = Path(__file__).resolve().parents[2]
PKG_ROOT = REPO_ROOT / "contracts" / "CL06_3-r1"
API_CONTRACT_PATH = PKG_ROOT / "contracts" / "api" / "api-contract.v3.json"
EVENT_CATALOG_PATH = PKG_ROOT / "contracts" / "catalogs" / "event-catalog.v3.json"
LIMITS_PATH = PKG_ROOT / "contracts" / "catalogs" / "limits.v1.json"
LIMITATIONS_PATH = PKG_ROOT / "contracts" / "catalogs" / "limitations.v2.json"
CMP_RULES_PATH = PKG_ROOT / "contracts" / "catalogs" / "comparability-rules.v1.json"
PROGRESS_SERIES_SCHEMA_PATH = PKG_ROOT / "contracts" / "schemas" / "progress-series.schema.json"
EVOLUTION_SCHEMA_PATH = PKG_ROOT / "contracts" / "schemas" / "events" / "evolution.published.schema.json"
ADVERSARIAL_CASES_PATH = PKG_ROOT / "fixtures" / "adversarial" / "cases.v3.json"
VALID_LEDGER_PATH = PKG_ROOT / "fixtures" / "valid" / "ledger.v3.json"
REF_PY_PATH = PKG_ROOT / "reference" / "python" / "elo_ref.py"

EXPECTED_V3_ROUTE_IDS: set[str] = {
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


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_ref():
    spec = importlib.util.spec_from_file_location("s1_01_cl06_3_elo_ref", REF_PY_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _rehash(ev: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(ev)
    out.pop("hash", None)
    out["event_id"] = compute_event_id(out["stream_id"], out["seq"])
    out["hash"] = compute_event_hash(out)
    return out


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


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


def _make_world(tmp_path: Path, *, real_data_gate_open: bool = False) -> dict[str, Any]:
    """Create isolated v3 app with linked therapist T1, unlinked T2, other-org T3, and participants P1, P2."""
    app = create_app(data_dir=str(tmp_path))
    store = app.state.v3_store
    if real_data_gate_open:
        store.real_data_gate_open = True
        store.ledger.real_data_gate_open = True
    client = TestClient(app)

    store.seed_therapist(
        therapist_id="t_evo-0001",
        username="therapist_evo_1",
        password="synthetic-password-1",
        org_id="o_evo-0001",
        display_label="Synthetic Therapist Evo 1",
    )
    store.seed_therapist(
        therapist_id="t_evo-0002",
        username="therapist_evo_2",
        password="synthetic-password-2",
        org_id="o_evo-0001",
        display_label="Synthetic Therapist Evo 2",
    )
    store.seed_therapist(
        therapist_id="t_evo-0003",
        username="therapist_evo_3",
        password="synthetic-password-3",
        org_id="o_evo-0002",
        display_label="Synthetic Therapist Evo 3",
    )

    def _login(u: str, p: str) -> str:
        r = client.post("/api/v3/auth/therapist", json={"username": u, "password": p})
        assert r.status_code == 200, r.text
        return r.json()["token"]

    t1_tok = _login("therapist_evo_1", "synthetic-password-1")
    t2_tok = _login("therapist_evo_2", "synthetic-password-2")
    t3_tok = _login("therapist_evo_3", "synthetic-password-3")

    r_p1 = client.post(
        "/api/v3/participants",
        headers=_headers(t1_tok),
        json={"alias": "Synthetic Evo P1", "side": "right"},
    )
    assert r_p1.status_code == 201, r_p1.text
    p1_id = r_p1.json()["entity_id"]
    cl1_id = r_p1.headers["X-Elo-Care-Link-Id"]

    r_inv1 = client.post("/api/v3/invites", headers=_headers(t1_tok), json={"participant_id": p1_id})
    assert r_inv1.status_code == 201, r_inv1.text
    r_p1_auth = client.post("/api/v3/auth/invite", json={"invite_token": r_inv1.json()["invite_token"]})
    assert r_p1_auth.status_code == 200, r_p1_auth.text
    p1_tok = r_p1_auth.json()["token"]

    r_p2 = client.post(
        "/api/v3/participants",
        headers=_headers(t2_tok),
        json={"alias": "Synthetic Evo P2", "side": "right"},
    )
    assert r_p2.status_code == 201, r_p2.text
    p2_id = r_p2.json()["entity_id"]

    r_inv2 = client.post("/api/v3/invites", headers=_headers(t2_tok), json={"participant_id": p2_id})
    assert r_inv2.status_code == 201, r_inv2.text
    r_p2_auth = client.post("/api/v3/auth/invite", json={"invite_token": r_inv2.json()["invite_token"]})
    assert r_p2_auth.status_code == 200, r_p2_auth.text
    p2_tok = r_p2_auth.json()["token"]

    return {
        "app": app,
        "store": store,
        "client": client,
        "org1": "o_evo-0001",
        "org2": "o_evo-0002",
        "t1_id": "t_evo-0001",
        "t2_id": "t_evo-0002",
        "t3_id": "t_evo-0003",
        "t1_tok": t1_tok,
        "t2_tok": t2_tok,
        "t3_tok": t3_tok,
        "p1_id": p1_id,
        "p1_tok": p1_tok,
        "cl1_id": cl1_id,
        "p2_id": p2_id,
        "p2_tok": p2_tok,
    }


def _publish_rx(
    client: TestClient,
    t_tok: str,
    pid: str,
    *,
    side: str = "right",
    target_sets: int = 1,
    target_repetitions: int = 2,
    valid_from: str = "2026-11-01",
    valid_to: str = "2026-12-31",
) -> tuple[str, int]:
    resp = client.post(
        "/api/v3/prescriptions",
        headers=_headers(t_tok),
        json={
            "participant_id": pid,
            "exercise_id": "organizar-a-mesa",
            "permitted_movement": "hand_open_close",
            "side": side,
            "target_sets": target_sets,
            "target_repetitions": target_repetitions,
            "sessions_per_week": 5,
            "valid_from": valid_from,
            "valid_to": valid_to,
            "timezone": "America/Sao_Paulo",
            "min_calibration_span": None,
            "instructions_ptbr": "Abra e feche a mão no seu ritmo.",
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    return body["prescription_id"], body["revision"]


def _seed_rx_with_origin(
    store,
    org_id: str,
    therapist_id: str,
    pid: str,
    rx_id: str,
    *,
    side: str = "right",
    target_sets: int = 1,
    target_repetitions: int = 2,
    revision: int = 1,
    prev_hash: str | None = None,
    data_origin: str = "synthetic_fixture",
    origin_ref: str | None = None,
    occurred_at: str = "2026-11-20T10:00:00.000Z",
) -> dict[str, Any]:
    """Insert a schema-valid prescription.published event with explicit data_origin for cross-origin tests."""
    ev: dict[str, Any] = {
        "schema_version": 3,
        "type": "prescription.published",
        "stream_id": f"prescription:{rx_id}",
        "seq": revision,
        "prev_hash": prev_hash,
        "occurred_at": occurred_at,
        "actor": {"role": "therapist", "id": therapist_id},
        "scope": {
            "org_id": org_id,
            "participant_id": pid,
            "prescription_id": rx_id,
            "prescription_revision": revision,
            "exercise_id": "organizar-a-mesa",
        },
        "source": {"type": "therapist"},
        "execution_mode": "not_applicable",
        "data_origin": data_origin,
        "payload": {
            "participant_id": pid,
            "exercise_id": "organizar-a-mesa",
            "permitted_movement": "hand_open_close",
            "side": side,
            "target_sets": target_sets,
            "target_repetitions": target_repetitions,
            "sessions_per_week": 5,
            "valid_from": "2026-11-01",
            "valid_to": "2026-12-31",
            "timezone": "America/Sao_Paulo",
            "min_calibration_span": None,
            "instructions_ptbr": "Abra e feche a mão no seu ritmo.",
            "prescription_id": rx_id,
            "revision": revision,
            "supersedes_revision": revision - 1 if revision > 1 else None,
            "created_by": therapist_id,
            "created_at": occurred_at,
            "limits_version": "limits-v1",
        },
    }
    if origin_ref is not None:
        ev["origin_ref"] = origin_ref
    ev = _rehash(ev)
    store.insert_prescription_revision(ev, is_new_stream=False)
    return ev


def _grant_camera_consent(
    client: TestClient,
    p_tok: str,
    org_id: str,
    pid: str,
    *,
    data_origin: str = "synthetic_fixture",
    origin_ref: str | None = None,
    seq: int = 1,
    prev_hash: str | None = None,
    occurred_at: str = "2026-11-20T12:00:00.000Z",
) -> dict[str, Any]:
    ev: dict[str, Any] = {
        "schema_version": 3,
        "type": "consent.accepted",
        "stream_id": f"consent:{pid}",
        "seq": seq,
        "prev_hash": prev_hash,
        "occurred_at": occurred_at,
        "actor": {"role": "participant", "id": pid},
        "scope": {"org_id": org_id, "participant_id": pid},
        "source": {"type": "participant_report"},
        "execution_mode": "not_applicable",
        "data_origin": data_origin,
        "payload": {"consent_version": "consent-2026-11-20-v1", "scopes": ["camera"]},
    }
    if origin_ref is not None:
        ev["origin_ref"] = origin_ref
    ev = _rehash(ev)
    resp = client.post("/api/v3/events:batch", headers=_headers(p_tok), json={"events": [ev]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["results"][0]["status"] in ("stored", "duplicate"), resp.json()
    return ev


def _append_capture_session(
    client: TestClient,
    p_tok: str,
    org_id: str,
    pid: str,
    rx_id: str,
    rx_rev: int,
    session_id: str,
    *,
    occurred_day: str = "2026-11-23",
    start_hhmmss: str = "13:00:00",
    mode: str = "camera",
    side: str = "right",
    target_cycles: int = 2,
    usable_fraction: float | None = 0.85,
    algorithm_version: str = "c05-hand-2",
    data_origin: str = "synthetic_fixture",
    origin_ref: str | None = None,
    assistance: str | None = "some",
    execution: str = "complete",
    end_action: str | None = None,
    include_measurement: bool = False,
) -> list[dict[str, Any]]:
    """Append a valid terminal capture session (camera or simulation) via events:batch."""
    stream_id = f"session:{session_id}"
    scope = {
        "org_id": org_id,
        "participant_id": pid,
        "session_id": session_id,
        "prescription_id": rx_id,
        "prescription_revision": rx_rev,
        "exercise_id": "organizar-a-mesa",
    }
    cap_source = {"type": mode, "algorithm_version": algorithm_version, "device_hint": "desktop-chrome"}
    rep_source = {"type": "participant_report"}
    events: list[dict[str, Any]] = []
    seq = 1
    prev: str | None = None

    def _ts(offset_sec: int) -> str:
        hh, mm, ss = [int(x) for x in start_hhmmss.split(":")]
        total = hh * 3600 + mm * 60 + ss + offset_sec
        return f"{occurred_day}T{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}.000Z"

    def _add(
        ev_type: str,
        payload: dict[str, Any],
        *,
        source: dict[str, Any],
        t_mono_ms: int | None,
        offset_sec: int,
    ) -> dict[str, Any]:
        nonlocal seq, prev
        ev: dict[str, Any] = {
            "schema_version": 3,
            "type": ev_type,
            "stream_id": stream_id,
            "seq": seq,
            "prev_hash": prev,
            "occurred_at": _ts(offset_sec),
            "actor": {"role": "participant", "id": pid},
            "scope": dict(scope),
            "source": dict(source),
            "execution_mode": mode,
            "data_origin": data_origin,
            "payload": payload,
        }
        if t_mono_ms is not None:
            ev["t_mono_ms"] = t_mono_ms
        if origin_ref is not None:
            ev["origin_ref"] = origin_ref
        ev = _rehash(ev)
        events.append(ev)
        prev = ev["hash"]
        seq += 1
        return ev

    _add(
        "session.started",
        {
            "source_mode": mode,
            "prescription_id": rx_id,
            "prescription_revision": rx_rev,
            "capture_context": {"device_hint": "desktop-chrome", "frame_width": 640, "frame_height": 480},
        },
        source=cap_source,
        t_mono_ms=0,
        offset_sec=0,
    )
    a1 = _add(
        "calibration.attempted",
        {"attempt": 1, "posture": "open", "n_samples": 20, "median": 1.8, "mad": 0.02, "accepted": True, "reason": None},
        source=cap_source,
        t_mono_ms=100,
        offset_sec=1,
    )
    a2 = _add(
        "calibration.attempted",
        {"attempt": 2, "posture": "closed", "n_samples": 20, "median": 0.8, "mad": 0.02, "accepted": True, "reason": None},
        source=cap_source,
        t_mono_ms=200,
        offset_sec=2,
    )
    cal_id = f"cal_{session_id[2:]}"
    _add(
        "calibration.applied",
        {
            "calibration_id": cal_id,
            "open": 1.8,
            "closed": 0.8,
            "span": 1.0,
            "open_samples": 20,
            "closed_samples": 20,
            "attempt_refs": sorted([a1["event_id"], a2["event_id"]]),
            "min_span_required": None,
        },
        source=cap_source,
        t_mono_ms=300,
        offset_sec=3,
    )
    _add(
        "session.control",
        {"action": "start", "interrupt_reason": None},
        source=cap_source,
        t_mono_ms=400,
        offset_sec=4,
    )
    cycles_to_emit = target_cycles if end_action is None else max(0, target_cycles - 1)
    for cidx in range(1, cycles_to_emit + 1):
        _add(
            "cycle.accepted",
            {
                "cycle_index": cidx,
                "calibration_id": cal_id,
                "open_peak_n": 0.9,
                "closed_trough_n": 0.05,
                "armed_to_close_ms": 550,
                "frames": 30,
                "usable_frames": 30,
                "handedness": {"label": side, "score": 0.96},
            },
            source=cap_source,
            t_mono_ms=500 + cidx * 500,
            offset_sec=4 + cidx,
        )

    sec_cursor = 10 + cycles_to_emit
    if end_action is None:
        _add(
            "session.completed",
            {"accepted": target_cycles, "target": target_cycles},
            source=cap_source,
            t_mono_ms=5000,
            offset_sec=sec_cursor,
        )
    else:
        _add(
            "session.control",
            {"action": end_action, "interrupt_reason": "camera_error" if end_action == "interrupt" else None},
            source=cap_source,
            t_mono_ms=5000,
            offset_sec=sec_cursor,
        )

    if usable_fraction is not None:
        _add(
            "session.capture_summary",
            {
                "frames_total": 300,
                "fps_mean": 24.0,
                "fps_min": 15.0,
                "usable_fraction": usable_fraction,
                "lost_events": 0,
            },
            source=cap_source,
            t_mono_ms=5200,
            offset_sec=sec_cursor + 1,
        )

    if include_measurement:
        _add(
            "measurement.recorded",
            {
                "measurement_id": f"ms_{session_id[2:]}",
                "measure_kind": "opening_index",
                "value": 1.05,
                "unit": "1",
                "method": "landmark_ratio_v1",
                "quality": "usable",
                "quality_reason": None,
                "protocol_id": None,
                "limitation_codes": ["L10", "L18"],
                "experimental": True,
                "body_segment": "hand",
            },
            source=cap_source,
            t_mono_ms=5300,
            offset_sec=sec_cursor + 2,
        )

    if assistance is not None:
        _add(
            "report.submitted",
            {"execution": execution, "assistance": assistance, "reporter_role": "participant"},
            source=rep_source,
            t_mono_ms=None,
            offset_sec=sec_cursor + 3,
        )

    resp = client.post("/api/v3/events:batch", headers=_headers(p_tok), json={"events": events})
    assert resp.status_code == 200, resp.text
    for item in resp.json()["results"]:
        assert item["status"] == "stored", (session_id, item)
    return events


def _append_report_only_session(
    client: TestClient,
    p_tok: str,
    org_id: str,
    pid: str,
    rx_id: str,
    rx_rev: int,
    session_id: str,
    *,
    occurred_day: str = "2026-11-23",
    start_hhmmss: str = "14:00:00",
    data_origin: str = "synthetic_fixture",
    origin_ref: str | None = None,
    assistance: str | None = "some",
    execution: str = "complete",
    end_action: str = "end",
    terminal: bool = True,
) -> list[dict[str, Any]]:
    """Append a report_only session via events:batch."""
    stream_id = f"session:{session_id}"
    scope = {
        "org_id": org_id,
        "participant_id": pid,
        "session_id": session_id,
        "prescription_id": rx_id,
        "prescription_revision": rx_rev,
        "exercise_id": "organizar-a-mesa",
    }
    rep_source = {"type": "participant_report"}
    events: list[dict[str, Any]] = []
    seq = 1
    prev: str | None = None

    def _ts(offset_sec: int) -> str:
        hh, mm, ss = [int(x) for x in start_hhmmss.split(":")]
        total = hh * 3600 + mm * 60 + ss + offset_sec
        return f"{occurred_day}T{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}.000Z"

    def _add(ev_type: str, payload: dict[str, Any], offset_sec: int) -> dict[str, Any]:
        nonlocal seq, prev
        ev: dict[str, Any] = {
            "schema_version": 3,
            "type": ev_type,
            "stream_id": stream_id,
            "seq": seq,
            "prev_hash": prev,
            "occurred_at": _ts(offset_sec),
            "actor": {"role": "participant", "id": pid},
            "scope": dict(scope),
            "source": dict(rep_source),
            "execution_mode": "report_only",
            "data_origin": data_origin,
            "payload": payload,
        }
        if origin_ref is not None:
            ev["origin_ref"] = origin_ref
        ev = _rehash(ev)
        events.append(ev)
        prev = ev["hash"]
        seq += 1
        return ev

    _add(
        "session.started",
        {
            "source_mode": "report_only",
            "prescription_id": rx_id,
            "prescription_revision": rx_rev,
            "capture_context": None,
        },
        0,
    )
    _add("session.control", {"action": "start", "interrupt_reason": None}, 1)
    if terminal:
        _add("session.control", {"action": end_action, "interrupt_reason": None}, 2)
    if assistance is not None:
        _add(
            "report.submitted",
            {"execution": execution, "assistance": assistance, "reporter_role": "participant"},
            3,
        )

    resp = client.post("/api/v3/events:batch", headers=_headers(p_tok), json={"events": events})
    assert resp.status_code == 200, resp.text
    for item in resp.json()["results"]:
        assert item["status"] == "stored", (session_id, item)
    return events


def _list_facts_by_session_type(client: TestClient, t_tok: str, pid: str) -> dict[tuple[str, str], tuple[dict[str, Any], str]]:
    r = client.get(f"/api/v3/participants/{pid}/facts", headers=_headers(t_tok))
    assert r.status_code == 200, r.text
    out: dict[tuple[str, str], tuple[dict[str, Any], str]] = {}
    for fact in r.json()["facts"]:
        ch = hash_canonical(fact)
        out[(fact["scope"]["session_id"], fact["type"])] = (fact, ch)
    return out


def _record_review(
    client: TestClient,
    t_tok: str,
    fact_id: str,
    content_hash: str,
    *,
    decision: str = "approve",
    note: str | None = None,
    participant_id: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"fact_id": fact_id, "content_hash": content_hash, "decision": decision}
    if note is not None:
        body["note"] = note
    if participant_id is not None:
        body["participant_id"] = participant_id
    r = client.post("/api/v3/reviews", headers=_headers(t_tok), json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _table_counts(store) -> tuple[int, int]:
    ev_n = store.db.execute("SELECT COUNT(*) FROM v3_events").fetchone()[0]
    evo_n = store.db.execute("SELECT COUNT(*) FROM v3_evolutions").fetchone()[0]
    return int(ev_n), int(evo_n)


# =========================================================================
# 1. Row 1: Contract route parity (+4 exact routes -> 31 total)
# =========================================================================


def test_s1_01_routes_match_api_contract(tmp_path: Path):
    app = create_app(data_dir=str(tmp_path))
    contract = _load_json(API_CONTRACT_PATH)
    by_id = {ep["id"]: ep for ep in contract["endpoints"]}

    expected_method_paths = {(by_id[eid]["method"], by_id[eid]["path"]) for eid in EXPECTED_V3_ROUTE_IDS}
    actual_method_paths = _collect_v3_routes(app)
    assert actual_method_paths == expected_method_paths
    assert len(actual_method_paths) == 31

    assert (by_id["evolution.series"]["method"], by_id["evolution.series"]["path"], by_id["evolution.series"]["roles"]) == (
        "GET",
        "/api/v3/participants/{participant_id}/evolution/series",
        ["therapist"],
    )
    assert (by_id["evolution.publish"]["method"], by_id["evolution.publish"]["path"], by_id["evolution.publish"]["roles"]) == (
        "POST",
        "/api/v3/evolution",
        ["therapist"],
    )
    assert (by_id["evolution.get"]["method"], by_id["evolution.get"]["path"], by_id["evolution.get"]["roles"]) == (
        "GET",
        "/api/v3/evolution/{evolution_id}",
        ["participant", "therapist"],
    )
    assert (by_id["timeline.get"]["method"], by_id["timeline.get"]["path"], by_id["timeline.get"]["roles"]) == (
        "GET",
        "/api/v3/participants/{participant_id}/timeline",
        ["therapist"],
    )


# =========================================================================
# 2. D-S1-01-1 & D-S1-01-2: Series key, ledger fixture hash, schema, range
# =========================================================================


def test_series_key_reproduces_ledger_fixture_and_all_fact_types(tmp_path: Path):
    ref = _load_ref()
    ledger_doc = _load_json(VALID_LEDGER_PATH)
    ps_schema = _load_json(PROGRESS_SERIES_SCHEMA_PATH)

    # Exact reproduction of ledger.v3.json series_key_example hash 452121f7...6576
    rx_ev = next(e for e in ledger_doc["events"] if e["type"] == "prescription.published")
    start_ev = next(e for e in ledger_doc["events"] if e["type"] == "session.started" and e["scope"]["session_id"] == "s_fixture-0001")
    evo_ev = next(e for e in ledger_doc["events"] if e["type"] == "evolution.published")
    expected_sk = ledger_doc["series_key_example"]
    expected_sk_hash = evo_ev["payload"]["series"][0]["series_key_hash"]

    f01_fixture_like = {
        "type": "F01",
        "scope": dict(start_ev["scope"]),
        "versions": {"catalog": "2", "verifier": "0.1.0", "algorithm": "c05-hand-2", "definition": 2},
        "flags": {"summary_eligible": True, "highlight": False},
    }
    sk = build_series_key(f01_fixture_like, start_ev=start_ev, rx_ev=rx_ev, f06_low_quality=False)
    assert sk == expected_sk
    assert hash_canonical(sk) == expected_sk_hash == "452121f7c58eedffa76f1069130d695c4033abd4716289ab1f010b7b99716576"

    # End-to-end GET evolution.series across F01..F06, F08 (and excluding F09, F10, non-terminal)
    w = _make_world(tmp_path)
    client = w["client"]
    rx_id, rx_rev = _publish_rx(client, w["t1_tok"], w["p1_id"], target_sets=1, target_repetitions=2)
    _grant_camera_consent(client, w["p1_tok"], w["org1"], w["p1_id"])

    # Session 1: camera, usable quality, F01/F02/F03/F04/F06/F09/F10
    _append_capture_session(
        client,
        w["p1_tok"],
        w["org1"],
        w["p1_id"],
        rx_id,
        rx_rev,
        "s_evo-0001",
        occurred_day="2026-11-23",
        usable_fraction=0.88,
        assistance="some",
        execution="complete",
        include_measurement=True,
    )
    # Session 2: camera, low quality, pain symptom (F08) + discrepancy (F05: reported complete with 1/2 cycles)
    _append_capture_session(
        client,
        w["p1_tok"],
        w["org1"],
        w["p1_id"],
        rx_id,
        rx_rev,
        "s_evo-0002",
        occurred_day="2026-11-24",
        usable_fraction=0.35,
        assistance="full",
        execution="complete",
        end_action="pain",
    )
    # Session 3: camera, NO capture_summary -> observation_quality_class == "unknown"
    _append_capture_session(
        client,
        w["p1_tok"],
        w["org1"],
        w["p1_id"],
        rx_id,
        rx_rev,
        "s_evo-0003",
        occurred_day="2026-11-25",
        usable_fraction=None,
        assistance="none",
        execution="complete",
    )
    # Session 4: report_only terminal -> observation_quality_class == "not_applicable", algorithm_version == "none"
    _append_report_only_session(
        client,
        w["p1_tok"],
        w["org1"],
        w["p1_id"],
        rx_id,
        rx_rev,
        "s_evo-0004",
        occurred_day="2026-11-26",
        assistance="none",
        execution="partial",
    )
    # Session 5: report_only NON-terminal (started, never ended) -> no facts project into series
    _append_report_only_session(
        client,
        w["p1_tok"],
        w["org1"],
        w["p1_id"],
        rx_id,
        rx_rev,
        "s_evo-0005",
        occurred_day="2026-11-27",
        assistance=None,
        terminal=False,
    )

    facts_map = _list_facts_by_session_type(client, w["t1_tok"], w["p1_id"])
    # Approve ALL derived facts (including F09, F10, and non-terminal session facts)
    for (sid, ftype), (fact, ch) in facts_map.items():
        _record_review(client, w["t1_tok"], fact["fact_id"], ch, decision="approve", participant_id=w["p1_id"])

    r = client.get(f"/api/v3/participants/{w['p1_id']}/evolution/series", headers=_headers(w["t1_tok"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) == {"series", "rules_version", "notices", "context_changes"}
    assert body["rules_version"] == "cmp-v1"
    series = body["series"]
    assert len(series) > 0

    # Every series validates against progress-series.schema.json via CL06.3 REF
    seen_types = set()
    seen_fids = set()
    sk_hashes = []
    for s in series:
        assert ref.validate(ps_schema, s) == [], s
        assert s["series_key_hash"] == ref.hash_canonical(s["series_key"])
        sk_hashes.append(s["series_key_hash"])
        seen_types.add(s["series_key"]["fact_type"])
        for it in s["items"]:
            seen_fids.add(it["fact_id"])

    # Series ordered ascending by series_key_hash
    assert sk_hashes == sorted(sk_hashes)
    # F09 and F10 never projected
    assert "F09" not in seen_types
    assert "F10" not in seen_types
    # All 7 eligible types projected
    assert seen_types == {"F01", "F02", "F03", "F04", "F05", "F06", "F08"}
    # Non-terminal session 5 facts never projected
    for (sid, _), (fact, _) in facts_map.items():
        if sid == "s_evo-0005":
            assert fact["fact_id"] not in seen_fids

    # Check observation_quality_class values across camera usable/low/unknown and report_only not_applicable
    f01_qualities = {s["series_key"]["observation_quality_class"] for s in series if s["series_key"]["fact_type"] == "F01"}
    assert f01_qualities == {"usable", "low", "unknown"}
    ro_f03 = [s for s in series if s["series_key"]["fact_type"] == "F03" and s["series_key"]["execution_mode"] == "report_only"]
    assert len(ro_f03) == 1
    assert ro_f03[0]["series_key"]["observation_quality_class"] == "not_applicable"
    assert ro_f03[0]["series_key"]["algorithm_version"] == "none"
    assert ro_f03[0]["series_key"]["method"] == "reported_execution"
    assert ro_f03[0]["series_key"]["unit"] == "category"

    # Query range filters: inclusive on session_date_local; malformed / inverted -> 400 RULE_VIOLATION
    r_range = client.get(
        f"/api/v3/participants/{w['p1_id']}/evolution/series?from=2026-11-26&to=2026-11-26",
        headers=_headers(w["t1_tok"]),
    )
    assert r_range.status_code == 200, r_range.text
    for s in r_range.json()["series"]:
        for it in s["items"]:
            assert it["session_date_local"] == "2026-11-26"

    for bad_q in ("from=2026-02-30", "to=not-a-date", "from=2026-11-28&to=2026-11-20"):
        r_bad = client.get(
            f"/api/v3/participants/{w['p1_id']}/evolution/series?{bad_q}",
            headers=_headers(w["t1_tok"]),
        )
        assert r_bad.status_code == 400 and r_bad.json()["error"]["code"] == "RULE_VIOLATION", (bad_q, r_bad.text)


# =========================================================================
# 3. Row 2 & D-S1-01-3 / R5 / R6: Review gate & exact explicit precedence
# =========================================================================


def test_review_gate_get_vs_series_keys_vs_explicit_precedence(tmp_path: Path):
    w = _make_world(tmp_path)
    client = w["client"]
    store = w["store"]
    rx_id, rx_rev = _publish_rx(client, w["t1_tok"], w["p1_id"], target_sets=1, target_repetitions=2)
    _grant_camera_consent(client, w["p1_tok"], w["org1"], w["p1_id"])

    _append_capture_session(
        client,
        w["p1_tok"],
        w["org1"],
        w["p1_id"],
        rx_id,
        rx_rev,
        "s_gate-0001",
        occurred_day="2026-11-23",
        mode="camera",
        assistance="some",
        include_measurement=True,
    )
    _append_capture_session(
        client,
        w["p1_tok"],
        w["org1"],
        w["p1_id"],
        rx_id,
        rx_rev,
        "s_gate-0002",
        occurred_day="2026-11-24",
        mode="simulation",
        assistance="none",
    )

    facts_map = _list_facts_by_session_type(client, w["t1_tok"], w["p1_id"])
    f01_cam, h_f01_cam = facts_map[("s_gate-0001", "F01")]
    f01_sim, h_f01_sim = facts_map[("s_gate-0002", "F01")]
    f02_cam, h_f02_cam = facts_map[("s_gate-0001", "F02")]
    f09_cam, h_f09_cam = facts_map[("s_gate-0001", "F09")]
    f10_cam, h_f10_cam = facts_map[("s_gate-0001", "F10")]

    # Before any reviews: GET evolution.series returns 200 with empty lists/maps (R5, R13)
    r_empty = client.get(f"/api/v3/participants/{w['p1_id']}/evolution/series", headers=_headers(w["t1_tok"]))
    assert r_empty.status_code == 200
    assert r_empty.json() == {"series": [], "rules_version": "cmp-v1", "notices": [], "context_changes": {}}

    # Approve f01_cam and f01_sim; reject f02_cam
    rev1 = _record_review(client, w["t1_tok"], f01_cam["fact_id"], h_f01_cam, decision="approve", note="ok cam")
    rev2 = _record_review(client, w["t1_tok"], f01_sim["fact_id"], h_f01_sim, decision="approve", note="ok sim")
    _record_review(client, w["t1_tok"], f02_cam["fact_id"], h_f02_cam, decision="reject", note="rejected")

    r_ser = client.get(f"/api/v3/participants/{w['p1_id']}/evolution/series", headers=_headers(w["t1_tok"]))
    assert r_ser.status_code == 200
    ser_by_mode = {s["series_key"]["execution_mode"]: s for s in r_ser.json()["series"]}
    assert set(ser_by_mode.keys()) == {"camera", "simulation"}
    sk_cam = ser_by_mode["camera"]["series_key_hash"]
    sk_sim = ser_by_mode["simulation"]["series_key_hash"]

    before_counts = _table_counts(store)

    # Precedence 1: unknown fact -> 404 NOT_FOUND
    r1 = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series": [{"series_key_hash": sk_cam, "items": [{"fact_id": "f_" + "0" * 64, "content_hash": "0" * 64}]}],
        },
    )
    assert r1.status_code == 404 and r1.json()["error"]["code"] == "NOT_FOUND"

    # Precedence 2: F09 and F10 -> 422 FACT_NOT_SUMMARY_ELIGIBLE (even with stale hash & unreviewed)
    for bad_f in (f09_cam, f10_cam):
        r2 = client.post(
            "/api/v3/evolution",
            headers=_headers(w["t1_tok"]),
            json={
                "participant_id": w["p1_id"],
                "period": {"from": "2026-11-20", "to": "2026-11-30"},
                "series": [{"series_key_hash": sk_cam, "items": [{"fact_id": bad_f["fact_id"], "content_hash": "a" * 64}]}],
            },
        )
        assert r2.status_code == 422 and r2.json()["error"]["code"] == "FACT_NOT_SUMMARY_ELIGIBLE"

    # Precedence 3: content_hash != current -> 409 CONTENT_HASH_STALE
    r3 = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series": [{"series_key_hash": sk_cam, "items": [{"fact_id": f01_cam["fact_id"], "content_hash": "b" * 64}]}],
        },
    )
    assert r3.status_code == 409 and r3.json()["error"]["code"] == "CONTENT_HASH_STALE"

    # Precedence 4: unreviewed or rejected -> 409 UNREVIEWED_FACT_IN_EVOLUTION (checked BEFORE comparability!)
    f03_cam, h_f03_cam = facts_map[("s_gate-0001", "F03")]
    for unapp_f, unapp_h in ((f03_cam, h_f03_cam), (f02_cam, h_f02_cam)):
        r4 = client.post(
            "/api/v3/evolution",
            headers=_headers(w["t1_tok"]),
            json={
                "participant_id": w["p1_id"],
                "period": {"from": "2026-11-20", "to": "2026-11-30"},
                "series": [{"series_key_hash": sk_cam, "items": [{"fact_id": unapp_f["fact_id"], "content_hash": unapp_h}]}],
            },
        )
        assert r4.status_code == 409 and r4.json()["error"]["code"] == "UNREVIEWED_FACT_IN_EVOLUTION"

    # Precedence 5: computed key != declared key OR mixed keys in one series -> 400 COMPARABILITY_VIOLATION
    r5a = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series": [{"series_key_hash": sk_sim, "items": [{"fact_id": f01_cam["fact_id"], "content_hash": h_f01_cam}]}],
        },
    )
    assert r5a.status_code == 400 and r5a.json()["error"]["code"] == "COMPARABILITY_VIOLATION"

    r5b = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series": [
                {
                    "series_key_hash": sk_cam,
                    "items": [
                        {"fact_id": f01_cam["fact_id"], "content_hash": h_f01_cam},
                        {"fact_id": f01_sim["fact_id"], "content_hash": h_f01_sim},
                    ],
                }
            ],
        },
    )
    assert r5b.status_code == 400 and r5b.json()["error"]["code"] == "COMPARABILITY_VIOLATION"

    # Precedence 6: item outside period -> 400 RULE_VIOLATION
    r6 = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-25", "to": "2026-11-30"},
            "series": [{"series_key_hash": sk_cam, "items": [{"fact_id": f01_cam["fact_id"], "content_hash": h_f01_cam}]}],
        },
    )
    assert r6.status_code == 400 and r6.json()["error"]["code"] == "RULE_VIOLATION"

    # series_keys mode errors: unknown key -> 404; known key with 0 items in period -> 400 RULE_VIOLATION
    r_sk_404 = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series_keys": ["f" * 64],
        },
    )
    assert r_sk_404.status_code == 404 and r_sk_404.json()["error"]["code"] == "NOT_FOUND"

    r_sk_empty = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-28", "to": "2026-11-30"},
            "series_keys": [sk_cam],
        },
    )
    assert r_sk_empty.status_code == 400 and r_sk_empty.json()["error"]["code"] == "RULE_VIOLATION"

    # Dual-representation contradictions & duplicates -> 400 RULE_VIOLATION (D-S1-01-3, R6, D-S1b-03-4)
    for bad_body in (
        {
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "period_from": "2026-11-21",
            "series_keys": [sk_cam],
        },
        {
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series_keys": [sk_cam],
            "series": [{"series_key_hash": sk_sim, "items": [{"fact_id": f01_sim["fact_id"], "content_hash": h_f01_sim}]}],
        },
        {
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series_keys": [sk_cam, sk_cam],
        },
        {
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series": [
                {
                    "series_key_hash": sk_cam,
                    "items": [
                        {"fact_id": f01_cam["fact_id"], "content_hash": h_f01_cam},
                        {"fact_id": f01_cam["fact_id"], "content_hash": h_f01_cam},
                    ],
                }
            ],
        },
        {
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series_keys": [sk_cam],
            "note_refs": [rev1["review"]["hash"], rev1["review"]["hash"]],
        },
        {
            # Passing event_id instead of event hash (D-S1-01-3 requires event hash of review.recorded)
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series_keys": [sk_cam],
            "note_refs": [rev1["review"]["event_id"]],
        },
    ):
        rb = client.post("/api/v3/evolution", headers=_headers(w["t1_tok"]), json=bad_body)
        assert rb.status_code == 400 and rb.json()["error"]["code"] == "RULE_VIOLATION", (bad_body, rb.text)

    # Zero writes across all rejected calls
    assert _table_counts(store) == before_counts

    # Identical dual representations + unsorted valid review event hashes -> 201 with sorted note_refs
    unsorted_refs = sorted([rev1["review"]["hash"], rev2["review"]["hash"]], reverse=True)
    r_ok = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "period_from": "2026-11-20",
            "period_to": "2026-11-30",
            "series_keys": [sk_cam, sk_sim],
            "series": [
                {"series_key_hash": sk_sim, "items": [{"fact_id": f01_sim["fact_id"], "content_hash": h_f01_sim}]},
                {"series_key_hash": sk_cam, "items": [{"fact_id": f01_cam["fact_id"], "content_hash": h_f01_cam}]},
            ],
            "note_refs": unsorted_refs,
        },
    )
    assert r_ok.status_code == 201, r_ok.text
    evo_id = r_ok.json()["evolution_id"]
    g = client.get(f"/api/v3/evolution/{evo_id}", headers=_headers(w["t1_tok"]))
    assert g.status_code == 200
    assert g.json()["event"]["payload"]["note_refs"] == sorted(unsorted_refs)


# =========================================================================
# 4. Row 3, Row 7, R9, R10, R13, R14: Split notices, context_changes, origin_ref
# =========================================================================


def test_comparability_split_notices_context_changes_and_r10_r14_origin_ref(tmp_path: Path):
    w = _make_world(tmp_path, real_data_gate_open=True)
    client = w["client"]
    store = w["store"]

    orig_ref_1 = "1" * 64
    orig_ref_2 = "2" * 64
    rx_exp_ev1 = _seed_rx_with_origin(
        store, w["org1"], w["t1_id"], w["p1_id"], "rx_exp-0001",
        target_sets=1, target_repetitions=2, revision=1,
        data_origin="experimental_capture", origin_ref=orig_ref_1,
    )
    _seed_rx_with_origin(
        store, w["org1"], w["t1_id"], w["p1_id"], "rx_exp-0001",
        target_sets=2, target_repetitions=2, revision=2, prev_hash=rx_exp_ev1["hash"],
        data_origin="experimental_capture", origin_ref=orig_ref_1, occurred_at="2026-11-20T10:01:00.000Z",
    )
    _seed_rx_with_origin(
        store, w["org1"], w["t1_id"], w["p1_id"], "rx_live-0001",
        target_sets=1, target_repetitions=2, revision=1,
        data_origin="live",
    )
    _grant_camera_consent(client, w["p1_tok"], w["org1"], w["p1_id"])

    # Two comparable experimental_capture camera sessions with different origin_ref & dose/end_reason
    _append_capture_session(
        client,
        w["p1_tok"],
        w["org1"],
        w["p1_id"],
        "rx_exp-0001",
        1,
        "s_exp-0001",
        occurred_day="2026-11-23",
        mode="camera",
        target_cycles=2,
        usable_fraction=0.90,
        data_origin="experimental_capture",
        origin_ref=orig_ref_1,
        assistance="full",
    )
    _append_capture_session(
        client,
        w["p1_tok"],
        w["org1"],
        w["p1_id"],
        "rx_exp-0001",
        2,
        "s_exp-0002",
        occurred_day="2026-11-24",
        mode="camera",
        target_cycles=4,
        usable_fraction=0.85,
        data_origin="experimental_capture",
        origin_ref=orig_ref_2,
        assistance="some",
        end_action="pain",
    )
    # One simulation experimental_capture session -> splits F01 by execution_mode
    _append_capture_session(
        client,
        w["p1_tok"],
        w["org1"],
        w["p1_id"],
        "rx_exp-0001",
        1,
        "s_exp-0003",
        occurred_day="2026-11-25",
        mode="simulation",
        target_cycles=2,
        usable_fraction=0.90,
        data_origin="experimental_capture",
        origin_ref=orig_ref_1,
        assistance="none",
    )
    # One live camera session -> different data_origin_class
    _append_capture_session(
        client,
        w["p1_tok"],
        w["org1"],
        w["p1_id"],
        "rx_live-0001",
        1,
        "s_live-0001",
        occurred_day="2026-11-26",
        mode="camera",
        target_cycles=2,
        usable_fraction=0.90,
        data_origin="live",
        assistance="none",
    )

    facts_map = _list_facts_by_session_type(client, w["t1_tok"], w["p1_id"])
    for sid in ("s_exp-0001", "s_exp-0002", "s_exp-0003", "s_live-0001"):
        f, ch = facts_map[(sid, "F01")]
        _record_review(client, w["t1_tok"], f["fact_id"], ch, decision="approve")

    r_ser = client.get(f"/api/v3/participants/{w['p1_id']}/evolution/series", headers=_headers(w["t1_tok"]))
    assert r_ser.status_code == 200, r_ser.text
    ser_body = r_ser.json()
    f01_series = [s for s in ser_body["series"] if s["series_key"]["fact_type"] == "F01"]
    assert len(f01_series) == 3  # (exp,camera), (exp,sim), (live,camera)

    # Split notice emitted for F01 group with differing_keys in cmp-v1 key order
    cmp_keys = _load_json(CMP_RULES_PATH)["technical_criteria"]["keys"]
    assert len(ser_body["notices"]) == 1
    notice = ser_body["notices"][0]
    assert notice["kind"] == "series_split"
    assert notice["series_key_hashes"] == sorted(s["series_key_hash"] for s in f01_series)
    assert notice["differing_keys"] == [k for k in cmp_keys if k in ("execution_mode", "data_origin_class")]

    # Context changes for the 2-item (exp, camera) series in cmp-v1 dimension order
    exp_cam = next(s for s in f01_series if s["series_key"]["data_origin_class"] == "experimental_capture" and s["series_key"]["execution_mode"] == "camera")
    exp_sim = next(s for s in f01_series if s["series_key"]["data_origin_class"] == "experimental_capture" and s["series_key"]["execution_mode"] == "simulation")
    live_cam = next(s for s in f01_series if s["series_key"]["data_origin_class"] == "live")

    cc = ser_body["context_changes"][exp_cam["series_key_hash"]]
    assert [c["dimension"] for c in cc] == [
        "assistance_level",
        "pain_or_fatigue_signalled",
        "dose_prescribed",
        "session_end_reason",
    ]
    assert cc[0]["from"] == "full" and cc[0]["to"] == "some"
    assert cc[1]["from"] is False and cc[1]["to"] is True
    assert cc[2]["from"] == 2 and cc[2]["to"] == 4
    assert cc[3]["from"] == "completed" and cc[3]["to"] == "symptom"

    # R10: mixed data_origin across separate series in one publication -> 400 COMPARABILITY_VIOLATION, nothing stored
    before = _table_counts(store)
    r_mix = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series_keys": [exp_cam["series_key_hash"], live_cam["series_key_hash"]],
        },
    )
    assert r_mix.status_code == 400 and r_mix.json()["error"]["code"] == "COMPARABILITY_VIOLATION"
    assert _table_counts(store) == before

    # R14: experimental_capture with 1 origin_ref -> exact origin_ref on evolution.published envelope
    r_exp1 = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series_keys": [exp_sim["series_key_hash"]],
        },
    )
    assert r_exp1.status_code == 201, r_exp1.text
    g_exp1 = client.get(f"/api/v3/evolution/{r_exp1.json()['evolution_id']}", headers=_headers(w["t1_tok"]))
    assert g_exp1.json()["event"]["data_origin"] == "experimental_capture"
    assert g_exp1.json()["event"]["origin_ref"] == orig_ref_1

    # R14: experimental_capture with 2 distinct origin_refs -> hash_canonical(sorted([orig_ref_1, orig_ref_2]))
    r_exp2 = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series_keys": [exp_cam["series_key_hash"], exp_sim["series_key_hash"]],
        },
    )
    assert r_exp2.status_code == 201, r_exp2.text
    g_exp2 = client.get(f"/api/v3/evolution/{r_exp2.json()['evolution_id']}", headers=_headers(w["t1_tok"]))
    assert g_exp2.json()["event"]["data_origin"] == "experimental_capture"
    assert g_exp2.json()["event"]["origin_ref"] == hash_canonical(sorted([orig_ref_1, orig_ref_2]))

    # Participant view preserves data_origin_class & execution_mode per series and uses series_indexes in notices (no hashes)
    gp = client.get(f"/api/v3/evolution/{r_exp2.json()['evolution_id']}", headers=_headers(w["p1_tok"]))
    assert gp.status_code == 200
    p_body = gp.json()
    assert len(p_body["notices"]) == 1
    assert p_body["notices"][0] == {
        "kind": "series_split",
        "series_indexes": [0, 1],
        "differing_keys": ["execution_mode"],
    }
    assert {s["execution_mode"] for s in p_body["series"]} == {"camera", "simulation"}
    assert all(s["data_origin_class"] == "experimental_capture" for s in p_body["series"])
    assert all(s["origin_prefix"] == "[Captura experimental] " for s in p_body["series"])

    # R14: live origin -> origin_ref absent from envelope
    r_live = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-30"},
            "series_keys": [live_cam["series_key_hash"]],
        },
    )
    assert r_live.status_code == 201, r_live.text
    g_live = client.get(f"/api/v3/evolution/{r_live.json()['evolution_id']}", headers=_headers(w["t1_tok"]))
    assert g_live.json()["event"]["data_origin"] == "live"
    assert "origin_ref" not in g_live.json()["event"]


# =========================================================================
# 5. Row 4 & R2 / R11: Assistance transitions & unreported barrier
# =========================================================================


def test_assistance_transitions_and_unreported_barrier_r2_r11(tmp_path: Path):
    w = _make_world(tmp_path)
    client = w["client"]
    rx_id, rx_rev = _publish_rx(client, w["t1_tok"], w["p1_id"], side="right", target_sets=1, target_repetitions=2)

    # 6 report_only terminal sessions in R11 chronological order:
    # S1: full (Nov 20)
    # S2: some (Nov 21) -> S1->S2 = less_help_reported
    # S3: unreported (Nov 22, assistance="unreported") -> BARRIER between S2 and S4!
    # S4: none (Nov 23) -> S2->S4 = NO_TRANSITION_PRODUCED
    # S5: none (Nov 24) -> S4->S5 = unchanged
    # S6: some (Nov 25) -> S5->S6 = more_help_reported
    _append_report_only_session(client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_bar-0001", occurred_day="2026-11-20", assistance="full")
    _append_report_only_session(client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_bar-0002", occurred_day="2026-11-21", assistance="some")
    _append_report_only_session(client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_bar-0003", occurred_day="2026-11-22", assistance="unreported")
    _append_report_only_session(client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_bar-0004", occurred_day="2026-11-23", assistance="none")
    _append_report_only_session(client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_bar-0005", occurred_day="2026-11-24", assistance="none")
    _append_report_only_session(client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_bar-0006", occurred_day="2026-11-25", assistance="some")

    facts_map = _list_facts_by_session_type(client, w["t1_tok"], w["p1_id"])
    # No F04 fabricated for unreported session S3
    assert ("s_bar-0003", "F04") not in facts_map

    f04s = {}
    for sid in ("s_bar-0001", "s_bar-0002", "s_bar-0004", "s_bar-0005", "s_bar-0006"):
        f, ch = facts_map[(sid, "F04")]
        f04s[sid] = (f, ch)
        _record_review(client, w["t1_tok"], f["fact_id"], ch, decision="approve")

    r_ser = client.get(f"/api/v3/participants/{w['p1_id']}/evolution/series", headers=_headers(w["t1_tok"]))
    assert r_ser.status_code == 200
    f04_series = next(s for s in r_ser.json()["series"] if s["series_key"]["fact_type"] == "F04")
    sk_f04 = f04_series["series_key_hash"]

    # Helper check for barrier pair (S2 -> S4 across unreported S3)
    helper_res = compute_assistance_transition(
        {"fact_id": f04s["s_bar-0002"][0]["fact_id"], "assistance_level": "some", "session_order_key": ("2026-11-21", "2026-11-21T14:00:00.000Z", "s_bar-0002")},
        {"fact_id": f04s["s_bar-0004"][0]["fact_id"], "assistance_level": "none", "session_order_key": ("2026-11-23", "2026-11-23T14:00:00.000Z", "s_bar-0004")},
        series_key_hash=sk_f04,
        in_scope_sessions=[
            {"session_id": "s_bar-0003", "session_date_local": "2026-11-22", "start_occurred_at": "2026-11-22T14:00:00.000Z", "assistance_level": "unreported"}
        ],
    )
    assert helper_res == {"produced": False, "code": NO_TRANSITION_PRODUCED, "transition": None}

    # Publish all 5 approved F04 items via series_keys -> succeeds (201) with NO transition bridging S2->S4
    r_pub = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-26"},
            "series_keys": [sk_f04],
        },
    )
    assert r_pub.status_code == 201, r_pub.text
    g = client.get(f"/api/v3/evolution/{r_pub.json()['evolution_id']}", headers=_headers(w["t1_tok"]))
    trs = g.json()["event"]["payload"]["assistance_transitions"]
    assert [(t["from_fact_id"], t["to_fact_id"], t["direction"]) for t in trs] == [
        (f04s["s_bar-0001"][0]["fact_id"], f04s["s_bar-0002"][0]["fact_id"], "less_help_reported"),
        (f04s["s_bar-0004"][0]["fact_id"], f04s["s_bar-0005"][0]["fact_id"], "unchanged"),
        (f04s["s_bar-0005"][0]["fact_id"], f04s["s_bar-0006"][0]["fact_id"], "more_help_reported"),
    ]
    # context_changes for assistance_level also obeys R2 barrier (no entry for S2->S4)
    ctx_ch = g.json()["context_changes"][sk_f04]
    assert [(c["from_fact_id"], c["to_fact_id"], c["dimension"]) for c in ctx_ch] == [
        (f04s["s_bar-0001"][0]["fact_id"], f04s["s_bar-0002"][0]["fact_id"], "assistance_level"),
        (f04s["s_bar-0005"][0]["fact_id"], f04s["s_bar-0006"][0]["fact_id"], "assistance_level"),
    ]

    # R2: explicit selection skipping a REPORTED session (S5) is NOT a barrier -> S4->S6 produces more_help_reported
    r_skip_rep = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-26"},
            "series": [
                {
                    "series_key_hash": sk_f04,
                    "items": [
                        {"fact_id": f04s["s_bar-0004"][0]["fact_id"], "content_hash": f04s["s_bar-0004"][1]},
                        {"fact_id": f04s["s_bar-0006"][0]["fact_id"], "content_hash": f04s["s_bar-0006"][1]},
                    ],
                }
            ],
        },
    )
    assert r_skip_rep.status_code == 201, r_skip_rep.text
    g2 = client.get(f"/api/v3/evolution/{r_skip_rep.json()['evolution_id']}", headers=_headers(w["t1_tok"]))
    assert len(g2.json()["event"]["payload"]["assistance_transitions"]) == 1
    assert g2.json()["event"]["payload"]["assistance_transitions"][0]["direction"] == "more_help_reported"


# =========================================================================
# 6. Row 5, Row 6, Row 8, R6, R7, R8, R12, R13: Event validity, immutability,
#    R7 snapshot isolation, R12 replay precedence, participant simplified view
# =========================================================================


def test_published_evolution_event_immutability_r7_snapshot_and_r12_replay(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("ELO_S3_EXPLANATIONS", raising=False)
    ref = _load_ref()
    event_cat = _load_json(EVENT_CATALOG_PATH)
    limits = _load_json(LIMITS_PATH)
    evo_schema = _load_json(EVOLUTION_SCHEMA_PATH)

    w = _make_world(tmp_path)
    client = w["client"]
    store = w["store"]
    rx_id, rx_rev = _publish_rx(client, w["t1_tok"], w["p1_id"], side="right", target_sets=1, target_repetitions=2)

    s1_evs = _append_report_only_session(
        client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_imm-0001", occurred_day="2026-11-21", assistance="full"
    )
    _append_report_only_session(
        client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_imm-0002", occurred_day="2026-11-22", assistance="some"
    )

    facts_map = _list_facts_by_session_type(client, w["t1_tok"], w["p1_id"])
    f1, h1 = facts_map[("s_imm-0001", "F04")]
    f2, h2 = facts_map[("s_imm-0002", "F04")]
    _record_review(client, w["t1_tok"], f1["fact_id"], h1, decision="approve")
    _record_review(client, w["t1_tok"], f2["fact_id"], h2, decision="approve")

    sk_f04 = client.get(f"/api/v3/participants/{w['p1_id']}/evolution/series", headers=_headers(w["t1_tok"])).json()["series"][0]["series_key_hash"]

    pub_req = {
        "evolution_id": "evo_fixed-0001",
        "participant_id": w["p1_id"],
        "period": {"from": "2026-11-20", "to": "2026-11-25"},
        "series": [
            {
                "series_key_hash": sk_f04,
                "items": [
                    {"fact_id": f2["fact_id"], "content_hash": h2},
                    {"fact_id": f1["fact_id"], "content_hash": h1},
                ],
            }
        ],
        # Attempt to spoof server fields -> must be ignored and set by server
        "actor": {"role": "participant", "id": w["p1_id"]},
        "seq": 999,
    }
    r1 = client.post("/api/v3/evolution", headers=_headers(w["t1_tok"]), json=pub_req)
    assert r1.status_code == 201, r1.text
    res1 = r1.json()
    assert res1["evolution_id"] == "evo_fixed-0001"

    # Validate stored event with S0-03 validate_event AND CL06.3 REF
    t_view = client.get("/api/v3/evolution/evo_fixed-0001", headers=_headers(w["t1_tok"])).json()
    assert "explanation" not in t_view
    monkeypatch.setenv("ELO_S3_EXPLANATIONS", "1")
    path = "/api/v3/evolution/evo_fixed-0001"
    gated = client.get(path, headers=_headers(w["t1_tok"])).json()
    explanation = gated.pop("explanation")
    assert gated == t_view
    assert explanation["publication"]["content_hash"] == res1["content_hash"]
    assert explanation["series"][0]["reported_assistance"] == [{
        "direction": "less_help_reported",
        "from_fact": {"fact_id": f1["fact_id"], "content_hash": h1},
        "to_fact": {"fact_id": f2["fact_id"], "content_hash": h2},
    }]
    assert "explanation" not in client.get(path, headers=_headers(w["p1_tok"])).json()
    denied = client.get(path, headers=_headers(w["t2_tok"]))
    assert denied.status_code == 404 and "explanation" not in denied.json()
    monkeypatch.delenv("ELO_S3_EXPLANATIONS")
    ev = t_view["event"]
    assert ev["type"] == "evolution.published"
    assert ev["actor"] == {"role": "therapist", "id": w["t1_id"]}
    assert ev["execution_mode"] == "not_applicable"
    assert ev["data_origin"] == "synthetic_fixture"
    assert validate_event(ev, gate_open=False) == []
    assert ref.validate(evo_schema, ev) == []
    assert ref.check_event_semantics(ev, event_cat, limits, real_data_gate_open=False) == []
    assert ref.check_event_integrity(ev) == []
    stream_evs = store.get_stream_events(ev["stream_id"])
    assert ref.check_stream_chain(stream_evs) == []

    p = ev["payload"]
    assert p["content_hash"] == ref.hash_canonical({k: v for k, v in p.items() if k != "content_hash"})
    # Items ordered in R11 ascending order despite reversed request order
    assert [it["fact_id"] for it in p["series"][0]["items"]] == [f1["fact_id"], f2["fact_id"]]

    # Participant simplified view before mutation (D-S1-01-5, R8, R9, R13)
    p_view_before = client.get("/api/v3/evolution/evo_fixed-0001", headers=_headers(w["p1_tok"])).json()
    assert set(p_view_before.keys()) == {"evolution_id", "published_at", "period", "series", "notices"}
    assert "assistance_transitions" not in p_view_before  # R8: no top-level transitions
    p_ser = p_view_before["series"][0]
    assert set(p_ser.keys()) == {
        "data_origin_class",
        "execution_mode",
        "origin_prefix",
        "items",
        "assistance_transitions",
        "context_changes",
    }
    assert p_ser["assistance_transitions"] == [
        {"from_date": "2026-11-21", "to_date": "2026-11-22", "direction": "less_help_reported"}
    ]
    assert p_ser["context_changes"] == [
        {"from_date": "2026-11-21", "to_date": "2026-11-22", "dimension": "assistance_level", "from": "full", "to": "some"}
    ]
    # Zero hashes, fact_ids, note_refs, or actor ids anywhere in participant view
    p_view_txt = json.dumps(p_view_before)
    assert f1["fact_id"] not in p_view_txt
    assert h1 not in p_view_txt
    assert sk_f04 not in p_view_txt
    assert w["t1_id"] not in p_view_txt
    assert "note_refs" not in p_view_txt

    # Mutate ledger: participant submits a superseding report for s_imm-0001 -> f1 is now STALE / no longer derived!
    last_ev = s1_evs[-1]
    sup_rep = _rehash(
        {
            "schema_version": 3,
            "type": "report.submitted",
            "stream_id": last_ev["stream_id"],
            "seq": last_ev["seq"] + 1,
            "prev_hash": last_ev["hash"],
            "occurred_at": "2026-11-21T15:00:00.000Z",
            "actor": {"role": "participant", "id": w["p1_id"]},
            "scope": dict(last_ev["scope"]),
            "source": {"type": "participant_report"},
            "execution_mode": "report_only",
            "data_origin": "synthetic_fixture",
            "payload": {"execution": "complete", "assistance": "none", "reporter_role": "participant"},
        }
    )
    r_batch = client.post("/api/v3/events:batch", headers=_headers(w["p1_tok"]), json={"events": [sup_rep]})
    assert r_batch.status_code == 200 and r_batch.json()["results"][0]["status"] == "stored"

    # R7: evolution.get still serves identical historical snapshot (therapist & participant)
    assert client.get("/api/v3/evolution/evo_fixed-0001", headers=_headers(w["t1_tok"])).json() == t_view
    assert client.get("/api/v3/evolution/evo_fixed-0001", headers=_headers(w["p1_tok"])).json() == p_view_before

    # R12: replaying same evolution_id with identical fingerprint returns 200 WITHOUT re-running stale item gates!
    counts_before_replay = _table_counts(store)
    r_replay = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "evolution_id": "evo_fixed-0001",
            "participant_id": w["p1_id"],
            "period_from": "2026-11-20",
            "period_to": "2026-11-25",
            "series": [
                {
                    "series_key_hash": sk_f04,
                    "items": [
                        {"fact_id": f1["fact_id"], "content_hash": h1},
                        {"fact_id": f2["fact_id"], "content_hash": h2},
                    ],
                }
            ],
        },
    )
    assert r_replay.status_code == 200
    assert r_replay.json() == res1
    assert _table_counts(store) == counts_before_replay

    # R12 / Row 6: same evolution_id with DIFFERENT fingerprint -> 409 CONFLICT_IMMUTABLE (even before item gates!)
    r_conf = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={
            "evolution_id": "evo_fixed-0001",
            "participant_id": w["p1_id"],
            "period": {"from": "2026-11-20", "to": "2026-11-26"},
            "series": [
                {
                    "series_key_hash": sk_f04,
                    "items": [{"fact_id": "f_" + "9" * 64, "content_hash": "9" * 64}],
                }
            ],
        },
    )
    assert r_conf.status_code == 409 and r_conf.json()["error"]["code"] == "CONFLICT_IMMUTABLE"
    assert _table_counts(store) == counts_before_replay

    # DB triggers prevent update or delete on v3_evolutions
    with pytest.raises(sqlite3.DatabaseError):
        store.db.execute("UPDATE v3_evolutions SET content_hash = '0' WHERE evolution_id = 'evo_fixed-0001'")
    with pytest.raises(sqlite3.DatabaseError):
        store.db.execute("DELETE FROM v3_evolutions WHERE evolution_id = 'evo_fixed-0001'")


# =========================================================================
# 7. Row 7 & Row 9 & R3 / R4: timeline.get unified history & total order
# =========================================================================


def test_timeline_get_entities_events_order_and_exclusions(tmp_path: Path):
    w = _make_world(tmp_path)
    client = w["client"]

    # Create all 5 clinical entity types (including revised v2 of functional_assessment & goal)
    r_fa1 = client.post(
        f"/api/v3/participants/{w['p1_id']}/assessments",
        headers=_headers(w["t1_tok"]),
        json={
            "assessment_date": "2026-11-20",
            "body_segment": "hand",
            "side": "right",
            "instrument": {"instrument_id": "custom_unvalidated", "instrument_version": "0", "status": "unvalidated_custom"},
            "items": [
                {
                    "item_key": "grip_item",
                    "value_type": "integer",
                    "value": 3,
                    "unit": None,
                    "source": "therapist_observed",
                    "assistance": "some",
                    "not_assessed": False,
                }
            ],
            "therapist_note": "baseline",
        },
    )
    assert r_fa1.status_code == 201, r_fa1.text
    fa1_id = r_fa1.json()["entity_id"]

    r_fa2 = client.post(
        f"/api/v3/assessments/{fa1_id}/versions",
        headers=_headers(w["t1_tok"]),
        json={
            "assessment_date": "2026-11-21",
            "body_segment": "hand",
            "side": "right",
            "instrument": {"instrument_id": "custom_unvalidated", "instrument_version": "0", "status": "unvalidated_custom"},
            "items": [
                {
                    "item_key": "grip_item",
                    "value_type": "integer",
                    "value": 4,
                    "unit": None,
                    "source": "therapist_observed",
                    "assistance": "none",
                    "not_assessed": False,
                }
            ],
            "therapist_note": "revised",
        },
    )
    assert r_fa2.status_code == 201, r_fa2.text

    r_fa_cur = client.post(
        f"/api/v3/participants/{w['p1_id']}/assessments",
        headers=_headers(w["t1_tok"]),
        json={
            "assessment_date": "2026-11-25",
            "body_segment": "hand",
            "side": "right",
            "instrument": {"instrument_id": "custom_unvalidated", "instrument_version": "0", "status": "unvalidated_custom"},
            "items": [
                {
                    "item_key": "grip_item",
                    "value_type": "integer",
                    "value": 5,
                    "unit": None,
                    "source": "therapist_observed",
                    "assistance": "none",
                    "not_assessed": False,
                }
            ],
            "therapist_note": "followup",
        },
    )
    assert r_fa_cur.status_code == 201, r_fa_cur.text
    fa_cur_id = r_fa_cur.json()["entity_id"]

    r_gl1 = client.post(
        f"/api/v3/participants/{w['p1_id']}/goals",
        headers=_headers(w["t1_tok"]),
        json={
            "goal_text": "Completar atividade da mesa",
            "body_segment": "hand",
            "target": {"kind": "session_count", "value": 5, "unit": None},
            "status": "active",
            "confirmed_by": None,
            "confirmed_at": None,
        },
    )
    assert r_gl1.status_code == 201, r_gl1.text
    gl_id = r_gl1.json()["entity_id"]

    r_gl2 = client.post(
        f"/api/v3/goals/{gl_id}/versions",
        headers=_headers(w["t1_tok"]),
        json={
            "goal_text": "Completar atividade da mesa",
            "body_segment": "hand",
            "target": {"kind": "session_count", "value": 5, "unit": None},
            "status": "achieved_confirmed",
            "confirmed_by": None,
            "confirmed_at": None,
        },
    )
    assert r_gl2.status_code == 201, r_gl2.text

    r_enc = client.post(
        f"/api/v3/participants/{w['p1_id']}/encounters",
        headers=_headers(w["t1_tok"]),
        json={
            "encounter_date": "2026-11-22",
            "modality": "in_person",
            "duration_min": 40,
            "prescription_ref": None,
            "assessment_ref": fa1_id,
            "therapist_note": "encontro",
        },
    )
    assert r_enc.status_code == 201, r_enc.text

    r_ra = client.post(
        f"/api/v3/participants/{w['p1_id']}/reassessments",
        headers=_headers(w["t1_tok"]),
        json={
            "baseline_assessment_ref": fa1_id,
            "current_assessment_ref": fa_cur_id,
            "item_comparability": [{"item_key": "grip_item", "comparable": True, "reason": None}],
        },
    )
    assert r_ra.status_code == 201, r_ra.text

    r_im = client.post(
        f"/api/v3/participants/{w['p1_id']}/instrumental-measurements",
        headers=_headers(w["t1_tok"]),
        json={
            "measured_at": "2026-11-22T12:00:00.000Z",
            "body_segment": "hand",
            "side": "right",
            "movement_key": "pinch_force",
            "value": 12.5,
            "unit": "kgf",
            "instrument_label": "Dinamometro sintetico",
            "method": "therapist_instrumental_manual",
            "assistance": "none",
            "therapist_note": None,
        },
    )
    assert r_im.status_code == 201, r_im.text

    # Published events: prescription.published, summary.published, evolution.published (plus consent/session/review excluded!)
    rx_id, rx_rev = _publish_rx(client, w["t1_tok"], w["p1_id"])
    _grant_camera_consent(client, w["p1_tok"], w["org1"], w["p1_id"])
    _append_report_only_session(
        client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_tl-00001", occurred_day="2026-11-23", assistance="some"
    )
    facts_map = _list_facts_by_session_type(client, w["t1_tok"], w["p1_id"])
    f04, h04 = facts_map[("s_tl-00001", "F04")]
    _record_review(client, w["t1_tok"], f04["fact_id"], h04, decision="approve")

    r_sum = client.post(
        "/api/v3/summaries",
        headers=_headers(w["t1_tok"]),
        json={"participant_id": w["p1_id"], "items": [{"fact_id": f04["fact_id"], "content_hash": h04}]},
    )
    assert r_sum.status_code == 201, r_sum.text

    sk = client.get(f"/api/v3/participants/{w['p1_id']}/evolution/series", headers=_headers(w["t1_tok"])).json()["series"][0]["series_key_hash"]
    r_evo = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={"participant_id": w["p1_id"], "period": {"from": "2026-11-20", "to": "2026-11-25"}, "series_keys": [sk]},
    )
    assert r_evo.status_code == 201, r_evo.text

    r_tl = client.get(f"/api/v3/participants/{w['p1_id']}/timeline", headers=_headers(w["t1_tok"]))
    assert r_tl.status_code == 200, r_tl.text
    items = r_tl.json()["items"]

    # Check exact included refs (8 entity versions + 3 published events = 11)
    expected_refs = {
        f"{fa1_id}@v1",
        f"{fa1_id}@v2",
        f"{fa_cur_id}@v1",
        f"{gl_id}@v1",
        f"{gl_id}@v2",
        f"{r_enc.json()['entity_id']}@v1",
        f"{r_ra.json()['entity_id']}@v1",
        f"{r_im.json()['entity_id']}@v1",
        r_sum.json()["event_id"],
        r_evo.json()["event_id"],
    }
    rx_evs = w["store"].list_prescriptions(w["p1_id"])
    expected_refs.add(rx_evs[0]["event_id"])
    assert {it["ref"] for it in items} == expected_refs

    # Excluded kinds never appear
    kinds = {it["kind"] for it in items}
    for excluded in ("participant", "therapist", "care_link", "draft", "consent.accepted", "session.started", "review.recorded"):
        assert excluded not in kinds

    # Every item has all 6 required keys and trimmed origin_label
    entity_kinds = {"functional_assessment", "goal", "encounter", "reassessment", "instrumental_measurement"}
    for it in items:
        assert set(it.keys()) == {"kind", "ref", "occurred_at", "origin_label", "data_origin", "execution_mode"}
        assert it["data_origin"] == "synthetic_fixture"
        assert it["origin_label"] == origin_label_for("synthetic_fixture") == "[Dados sintéticos]"
        assert it["execution_mode"] == "not_applicable"

    # Verify R4 total order: (occurred_at, source_rank, kind, ref)
    sort_keys = [(it["occurred_at"], 0 if it["kind"] in entity_kinds else 1, it["kind"], it["ref"]) for it in items]
    assert sort_keys == sorted(sort_keys)


# =========================================================================
# 8. Row 11: Service adversarial cases V3-S1..V3-S4 iterated from file
# =========================================================================


def test_service_cases_v3_s1_to_v3_s4_from_cases_file(tmp_path: Path):
    cases_doc = _load_json(ADVERSARIAL_CASES_PATH)
    s_cases = [c for c in cases_doc["cases"] if c["id"] in {"V3-S1", "V3-S2", "V3-S3", "V3-S4"}]
    assert [c["id"] for c in s_cases] == ["V3-S1", "V3-S2", "V3-S3", "V3-S4"]

    w = _make_world(tmp_path / "std")
    client = w["client"]
    store = w["store"]
    rx_id, rx_rev = _publish_rx(client, w["t1_tok"], w["p1_id"], target_sets=1, target_repetitions=2)
    _grant_camera_consent(client, w["p1_tok"], w["org1"], w["p1_id"])

    _append_capture_session(client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_adv-0001", occurred_day="2026-11-20", mode="camera", assistance="full")
    _append_capture_session(client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_adv-0002", occurred_day="2026-11-21", mode="simulation", assistance="some")
    _append_report_only_session(client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_adv-0003", occurred_day="2026-11-22", assistance="full")
    _append_report_only_session(client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_adv-0004", occurred_day="2026-11-23", assistance="unreported")
    _append_report_only_session(client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_adv-0005", occurred_day="2026-11-24", assistance="none")

    facts_map = _list_facts_by_session_type(client, w["t1_tok"], w["p1_id"])
    f01_cam, h01_cam = facts_map[("s_adv-0001", "F01")]
    f01_sim, h01_sim = facts_map[("s_adv-0002", "F01")]
    f04_1, h04_1 = facts_map[("s_adv-0003", "F04")]
    f04_2, h04_2 = facts_map[("s_adv-0005", "F04")]

    # Approve f01_sim, f04_1, f04_2; leave f01_cam unapproved initially for V3-S1
    _record_review(client, w["t1_tok"], f01_sim["fact_id"], h01_sim, decision="approve")
    _record_review(client, w["t1_tok"], f04_1["fact_id"], h04_1, decision="approve")
    _record_review(client, w["t1_tok"], f04_2["fact_id"], h04_2, decision="approve")

    ser_list = client.get(f"/api/v3/participants/{w['p1_id']}/evolution/series", headers=_headers(w["t1_tok"])).json()["series"]
    sk_sim = next(s["series_key_hash"] for s in ser_list if s["series_key"]["fact_type"] == "F01")
    sk_f04 = next(s["series_key_hash"] for s in ser_list if s["series_key"]["fact_type"] == "F04")

    for case in s_cases:
        cid = case["id"]
        expected_code = case["expect"]["code"]

        if cid == "V3-S1":
            # evolution.publish citing a fact not approved -> UNREVIEWED_FACT_IN_EVOLUTION
            before = _table_counts(store)
            r = client.post(
                "/api/v3/evolution",
                headers=_headers(w["t1_tok"]),
                json={
                    "participant_id": w["p1_id"],
                    "period": {"from": "2026-11-20", "to": "2026-11-25"},
                    "series": [{"series_key_hash": sk_sim, "items": [{"fact_id": f01_cam["fact_id"], "content_hash": h01_cam}]}],
                },
            )
            assert r.status_code == 409
            assert r.json()["error"]["code"] == expected_code
            assert _table_counts(store) == before

        elif cid == "V3-S2":
            # evolution.publish citing an approval with a stale content_hash -> CONTENT_HASH_STALE
            before = _table_counts(store)
            r = client.post(
                "/api/v3/evolution",
                headers=_headers(w["t1_tok"]),
                json={
                    "participant_id": w["p1_id"],
                    "period": {"from": "2026-11-20", "to": "2026-11-25"},
                    "series": [{"series_key_hash": sk_sim, "items": [{"fact_id": f01_sim["fact_id"], "content_hash": "e" * 64}]}],
                },
            )
            assert r.status_code == 409
            assert r.json()["error"]["code"] == expected_code
            assert _table_counts(store) == before

        elif cid == "V3-S3":
            # All three V3-S3 sub-cases:
            # (a) camera + simulation in one series
            _record_review(client, w["t1_tok"], f01_cam["fact_id"], h01_cam, decision="approve")
            ser2 = client.get(f"/api/v3/participants/{w['p1_id']}/evolution/series", headers=_headers(w["t1_tok"])).json()["series"]
            sk_cam_obj = next(s["series_key"] for s in ser2 if s["series_key"]["fact_type"] == "F01" and s["series_key"]["execution_mode"] == "camera")
            sk_cam = hash_canonical(sk_cam_obj)

            before = _table_counts(store)
            r_mode = client.post(
                "/api/v3/evolution",
                headers=_headers(w["t1_tok"]),
                json={
                    "participant_id": w["p1_id"],
                    "period": {"from": "2026-11-20", "to": "2026-11-25"},
                    "series": [
                        {
                            "series_key_hash": sk_cam,
                            "items": [
                                {"fact_id": f01_cam["fact_id"], "content_hash": h01_cam},
                                {"fact_id": f01_sim["fact_id"], "content_hash": h01_sim},
                            ],
                        }
                    ],
                },
            )
            assert r_mode.status_code == 400 and r_mode.json()["error"]["code"] == expected_code
            assert _table_counts(store) == before

            # (b) F01 definition 1 vs 2 (D-S1-01-3 line 79)
            sk_def1 = dict(sk_cam_obj)
            sk_def1["fact_definition_version"] = "1"
            ok_def, code_def = check_series_comparability([sk_def1, sk_cam_obj])
            assert not ok_def and code_def == expected_code
            r_def = client.post(
                "/api/v3/evolution",
                headers=_headers(w["t1_tok"]),
                json={
                    "participant_id": w["p1_id"],
                    "period": {"from": "2026-11-20", "to": "2026-11-25"},
                    "series": [{"series_key_hash": hash_canonical(sk_def1), "items": [{"fact_id": f01_cam["fact_id"], "content_hash": h01_cam}]}],
                },
            )
            assert r_def.status_code == 400 and r_def.json()["error"]["code"] == expected_code
            assert _table_counts(store) == before

            # (c) experimental_capture vs live (with real_data_gate_open=True)
            w_live = _make_world(tmp_path / "live_s3", real_data_gate_open=True)
            _seed_rx_with_origin(
                w_live["store"], w_live["org1"], w_live["t1_id"], w_live["p1_id"], "rx_s3exp-01",
                target_sets=1, target_repetitions=2, revision=1,
                data_origin="experimental_capture", origin_ref="3" * 64,
            )
            _seed_rx_with_origin(
                w_live["store"], w_live["org1"], w_live["t1_id"], w_live["p1_id"], "rx_s3liv-01",
                target_sets=1, target_repetitions=2, revision=1,
                data_origin="live",
            )
            _grant_camera_consent(w_live["client"], w_live["p1_tok"], w_live["org1"], w_live["p1_id"])
            _append_capture_session(
                w_live["client"], w_live["p1_tok"], w_live["org1"], w_live["p1_id"], "rx_s3exp-01", 1, "s_mix-0001",
                occurred_day="2026-11-20", data_origin="experimental_capture", origin_ref="3" * 64,
            )
            _append_capture_session(
                w_live["client"], w_live["p1_tok"], w_live["org1"], w_live["p1_id"], "rx_s3liv-01", 1, "s_mix-0002",
                occurred_day="2026-11-21", data_origin="live",
            )
            fm_l = _list_facts_by_session_type(w_live["client"], w_live["t1_tok"], w_live["p1_id"])
            fl1, hl1 = fm_l[("s_mix-0001", "F01")]
            fl2, hl2 = fm_l[("s_mix-0002", "F01")]
            _record_review(w_live["client"], w_live["t1_tok"], fl1["fact_id"], hl1, decision="approve")
            _record_review(w_live["client"], w_live["t1_tok"], fl2["fact_id"], hl2, decision="approve")
            ser_l = w_live["client"].get(f"/api/v3/participants/{w_live['p1_id']}/evolution/series", headers=_headers(w_live["t1_tok"])).json()["series"]
            sk_exp_l = next(s["series_key_hash"] for s in ser_l if s["series_key"]["data_origin_class"] == "experimental_capture")
            before_l = _table_counts(w_live["store"])
            r_org = w_live["client"].post(
                "/api/v3/evolution",
                headers=_headers(w_live["t1_tok"]),
                json={
                    "participant_id": w_live["p1_id"],
                    "period": {"from": "2026-11-20", "to": "2026-11-25"},
                    "series": [
                        {
                            "series_key_hash": sk_exp_l,
                            "items": [
                                {"fact_id": fl1["fact_id"], "content_hash": hl1},
                                {"fact_id": fl2["fact_id"], "content_hash": hl2},
                            ],
                        }
                    ],
                },
            )
            assert r_org.status_code == 400 and r_org.json()["error"]["code"] == expected_code
            assert _table_counts(w_live["store"]) == before_l

        elif cid == "V3-S4":
            # assistance transition across an unreported session -> helper NO_TRANSITION_PRODUCED & absent from event
            h_res = compute_assistance_transition(
                {"fact_id": f04_1["fact_id"], "assistance_level": "full", "session_order_key": ("2026-11-22", "2026-11-22T14:00:00.000Z", "s_adv-0003")},
                {"fact_id": f04_2["fact_id"], "assistance_level": "none", "session_order_key": ("2026-11-24", "2026-11-24T14:00:00.000Z", "s_adv-0005")},
                series_key_hash=sk_f04,
                in_scope_sessions=[
                    {"session_id": "s_adv-0004", "session_date_local": "2026-11-23", "start_occurred_at": "2026-11-23T14:00:00.000Z", "assistance_level": "unreported"}
                ],
            )
            assert not h_res["produced"] and h_res["code"] == expected_code

            r_pub = client.post(
                "/api/v3/evolution",
                headers=_headers(w["t1_tok"]),
                json={
                    "participant_id": w["p1_id"],
                    "period": {"from": "2026-11-20", "to": "2026-11-25"},
                    "series_keys": [sk_f04],
                },
            )
            assert r_pub.status_code == 201, r_pub.text
            g = client.get(f"/api/v3/evolution/{r_pub.json()['evolution_id']}", headers=_headers(w["t1_tok"]))
            assert g.json()["event"]["payload"]["assistance_transitions"] == []


# =========================================================================
# 9. Row 8, Row 10, Row 12: Authorization matrix & server-authored only
# =========================================================================


def test_authorization_and_server_authored_only(tmp_path: Path):
    w = _make_world(tmp_path)
    client = w["client"]
    store = w["store"]

    rx_id, rx_rev = _publish_rx(client, w["t1_tok"], w["p1_id"])
    _append_report_only_session(client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, "s_auth-0001", occurred_day="2026-11-23", assistance="some")
    facts_map = _list_facts_by_session_type(client, w["t1_tok"], w["p1_id"])
    f04, h04 = facts_map[("s_auth-0001", "F04")]
    _record_review(client, w["t1_tok"], f04["fact_id"], h04, decision="approve")
    sk = client.get(f"/api/v3/participants/{w['p1_id']}/evolution/series", headers=_headers(w["t1_tok"])).json()["series"][0]["series_key_hash"]
    r_evo = client.post(
        "/api/v3/evolution",
        headers=_headers(w["t1_tok"]),
        json={"participant_id": w["p1_id"], "period": {"from": "2026-11-20", "to": "2026-11-25"}, "series_keys": [sk]},
    )
    assert r_evo.status_code == 201
    evo_id = r_evo.json()["evolution_id"]

    # Forged caregiver / supervisor tokens (PD-08)
    cg_tok, _ = store.issue_token(Principal(role="caregiver", id="t_forged-cg", org_id=w["org1"]))
    sup_tok, _ = store.issue_token(Principal(role="supervisor", id="t_forged-sup", org_id=w["org1"]))

    pub_payload = {"participant_id": w["p1_id"], "period": {"from": "2026-11-20", "to": "2026-11-25"}, "series_keys": [sk]}

    # 1. No token -> 401 UNAUTHENTICATED on all 4 routes
    for method, path, body in (
        ("GET", f"/api/v3/participants/{w['p1_id']}/evolution/series", None),
        ("POST", "/api/v3/evolution", pub_payload),
        ("GET", f"/api/v3/evolution/{evo_id}", None),
        ("GET", f"/api/v3/participants/{w['p1_id']}/timeline", None),
    ):
        r = client.request(method, path, json=body)
        assert r.status_code == 401 and r.json()["error"]["code"] == "UNAUTHENTICATED"

    # 2. Forged role -> 403 ROLE_NOT_ALLOWED on all 4 routes
    for tok in (cg_tok, sup_tok):
        for method, path, body in (
            ("GET", f"/api/v3/participants/{w['p1_id']}/evolution/series", None),
            ("POST", "/api/v3/evolution", pub_payload),
            ("GET", f"/api/v3/evolution/{evo_id}", None),
            ("GET", f"/api/v3/participants/{w['p1_id']}/timeline", None),
        ):
            r = client.request(method, path, headers=_headers(tok), json=body)
            assert r.status_code == 403 and r.json()["error"]["code"] == "ROLE_NOT_ALLOWED"

    # 3. Participant on therapist-only routes -> 403 FORBIDDEN
    for method, path, body in (
        ("GET", f"/api/v3/participants/{w['p1_id']}/evolution/series", None),
        ("POST", "/api/v3/evolution", pub_payload),
        ("GET", f"/api/v3/participants/{w['p1_id']}/timeline", None),
    ):
        r = client.request(method, path, headers=_headers(w["p1_tok"]), json=body)
        assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN"

    # 4. Unlinked (T2) and other-org (T3) therapists -> 403 SCOPE_VIOLATION on participant-scoped routes, 404 on evolution.get
    for tok in (w["t2_tok"], w["t3_tok"]):
        for method, path, body in (
            ("GET", f"/api/v3/participants/{w['p1_id']}/evolution/series", None),
            ("POST", "/api/v3/evolution", pub_payload),
            ("GET", f"/api/v3/participants/{w['p1_id']}/timeline", None),
        ):
            r = client.request(method, path, headers=_headers(tok), json=body)
            assert r.status_code == 403 and r.json()["error"]["code"] == "SCOPE_VIOLATION"
        r_g = client.get(f"/api/v3/evolution/{evo_id}", headers=_headers(tok))
        assert r_g.status_code == 404 and r_g.json()["error"]["code"] == "NOT_FOUND"

    # 5. Other participant (P2) and unknown evolution_id on evolution.get -> 404 NOT_FOUND (D-S0-02-1)
    assert client.get(f"/api/v3/evolution/{evo_id}", headers=_headers(w["p2_tok"])).status_code == 404
    assert client.get("/api/v3/evolution/evo_doesnotexist", headers=_headers(w["t1_tok"])).status_code == 404

    # 6. Row 10: evolution.published via events:batch -> rejected with FORBIDDEN
    evo_ev = client.get(f"/api/v3/evolution/{evo_id}", headers=_headers(w["t1_tok"])).json()["event"]
    forged_evo = _rehash(
        {
            **evo_ev,
            "seq": evo_ev["seq"] + 1,
            "prev_hash": evo_ev["hash"],
            "payload": {**evo_ev["payload"], "evolution_id": "evo_forged-0001"},
        }
    )
    r_b = client.post("/api/v3/events:batch", headers=_headers(w["p1_tok"]), json={"events": [forged_evo]})
    assert r_b.status_code == 200
    res_item = r_b.json()["results"][0]
    assert res_item["status"] == "rejected"
    assert "FORBIDDEN" in res_item["codes"]

    # 7. Revoke care_link -> T1 loses access (403 SCOPE_VIOLATION on participant routes, 404 on evolution.get)
    r_rev = client.post(f"/api/v3/care-links/{w['cl1_id']}:revoke", headers=_headers(w["t1_tok"]))
    assert r_rev.status_code == 200
    assert client.get(f"/api/v3/participants/{w['p1_id']}/evolution/series", headers=_headers(w["t1_tok"])).status_code == 403
    assert client.post("/api/v3/evolution", headers=_headers(w["t1_tok"]), json=pub_payload).status_code == 403
    assert client.get(f"/api/v3/participants/{w['p1_id']}/timeline", headers=_headers(w["t1_tok"])).status_code == 403
    assert client.get(f"/api/v3/evolution/{evo_id}", headers=_headers(w["t1_tok"])).status_code == 404
    # Own participant can still read their published evolution
    assert client.get(f"/api/v3/evolution/{evo_id}", headers=_headers(w["p1_tok"])).status_code == 200


# =========================================================================
# 10. Seeded randomized sequence oracle test (120 steps)
# =========================================================================


def test_seeded_evolution_sequences_against_oracle(tmp_path: Path, monkeypatch):
    """120-step deterministic seeded test verifying review states, staleness, comparability, and replay against an oracle."""
    monkeypatch.setattr(elo_api, "RATE_LIMIT", (10000, 60.0))
    rng = random.Random(20261125)
    w = _make_world(tmp_path)
    client = w["client"]
    rx_id, rx_rev = _publish_rx(client, w["t1_tok"], w["p1_id"], target_sets=1, target_repetitions=2)
    _grant_camera_consent(client, w["p1_tok"], w["org1"], w["p1_id"])

    # Seed 6 sessions across camera, simulation, and report_only (with one unreported assistance)
    session_specs = [
        ("s_ora-0001", "2026-11-20", "camera", "full"),
        ("s_ora-0002", "2026-11-21", "camera", "some"),
        ("s_ora-0003", "2026-11-22", "simulation", "none"),
        ("s_ora-0004", "2026-11-23", "report_only", "full"),
        ("s_ora-0005", "2026-11-24", "report_only", "unreported"),
        ("s_ora-0006", "2026-11-25", "report_only", "none"),
    ]
    session_events: dict[str, list[dict[str, Any]]] = {}
    for sid, day, mode, assist in session_specs:
        if mode == "report_only":
            session_events[sid] = _append_report_only_session(
                client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, sid, occurred_day=day, assistance=assist
            )
        else:
            session_events[sid] = _append_capture_session(
                client, w["p1_tok"], w["org1"], w["p1_id"], rx_id, rx_rev, sid, occurred_day=day, mode=mode, assistance=assist
            )

    # Independent oracle state
    seen_fids: set[str] = set()
    effective_review: dict[str, tuple[str, str]] = {}  # fid -> (decision, content_hash)
    known_fids: list[str] = []
    known_meta: dict[str, tuple[str, str, bool]] = {}  # fid -> (fact_type, sk_hash_or_empty, summary_eligible)
    published_evos: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}

    def _refresh_current() -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
        fm = _list_facts_by_session_type(client, w["t1_tok"], w["p1_id"])
        by_id: dict[str, dict[str, Any]] = {}
        ch_by_id: dict[str, str] = {}
        for (sid, ftype), (fact, ch) in fm.items():
            fid = fact["fact_id"]
            by_id[fid] = fact
            ch_by_id[fid] = ch
            if fid not in known_fids:
                known_fids.append(fid)
            known_meta[fid] = (ftype, sid, bool(fact["flags"]["summary_eligible"]))
        return by_id, ch_by_id

    cur_by_id, cur_hashes = _refresh_current()
    # Pre-compute series_key_hash per eligible fact by looking up via build_series_key
    rx_ev = w["store"].get_prescription(rx_id, rx_rev)
    assert rx_ev is not None

    def _sk_hash_of(fact: dict[str, Any]) -> str | None:
        sid = fact["scope"]["session_id"]
        s_evs = session_events[sid]
        start_ev = s_evs[0]
        f06 = next((f for f in cur_by_id.values() if f["scope"]["session_id"] == sid and f["type"] == "F06"), None)
        f06_low = bool(f06["params"]["low_capture_quality"]) if f06 is not None else None
        sk = build_series_key(fact, start_ev=start_ev, rx_ev=rx_ev, f06_low_quality=f06_low)
        return hash_canonical(sk) if sk is not None else None

    for step in range(120):
        action = rng.choices(
            ["review", "publish_explicit", "get_series", "replay", "supersede_report"],
            weights=[35, 35, 15, 10, 5],
            k=1,
        )[0]

        if action == "review":
            fid = rng.choice(list(cur_by_id.keys()))
            dec = rng.choice(["approve", "reject", "annotate"])
            _record_review(client, w["t1_tok"], fid, cur_hashes[fid], decision=dec, note=f"step-{step}" if dec == "annotate" else None)
            seen_fids.add(fid)
            if dec in ("approve", "reject"):
                effective_review[fid] = (dec, cur_hashes[fid])

        elif action == "get_series":
            r = client.get(f"/api/v3/participants/{w['p1_id']}/evolution/series", headers=_headers(w["t1_tok"]))
            assert r.status_code == 200
            returned_fids = {it["fact_id"] for s in r.json()["series"] for it in s["items"]}
            expected_fids = {
                fid
                for fid, f in cur_by_id.items()
                if f["flags"]["summary_eligible"]
                and fid in effective_review
                and effective_review[fid] == ("approve", cur_hashes[fid])
            }
            assert returned_fids == expected_fids, (step, returned_fids ^ expected_fids)

        elif action == "publish_explicit":
            k = rng.choice([1, 2])
            chosen = rng.sample(known_fids, min(k, len(known_fids)))
            # Pick a declared series_key_hash from the first derivable eligible chosen fact, or dummy hex
            declared_sk = "a" * 64
            for fid in chosen:
                if fid in cur_by_id:
                    h = _sk_hash_of(cur_by_id[fid])
                    if h is not None:
                        declared_sk = h
                        break

            items_req = [
                {"fact_id": fid, "content_hash": cur_hashes.get(fid, "0" * 64)}
                for fid in chosen
            ]

            # Oracle prediction following exact D-S1-01-3 1..6 precedence
            exp_status = 201
            exp_code: str | None = None
            series_sk_seen: str | None = None
            for it in items_req:
                fid = it["fact_id"]
                if fid not in cur_by_id:
                    if fid not in seen_fids:
                        exp_status, exp_code = 404, "NOT_FOUND"
                    else:
                        exp_status, exp_code = 409, "CONTENT_HASH_STALE"
                    break
                f = cur_by_id[fid]
                if not f["flags"]["summary_eligible"]:
                    exp_status, exp_code = 422, "FACT_NOT_SUMMARY_ELIGIBLE"
                    break
                ch = cur_hashes[fid]
                eff = effective_review.get(fid)
                if it["content_hash"] != ch or (eff is not None and eff[0] == "approve" and eff[1] != ch):
                    exp_status, exp_code = 409, "CONTENT_HASH_STALE"
                    break
                if eff is None or eff[0] != "approve" or eff[1] != ch:
                    exp_status, exp_code = 409, "UNREVIEWED_FACT_IN_EVOLUTION"
                    break
                comp_sk = _sk_hash_of(f)
                if comp_sk is None:
                    exp_status, exp_code = 400, "RULE_VIOLATION"
                    break
                if comp_sk != declared_sk or (series_sk_seen is not None and comp_sk != series_sk_seen):
                    exp_status, exp_code = 400, "COMPARABILITY_VIOLATION"
                    break
                series_sk_seen = comp_sk

            evo_id = f"evo_seed-{step:04d}"
            req_body = {
                "evolution_id": evo_id,
                "participant_id": w["p1_id"],
                "period": {"from": "2026-11-20", "to": "2026-11-26"},
                "series": [{"series_key_hash": declared_sk, "items": items_req}],
            }
            resp = client.post("/api/v3/evolution", headers=_headers(w["t1_tok"]), json=req_body)
            assert resp.status_code == exp_status, (step, chosen, resp.status_code, resp.text)
            if exp_code is not None:
                assert resp.json()["error"]["code"] == exp_code, (step, resp.json())
            else:
                published_evos[evo_id] = (req_body, resp.json())

        elif action == "replay" and published_evos:
            evo_id = rng.choice(list(published_evos.keys()))
            orig_req, orig_res = published_evos[evo_id]
            r_rep = client.post("/api/v3/evolution", headers=_headers(w["t1_tok"]), json=orig_req)
            assert r_rep.status_code == 200 and r_rep.json() == orig_res
            bad_req = {**orig_req, "period": {"from": "2026-11-19", "to": "2026-11-26"}}
            r_cf = client.post("/api/v3/evolution", headers=_headers(w["t1_tok"]), json=bad_req)
            assert r_cf.status_code == 409 and r_cf.json()["error"]["code"] == "CONFLICT_IMMUTABLE"

        elif action == "supersede_report":
            # Supersede report on s_ora-0004 (cycles assistance between full/some/none) -> makes old F04 stale
            sid = "s_ora-0004"
            last_ev = session_events[sid][-1]
            new_assist = rng.choice(["none", "some", "full"])
            new_rep = _rehash(
                {
                    "schema_version": 3,
                    "type": "report.submitted",
                    "stream_id": last_ev["stream_id"],
                    "seq": last_ev["seq"] + 1,
                    "prev_hash": last_ev["hash"],
                    "occurred_at": f"2026-11-23T15:{step // 60:02d}:{step % 60:02d}.000Z",
                    "actor": {"role": "participant", "id": w["p1_id"]},
                    "scope": dict(last_ev["scope"]),
                    "source": {"type": "participant_report"},
                    "execution_mode": "report_only",
                    "data_origin": "synthetic_fixture",
                    "payload": {"execution": "complete", "assistance": new_assist, "reporter_role": "participant"},
                }
            )
            rb = client.post("/api/v3/events:batch", headers=_headers(w["p1_tok"]), json={"events": [new_rep]})
            assert rb.status_code == 200 and rb.json()["results"][0]["status"] == "stored"
            session_events[sid].append(new_rep)
            cur_by_id, cur_hashes = _refresh_current()
