"""Tests for S1b-01: session-phase state machine and stateful session-stream rules.

Covers ACCEPTANCE rows 1-8 and row 10 (mutation sensitivity).
All test credentials and identifiers are synthetic and generated at runtime.
"""

from __future__ import annotations

import copy
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from elo.api import create_app
from elo.canonical import compute_event_hash, compute_event_id
from elo.v3.entities import new_id
from elo.v3.errors import EMITTABLE_ERROR_CODES, ITEM_WARNING_CODES
from elo.v3.session_rules import (
    ALLOWED_PRE_PHASES,
    SESSION_PHASES,
    SESSION_RULE_ERROR_CODES,
    SESSION_RULE_WARNING_CODES,
    TERMINAL_PHASES,
    advance_phase,
    evaluate_session_stream,
    is_terminal_phase,
    project_prescription,
    project_session_event,
)
from elo.v3.store import V3Store

REPO_ROOT = Path(__file__).resolve().parents[2]
PKG = REPO_ROOT / "contracts" / "CL06_3-r1"
ERROR_CODES_PATH = PKG / "contracts" / "catalogs" / "error-codes.v3.json"
LEDGER_PATH = PKG / "fixtures" / "valid" / "ledger.v3.json"
ORIGIN_REGISTER_PATH = REPO_ROOT / "docs" / "ORIGIN_REGISTER.md"

SPEC_SHAS = (
    "52376bace2fd829a4fd48a1fa5ff85d9ae83dda5e229e52749908088c75b04b9",
    "7759c9952c73dd1067543993f123f4af4139c23d084553de950c8693817a8fc8",
    "1b812c75760f01b893429633d7b3636f442c34d48a0f824459ea29fbd3497b66",
    "9ae0e0518ce23c89dc2304ea96a6bc27835379d618a7315f9d1a4d2e4deede51",
)

DEFAULT_STREAMS_PATH = (
    Path.home()
    / "hackathons"
    / "elo-platform"
    / "knowledge"
    / "objects"
    / "9ae0e0518ce23c89dc2304ea96a6bc27835379d618a7315f9d1a4d2e4deede51"
    / "streams.json"
)

# Exact oracle outcomes of unmodified SPEC checkSessionStream on all 10 cases of streams.json (D-S1b-01-2).
SPEC_STREAMS_ORACLE: dict[str, dict[str, Any]] = {
    "S01": {"errors": ["OUT_OF_ORDER"], "warnings": ["CLOCK_REGRESSION"], "phase": "ended", "replayable": True},
    "S02": {"errors": ["CHAIN_BROKEN"], "warnings": [], "phase": "ended", "replayable": True},
    "S03": {"errors": [], "warnings": ["SEQ_GAP"], "phase": "active", "replayable": False},
    "S04": {"errors": ["INVALID_TRANSITION", "RULE_VIOLATION"], "warnings": [], "phase": "ended", "replayable": True},
    "S05": {"errors": ["CALIBRATION_MISMATCH"], "warnings": [], "phase": "ended", "replayable": True},
    "S06": {"errors": ["COMPLETION_INCONSISTENT"], "warnings": [], "phase": "ended", "replayable": True},
    "S07": {"errors": ["SOURCE_INCONSISTENT"], "warnings": [], "phase": "ended", "replayable": True},
    "S08": {"errors": ["HASH_CONFLICT"], "warnings": [], "phase": "ended", "replayable": True},
    "S09": {"errors": ["PRESCRIPTION_NOT_FOUND"], "warnings": [], "phase": "ended", "replayable": True},
    "S10": {"errors": ["SOURCE_INCONSISTENT"], "warnings": [], "phase": "ended", "replayable": True},
}


def _rehash(ev: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(ev)
    out["event_id"] = compute_event_id(out["stream_id"], out["seq"])
    out["hash"] = compute_event_hash(out)
    return out


class _SessionBuilder:
    """Helper that constructs schema-valid, hash-chained CL06.3 v3 session events."""

    def __init__(
        self,
        *,
        org_id: str,
        participant_id: str,
        session_id: str | None = None,
        prescription_id: str = "rx_fixture-0001",
        prescription_revision: int = 1,
        exercise_id: str = "organizar-a-mesa",
        mode: str = "camera",
        algorithm_version: str = "c05-hand-2",
        data_origin: str = "synthetic_fixture",
        base_time: datetime | None = None,
    ) -> None:
        self.org_id = org_id
        self.participant_id = participant_id
        self.session_id = session_id or new_id("s")
        self.prescription_id = prescription_id
        self.prescription_revision = prescription_revision
        self.exercise_id = exercise_id
        self.mode = mode
        self.algorithm_version = algorithm_version
        self.data_origin = data_origin
        self.base_time = base_time or datetime(2026, 11, 25, 10, 0, 0, tzinfo=timezone.utc)
        self.events: list[dict[str, Any]] = []
        self._mono = 0
        self._sec = 0

    @property
    def stream_id(self) -> str:
        return f"session:{self.session_id}"

    def _next_occurred_at(self, occurred_at: str | None) -> str:
        if occurred_at is not None:
            return occurred_at
        self._sec += 1
        return (self.base_time + timedelta(seconds=self._sec)).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    def _default_source(self, ev_type: str, source_type: str | None, algo: str | None) -> dict[str, Any]:
        if ev_type == "report.submitted":
            return {"type": source_type or "participant_report"}
        stype = source_type or {"camera": "camera", "simulation": "simulation", "report_only": "participant_report"}[self.mode]
        src: dict[str, Any] = {"type": stype}
        if stype in ("camera", "simulation"):
            src["algorithm_version"] = algo if algo is not None else self.algorithm_version
            src["device_hint"] = "desktop-chrome"
        return src

    def add(
        self,
        ev_type: str,
        payload: dict[str, Any],
        *,
        seq: int | None = None,
        prev_hash: str | None = None,
        t_mono_ms: int | None = None,
        include_mono: bool | None = None,
        occurred_at: str | None = None,
        source_type: str | None = None,
        algorithm_version: str | None = None,
        scope_override: dict[str, Any] | None = None,
        data_origin: str | None = None,
        execution_mode: str | None = None,
    ) -> dict[str, Any]:
        actual_seq = seq if seq is not None else len(self.events) + 1
        if prev_hash is None and actual_seq > 1 and self.events:
            actual_prev = self.events[-1]["hash"]
        else:
            actual_prev = prev_hash
        scope = {
            "org_id": self.org_id,
            "participant_id": self.participant_id,
            "session_id": self.session_id,
            "prescription_id": self.prescription_id,
            "prescription_revision": self.prescription_revision,
            "exercise_id": self.exercise_id,
        }
        if scope_override:
            scope.update(scope_override)
        ev: dict[str, Any] = {
            "event_id": "",
            "schema_version": 3,
            "type": ev_type,
            "stream_id": self.stream_id,
            "seq": actual_seq,
            "prev_hash": actual_prev,
            "occurred_at": self._next_occurred_at(occurred_at),
            "actor": {"role": "participant", "id": self.participant_id},
            "scope": scope,
            "source": self._default_source(ev_type, source_type, algorithm_version),
            "execution_mode": execution_mode or self.mode,
            "data_origin": data_origin or self.data_origin,
            "payload": payload,
        }
        want_mono = include_mono if include_mono is not None else (self.mode in ("camera", "simulation") and ev_type != "report.submitted")
        if want_mono:
            if t_mono_ms is not None:
                ev["t_mono_ms"] = t_mono_ms
            else:
                self._mono += 500
                ev["t_mono_ms"] = self._mono
        ev = _rehash(ev)
        self.events.append(ev)
        return ev

    def start_session(self, **kw: Any) -> dict[str, Any]:
        ctx = None if self.mode == "report_only" else {"device_hint": "desktop-chrome", "frame_width": 640, "frame_height": 480}
        return self.add(
            "session.started",
            {
                "source_mode": self.mode,
                "prescription_id": self.prescription_id,
                "prescription_revision": self.prescription_revision,
                "capture_context": ctx,
            },
            **kw,
        )

    def calibrate(self, cal_id: str = "cal_test-0001", attempt_base: int = 1) -> dict[str, Any]:
        open_ev = self.add(
            "calibration.attempted",
            {
                "attempt": attempt_base,
                "posture": "open",
                "n_samples": 24,
                "median": 1.9,
                "mad": 0.02,
                "accepted": True,
                "reason": None,
            },
        )
        closed_ev = self.add(
            "calibration.attempted",
            {
                "attempt": attempt_base + 1,
                "posture": "closed",
                "n_samples": 24,
                "median": 0.8,
                "mad": 0.02,
                "accepted": True,
                "reason": None,
            },
        )
        return self.add(
            "calibration.applied",
            {
                "calibration_id": cal_id,
                "open": 1.9,
                "closed": 0.8,
                "span": 1.1,
                "open_samples": 24,
                "closed_samples": 24,
                "attempt_refs": sorted([open_ev["event_id"], closed_ev["event_id"]]),
                "min_span_required": None,
            },
        )

    def control(self, action: str, *, interrupt_reason: str | None = None, **kw: Any) -> dict[str, Any]:
        return self.add(
            "session.control",
            {"action": action, "interrupt_reason": interrupt_reason},
            **kw,
        )

    def cycle_accepted(self, idx: int, cal_id: str = "cal_test-0001", **kw: Any) -> dict[str, Any]:
        return self.add(
            "cycle.accepted",
            {
                "cycle_index": idx,
                "calibration_id": cal_id,
                "open_peak_n": 0.9,
                "closed_trough_n": 0.05,
                "armed_to_close_ms": 500,
                "frames": 30,
                "usable_frames": 28,
                "handedness": {"label": "right", "score": 0.97},
            },
            **kw,
        )

    def cycle_rejected(self, idx: int, cal_id: str = "cal_test-0001", reason: str = "low_quality", **kw: Any) -> dict[str, Any]:
        return self.add(
            "cycle.rejected",
            {
                "cycle_index": idx,
                "calibration_id": cal_id,
                "open_peak_n": 0.9,
                "closed_trough_n": 0.05,
                "armed_to_close_ms": 500,
                "frames": 30,
                "usable_frames": 28,
                "handedness": {"label": "right", "score": 0.97},
                "reason": reason,
            },
            **kw,
        )

    def observation(self, cal_id: str = "cal_test-0001", **kw: Any) -> dict[str, Any]:
        return self.add(
            "observation.recorded",
            {
                "calibration_id": cal_id,
                "metric": 1.2,
                "metric_unit": "1",
                "quality": "usable",
                "quality_reason": None,
                "handedness": {"label": "right", "score": 0.97},
                "fps_window": 24.0,
            },
            **kw,
        )

    def completed(self, accepted: int, target: int, **kw: Any) -> dict[str, Any]:
        return self.add("session.completed", {"accepted": accepted, "target": target}, **kw)

    def capture_summary(self, **kw: Any) -> dict[str, Any]:
        return self.add(
            "session.capture_summary",
            {
                "frames_total": 120,
                "fps_mean": 24.0,
                "fps_min": 18.0,
                "usable_fraction": 0.9,
                "lost_events": 0,
            },
            **kw,
        )

    def measurement(self, **kw: Any) -> dict[str, Any]:
        return self.add(
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
                "limitation_codes": ["L10"],
                "experimental": True,
                "body_segment": "hand",
            },
            **kw,
        )

    def report(self, execution: str = "complete", **kw: Any) -> dict[str, Any]:
        return self.add(
            "report.submitted",
            {"execution": execution, "assistance": "none", "reporter_role": "participant"},
            **kw,
        )


def _sample_prescription(
    *,
    participant_id: str = "p_test-0001",
    prescription_id: str = "rx_fixture-0001",
    revision: int = 1,
    target_sets: int = 1,
    target_repetitions: int = 4,
) -> dict[str, Any]:
    return {
        "prescription_id": prescription_id,
        "revision": revision,
        "participant_id": participant_id,
        "target_sets": target_sets,
        "target_repetitions": target_repetitions,
    }


def _seed_app_with_rx_and_consent(monkeypatch, *, target_sets: int = 1, target_repetitions: int = 4):
    monkeypatch.delenv("ELO_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("ELO_V3_REAL_DATA_GATE_OPEN", raising=False)
    monkeypatch.setenv("ELO_V3_DATA_ORIGIN", "synthetic_fixture")

    org_id = new_id("o")
    t_id = new_id("t")
    t_pw = secrets.token_urlsafe(12)
    monkeypatch.setenv(
        "ELO_V3_THERAPIST_SEEDS",
        json.dumps([{"therapist_id": t_id, "username": "t_rules", "password": t_pw, "org_id": org_id, "display_label": "T Rules"}]),
    )
    app = create_app(":memory:")
    client = TestClient(app)

    t_tok = client.post("/api/v3/auth/therapist", json={"username": "t_rules", "password": t_pw}).json()["token"]
    t_hdr = {"Authorization": f"Bearer {t_tok}"}

    p = client.post("/api/v3/participants", headers=t_hdr, json={"alias": "Rules P1", "side": "right"}).json()
    p_id = p["entity_id"]
    inv = client.post("/api/v3/invites", headers=t_hdr, json={"participant_id": p_id}).json()
    p_tok = client.post("/api/v3/auth/invite", json={"invite_token": inv["invite_token"]}).json()["token"]
    p_hdr = {"Authorization": f"Bearer {p_tok}"}

    rx_resp = client.post(
        "/api/v3/prescriptions",
        headers=t_hdr,
        json={
            "participant_id": p_id,
            "exercise_id": "organizar-a-mesa",
            "permitted_movement": "hand_open_close",
            "side": "right",
            "target_sets": target_sets,
            "target_repetitions": target_repetitions,
            "sessions_per_week": 5,
            "valid_from": "2026-11-23",
            "valid_to": "2026-12-21",
            "timezone": "America/Sao_Paulo",
            "min_calibration_span": None,
            "instructions_ptbr": "Abra e feche a mão no seu ritmo.",
        },
    )
    assert rx_resp.status_code == 201, rx_resp.text
    rx_res = rx_resp.json()

    consent = _rehash(
        {
            "event_id": "",
            "schema_version": 3,
            "type": "consent.accepted",
            "stream_id": f"consent:{p_id}",
            "seq": 1,
            "prev_hash": None,
            "occurred_at": "2026-11-25T09:59:00.000Z",
            "actor": {"role": "participant", "id": p_id},
            "scope": {"org_id": org_id, "participant_id": p_id},
            "source": {"type": "participant_report"},
            "execution_mode": "not_applicable",
            "data_origin": "synthetic_fixture",
            "payload": {"consent_version": "consent-2026-11-25-v1", "scopes": ["camera"]},
        }
    )
    rc = client.post("/api/v3/events:batch", headers=p_hdr, json={"events": [consent]})
    assert rc.status_code == 200 and rc.json()["results"][0]["status"] == "stored"

    return app, client, {
        "org_id": org_id,
        "p_id": p_id,
        "p_hdr": p_hdr,
        "rx_id": rx_res["prescription_id"],
        "rx_rev": rx_res["revision"],
    }


# --- Row 1: All 10 CL06.1 streams.json fixtures, iterated dynamically (D-S1b-01-1, D-S1b-01-2) ---


def test_cl06_1_streams_fixtures_exact_parity():
    streams_path = Path(os.environ.get("ELO_CL06_1_STREAMS_PATH", str(DEFAULT_STREAMS_PATH)))
    assert streams_path.is_file(), f"CL06.1 streams.json fixture not found at {streams_path}"

    cases = json.loads(streams_path.read_text(encoding="utf-8"))
    assert isinstance(cases, list) and len(cases) == 10

    seen_ids: list[str] = []
    for case in cases:
        cid = case["id"]
        seen_ids.append(cid)
        projected_events = [project_session_event(ev) for ev in case["value"]]
        projected_rx = project_prescription(case.get("prescription"))
        report = evaluate_session_stream(projected_events, projected_rx)

        err_codes = sorted({f.code for f in report.errors})
        warn_codes = sorted({f.code for f in report.warnings})
        exp = case["expect"]

        # Verify anchor expect code (with warning flag) is contained appropriately
        if exp.get("warning"):
            assert exp["code"] in warn_codes, f"{cid}: expected warning {exp['code']} in {warn_codes}"
            assert err_codes == [], f"{cid}: unexpected errors {err_codes}"
        else:
            assert exp["code"] in err_codes, f"{cid}: expected error {exp['code']} in {err_codes}"

        # Verify exact full code set (errors + warnings) and gap-aware final phase match unmodified SPEC
        oracle = SPEC_STREAMS_ORACLE[cid]
        assert err_codes == oracle["errors"], f"{cid}: errors {err_codes} != oracle {oracle['errors']}"
        assert warn_codes == oracle["warnings"], f"{cid}: warnings {warn_codes} != oracle {oracle['warnings']}"
        assert report.state.phase == oracle["phase"], f"{cid}: phase {report.state.phase} != oracle {oracle['phase']}"
        assert report.state.replayable is oracle["replayable"], f"{cid}: replayable mismatch"

    assert len(seen_ids) == 10


# --- Row 2: Positive and negative named tests for all 7 stream-layer codes ---


def test_invalid_transition_positive_and_negative():
    rx = _sample_prescription()
    # Positive: cycle.accepted while paused -> INVALID_TRANSITION (also exercises Row 10 mutation 1)
    b_bad = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_bad.start_session()
    b_bad.calibrate("cal_t-0001")
    b_bad.control("start")
    b_bad.control("pause")
    b_bad.cycle_accepted(1, "cal_t-0001")
    rep_bad = evaluate_session_stream(b_bad.events, rx)
    assert "INVALID_TRANSITION" in {f.code for f in rep_bad.errors}
    assert rep_bad.state.phase == "paused"

    # Negative: minimally different valid sequence resumes before cycle.accepted -> no error
    b_ok = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_ok.start_session()
    b_ok.calibrate("cal_t-0001")
    b_ok.control("start")
    b_ok.control("pause")
    b_ok.control("resume")
    b_ok.cycle_accepted(1, "cal_t-0001")
    rep_ok = evaluate_session_stream(b_ok.events, rx)
    assert rep_ok.errors == [] and rep_ok.warnings == []
    assert rep_ok.state.phase == "active"


def test_over_target_positive_and_negative():
    rx = _sample_prescription(target_sets=1, target_repetitions=2)
    # Positive: 3rd accepted cycle exceeds target=2 -> OVER_TARGET (also exercises Row 10 mutation 2)
    b_bad = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_bad.start_session()
    b_bad.calibrate("cal_t-0001")
    b_bad.control("start")
    b_bad.cycle_accepted(1, "cal_t-0001")
    b_bad.cycle_accepted(2, "cal_t-0001")
    b_bad.cycle_accepted(3, "cal_t-0001")
    rep_bad = evaluate_session_stream(b_bad.events, rx)
    assert "OVER_TARGET" in {f.code for f in rep_bad.errors}

    # Negative: exactly 2 accepted cycles followed by session.completed -> no error
    b_ok = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_ok.start_session()
    b_ok.calibrate("cal_t-0001")
    b_ok.control("start")
    b_ok.cycle_accepted(1, "cal_t-0001")
    b_ok.cycle_accepted(2, "cal_t-0001")
    b_ok.completed(2, 2)
    rep_ok = evaluate_session_stream(b_ok.events, rx)
    assert rep_ok.errors == [] and rep_ok.warnings == []
    assert rep_ok.state.phase == "completed"


def test_calibration_mismatch_positive_and_negative():
    rx = _sample_prescription()
    # Positive: recalibrated before start, but cycle cites the superseded first calibration_id
    b_bad = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_bad.start_session()
    b_bad.calibrate("cal_first-0001", attempt_base=1)
    b_bad.calibrate("cal_second-0002", attempt_base=3)
    b_bad.control("start")
    b_bad.cycle_accepted(1, "cal_first-0001")
    rep_bad = evaluate_session_stream(b_bad.events, rx)
    assert [f.code for f in rep_bad.errors] == ["CALIBRATION_MISMATCH"]

    # Negative: cycle cites the latest effective calibration_id applied before start
    b_ok = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_ok.start_session()
    b_ok.calibrate("cal_first-0001", attempt_base=1)
    b_ok.calibrate("cal_second-0002", attempt_base=3)
    b_ok.control("start")
    b_ok.cycle_accepted(1, "cal_second-0002")
    rep_ok = evaluate_session_stream(b_ok.events, rx)
    assert rep_ok.errors == [] and rep_ok.warnings == []
    assert rep_ok.state.effective_calibration_id == "cal_second-0002"


def test_completion_inconsistent_positive_and_negative():
    rx = _sample_prescription(target_sets=1, target_repetitions=2)
    # Positive (a): reaching target then sending session.control(fatigue) instead of session.completed
    b_after = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_after.start_session()
    b_after.calibrate("cal_t-0001")
    b_after.control("start")
    b_after.cycle_accepted(1, "cal_t-0001")
    b_after.cycle_accepted(2, "cal_t-0001")
    b_after.control("fatigue")
    rep_after = evaluate_session_stream(b_after.events, rx)
    assert [f.code for f in rep_after.errors] == ["COMPLETION_INCONSISTENT"]

    # Positive (b): session.completed before reaching target (accepted count mismatch)
    b_early = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_early.start_session()
    b_early.calibrate("cal_t-0001")
    b_early.control("start")
    b_early.cycle_accepted(1, "cal_t-0001")
    b_early.completed(2, 2)
    rep_early = evaluate_session_stream(b_early.events, rx)
    assert [f.code for f in rep_early.errors] == ["COMPLETION_INCONSISTENT"]

    # Negative: reaching target immediately followed by matching session.completed
    b_ok = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_ok.start_session()
    b_ok.calibrate("cal_t-0001")
    b_ok.control("start")
    b_ok.cycle_accepted(1, "cal_t-0001")
    b_ok.cycle_accepted(2, "cal_t-0001")
    b_ok.completed(2, 2)
    rep_ok = evaluate_session_stream(b_ok.events, rx)
    assert rep_ok.errors == [] and rep_ok.warnings == []
    assert rep_ok.state.phase == "completed"


def test_source_inconsistent_positive_and_negative():
    rx = _sample_prescription()
    # Positive (a): source.type switches camera -> simulation mid-session
    b_src = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_src.start_session()
    b_src.calibrate("cal_t-0001")
    b_src.control("start")
    b_src.cycle_accepted(1, "cal_t-0001", source_type="simulation")
    assert [f.code for f in evaluate_session_stream(b_src.events, rx).errors] == ["SOURCE_INCONSISTENT"]

    # Positive (b): algorithm_version changes mid-session
    b_alg = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_alg.start_session()
    b_alg.calibrate("cal_t-0001")
    b_alg.control("start")
    b_alg.cycle_accepted(1, "cal_t-0001", algorithm_version="c05-hand-3")
    assert [f.code for f in evaluate_session_stream(b_alg.events, rx).errors] == ["SOURCE_INCONSISTENT"]

    # Positive (c): scope or data_origin changes mid-session
    b_scope = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_scope.start_session()
    b_scope.calibrate("cal_t-0001")
    b_scope.control("start")
    b_scope.cycle_accepted(1, "cal_t-0001", scope_override={"participant_id": "p_other-9999"})
    assert [f.code for f in evaluate_session_stream(b_scope.events, rx).errors] == ["SOURCE_INCONSISTENT"]

    # Negative: consistent camera source/algorithm/scope/origin, with report.submitted using participant_report
    b_ok = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_ok.start_session()
    b_ok.calibrate("cal_t-0001")
    b_ok.control("start")
    b_ok.cycle_accepted(1, "cal_t-0001")
    b_ok.control("end")
    b_ok.report("partial")
    rep_ok = evaluate_session_stream(b_ok.events, rx)
    assert rep_ok.errors == [] and rep_ok.warnings == []


def test_out_of_order_positive_and_negative():
    rx = _sample_prescription()
    # Positive: monotonic timestamp regresses
    b_bad = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_bad.start_session(t_mono_ms=100)
    b_bad.calibrate("cal_t-0001")
    b_bad.control("start", t_mono_ms=3000)
    b_bad.cycle_accepted(1, "cal_t-0001", t_mono_ms=2500)
    rep_bad = evaluate_session_stream(b_bad.events, rx)
    assert [f.code for f in rep_bad.errors] == ["OUT_OF_ORDER"]

    # Negative: monotonic timestamp stays equal or increases
    b_ok = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_ok.start_session(t_mono_ms=100)
    b_ok.calibrate("cal_t-0001")
    b_ok.control("start", t_mono_ms=3000)
    b_ok.cycle_accepted(1, "cal_t-0001", t_mono_ms=3000)
    rep_ok = evaluate_session_stream(b_ok.events, rx)
    assert rep_ok.errors == [] and rep_ok.warnings == []


def test_clock_regression_positive_and_negative():
    rx = _sample_prescription()
    # Positive: occurred_at moves backward while t_mono_ms remains monotonic -> warning CLOCK_REGRESSION, no errors
    b_warn = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_warn.start_session(t_mono_ms=100)
    b_warn.calibrate("cal_t-0001")
    b_warn.control("start", occurred_at="2026-11-25T10:00:20.000Z", t_mono_ms=3000)
    b_warn.cycle_accepted(1, "cal_t-0001", occurred_at="2026-11-25T10:00:19.000Z", t_mono_ms=3500)
    rep_warn = evaluate_session_stream(b_warn.events, rx)
    assert rep_warn.errors == []
    assert [f.code for f in rep_warn.warnings] == ["CLOCK_REGRESSION"]

    # Negative: non-decreasing occurred_at -> no warning and no error
    b_ok = _SessionBuilder(org_id="o_t1", participant_id="p_test-0001")
    b_ok.start_session(t_mono_ms=100)
    b_ok.calibrate("cal_t-0001")
    b_ok.control("start", occurred_at="2026-11-25T10:00:20.000Z", t_mono_ms=3000)
    b_ok.cycle_accepted(1, "cal_t-0001", occurred_at="2026-11-25T10:00:20.000Z", t_mono_ms=3500)
    rep_ok = evaluate_session_stream(b_ok.events, rx)
    assert rep_ok.errors == [] and rep_ok.warnings == []


# --- Row 3: Phase machine completeness, modes, recalibration, terminals, D-S1b-01-3 ---


def test_phase_machine_all_phases_modes_recalibration_and_terminals():
    assert SESSION_PHASES == ("created", "calibrated", "active", "paused", "ended", "completed")
    assert TERMINAL_PHASES == frozenset({"ended", "completed"})
    assert is_terminal_phase("ended") and is_terminal_phase("completed")
    assert not is_terminal_phase("active") and not is_terminal_phase(None)

    def _ev(ev_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            "event_id": "a" * 64,
            "type": ev_type,
            "stream_id": "session:s_pm",
            "seq": 1,
            "hash": "b" * 64,
            "prev_hash": None,
            "occurred_at": "2026-11-25T10:00:00.000Z",
            "scope": {},
            "data_origin": "synthetic_fixture",
            "source": {"type": "camera"},
            "payload": payload or {},
        }

    # Capture modes require calibration before control:start
    for mode in ("camera", "simulation"):
        assert advance_phase(None, _ev("session.started", {"source_mode": mode}), mode) == ("created", None)
        assert advance_phase("created", _ev("session.control", {"action": "start"}), mode) == (None, "INVALID_TRANSITION")
        assert advance_phase("created", _ev("calibration.applied"), mode) == ("calibrated", None)
        # Recalibration allowed in calibrated before start
        assert advance_phase("calibrated", _ev("calibration.attempted"), mode) == ("calibrated", None)
        assert advance_phase("calibrated", _ev("calibration.applied"), mode) == ("calibrated", None)
        assert advance_phase("calibrated", _ev("calibration.failed"), mode) == ("calibrated", None)
        assert advance_phase("calibrated", _ev("session.control", {"action": "start"}), mode) == ("active", None)
        # Recalibration forbidden after start
        for phase_after in ("active", "paused", "ended", "completed"):
            assert advance_phase(phase_after, _ev("calibration.applied"), mode) == (None, "INVALID_TRANSITION")
            assert advance_phase(phase_after, _ev("calibration.attempted"), mode) == (None, "INVALID_TRANSITION")
        # Pause / resume & active-only vs paused-allowed capture events
        assert advance_phase("active", _ev("observation.recorded"), mode) == ("active", None)
        assert advance_phase("active", _ev("cycle.accepted"), mode) == ("active", None)
        assert advance_phase("active", _ev("cycle.rejected"), mode) == ("active", None)
        assert advance_phase("active", _ev("session.control", {"action": "pause"}), mode) == ("paused", None)
        assert advance_phase("paused", _ev("cycle.rejected"), mode) == ("paused", None)
        assert advance_phase("paused", _ev("cycle.accepted"), mode) == (None, "INVALID_TRANSITION")
        assert advance_phase("paused", _ev("observation.recorded"), mode) == (None, "INVALID_TRANSITION")
        assert advance_phase("paused", _ev("session.control", {"action": "resume"}), mode) == ("active", None)
        # Completion
        assert advance_phase("active", _ev("session.completed"), mode) == ("completed", None)
        assert advance_phase("paused", _ev("session.completed"), mode) == (None, "INVALID_TRANSITION")
        # measurement.recorded (D-S1b-01-3): allowed ONLY in ended/completed for capture modes
        for non_term in ("created", "calibrated", "active", "paused"):
            assert advance_phase(non_term, _ev("measurement.recorded"), mode) == (None, "INVALID_TRANSITION")
        for term in ("ended", "completed"):
            assert advance_phase(term, _ev("measurement.recorded"), mode) == (term, None)
            assert advance_phase(term, _ev("session.capture_summary"), mode) == (term, None)
            assert advance_phase(term, _ev("report.submitted"), mode) == (term, None)
            assert advance_phase(term, _ev("cycle.accepted"), mode) == (None, "INVALID_TRANSITION")
            assert advance_phase(term, _ev("session.control", {"action": "end"}), mode) == (None, "INVALID_TRANSITION")

    # report_only starts directly from created without calibration and forbids all capture-only types
    assert advance_phase("created", _ev("session.control", {"action": "start"}), "report_only") == ("active", None)
    assert advance_phase("active", _ev("session.control", {"action": "pause"}), "report_only") == ("paused", None)
    assert advance_phase("paused", _ev("session.control", {"action": "resume"}), "report_only") == ("active", None)
    assert advance_phase("active", _ev("session.control", {"action": "end"}), "report_only") == ("ended", None)
    assert advance_phase("ended", _ev("report.submitted"), "report_only") == ("ended", None)
    for cap_type in ("calibration.applied", "observation.recorded", "cycle.accepted", "cycle.rejected", "session.completed", "session.capture_summary", "measurement.recorded"):
        for ph in SESSION_PHASES:
            assert advance_phase(ph, _ev(cap_type), "report_only") == (None, "INVALID_TRANSITION")

    # All 4 end actions transition every non-terminal phase to ended
    for action in ("end", "pain", "fatigue", "interrupt"):
        for ph in ("created", "calibrated", "active", "paused"):
            assert advance_phase(ph, _ev("session.control", {"action": action}), "camera") == ("ended", None)
        for term in ("ended", "completed"):
            assert advance_phase(term, _ev("session.control", {"action": action}), "camera") == (None, "INVALID_TRANSITION")

    assert ALLOWED_PRE_PHASES["measurement.recorded"] == frozenset({"ended", "completed"})


# --- Row 4: Wired into store-level append AND HTTP POST /api/v3/events:batch ---


def test_store_append_and_events_batch_wiring_warnings_rejects_and_poison(monkeypatch):
    app, client, ctx = _seed_app_with_rx_and_consent(monkeypatch, target_sets=1, target_repetitions=2)
    p_hdr = ctx["p_hdr"]

    def _post_batch(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        r = client.post("/api/v3/events:batch", headers=p_hdr, json={"events": events})
        assert r.status_code == 200, r.text
        return r.json()["results"]

    # 1. CLOCK_REGRESSION is stored with warning code and does NOT poison the stream
    b_clk = _SessionBuilder(
        org_id=ctx["org_id"],
        participant_id=ctx["p_id"],
        prescription_id=ctx["rx_id"],
        prescription_revision=ctx["rx_rev"],
    )
    b_clk.start_session(t_mono_ms=100)
    b_clk.calibrate("cal_clk-0001")
    b_clk.control("start", occurred_at="2026-11-25T10:10:20.000Z", t_mono_ms=3000)
    b_clk.cycle_accepted(1, "cal_clk-0001", occurred_at="2026-11-25T10:10:19.000Z", t_mono_ms=3500)
    b_clk.control("end", occurred_at="2026-11-25T10:10:25.000Z", t_mono_ms=4000)
    res_clk = _post_batch(b_clk.events)
    assert [it["status"] for it in res_clk] == ["stored"] * len(b_clk.events)
    assert res_clk[-2]["codes"] == ["CLOCK_REGRESSION"]
    assert res_clk[-1]["codes"] == []

    # 2. SEQ_GAP across batches -> stored with warning SEQ_GAP and stream marked incomplete
    b_gap = _SessionBuilder(
        org_id=ctx["org_id"],
        participant_id=ctx["p_id"],
        prescription_id=ctx["rx_id"],
        prescription_revision=ctx["rx_rev"],
        mode="report_only",
    )
    e1 = b_gap.start_session()
    e2 = b_gap.control("start")
    e3 = b_gap.control("end")
    assert _post_batch([e1])[0] == {"event_id": e1["event_id"], "status": "stored", "codes": []}
    res_gap = _post_batch([e3])[0]
    assert res_gap == {"event_id": e3["event_id"], "status": "stored", "codes": ["SEQ_GAP"]}
    assert app.state.v3_store.is_stream_incomplete(b_gap.stream_id) is True

    # 3. Each of the 6 rejecting stream codes rejects the item, stores nothing for it,
    #    and poisons subsequent items of the SAME stream in the same batch with CHAIN_BROKEN (D-S0-04-2b),
    #    while an independent stream in the same batch succeeds.
    def _build_poison_case(kind: str) -> tuple[list[dict[str, Any]], int, str]:
        b = _SessionBuilder(
            org_id=ctx["org_id"],
            participant_id=ctx["p_id"],
            prescription_id=ctx["rx_id"],
            prescription_revision=ctx["rx_rev"],
        )
        b.start_session()
        b.calibrate("cal_rej-0001")
        b.control("start")
        if kind == "INVALID_TRANSITION":
            b.control("pause")
            bad_idx = len(b.events)
            b.cycle_accepted(1, "cal_rej-0001")
            b.control("resume")
            return b.events, bad_idx, "INVALID_TRANSITION"
        if kind == "OVER_TARGET":
            b.cycle_accepted(1, "cal_rej-0001")
            b.cycle_accepted(2, "cal_rej-0001")
            bad_idx = len(b.events)
            b.cycle_accepted(3, "cal_rej-0001")
            b.control("end")
            return b.events, bad_idx, "OVER_TARGET"
        if kind == "CALIBRATION_MISMATCH":
            bad_idx = len(b.events)
            b.cycle_accepted(1, "cal_wrong-9999")
            b.control("end")
            return b.events, bad_idx, "CALIBRATION_MISMATCH"
        if kind == "COMPLETION_INCONSISTENT":
            b.cycle_accepted(1, "cal_rej-0001")
            b.cycle_accepted(2, "cal_rej-0001")
            bad_idx = len(b.events)
            b.control("fatigue")
            b.report("partial")
            return b.events, bad_idx, "COMPLETION_INCONSISTENT"
        if kind == "SOURCE_INCONSISTENT":
            bad_idx = len(b.events)
            b.cycle_accepted(1, "cal_rej-0001", algorithm_version="c05-hand-9")
            b.control("end")
            return b.events, bad_idx, "SOURCE_INCONSISTENT"
        if kind == "OUT_OF_ORDER":
            b.cycle_accepted(1, "cal_rej-0001", t_mono_ms=9000)
            bad_idx = len(b.events)
            b.cycle_accepted(2, "cal_rej-0001", t_mono_ms=8000)
            b.control("end", t_mono_ms=9500)
            return b.events, bad_idx, "OUT_OF_ORDER"
        raise AssertionError(kind)

    for code in (
        "INVALID_TRANSITION",
        "OVER_TARGET",
        "CALIBRATION_MISMATCH",
        "COMPLETION_INCONSISTENT",
        "SOURCE_INCONSISTENT",
        "OUT_OF_ORDER",
    ):
        evs, bad_idx, expected_code = _build_poison_case(code)
        # Independent report_only session sorted after or before by stream_id
        b_ind = _SessionBuilder(
            org_id=ctx["org_id"],
            participant_id=ctx["p_id"],
            prescription_id=ctx["rx_id"],
            prescription_revision=ctx["rx_rev"],
            mode="report_only",
        )
        ind_ev = b_ind.start_session()
        batch = sorted([*evs, ind_ev], key=lambda e: (e["stream_id"], e["seq"]))
        res = _post_batch(batch)
        by_id = {r["event_id"]: r for r in res}

        for good_ev in evs[:bad_idx]:
            assert by_id[good_ev["event_id"]]["status"] == "stored", f"{code}: prefix failed"
        bad_res = by_id[evs[bad_idx]["event_id"]]
        assert bad_res["status"] == "rejected" and expected_code in bad_res["codes"], f"{code}: {bad_res}"
        after_res = by_id[evs[bad_idx + 1]["event_id"]]
        assert after_res["status"] == "rejected" and "CHAIN_BROKEN" in after_res["codes"], f"{code}: {after_res}"
        assert "SEQ_GAP" not in after_res["codes"]
        # Independent stream was NOT poisoned
        assert by_id[ind_ev["event_id"]] == {"event_id": ind_ev["event_id"], "status": "stored", "codes": []}
        # Rejected items were NOT persisted
        stored_seqs = [e["seq"] for e in app.state.v3_store.get_stream_events(evs[0]["stream_id"])]
        assert stored_seqs == [e["seq"] for e in evs[:bad_idx]]

    # 4. Also verify direct store-level V3Store.append enforces session rules (INVALID_TRANSITION & OVER_TARGET)
    store = V3Store(":memory:")
    ledger = json.loads(LEDGER_PATH.read_text(encoding="utf-8"))["events"]
    rx0, consent0 = ledger[0], ledger[1]
    assert [r["status"] for r in store.append([rx0, consent0])] == ["stored", "stored"]

    b_st = _SessionBuilder(
        org_id="o_fixture-0001",
        participant_id="p_fixture-0001",
        prescription_id="rx_fixture-0001",
        prescription_revision=1,
    )
    b_st.start_session()
    b_st.calibrate("cal_store-0001")
    b_st.control("start")
    b_st.control("pause")
    b_st.cycle_accepted(1, "cal_store-0001")
    st_res = store.append(b_st.events)
    assert [r["status"] for r in st_res[:-1]] == ["stored"] * (len(b_st.events) - 1)
    assert st_res[-1]["status"] == "rejected" and "INVALID_TRANSITION" in st_res[-1]["codes"]


# --- Row 5: Valid CL06.3 22-event ledger still imports cleanly ---


def test_valid_ledger_v3_imports_cleanly_and_reaches_expected_phases():
    ledger = json.loads(LEDGER_PATH.read_text(encoding="utf-8"))["events"]
    assert len(ledger) == 22

    store = V3Store(":memory:")
    results = store.append(ledger)
    assert len(results) == 22
    assert all(r["status"] == "stored" and r["codes"] == [] for r in results), results

    rx_payload = next(e["payload"] for e in ledger if e["type"] == "prescription.published")
    rep_a = evaluate_session_stream(store.get_stream_events("session:s_fixture-0001"), rx_payload)
    rep_b = evaluate_session_stream(store.get_stream_events("session:s_fixture-0002"), rx_payload)
    assert rep_a.errors == [] and rep_a.warnings == [] and rep_a.state.phase == "completed"
    assert rep_b.errors == [] and rep_b.warnings == [] and rep_b.state.phase == "ended"


# --- Row 7 & Row 8: Provenance row & error catalog alignment ---


def test_origin_register_provenance_and_error_catalog_alignment():
    reg_text = ORIGIN_REGISTER_PATH.read_text(encoding="utf-8")
    assert "phase rules specified by CL06.1, new code" in reg_text
    for sha in SPEC_SHAS:
        assert sha in reg_text, f"Missing SPEC object sha256 {sha} in ORIGIN_REGISTER.md"

    catalog = json.loads(ERROR_CODES_PATH.read_text(encoding="utf-8"))["codes"]
    for code, status in EMITTABLE_ERROR_CODES.items():
        assert code in catalog, f"{code} missing from error-codes.v3.json"
        assert catalog[code]["http"] == status, f"{code}: {status} != {catalog[code]['http']}"
    for code, status in ITEM_WARNING_CODES.items():
        assert code in catalog and catalog[code]["http"] == status
        assert code not in EMITTABLE_ERROR_CODES

    stream_codes = (
        "INVALID_TRANSITION",
        "OVER_TARGET",
        "CALIBRATION_MISMATCH",
        "COMPLETION_INCONSISTENT",
        "SOURCE_INCONSISTENT",
        "OUT_OF_ORDER",
        "CLOCK_REGRESSION",
    )
    for code in stream_codes:
        assert code in catalog and catalog[code]["layer"] == "stream"
        if code == "CLOCK_REGRESSION":
            assert code in SESSION_RULE_WARNING_CODES and catalog[code]["http"] == 200
        else:
            assert code in SESSION_RULE_ERROR_CODES
            assert EMITTABLE_ERROR_CODES[code] == catalog[code]["http"]
