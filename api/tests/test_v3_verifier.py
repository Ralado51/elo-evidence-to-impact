"""Tests for S1b-02: single normative fact verifier (fact-catalog v2) and facts.* HTTP routes.

Covers ACCEPTANCE rows 1, 2, 4, 5, 6, 7, 8, 9, and 11 (mutation sensitivity).
All test credentials and identifiers are synthetic and generated at runtime.
"""

from __future__ import annotations

import ast
import copy
import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from elo.api import create_app
from elo.canonical import compute_event_hash, compute_event_id, hash_canonical
from elo.v3.entities import new_id
from elo.v3.errors import EMITTABLE_ERROR_CODES, ITEM_WARNING_CODES, VERIFIER_RESULT_CODES
from elo.v3.store import sha256_token
from elo.v3.verifier import (
    FACT_CATALOG_VERSION,
    VERIFIER_VERSION,
    compute_content_hash,
    compute_fact_id,
    derive_facts,
    load_fact_catalog,
    verify_fact,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
PKG = REPO_ROOT / "contracts" / "CL06_3-r1"
CONTRACTS = PKG / "contracts"
API_CONTRACT_PATH = CONTRACTS / "api" / "api-contract.v3.json"
ERROR_CODES_PATH = CONTRACTS / "catalogs" / "error-codes.v3.json"
LEDGER_PATH = PKG / "fixtures" / "valid" / "ledger.v3.json"
PROPOSALS_PATH = PKG / "fixtures" / "valid" / "fact-proposals.v3.json"
ORACLE_PATH = PKG / "fixtures" / "expected" / "facts.oracle.v3.json"
CASES_PATH = PKG / "fixtures" / "adversarial" / "cases.v3.json"

S1B_02_ROUTE_IDS = {
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


def _rehash(ev: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(ev)
    out["event_id"] = compute_event_id(out["stream_id"], out["seq"])
    out["hash"] = compute_event_hash(out)
    return out


def _proposal_from_fact(fact: dict[str, Any]) -> dict[str, Any]:
    return {
        k: copy.deepcopy(fact[k])
        for k in ("type", "catalog_version", "params", "evidence_refs", "scope", "data_origin")
    }


def _build_rx_event(
    *,
    org_id: str = "o_verif-0001",
    participant_id: str = "p_verif-0001",
    therapist_id: str = "t_verif-0001",
    prescription_id: str = "rx_verif-0001",
    revision: int = 1,
    target_sets: int = 1,
    target_repetitions: int = 4,
    side: str = "right",
    tz: str = "America/Sao_Paulo",
) -> dict[str, Any]:
    return _rehash(
        {
            "event_id": "",
            "schema_version": 3,
            "type": "prescription.published",
            "stream_id": f"prescription:{prescription_id}",
            "seq": revision,
            "prev_hash": None,
            "occurred_at": "2026-11-25T09:00:00.000Z",
            "actor": {"role": "therapist", "id": therapist_id},
            "scope": {
                "org_id": org_id,
                "participant_id": participant_id,
                "prescription_id": prescription_id,
                "prescription_revision": revision,
                "exercise_id": "organizar-a-mesa",
            },
            "source": {"type": "therapist"},
            "execution_mode": "not_applicable",
            "data_origin": "synthetic_fixture",
            "payload": {
                "participant_id": participant_id,
                "exercise_id": "organizar-a-mesa",
                "permitted_movement": "hand_open_close",
                "side": side,
                "target_sets": target_sets,
                "target_repetitions": target_repetitions,
                "sessions_per_week": 5,
                "valid_from": "2026-11-23",
                "valid_to": "2026-12-21",
                "timezone": tz,
                "min_calibration_span": None,
                "instructions_ptbr": "Abra e feche a mão.",
                "prescription_id": prescription_id,
                "revision": revision,
                "supersedes_revision": None,
                "created_by": therapist_id,
                "created_at": "2026-11-25T09:00:00.000Z",
                "limits_version": "limits-v1",
            },
        }
    )


class _SynthSession:
    """Minimal schema-valid session stream builder for verifier tests."""

    def __init__(
        self,
        rx_ev: dict[str, Any],
        *,
        session_id: str | None = None,
        mode: str = "camera",
        occurred_base: datetime | None = None,
        data_origin: str = "synthetic_fixture",
    ) -> None:
        self.rx_ev = rx_ev
        self.org_id = rx_ev["scope"]["org_id"]
        self.participant_id = rx_ev["scope"]["participant_id"]
        self.prescription_id = rx_ev["payload"]["prescription_id"]
        self.prescription_revision = rx_ev["payload"]["revision"]
        self.session_id = session_id or new_id("s")
        self.mode = mode
        self.data_origin = data_origin
        self.base = occurred_base or datetime(2026, 11, 25, 13, 0, 0, tzinfo=timezone.utc)
        self.events: list[dict[str, Any]] = []
        self._sec = 0
        self._mono = 0

    @property
    def stream_id(self) -> str:
        return f"session:{self.session_id}"

    @property
    def scope(self) -> dict[str, Any]:
        return {
            "org_id": self.org_id,
            "participant_id": self.participant_id,
            "session_id": self.session_id,
            "prescription_id": self.prescription_id,
            "prescription_revision": self.prescription_revision,
            "exercise_id": "organizar-a-mesa",
        }

    def add(self, ev_type: str, payload: dict[str, Any], *, seq: int | None = None, prev_hash: str | None = None) -> dict[str, Any]:
        actual_seq = seq if seq is not None else ((self.events[-1]["seq"] + 1) if self.events else 1)
        actual_prev = prev_hash if prev_hash is not None else (self.events[-1]["hash"] if actual_seq > 1 and self.events else None)
        self._sec += 1
        occ = (self.base + timedelta(seconds=self._sec)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        if ev_type == "report.submitted":
            source: dict[str, Any] = {"type": "participant_report"}
        else:
            stype = {"camera": "camera", "simulation": "simulation", "report_only": "participant_report"}[self.mode]
            source = {"type": stype}
            if stype in ("camera", "simulation"):
                source["algorithm_version"] = "c05-hand-2"
                source["device_hint"] = "desktop-chrome"
        ev: dict[str, Any] = {
            "event_id": "",
            "schema_version": 3,
            "type": ev_type,
            "stream_id": self.stream_id,
            "seq": actual_seq,
            "prev_hash": actual_prev,
            "occurred_at": occ,
            "actor": {"role": "participant", "id": self.participant_id},
            "scope": self.scope,
            "source": source,
            "execution_mode": self.mode,
            "data_origin": self.data_origin,
            "payload": payload,
        }
        if self.mode in ("camera", "simulation") and ev_type != "report.submitted":
            self._mono += 500
            ev["t_mono_ms"] = self._mono
        ev = _rehash(ev)
        self.events.append(ev)
        return ev

    def start_session(self) -> dict[str, Any]:
        ctx = None if self.mode == "report_only" else {"device_hint": "desktop-chrome", "frame_width": 640, "frame_height": 480}
        return self.add(
            "session.started",
            {
                "source_mode": self.mode,
                "prescription_id": self.prescription_id,
                "prescription_revision": self.prescription_revision,
                "capture_context": ctx,
            },
        )

    def calibrate(self, cal_id: str = "cal_verif-0001") -> dict[str, Any]:
        o = self.add("calibration.attempted", {"attempt": 1, "posture": "open", "n_samples": 24, "median": 1.9, "mad": 0.02, "accepted": True, "reason": None})
        c = self.add("calibration.attempted", {"attempt": 2, "posture": "closed", "n_samples": 24, "median": 0.8, "mad": 0.02, "accepted": True, "reason": None})
        return self.add(
            "calibration.applied",
            {
                "calibration_id": cal_id,
                "open": 1.9,
                "closed": 0.8,
                "span": 1.1,
                "open_samples": 24,
                "closed_samples": 24,
                "attempt_refs": sorted([o["event_id"], c["event_id"]]),
                "min_span_required": None,
            },
        )

    def control(self, action: str, *, interrupt_reason: str | None = None, seq: int | None = None, prev_hash: str | None = None) -> dict[str, Any]:
        return self.add("session.control", {"action": action, "interrupt_reason": interrupt_reason}, seq=seq, prev_hash=prev_hash)

    def cycle_accepted(self, idx: int, cal_id: str = "cal_verif-0001", *, handedness: dict[str, Any] | None = "default") -> dict[str, Any]:
        hand = {"label": "right", "score": 0.96} if handedness == "default" else handedness
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
                "handedness": hand,
            },
        )

    def cycle_rejected(self, idx: int, cal_id: str = "cal_verif-0001", *, reason: str = "handedness_incompatible", label: str = "left") -> dict[str, Any]:
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
                "handedness": {"label": label, "score": 0.95},
                "reason": reason,
            },
        )

    def completed(self, accepted: int, target: int) -> dict[str, Any]:
        return self.add("session.completed", {"accepted": accepted, "target": target})

    def capture_summary(self, *, frames_total: int = 200, usable_fraction: float | None = 0.85, lost_events: int = 1, fps_mean: float | None = 24.0, fps_min: float | None = 15.0) -> dict[str, Any]:
        return self.add(
            "session.capture_summary",
            {
                "frames_total": frames_total,
                "fps_mean": fps_mean,
                "fps_min": fps_min,
                "usable_fraction": usable_fraction,
                "lost_events": lost_events,
            },
        )

    def measurement(self, *, quality: str = "usable", value: float | None = 1.15, experimental: bool = True, measure_kind: str = "opening_index") -> dict[str, Any]:
        return self.add(
            "measurement.recorded",
            {
                "measurement_id": new_id("ms"),
                "measure_kind": measure_kind,
                "value": value,
                "unit": "1",
                "method": "landmark_ratio_v1",
                "quality": quality,
                "quality_reason": None if quality == "usable" else "no_hand",
                "protocol_id": None,
                "limitation_codes": ["L10", "L18"],
                "experimental": experimental,
                "body_segment": "hand",
            },
        )

    def report(self, *, execution: str = "complete", assistance: str = "none") -> dict[str, Any]:
        return self.add(
            "report.submitted",
            {"execution": execution, "assistance": assistance, "reporter_role": "participant"},
        )


def _db_fingerprint(conn) -> dict[str, tuple[int, str]]:
    tables = [
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    ]
    snap: dict[str, tuple[int, str]] = {}
    for tbl in tables:
        rows = conn.execute(f'SELECT * FROM "{tbl}"').fetchall()
        raw = json.dumps(rows, sort_keys=True, ensure_ascii=False).encode("utf-8")
        snap[tbl] = (len(rows), hashlib.sha256(raw).hexdigest())
    return snap


def _collect_v3_routes(app) -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path, ops in app.openapi().get("paths", {}).items():
        if path.startswith("/api/v3"):
            for method in ops:
                if method.upper() not in ("HEAD", "OPTIONS"):
                    found.add((method.upper(), path))
    return found


def _make_seeded_app(monkeypatch):
    monkeypatch.delenv("ELO_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("ELO_V3_REAL_DATA_GATE_OPEN", raising=False)
    monkeypatch.setenv("ELO_V3_DATA_ORIGIN", "synthetic_fixture")

    org_a = new_id("o")
    org_b = new_id("o")
    t1_id, t2_id, t3_id = new_id("t"), new_id("t"), new_id("t")
    t1_pw, t2_pw, t3_pw = secrets.token_urlsafe(12), secrets.token_urlsafe(12), secrets.token_urlsafe(12)
    seeds = [
        {"therapist_id": t1_id, "username": "t_vf1", "password": t1_pw, "org_id": org_a, "display_label": "T VF1"},
        {"therapist_id": t2_id, "username": "t_vf2", "password": t2_pw, "org_id": org_a, "display_label": "T VF2"},
        {"therapist_id": t3_id, "username": "t_vf3", "password": t3_pw, "org_id": org_b, "display_label": "T VF3"},
    ]
    monkeypatch.setenv("ELO_V3_THERAPIST_SEEDS", json.dumps(seeds))
    app = create_app(":memory:")
    client = TestClient(app)

    def login(u: str, p: str) -> str:
        r = client.post("/api/v3/auth/therapist", json={"username": u, "password": p})
        assert r.status_code == 200
        return r.json()["token"]

    t1_tok = login("t_vf1", t1_pw)
    t2_tok = login("t_vf2", t2_pw)
    t3_tok = login("t_vf3", t3_pw)

    rp = client.post("/api/v3/participants", headers={"Authorization": f"Bearer {t1_tok}"}, json={"alias": "Verif P1", "side": "right"})
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
        "p1_id": p1["entity_id"],
        "p1_tok": p1_tok,
        "cl1_id": cl1_id,
    }


# --- Row 1: Ledger derivation, ORACLE parity, fact_id/content_hash formulas, fact-proposals ---


def test_ledger_derivation_oracle_parity_and_fact_proposals():
    ledger = _load_json(LEDGER_PATH)["events"]
    oracle = _load_json(ORACLE_PATH)
    oracle_f01 = oracle["facts"][0]

    facts, content_hashes = derive_facts(ledger)
    # LEDGER yields exactly 10 facts: 7 for s_fixture-0001 + 3 for s_fixture-0002
    derived_pairs = [(f["scope"]["session_id"], f["type"]) for f in facts]
    assert derived_pairs == [
        ("s_fixture-0001", "F01"),
        ("s_fixture-0001", "F02"),
        ("s_fixture-0001", "F03"),
        ("s_fixture-0001", "F04"),
        ("s_fixture-0001", "F06"),
        ("s_fixture-0001", "F09"),
        ("s_fixture-0001", "F10"),
        ("s_fixture-0002", "F02"),
        ("s_fixture-0002", "F03"),
        ("s_fixture-0002", "F04"),
    ]

    # Check every derived fact's fact_id, content_hash, and absence of forbidden stems
    forbidden_stems = ("diagnost", "melhor", "pior", "recuper", "independen", "amplitude", "desempenho")
    for f in facts:
        body = {k: f[k] for k in ("catalog_version", "data_origin", "evidence_refs", "params", "scope", "type")}
        assert f["fact_id"] == "f_" + hash_canonical(body)
        assert f["fact_id"] == compute_fact_id(f)
        assert content_hashes[f["fact_id"]] == hash_canonical(f)
        assert content_hashes[f["fact_id"]] == compute_content_hash(f)
        rendered_text_low = f["rendered"]["text_ptbr"].lower()
        for stem in forbidden_stems:
            assert stem not in rendered_text_low, f"Forbidden stem {stem!r} in {f['type']}: {rendered_text_low}"

    # F01 of s_fixture-0001 equals ORACLE in every field except session_date_local (2026-11-25) & dependent fields
    f01 = next(f for f in facts if f["scope"]["session_id"] == "s_fixture-0001" and f["type"] == "F01")
    assert f01["type"] == oracle_f01["type"]
    assert f01["catalog_version"] == oracle_f01["catalog_version"]
    assert f01["evidence_refs"] == oracle_f01["evidence_refs"]
    assert f01["scope"] == oracle_f01["scope"]
    assert f01["data_origin"] == oracle_f01["data_origin"]
    assert f01["limitations"] == oracle_f01["limitations"]
    assert f01["flags"] == oracle_f01["flags"]
    assert f01["rendered"]["limitations_ptbr"] == oracle_f01["rendered"]["limitations_ptbr"]
    assert f01["versions"]["catalog"] == oracle_f01["versions"]["catalog"]
    assert f01["versions"]["algorithm"] == oracle_f01["versions"]["algorithm"]
    assert f01["versions"]["definition"] == oracle_f01["versions"]["definition"]
    assert f01["versions"]["verifier"] == VERIFIER_VERSION

    assert f01["params"]["session_date_local"] == "2026-11-25"
    for key, val in oracle_f01["params"].items():
        if key != "session_date_local":
            assert f01["params"][key] == val, f"param {key} mismatch"
    assert (
        f01["rendered"]["text_ptbr"]
        == "[Dados sintéticos] Na sessão de 25/11/2026, a câmera contou 4 de 4 ciclos de abrir e fechar a mão prescrita."
    )

    # All 3 fact-proposals.v3.json proposals verify after replacing session_date_local -> 2026-11-25
    proposals = _load_json(PROPOSALS_PATH)["proposals"]
    assert set(proposals.keys()) == {"F01", "F06", "F10"}
    for ftype, prop in proposals.items():
        # Unmodified (2026-11-24) -> RECOMPUTE_MISMATCH
        r_old = verify_fact(prop, ledger)
        assert r_old["valid"] is False and r_old["code"] == "RECOMPUTE_MISMATCH" and r_old["step"] == "RECOMPUTE"
        # Updated to derived 2026-11-25 -> VERIFIED
        adj = copy.deepcopy(prop)
        adj["params"]["session_date_local"] = "2026-11-25"
        r_ok = verify_fact(adj, ledger)
        assert r_ok["valid"] is True and r_ok["code"] is None and r_ok["step"] is None
        assert r_ok["fact"]["type"] == ftype
        assert r_ok["content_hash"] == hash_canonical(r_ok["fact"])


# --- Row 2: All 10 verifier-layer PENDING cases in cases.v3.json executable ---


def test_all_10_verifier_pending_cases_from_cases_v3():
    ledger = _load_json(LEDGER_PATH)["events"]
    cases_doc = _load_json(CASES_PATH)["cases"]
    verifier_cases = [c for c in cases_doc if c["layer"] == "verifier" and c["status"] == "PENDING_IMPLEMENTATION"]
    expected_ids = {"P3-scope", "P3b", "P5", "P5b", "P6", "P7b", "P9", "V3-V1", "V3-V2", "V3-V3"}
    assert {c["id"] for c in verifier_cases} == expected_ids

    facts, _ = derive_facts(ledger)
    by_sess_type = {(f["scope"]["session_id"], f["type"]): f for f in facts}
    s1_events = [e for e in ledger if e["stream_id"] == "session:s_fixture-0001"]
    s2_events = [e for e in ledger if e["stream_id"] == "session:s_fixture-0002"]
    rx_ev = next(e for e in ledger if e["type"] == "prescription.published")

    # Mutated ledger for P6: append valid second report.submitted at seq 15 on session A (exact R00 pattern)
    s1_seq14 = next(e for e in s1_events if e["seq"] == 14)
    s1_seq15_report = _rehash(
        {
            "event_id": "",
            "schema_version": 3,
            "type": "report.submitted",
            "stream_id": "session:s_fixture-0001",
            "seq": 15,
            "prev_hash": s1_seq14["hash"],
            "occurred_at": "2026-11-25T09:46:55.000Z",
            "actor": {"role": "participant", "id": "p_fixture-0001"},
            "scope": copy.deepcopy(s1_seq14["scope"]),
            "source": {"type": "participant_report"},
            "execution_mode": "camera",
            "data_origin": "synthetic_fixture",
            "payload": {"execution": "partial", "assistance": "full", "reporter_role": "participant"},
        }
    )
    ledger_p6 = [*ledger, s1_seq15_report]

    # Build each case cleanly from its mutation / note
    def _run_case(cid: str) -> dict[str, Any]:
        if cid == "P3-scope":
            # Fact scoped to S2 citing S1 evidence
            prop = _proposal_from_fact(by_sess_type[("s_fixture-0002", "F02")])
            s1_start = next(e for e in s1_events if e["type"] == "session.started")
            prop["evidence_refs"] = sorted([s1_start["event_id"], prop["evidence_refs"][-1]])
            return verify_fact(prop, ledger)
        if cid == "P7b":
            # Scope with revision 2 (not published) citing rev-1 events
            prop = _proposal_from_fact(by_sess_type[("s_fixture-0001", "F01")])
            prop["scope"]["prescription_revision"] = 2
            return verify_fact(prop, ledger)
        if cid == "P3b":
            # F06 with altered usable_fraction
            prop = _proposal_from_fact(by_sess_type[("s_fixture-0001", "F06")])
            prop["params"]["usable_fraction"] = 0.95
            return verify_fact(prop, ledger)
        if cid == "P5":
            # REGRESSION: F01 omits cycle seq 9 and adjusts params.accepted=3
            prop = _proposal_from_fact(by_sess_type[("s_fixture-0001", "F01")])
            seq9_id = next(e["event_id"] for e in s1_events if e["seq"] == 9)
            prop["evidence_refs"] = [r for r in prop["evidence_refs"] if r != seq9_id]
            prop["params"]["accepted"] = 3
            return verify_fact(prop, ledger)
        if cid == "P5b":
            # F01 accepted inflated to 5 with full evidence
            prop = _proposal_from_fact(by_sess_type[("s_fixture-0001", "F01")])
            prop["params"]["accepted"] = 5
            return verify_fact(prop, ledger)
        if cid == "P6":
            # REGRESSION: F04 cites superseded seq 14 report after seq 15 report was appended
            prop = _proposal_from_fact(by_sess_type[("s_fixture-0001", "F04")])
            return verify_fact(prop, ledger_p6)
        if cid == "P9":
            # F05 claimed for report-only session s_fixture-0002
            s2_start = next(e for e in s2_events if e["type"] == "session.started")
            s2_end = next(e for e in s2_events if e["type"] == "session.control" and e["payload"]["action"] == "end")
            s2_rep = next(e for e in s2_events if e["type"] == "report.submitted")
            prop = {
                "type": "F05",
                "catalog_version": "2",
                "params": {
                    "session_id": "s_fixture-0002",
                    "session_date_local": "2026-11-25",
                    "reported_execution": "partial",
                    "observed_accepted": 0,
                    "target": 4,
                    "capture_source": "camera",
                },
                "evidence_refs": sorted([s2_start["event_id"], rx_ev["event_id"], s2_end["event_id"], s2_rep["event_id"]]),
                "scope": copy.deepcopy(s2_start["scope"]),
                "data_origin": "synthetic_fixture",
            }
            return verify_fact(prop, ledger)
        if cid == "V3-V1":
            # F01 v2 omits the handedness_incompatible cycle.rejected event (seq 8)
            prop = _proposal_from_fact(by_sess_type[("s_fixture-0001", "F01")])
            seq8_id = next(e["event_id"] for e in s1_events if e["seq"] == 8)
            prop["evidence_refs"] = [r for r in prop["evidence_refs"] if r != seq8_id]
            prop["params"]["handedness_mismatch_cycles"] = 0
            return verify_fact(prop, ledger)
        if cid == "V3-V2":
            # F01 v2 mismatch count computed under v1 semantics (0) with full evidence
            prop = _proposal_from_fact(by_sess_type[("s_fixture-0001", "F01")])
            prop["params"]["handedness_mismatch_cycles"] = 0
            return verify_fact(prop, ledger)
        if cid == "V3-V3":
            # F10 for a capture session without measurement.recorded
            ledger_no_meas = [e for e in ledger if e["type"] != "measurement.recorded"]
            s1_start = next(e for e in s1_events if e["type"] == "session.started")
            prop = _proposal_from_fact(by_sess_type[("s_fixture-0001", "F10")])
            prop["evidence_refs"] = [s1_start["event_id"]]
            return verify_fact(prop, ledger_no_meas)
        raise AssertionError(f"Unhandled case {cid}")

    for case in verifier_cases:
        cid = case["id"]
        res = _run_case(cid)
        assert res["valid"] is False, f"{cid} unexpectedly accepted: {res}"
        assert res["fact"] is None and res["content_hash"] is None
        assert res["code"] == case["expect"]["code"], f"{cid}: got {res['code']} != {case['expect']['code']}"
        if "step" in case["expect"]:
            assert res["step"] == case["expect"]["step"], f"{cid}: got step {res['step']} != {case['expect']['step']}"

    # Also verify REFS_EXIST (REF_MISSING) and REFS_TYPE (REF_WRONG_TYPE) directly
    p_missing = _proposal_from_fact(by_sess_type[("s_fixture-0001", "F02")])
    p_missing["evidence_refs"] = sorted([p_missing["evidence_refs"][0], "0" * 64])
    r_miss = verify_fact(p_missing, ledger)
    assert r_miss["valid"] is False and r_miss["code"] == "REF_MISSING" and r_miss["step"] == "REFS_EXIST"

    p_wrong_type = _proposal_from_fact(by_sess_type[("s_fixture-0001", "F02")])
    s1_rep = next(e for e in s1_events if e["type"] == "report.submitted")
    p_wrong_type["evidence_refs"] = sorted([p_wrong_type["evidence_refs"][0], s1_rep["event_id"]])
    r_wt = verify_fact(p_wrong_type, ledger)
    assert r_wt["valid"] is False and r_wt["code"] == "REF_WRONG_TYPE" and r_wt["step"] == "REFS_TYPE"


# --- Row 4: Every catalog type (F01..F10) positive & negative + every precondition failing ---


def test_every_catalog_type_positive_and_negative():
    cat = load_fact_catalog()
    all_types = list(cat["types"].keys())
    assert all_types == ["F01", "F02", "F03", "F04", "F05", "F06", "F08", "F09", "F10"]

    # Build a rich capture session that derives F01, F02, F03, F04, F05, F06, F08, F09, F10!
    # (2 of 4 cycles + pain symptom -> F08, report="complete" while observed=2 < target=4 -> F05,
    #  simulation mode -> L13, 1 unknown handedness -> L19, 1 incompatible -> L17, low_capture_quality -> L14!)
    rx = _build_rx_event(target_sets=1, target_repetitions=4)
    sess = _SynthSession(rx, mode="simulation")
    sess.start_session()
    sess.calibrate("cal_rich-0001")
    sess.control("start")
    sess.cycle_accepted(1, "cal_rich-0001")
    sess.cycle_accepted(2, "cal_rich-0001", handedness=None)
    sess.cycle_rejected(3, "cal_rich-0001", reason="handedness_incompatible", label="left")
    sess.control("pain")
    sess.capture_summary(frames_total=150, usable_fraction=0.42, lost_events=3, fps_mean=20.0, fps_min=10.0)
    sess.measurement(quality="usable", value=1.15, experimental=True)
    sess.report(execution="complete", assistance="some")
    ledger = [rx, *sess.events]

    facts, hashes = derive_facts(ledger)
    by_type = {f["type"]: f for f in facts}
    assert set(by_type.keys()) == set(all_types)

    # Check key derived fields, limitations, decimal2 formatting, and versions.algorithm
    assert by_type["F01"]["params"]["handedness_unknown_cycles"] == 1
    assert by_type["F01"]["params"]["handedness_mismatch_cycles"] == 1
    assert {"L01", "L02", "L03", "L11", "L13", "L17", "L19"} <= set(by_type["F01"]["limitations"])
    assert by_type["F02"]["params"] == {"session_id": sess.session_id, "session_date_local": "2026-11-25", "end_reason": "symptom", "interrupt_reason": None}
    assert by_type["F02"]["versions"]["algorithm"] is None
    assert by_type["F03"]["versions"]["algorithm"] is None
    assert by_type["F04"]["versions"]["algorithm"] is None
    assert by_type["F08"]["versions"]["algorithm"] is None
    assert by_type["F05"]["params"]["observed_accepted"] == 2 and by_type["F05"]["params"]["reported_execution"] == "complete"
    assert "L13" in by_type["F05"]["limitations"] and by_type["F05"]["flags"]["highlight"] is True
    assert by_type["F06"]["params"]["low_capture_quality"] is True and "L14" in by_type["F06"]["limitations"]
    assert by_type["F08"]["params"]["symptom"] == "pain" and by_type["F08"]["flags"]["highlight"] is True
    assert "1,10" in by_type["F09"]["rendered"]["text_ptbr"] and by_type["F09"]["flags"]["summary_eligible"] is False
    assert "1,15" in by_type["F10"]["rendered"]["text_ptbr"] and by_type["F10"]["flags"]["summary_eligible"] is False

    # Positive verify AND negative rejected proposal for EVERY catalog type
    for ftype in all_types:
        good_prop = _proposal_from_fact(by_type[ftype])
        r_good = verify_fact(good_prop, ledger)
        assert r_good["valid"] is True and r_good["fact"]["fact_id"] == by_type[ftype]["fact_id"]
        assert r_good["content_hash"] == hashes[by_type[ftype]["fact_id"]]

        # Negative: tamper one param -> RECOMPUTE_MISMATCH
        bad_param = copy.deepcopy(good_prop)
        bad_param["params"]["session_date_local"] = "2026-11-20"
        r_bad_p = verify_fact(bad_param, ledger)
        assert r_bad_p["valid"] is False and r_bad_p["code"] == "RECOMPUTE_MISMATCH" and r_bad_p["step"] == "RECOMPUTE"

        # Negative: drop one evidence ref -> EVIDENCE_SET_MISMATCH
        bad_ev = copy.deepcopy(good_prop)
        bad_ev["evidence_refs"] = bad_ev["evidence_refs"][:-1]
        r_bad_e = verify_fact(bad_ev, ledger)
        assert r_bad_e["valid"] is False and r_bad_e["code"] == "EVIDENCE_SET_MISMATCH" and r_bad_e["step"] == "EVIDENCE_SET"


def test_every_catalog_precondition_has_failing_test():
    cat = load_fact_catalog()
    all_preconds = set(cat["preconditions"].keys())
    tested_preconds: set[str] = set()

    rx = _build_rx_event(target_sets=1, target_repetitions=2)

    def _expect_precond_fail(prop: dict[str, Any], ledger: list[dict[str, Any]], precond_name: str) -> None:
        res = verify_fact(prop, ledger)
        assert res["valid"] is False and res["code"] == "PRECONDITION_FAILED" and res["step"] == "PRECONDITIONS", (
            f"{precond_name}: expected PRECONDITION_FAILED/PRECONDITIONS, got {res}"
        )
        tested_preconds.add(precond_name)

    # 1. START_PRESENT: session has only a seq=2 event, no session.started at seq=1
    s1 = _SynthSession(rx, mode="report_only")
    e_no_start = s1.control("end", seq=2, prev_hash="a" * 64)
    _expect_precond_fail(
        {
            "type": "F02",
            "catalog_version": "2",
            "params": {"session_id": s1.session_id, "session_date_local": "2026-11-25", "end_reason": "ended", "interrupt_reason": None},
            "evidence_refs": [e_no_start["event_id"]],
            "scope": s1.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, e_no_start],
        "START_PRESENT",
    )

    # 2. MODE_IS_CAPTURE: report_only session claiming F06
    s2 = _SynthSession(rx, mode="report_only")
    st2 = s2.start_session()
    _expect_precond_fail(
        {
            "type": "F06",
            "catalog_version": "2",
            "params": {"session_id": s2.session_id, "session_date_local": "2026-11-25", "usable_fraction": 0.9, "lost_events": 0, "fps_mean": 24.0, "fps_min": 20.0, "low_capture_quality": False},
            "evidence_refs": [st2["event_id"]],
            "scope": s2.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s2.events],
        "MODE_IS_CAPTURE",
    )

    # 3. TERMINAL_PRESENT: session started but never terminated
    s3 = _SynthSession(rx, mode="report_only")
    st3 = s3.start_session()
    s3.control("start")
    _expect_precond_fail(
        {
            "type": "F02",
            "catalog_version": "2",
            "params": {"session_id": s3.session_id, "session_date_local": "2026-11-25", "end_reason": "ended", "interrupt_reason": None},
            "evidence_refs": [st3["event_id"]],
            "scope": s3.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s3.events],
        "TERMINAL_PRESENT",
    )

    # 4. EFFECTIVE_CALIBRATION_PRESENT: camera session ended before calibration
    s4 = _SynthSession(rx, mode="camera")
    st4 = s4.start_session()
    s4.control("end")
    _expect_precond_fail(
        {
            "type": "F09",
            "catalog_version": "2",
            "params": {"session_id": s4.session_id, "session_date_local": "2026-11-25", "calibration_id": "cal_none-0001", "open": 1.9, "closed": 0.8, "span": 1.1, "min_span_required": None},
            "evidence_refs": [st4["event_id"]],
            "scope": s4.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s4.events],
        "EFFECTIVE_CALIBRATION_PRESENT",
    )

    # 5. EFFECTIVE_REPORT_PRESENT: session ended with no report.submitted
    s5 = _SynthSession(rx, mode="report_only")
    st5 = s5.start_session()
    s5.control("start")
    s5.control("end")
    _expect_precond_fail(
        {
            "type": "F03",
            "catalog_version": "2",
            "params": {"session_id": s5.session_id, "session_date_local": "2026-11-25", "execution": "complete"},
            "evidence_refs": [st5["event_id"]],
            "scope": s5.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s5.events],
        "EFFECTIVE_REPORT_PRESENT",
    )

    # 6 & 7. REPORT_EXECUTION_NOT_UNREPORTED & REPORT_ASSISTANCE_NOT_UNREPORTED
    s6 = _SynthSession(rx, mode="report_only")
    st6 = s6.start_session()
    s6.control("start")
    s6.control("end")
    r6 = s6.report(execution="unreported", assistance="unreported")
    _expect_precond_fail(
        {
            "type": "F03",
            "catalog_version": "2",
            "params": {"session_id": s6.session_id, "session_date_local": "2026-11-25", "execution": "none"},
            "evidence_refs": sorted([st6["event_id"], r6["event_id"]]),
            "scope": s6.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s6.events],
        "REPORT_EXECUTION_NOT_UNREPORTED",
    )
    _expect_precond_fail(
        {
            "type": "F04",
            "catalog_version": "2",
            "params": {"session_id": s6.session_id, "session_date_local": "2026-11-25", "assistance": "none", "reporter_role": "participant"},
            "evidence_refs": sorted([st6["event_id"], r6["event_id"]]),
            "scope": s6.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s6.events],
        "REPORT_ASSISTANCE_NOT_UNREPORTED",
    )

    # 8. CAPTURE_SUMMARY_PRESENT: capture session without capture_summary
    s8 = _SynthSession(rx, mode="camera")
    st8 = s8.start_session()
    s8.calibrate("cal_s8-0001")
    s8.control("start")
    s8.control("end")
    _expect_precond_fail(
        {
            "type": "F06",
            "catalog_version": "2",
            "params": {"session_id": s8.session_id, "session_date_local": "2026-11-25", "usable_fraction": 0.9, "lost_events": 0, "fps_mean": 24.0, "fps_min": 20.0, "low_capture_quality": False},
            "evidence_refs": [st8["event_id"]],
            "scope": s8.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s8.events],
        "CAPTURE_SUMMARY_PRESENT",
    )

    # 9. CAPTURE_SUMMARY_NONEMPTY: frames_total == 0
    s9 = _SynthSession(rx, mode="camera")
    st9 = s9.start_session()
    s9.calibrate("cal_s9-0001")
    s9.control("start")
    s9.control("end")
    cs9 = s9.capture_summary(frames_total=0, usable_fraction=None, lost_events=0, fps_mean=None, fps_min=None)
    _expect_precond_fail(
        {
            "type": "F06",
            "catalog_version": "2",
            "params": {"session_id": s9.session_id, "session_date_local": "2026-11-25", "usable_fraction": 0.0, "lost_events": 0, "fps_mean": 0.0, "fps_min": 0.0, "low_capture_quality": True},
            "evidence_refs": sorted([st9["event_id"], cs9["event_id"]]),
            "scope": s9.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s9.events],
        "CAPTURE_SUMMARY_NONEMPTY",
    )

    # 10. TERMINAL_IS_SYMPTOM: terminal action is 'end', not pain|fatigue
    s10 = _SynthSession(rx, mode="report_only")
    st10 = s10.start_session()
    s10.control("start")
    t10 = s10.control("end")
    _expect_precond_fail(
        {
            "type": "F08",
            "catalog_version": "2",
            "params": {"session_id": s10.session_id, "session_date_local": "2026-11-25", "symptom": "pain"},
            "evidence_refs": sorted([st10["event_id"], t10["event_id"]]),
            "scope": s10.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s10.events],
        "TERMINAL_IS_SYMPTOM",
    )

    # 11. STREAM_CHECK_CLEAN: capture session has a broken stream rule (cycle.accepted with wrong handedness)
    s11 = _SynthSession(rx, mode="camera")
    st11 = s11.start_session()
    cal11 = s11.calibrate("cal_s11-0001")
    s11.control("start")
    c11 = s11.cycle_accepted(1, "cal_s11-0001", handedness={"label": "left", "score": 0.99})
    t11 = s11.control("end")
    _expect_precond_fail(
        {
            "type": "F01",
            "catalog_version": "2",
            "params": {
                "session_id": s11.session_id,
                "session_date_local": "2026-11-25",
                "accepted": 1,
                "target": 2,
                "capture_source": "camera",
                "algorithm_version": "c05-hand-2",
                "calibration_id": "cal_s11-0001",
                "handedness_mismatch_cycles": 0,
                "handedness_unknown_cycles": 0,
                "incomplete_upload": False,
            },
            "evidence_refs": sorted([st11["event_id"], rx["event_id"], cal11["event_id"], c11["event_id"], t11["event_id"]]),
            "scope": s11.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s11.events],
        "STREAM_CHECK_CLEAN",
    )

    # 12. NO_GAPS: session with SEQ_GAP -> F01 derives with incomplete_upload=True (L06), while F05 fails NO_GAPS!
    s12 = _SynthSession(rx, mode="camera")
    st12 = s12.start_session()
    cal12 = s12.calibrate("cal_s12-0001")
    s12.control("start")
    # Missing seq 6 (gap), seq 7 is end, seq 8 is report="complete" (discrepancy would hold if no gap)
    t12 = s12.control("end", seq=7, prev_hash="b" * 64)
    r12 = s12.report(execution="complete", assistance="none")
    f12_facts, _ = derive_facts([rx, *s12.events])
    f12_f01 = next(f for f in f12_facts if f["type"] == "F01")
    assert f12_f01["params"]["incomplete_upload"] is True and "L06" in f12_f01["limitations"]
    _expect_precond_fail(
        {
            "type": "F05",
            "catalog_version": "2",
            "params": {
                "session_id": s12.session_id,
                "session_date_local": "2026-11-25",
                "reported_execution": "complete",
                "observed_accepted": 0,
                "target": 2,
                "capture_source": "camera",
            },
            "evidence_refs": sorted([st12["event_id"], rx["event_id"], t12["event_id"], r12["event_id"]]),
            "scope": s12.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s12.events],
        "NO_GAPS",
    )

    # 13. DISCREPANCY_RULE: complete report with observed == target (2 == 2 -> no discrepancy)
    s13 = _SynthSession(rx, mode="camera")
    st13 = s13.start_session()
    s13.calibrate("cal_s13-0001")
    s13.control("start")
    c13a = s13.cycle_accepted(1, "cal_s13-0001")
    c13b = s13.cycle_accepted(2, "cal_s13-0001")
    t13 = s13.completed(2, 2)
    r13 = s13.report(execution="complete", assistance="none")
    _expect_precond_fail(
        {
            "type": "F05",
            "catalog_version": "2",
            "params": {
                "session_id": s13.session_id,
                "session_date_local": "2026-11-25",
                "reported_execution": "complete",
                "observed_accepted": 2,
                "target": 2,
                "capture_source": "camera",
            },
            "evidence_refs": sorted([st13["event_id"], rx["event_id"], c13a["event_id"], c13b["event_id"], t13["event_id"], r13["event_id"]]),
            "scope": s13.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s13.events],
        "DISCREPANCY_RULE",
    )

    # 14. MEASUREMENT_PRESENT: measurement quality == "missing" is not derived
    s14 = _SynthSession(rx, mode="camera")
    st14 = s14.start_session()
    s14.calibrate("cal_s14-0001")
    s14.control("start")
    s14.control("end")
    m14 = s14.measurement(quality="missing", value=None, experimental=True)
    _expect_precond_fail(
        {
            "type": "F10",
            "catalog_version": "2",
            "params": {
                "session_id": s14.session_id,
                "session_date_local": "2026-11-25",
                "measure_kind": "opening_index",
                "value": 1.0,
                "unit": "1",
                "method": "landmark_ratio_v1",
                "algorithm_version": "c05-hand-2",
                "protocol_id": None,
                "measurement_quality": "usable",
                "experimental": True,
            },
            "evidence_refs": sorted([st14["event_id"], m14["event_id"]]),
            "scope": s14.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s14.events],
        "MEASUREMENT_PRESENT",
    )

    # 15. MEASUREMENT_EXPERIMENTAL: measurement payload.experimental == False
    s15 = _SynthSession(rx, mode="camera")
    st15 = s15.start_session()
    s15.calibrate("cal_s15-0001")
    s15.control("start")
    s15.control("end")
    m15 = s15.measurement(quality="usable", value=1.1, experimental=False)
    _expect_precond_fail(
        {
            "type": "F10",
            "catalog_version": "2",
            "params": {
                "session_id": s15.session_id,
                "session_date_local": "2026-11-25",
                "measure_kind": "opening_index",
                "value": 1.1,
                "unit": "1",
                "method": "landmark_ratio_v1",
                "algorithm_version": "c05-hand-2",
                "protocol_id": None,
                "measurement_quality": "usable",
                "experimental": True,
            },
            "evidence_refs": sorted([st15["event_id"], m15["event_id"]]),
            "scope": s15.scope,
            "data_origin": "synthetic_fixture",
        },
        [rx, *s15.events],
        "MEASUREMENT_EXPERIMENTAL",
    )

    assert tested_preconds == all_preconds, f"Untested preconditions: {all_preconds - tested_preconds}"


# --- Row 5: Single truth path (zero legacy imports, exactly one fact verifier function) ---


def test_single_truth_path_and_no_legacy_verifier_imports():
    v3_dir = REPO_ROOT / "api" / "src" / "elo" / "v3"
    forbidden_modules = {"elo.verifier", "elo.home_sessions", "elo.review"}
    verify_fact_defs: list[str] = []

    for py_file in sorted(v3_dir.glob("*.py")):
        tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name not in forbidden_modules, f"{py_file.name} imports {alias.name}"
            elif isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                if node.level == 0:
                    assert mod not in forbidden_modules, f"{py_file.name} imports from {mod}"
                    if mod == "elo":
                        for alias in node.names:
                            assert alias.name not in {"verifier", "home_sessions", "review"}
                elif node.level >= 2:
                    # Relative import reaching parent elo package
                    assert mod not in {"verifier", "home_sessions", "review"}, f"{py_file.name} imports ..{mod}"
                    for alias in node.names:
                        assert alias.name not in {"verifier", "home_sessions", "review"}
            elif isinstance(node, ast.FunctionDef) and node.name == "verify_fact":
                verify_fact_defs.append(f"{py_file.name}:{node.name}")

    assert verify_fact_defs == ["verifier.py:verify_fact"]


# --- Rows 6, 7, 8: Routes, verify never persists, full authorization matrix ---


def test_facts_routes_persistence_and_authorization(monkeypatch):
    api_doc = _load_json(API_CONTRACT_PATH)
    by_id = {ep["id"]: ep for ep in api_doc["endpoints"]}
    expected_routes = {(by_id[rid]["method"], by_id[rid]["path"]) for rid in S1B_02_ROUTE_IDS}

    app, client, ctx = _make_seeded_app(monkeypatch)
    assert _collect_v3_routes(app) == expected_routes
    assert (by_id["facts.list"]["method"], by_id["facts.list"]["path"], by_id["facts.list"]["roles"]) == (
        "GET",
        "/api/v3/participants/{participant_id}/facts",
        ["therapist"],
    )
    assert (by_id["facts.evidence"]["method"], by_id["facts.evidence"]["path"], by_id["facts.evidence"]["roles"]) == (
        "GET",
        "/api/v3/facts/{fact_id}/evidence",
        ["therapist"],
    )
    assert (by_id["facts.verify"]["method"], by_id["facts.verify"]["path"], by_id["facts.verify"]["roles"]) == (
        "POST",
        "/api/v3/facts/verify",
        ["therapist"],
    )

    t1_hdr = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    t2_hdr = {"Authorization": f"Bearer {ctx['t2_tok']}"}
    t3_hdr = {"Authorization": f"Bearer {ctx['t3_tok']}"}
    p1_hdr = {"Authorization": f"Bearer {ctx['p1_tok']}"}

    # Publish a prescription + consent + full session for p1 through the real API!
    rx_r = client.post(
        "/api/v3/prescriptions",
        headers=t1_hdr,
        json={
            "participant_id": ctx["p1_id"],
            "exercise_id": "organizar-a-mesa",
            "permitted_movement": "hand_open_close",
            "side": "right",
            "target_sets": 1,
            "target_repetitions": 2,
            "sessions_per_week": 5,
            "valid_from": "2026-11-23",
            "valid_to": "2026-12-21",
            "timezone": "America/Sao_Paulo",
            "min_calibration_span": None,
            "instructions_ptbr": "Abra e feche a mão.",
        },
    )
    assert rx_r.status_code == 201
    rx_ev = app.state.v3_store.get_stream_events(f"prescription:{rx_r.json()['prescription_id']}")[0]

    consent = _rehash(
        {
            "event_id": "",
            "schema_version": 3,
            "type": "consent.accepted",
            "stream_id": f"consent:{ctx['p1_id']}",
            "seq": 1,
            "prev_hash": None,
            "occurred_at": "2026-11-25T12:00:00.000Z",
            "actor": {"role": "participant", "id": ctx["p1_id"]},
            "scope": {"org_id": ctx["org_a"], "participant_id": ctx["p1_id"]},
            "source": {"type": "participant_report"},
            "execution_mode": "not_applicable",
            "data_origin": "synthetic_fixture",
            "payload": {"consent_version": "consent-2026-11-25-v1", "scopes": ["camera"]},
        }
    )
    sess = _SynthSession(rx_ev, mode="camera")
    sess.start_session()
    sess.calibrate("cal_http-0001")
    sess.control("start")
    sess.cycle_accepted(1, "cal_http-0001")
    sess.cycle_accepted(2, "cal_http-0001")
    sess.completed(2, 2)
    sess.capture_summary()
    sess.measurement()
    sess.report(execution="complete", assistance="none")
    batch = sorted([consent, *sess.events], key=lambda e: (e["stream_id"], e["seq"]))
    rb = client.post("/api/v3/events:batch", headers=p1_hdr, json={"events": batch})
    assert rb.status_code == 200 and all(it["status"] == "stored" for it in rb.json()["results"]), rb.text

    # 1. facts.list (linked therapist -> 200 {facts, catalog_version: "2"})
    r_list = client.get(f"/api/v3/participants/{ctx['p1_id']}/facts", headers=t1_hdr)
    assert r_list.status_code == 200
    body_list = r_list.json()
    assert set(body_list.keys()) == {"facts", "catalog_version"}
    assert body_list["catalog_version"] == FACT_CATALOG_VERSION
    fact_types_returned = {f["type"] for f in body_list["facts"]}
    assert fact_types_returned == {"F01", "F02", "F03", "F04", "F06", "F09", "F10"}
    f01 = next(f for f in body_list["facts"] if f["type"] == "F01")
    f01_id = f01["fact_id"]

    # Date filter query params
    r_list_empty = client.get(f"/api/v3/participants/{ctx['p1_id']}/facts?from=2026-12-01", headers=t1_hdr)
    assert r_list_empty.status_code == 200 and r_list_empty.json()["facts"] == []

    # 2. facts.evidence (linked therapist -> 200 {fact_id, events})
    r_ev = client.get(f"/api/v3/facts/{f01_id}/evidence", headers=t1_hdr)
    assert r_ev.status_code == 200
    ev_body = r_ev.json()
    assert set(ev_body.keys()) == {"fact_id", "events"}
    assert ev_body["fact_id"] == f01_id
    assert [e["event_id"] for e in ev_body["events"]] == f01["evidence_refs"]

    # 3. facts.verify NEVER persists (Row 7): snapshot all tables before & after valid + invalid proposals
    before_snap = _db_fingerprint(app.state.v3_store.db)
    good_prop = _proposal_from_fact(f01)
    r_v_ok = client.post("/api/v3/facts/verify", headers=t1_hdr, json=good_prop)
    assert r_v_ok.status_code == 200
    v_ok = r_v_ok.json()
    assert set(v_ok.keys()) == {"valid", "code", "step", "fact", "content_hash"}
    assert v_ok["valid"] is True and v_ok["code"] is None and v_ok["step"] is None
    assert v_ok["fact"] == f01 and v_ok["content_hash"] == hash_canonical(f01)

    bad_prop = copy.deepcopy(good_prop)
    bad_prop["params"]["accepted"] = 99
    r_v_bad = client.post("/api/v3/facts/verify", headers=t1_hdr, json=bad_prop)
    assert r_v_bad.status_code == 200
    v_bad = r_v_bad.json()
    assert v_bad == {"valid": False, "code": "RECOMPUTE_MISMATCH", "step": "RECOMPUTE", "fact": None, "content_hash": None}

    after_snap = _db_fingerprint(app.state.v3_store.db)
    assert after_snap == before_snap

    # 4. Full Row 8 authorization matrix
    # Anonymous -> 401 UNAUTHENTICATED
    assert client.get(f"/api/v3/participants/{ctx['p1_id']}/facts").status_code == 401
    assert client.get(f"/api/v3/facts/{f01_id}/evidence").status_code == 401
    assert client.post("/api/v3/facts/verify", json=good_prop).status_code == 401

    # Participant -> 403 FORBIDDEN on all 3
    for resp in (
        client.get(f"/api/v3/participants/{ctx['p1_id']}/facts", headers=p1_hdr),
        client.get(f"/api/v3/facts/{f01_id}/evidence", headers=p1_hdr),
        client.post("/api/v3/facts/verify", headers=p1_hdr, json=good_prop),
    ):
        assert resp.status_code == 403 and resp.json()["error"]["code"] == "FORBIDDEN"

    # Unlinked same-org (t2) & other-org (t3) therapist -> 403 SCOPE_VIOLATION on list & verify, 404 NOT_FOUND on evidence
    for hdr in (t2_hdr, t3_hdr):
        rl = client.get(f"/api/v3/participants/{ctx['p1_id']}/facts", headers=hdr)
        assert rl.status_code == 403 and rl.json()["error"]["code"] == "SCOPE_VIOLATION"
        rv = client.post("/api/v3/facts/verify", headers=hdr, json=good_prop)
        assert rv.status_code == 403 and rv.json()["error"]["code"] == "SCOPE_VIOLATION"
        re_resp = client.get(f"/api/v3/facts/{f01_id}/evidence", headers=hdr)
        assert re_resp.status_code == 404 and re_resp.json()["error"]["code"] == "NOT_FOUND"

    # Unknown participant & unknown fact -> 404 NOT_FOUND
    unk_pid = new_id("p")
    unk_fid = "f_" + ("a" * 64)
    assert client.get(f"/api/v3/participants/{unk_pid}/facts", headers=t1_hdr).status_code == 404
    assert client.get(f"/api/v3/facts/{unk_fid}/evidence", headers=t1_hdr).status_code == 404
    unk_prop = copy.deepcopy(good_prop)
    unk_prop["scope"]["participant_id"] = unk_pid
    assert client.post("/api/v3/facts/verify", headers=t1_hdr, json=unk_prop).status_code == 404

    # Forged roles -> 403 ROLE_NOT_ALLOWED
    future = (datetime.now(timezone.utc) + timedelta(seconds=3600)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    for bad_role in ("caregiver", "supervisor", "admin", ""):
        raw = secrets.token_urlsafe(32)
        app.state.v3_store.db.execute(
            "INSERT INTO v3_tokens (token_hash, role, principal_id, org_id, expires_at, revoked, created_at) VALUES (?,?,?,?,?,0,?)",
            (sha256_token(raw), bad_role, ctx["t1_id"], ctx["org_a"], future, now),
        )
        app.state.v3_store.db.commit()
        bh = {"Authorization": f"Bearer {raw}"}
        for resp in (
            client.get(f"/api/v3/participants/{ctx['p1_id']}/facts", headers=bh),
            client.get(f"/api/v3/facts/{f01_id}/evidence", headers=bh),
            client.post("/api/v3/facts/verify", headers=bh, json=good_prop),
        ):
            assert resp.status_code == 403 and resp.json()["error"]["code"] == "ROLE_NOT_ALLOWED"

    # Revoked care_link -> t1 gets 403 SCOPE_VIOLATION on list & verify, 404 NOT_FOUND on evidence
    rev_r = client.post(f"/api/v3/care-links/{ctx['cl1_id']}:revoke", headers=t1_hdr, json={})
    assert rev_r.status_code == 200
    assert client.get(f"/api/v3/participants/{ctx['p1_id']}/facts", headers=t1_hdr).status_code == 403
    assert client.post("/api/v3/facts/verify", headers=t1_hdr, json=good_prop).status_code == 403
    assert client.get(f"/api/v3/facts/{f01_id}/evidence", headers=t1_hdr).status_code == 404


# --- Row 9: Error catalog alignment ---


def test_verifier_codes_match_error_catalog():
    catalog = _load_json(ERROR_CODES_PATH)["codes"]
    for code, status in VERIFIER_RESULT_CODES.items():
        assert code in catalog
        assert catalog[code]["http"] == status == 200
        assert catalog[code]["layer"] == "verifier"
        assert code not in EMITTABLE_ERROR_CODES
    for code, status in EMITTABLE_ERROR_CODES.items():
        assert code in catalog and catalog[code]["http"] == status
    for code, status in ITEM_WARNING_CODES.items():
        assert code in catalog and catalog[code]["http"] == status
