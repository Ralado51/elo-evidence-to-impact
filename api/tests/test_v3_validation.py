"""Tests for S0-03: CL06.3 v3 validation layer, real-data gate, and consent fold/requirement.

Covers ACCEPTANCE rows 1-19 (row 20 is the Verifier's independent differential harness).
All credentials and mutations are synthetic and deterministic.
"""

from __future__ import annotations

import ast
import copy
import importlib.util
import json
import random
import secrets
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from elo.api import create_app
from elo.canonical import compute_event_hash, compute_event_id
from elo.v3.entities import compute_entity_hash, new_id
from elo.v3.errors import EMITTABLE_ERROR_CODES, error_response, map_validation_code, to_http_error
from elo.v3.validation import (
    REAL_DATA_GATE_ENV,
    check_real_data_gate,
    consent_state,
    is_real_data_gate_open,
    require_consent,
    validate_entity,
    validate_entity_chain,
    validate_event,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
PKG = REPO_ROOT / "contracts" / "CL06_3-r1"
CONTRACTS = PKG / "contracts"
LEDGER_PATH = PKG / "fixtures" / "valid" / "ledger.v3.json"
ENTITIES_PATH = PKG / "fixtures" / "valid" / "entities.v3.json"
INVALID_PATH = PKG / "fixtures" / "invalid" / "contract-invalid.v3.json"
ERROR_CODES_PATH = CONTRACTS / "catalogs" / "error-codes.v3.json"
EVENT_CATALOG_PATH = CONTRACTS / "catalogs" / "event-catalog.v3.json"
LIMITS_PATH = CONTRACTS / "catalogs" / "limits.v1.json"
REF_PY_PATH = PKG / "reference" / "python" / "elo_ref.py"

MUTATION_SEED = 20260303


def _load_ref():
    spec = importlib.util.spec_from_file_location("s0_03_cl06_3_elo_ref", REF_PY_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _ref_validate_event(ref, event, es, cat, limits, *, gate_open: bool = False) -> list[str]:
    if not isinstance(event, dict):
        return ["TYPE"]
    if "type" not in event:
        return ["MISSING_FIELD"]
    et = event["type"]
    if not isinstance(et, str):
        return ["TYPE"]
    schema = es.get(et)
    if schema is None:
        return ["UNKNOWN_TYPE"]
    out = {c for _, c in ref.validate(schema, event)}
    try:
        out |= set(ref.check_event_integrity(event))
    except Exception:
        pass
    try:
        out |= set(ref.check_event_semantics(event, cat, limits, real_data_gate_open=gate_open))
    except Exception:
        pass
    return sorted(out)


def _ref_validate_entity(ref, entity, ns, cat, *, gate_open: bool = False) -> list[str]:
    if not isinstance(entity, dict):
        return ["TYPE"]
    if "entity_type" not in entity:
        return ["MISSING_FIELD"]
    et = entity["entity_type"]
    if not isinstance(et, str):
        return ["TYPE"]
    schema = ns.get(et)
    if schema is None:
        return ["UNKNOWN_TYPE"]
    out = {c for _, c in ref.validate(schema, entity)}
    try:
        out |= set(ref.check_entity_semantics(entity, cat, real_data_gate_open=gate_open))
    except Exception:
        pass
    return sorted(out)


def _rehash_event(ev: dict) -> dict:
    e = copy.deepcopy(ev)
    e["event_id"] = compute_event_id(e["stream_id"], e["seq"])
    e["hash"] = compute_event_hash(e)
    return e


def _rehash_entity(ent: dict) -> dict:
    x = copy.deepcopy(ent)
    x["hash"] = compute_entity_hash(x)
    return x


def _make_consent_event(seq: int, kind: str, scopes: list[str], participant_id: str = "p_fixture-0001") -> dict:
    return {
        "type": kind,
        "seq": seq,
        "stream_id": f"consent:{participant_id}",
        "execution_mode": "not_applicable",
        "payload": {"consent_version": "consent-2026-11-24-v1", "scopes": scopes},
    }


# --- Row 1: Valid events pass ------------------------------------------------------------


def test_valid_ledger_events_pass():
    ledger = _load_json(LEDGER_PATH)["events"]
    assert len(ledger) == 22
    for ev in ledger:
        assert validate_event(ev) == [], f"Unexpected errors for {ev['type']} seq={ev['seq']}"


# --- Row 2: Invalid events caught (iterating fixture file directly) ----------------------


def test_invalid_events_caught():
    cases = _load_json(INVALID_PATH)["events"]
    assert len(cases) == 33
    for case in cases:
        got = validate_event(case["event"])
        assert case["expect"] in got, f"{case['id']}: expected {case['expect']} in {got}"


# --- Row 3: Integrity cases --------------------------------------------------------------


def test_invalid_integrity_cases_caught():
    cases = _load_json(INVALID_PATH)["integrity"]
    assert len(cases) == 4
    for case in cases:
        got = validate_event(case["event"])
        assert case["expect"] in got, f"{case['id']}: expected {case['expect']} in {got}"


# --- Row 4: Valid entities pass ----------------------------------------------------------


def test_valid_entities_pass():
    data = _load_json(ENTITIES_PATH)
    assert len(data["entities"]) > 0
    for name, ent in data["entities"].items():
        assert validate_entity(ent) == [], f"Unexpected errors for entity {name}"
    for name, versions in data["chains"].items():
        assert validate_entity_chain(versions) == [], f"Unexpected chain errors for {name}"


# --- Row 5: Invalid entities and entity chains caught ------------------------------------


def test_invalid_entities_and_chains_caught():
    inv = _load_json(INVALID_PATH)
    ent_cases = inv["entities"]
    assert len(ent_cases) == 18
    for case in ent_cases:
        got = validate_entity(case["entity"])
        assert case["expect"] in got, f"{case['id']}: expected {case['expect']} in {got}"

    for case in inv["entity_chains"]:
        got = validate_entity_chain(case["versions"])
        assert got == sorted(case["expect"]), f"{case['id']}: expected {sorted(case['expect'])}, got {got}"


# --- Row 6: Exact parity with REF on rows 1-5 + >= 100 seeded mutations ------------------


def test_differential_parity_with_reference():
    ref = _load_ref()
    cat = _load_json(EVENT_CATALOG_PATH)
    limits = _load_json(LIMITS_PATH)
    es = {p.name[:-12]: _load_json(p) for p in (CONTRACTS / "schemas" / "events").glob("*.schema.json")}
    ns = {p.name[:-12]: _load_json(p) for p in (CONTRACTS / "schemas" / "entities").glob("*.schema.json")}

    ledger = _load_json(LEDGER_PATH)["events"]
    entities = list(_load_json(ENTITIES_PATH)["entities"].values())
    inv = _load_json(INVALID_PATH)

    # Exact parity on all valid and invalid fixture events & entities (both gate settings)
    for ev in ledger + [c["event"] for c in inv["events"]] + [c["event"] for c in inv["integrity"]]:
        for gate_open in (False, True):
            assert validate_event(ev, gate_open=gate_open) == _ref_validate_event(
                ref, ev, es, cat, limits, gate_open=gate_open
            )

    for ent in entities + [c["entity"] for c in inv["entities"]]:
        for gate_open in (False, True):
            assert validate_entity(ent, gate_open=gate_open) == _ref_validate_entity(
                ref, ent, ns, cat, gate_open=gate_open
            )

    # >= 100 seeded mutations (80 event mutations + 40 entity mutations = 120; seed=MUTATION_SEED)
    rng = random.Random(MUTATION_SEED)
    valid_hex = "a" * 64
    exec_modes = ["camera", "simulation", "report_only", "not_applicable", "invalid_mode"]
    origins = ["live", "synthetic_fixture", "experimental_capture", "imported_v1", "real"]
    roles = ["participant", "therapist", "system", "caregiver", "supervisor"]
    sources = ["camera", "simulation", "participant_report", "therapist", "system"]

    for i in range(80):
        ev = copy.deepcopy(rng.choice(ledger))
        op = i % 16
        if op == 0:
            ev["execution_mode"] = rng.choice(exec_modes)
        elif op == 1:
            ev["data_origin"] = rng.choice(origins)
            if rng.random() < 0.5:
                ev.pop("origin_ref", None)
            else:
                ev["origin_ref"] = valid_hex
        elif op == 2:
            ev["actor"]["role"] = rng.choice(roles)
        elif op == 3:
            ev["source"]["type"] = rng.choice(sources)
        elif op == 4:
            ev["stream_id"] = "session:s_wrongstream01"
        elif op == 5:
            ev["seq"] = rng.choice([1, 2, 99])
        elif op == 6:
            ev["prev_hash"] = None if ev.get("prev_hash") is not None else valid_hex
        elif op == 7:
            ev["hash"] = "0" * 64
        elif op == 8:
            ev["event_id"] = "1" * 64
        elif op == 9:
            if "t_mono_ms" in ev:
                del ev["t_mono_ms"]
            else:
                ev["t_mono_ms"] = 1234
        elif op == 10:
            if "algorithm_version" in ev["source"]:
                del ev["source"]["algorithm_version"]
            else:
                ev["source"]["algorithm_version"] = "c05-hand-2"
        elif op == 11:
            ev.pop("execution_mode", None)
        elif op == 12:
            ev["extra_unknown_key"] = "forbidden"
        elif op == 13:
            ev["schema_version"] = 2
        elif op == 14:
            ev["scope"]["session_id"] = "s_injected0001"
        else:
            ev["type"] = "nonexistent.event"

        gate_open = bool(i % 2)
        got = validate_event(ev, gate_open=gate_open)
        expected = _ref_validate_event(ref, ev, es, cat, limits, gate_open=gate_open)
        assert got == expected, f"Event mutation #{i} (op={op}, gate={gate_open}): {got} != {expected}"

    for i in range(40):
        ent = copy.deepcopy(rng.choice(entities))
        op = i % 10
        if op == 0:
            ent["data_origin"] = rng.choice(origins)
            if rng.random() < 0.5:
                ent.pop("origin_ref", None)
            else:
                ent["origin_ref"] = valid_hex
        elif op == 1:
            ent["author"]["role"] = rng.choice(["participant", "therapist", "caregiver"])
        elif op == 2:
            ent["entity_id"] = "zz_wrongprefix01"
        elif op == 3:
            ent["version"] = rng.choice([1, 2])
        elif op == 4:
            ent["prev_hash"] = None if ent.get("prev_hash") is not None else valid_hex
        elif op == 5:
            ent["hash"] = "f" * 64
        elif op == 6:
            ent["unexpected_extra"] = True
        elif op == 7:
            ent.pop("data_origin", None)
        elif op == 8:
            ent["entity_type"] = "unknown_entity"
        else:
            ent = _rehash_entity(ent)
            ent["data_origin"] = "live"
            ent = _rehash_entity(ent)

        gate_open = bool(i % 2)
        got = validate_entity(ent, gate_open=gate_open)
        expected = _ref_validate_entity(ref, ent, ns, cat, gate_open=gate_open)
        assert got == expected, f"Entity mutation #{i} (op={op}, gate={gate_open}): {got} != {expected}"


# --- Row 7 & Row 8: Real-data gate closed by default & server-only setting ---------------


def test_real_data_gate_closed_by_default_and_shared_with_s0_02(monkeypatch):
    monkeypatch.delenv(REAL_DATA_GATE_ENV, raising=False)
    assert is_real_data_gate_open() is False
    assert is_real_data_gate_open({}) is False
    assert check_real_data_gate("live") == ["REAL_DATA_GATE_CLOSED"]
    assert check_real_data_gate("synthetic_fixture") == []

    # Event with data_origin="live" rejected while gate closed, accepted when open
    ledger = _load_json(LEDGER_PATH)["events"]
    ev_live = copy.deepcopy(ledger[0])
    ev_live["data_origin"] = "live"
    ev_live = _rehash_event(ev_live)
    assert validate_event(ev_live) == ["REAL_DATA_GATE_CLOSED"]
    assert validate_event(ev_live, gate_open=True) == []

    # Entity with data_origin="live" rejected while gate closed, accepted when open
    ent_live = copy.deepcopy(next(iter(_load_json(ENTITIES_PATH)["entities"].values())))
    ent_live["data_origin"] = "live"
    ent_live = _rehash_entity(ent_live)
    assert validate_entity(ent_live) == ["REAL_DATA_GATE_CLOSED"]
    assert validate_entity(ent_live, gate_open=True) == []

    # S0-02 route participants.create uses the shared gate function
    pw = secrets.token_urlsafe(12)
    seeds = [{"therapist_id": new_id("t"), "username": "t_gate", "password": pw, "org_id": new_id("o"), "display_label": "Gate Tester"}]
    monkeypatch.setenv("ELO_V3_THERAPIST_SEEDS", json.dumps(seeds))
    monkeypatch.setenv("ELO_V3_DATA_ORIGIN", "live")
    monkeypatch.delenv(REAL_DATA_GATE_ENV, raising=False)
    app = create_app(":memory:")
    client = TestClient(app)
    token = client.post("/api/v3/auth/therapist", json={"username": "t_gate", "password": pw}).json()["token"]

    r = client.post("/api/v3/participants", headers={"Authorization": f"Bearer {token}"}, json={"alias": "Live P", "side": "left"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "REAL_DATA_GATE_CLOSED"


def test_real_data_gate_only_opens_by_explicit_server_setting(monkeypatch):
    pw = secrets.token_urlsafe(12)
    seeds = [{"therapist_id": new_id("t"), "username": "t_spoof", "password": pw, "org_id": new_id("o"), "display_label": "Spoof Tester"}]
    monkeypatch.setenv("ELO_V3_THERAPIST_SEEDS", json.dumps(seeds))
    monkeypatch.setenv("ELO_V3_DATA_ORIGIN", "synthetic_fixture")
    monkeypatch.delenv(REAL_DATA_GATE_ENV, raising=False)

    # Gate read at app start -> closed
    app = create_app(":memory:")
    assert app.state.v3_store.real_data_gate_open is False
    client = TestClient(app)
    token = client.post("/api/v3/auth/therapist", json={"username": "t_spoof", "password": pw}).json()["token"]

    # Spoofed body, headers, and query params NEVER open the gate
    r_spoof = client.post(
        "/api/v3/participants?real_data_gate_open=true&gate_open=1&ELO_V3_REAL_DATA_GATE_OPEN=true",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Real-Data-Gate-Open": "true",
            "ELO_V3_REAL_DATA_GATE_OPEN": "1",
        },
        json={
            "alias": "Spoofed Live",
            "side": "right",
            "data_origin": "live",
            "real_data_gate_open": True,
            "gate_open": True,
            "ELO_V3_REAL_DATA_GATE_OPEN": "true",
        },
    )
    assert r_spoof.status_code == 403
    assert r_spoof.json()["error"]["code"] == "REAL_DATA_GATE_CLOSED"

    # Mutating env AFTER app start does not flip an already-started app
    monkeypatch.setenv(REAL_DATA_GATE_ENV, "true")
    r_after = client.post(
        "/api/v3/participants",
        headers={"Authorization": f"Bearer {token}"},
        json={"alias": "Late Env", "side": "right", "data_origin": "live"},
    )
    assert r_after.status_code == 403
    assert r_after.json()["error"]["code"] == "REAL_DATA_GATE_CLOSED"

    # Explicit server setting at app start opens the gate
    app_open = create_app(":memory:")
    assert app_open.state.v3_store.real_data_gate_open is True


# --- Row 9: execution_mode rules (>= 5 extra named tests) --------------------------------


def test_execution_mode_not_applicable_outside_session_stream():
    ledger = _load_json(LEDGER_PATH)["events"]
    rx = copy.deepcopy(next(e for e in ledger if e["type"] == "prescription.published"))
    assert rx["execution_mode"] == "not_applicable"
    assert validate_event(rx) == []

    rx["execution_mode"] = "camera"
    rx = _rehash_event(rx)
    assert "EXECUTION_MODE_MISMATCH" in validate_event(rx)


def test_execution_mode_not_applicable_rejected_inside_session_stream():
    ledger = _load_json(LEDGER_PATH)["events"]
    rep = copy.deepcopy(next(e for e in ledger if e["type"] == "report.submitted"))
    rep["execution_mode"] = "not_applicable"
    rep = _rehash_event(rep)
    assert "EXECUTION_MODE_MISMATCH" in validate_event(rep)


def test_execution_mode_session_started_report_only_valid_and_mismatch_rejected():
    ledger = _load_json(LEDGER_PATH)["events"]
    st = copy.deepcopy(next(e for e in ledger if e["type"] == "session.started"))
    st["execution_mode"] = "report_only"
    st["source"] = {"type": "participant_report"}
    st["payload"]["source_mode"] = "report_only"
    st["payload"]["capture_context"] = None
    st = _rehash_event(st)
    assert validate_event(st) == []

    # source_mode disagrees with envelope execution_mode
    bad = copy.deepcopy(st)
    bad["payload"]["source_mode"] = "camera"
    bad = _rehash_event(bad)
    assert "EXECUTION_MODE_MISMATCH" in validate_event(bad)


def test_execution_mode_session_started_source_type_mismatch():
    ledger = _load_json(LEDGER_PATH)["events"]
    st = copy.deepcopy(next(e for e in ledger if e["type"] == "session.started"))
    st["execution_mode"] = "simulation"
    st["payload"]["source_mode"] = "simulation"
    st["source"]["type"] = "camera"  # disagrees with simulation
    st = _rehash_event(st)
    assert "EXECUTION_MODE_MISMATCH" in validate_event(st)


def test_execution_mode_capture_event_source_must_match():
    ledger = _load_json(LEDGER_PATH)["events"]
    for etype in ("cycle.accepted", "measurement.recorded"):
        cap = copy.deepcopy(next(e for e in ledger if e["type"] == etype))
        # Valid simulation capture
        cap_sim = copy.deepcopy(cap)
        cap_sim["execution_mode"] = "simulation"
        cap_sim["source"]["type"] = "simulation"
        cap_sim = _rehash_event(cap_sim)
        assert validate_event(cap_sim) == []

        # Mismatched simulation source in camera mode
        cap_bad = copy.deepcopy(cap)
        cap_bad["execution_mode"] = "camera"
        cap_bad["source"]["type"] = "simulation"
        cap_bad = _rehash_event(cap_bad)
        assert "EXECUTION_MODE_MISMATCH" in validate_event(cap_bad)


def test_execution_mode_participant_report_allowed_in_all_session_modes():
    ledger = _load_json(LEDGER_PATH)["events"]
    rep = copy.deepcopy(next(e for e in ledger if e["type"] == "report.submitted"))
    for mode in ("camera", "simulation", "report_only"):
        cand = copy.deepcopy(rep)
        cand["execution_mode"] = mode
        cand = _rehash_event(cand)
        assert validate_event(cand) == []


# --- Row 10: origin_ref rule -------------------------------------------------------------


@pytest.mark.parametrize("origin", ["experimental_capture", "imported_v1"])
def test_origin_ref_required_for_experimental_and_imported(origin):
    valid_ref = "b" * 64
    ledger = _load_json(LEDGER_PATH)["events"]
    ev = copy.deepcopy(ledger[0])
    ev["data_origin"] = origin
    ev.pop("origin_ref", None)
    ev = _rehash_event(ev)
    assert "ORIGIN_REF_REQUIRED" in validate_event(ev)

    ev["origin_ref"] = valid_ref
    ev = _rehash_event(ev)
    assert validate_event(ev) == []

    ent = copy.deepcopy(next(iter(_load_json(ENTITIES_PATH)["entities"].values())))
    ent["data_origin"] = origin
    ent.pop("origin_ref", None)
    ent = _rehash_entity(ent)
    assert "ORIGIN_REF_REQUIRED" in validate_entity(ent)

    ent["origin_ref"] = valid_ref
    ent = _rehash_entity(ent)
    assert validate_entity(ent) == []


# --- Row 11: Consent fold (>= 8 named sequences) -----------------------------------------


@pytest.mark.parametrize(
    "name,events,expected",
    [
        ("empty_stream", [], frozenset()),
        (
            "accept_camera",
            [_make_consent_event(1, "consent.accepted", ["camera"])],
            frozenset({"camera"}),
        ),
        (
            "accept_camera_and_microphone",
            [_make_consent_event(1, "consent.accepted", ["camera", "microphone"])],
            frozenset({"camera", "microphone"}),
        ),
        (
            "accept_then_revoke_camera",
            [
                _make_consent_event(1, "consent.accepted", ["camera"]),
                _make_consent_event(2, "consent.revoked", ["camera"]),
            ],
            frozenset(),
        ),
        (
            "accept_both_then_revoke_only_camera",
            [
                _make_consent_event(1, "consent.accepted", ["camera", "microphone"]),
                _make_consent_event(2, "consent.revoked", ["camera"]),
            ],
            frozenset({"microphone"}),
        ),
        (
            "repeated_accept_idempotent",
            [
                _make_consent_event(1, "consent.accepted", ["camera"]),
                _make_consent_event(2, "consent.accepted", ["camera"]),
            ],
            frozenset({"camera"}),
        ),
        (
            "revoke_without_prior_accept",
            [_make_consent_event(1, "consent.revoked", ["camera"])],
            frozenset(),
        ),
        (
            "unordered_input_sorted_by_seq_revoke_wins",
            [
                _make_consent_event(2, "consent.revoked", ["camera"]),
                _make_consent_event(1, "consent.accepted", ["camera"]),
            ],
            frozenset(),
        ),
        (
            "unordered_input_sorted_by_seq_reaccept_wins",
            [
                _make_consent_event(3, "consent.accepted", ["camera"]),
                _make_consent_event(1, "consent.accepted", ["camera"]),
                _make_consent_event(2, "consent.revoked", ["camera"]),
            ],
            frozenset({"camera"}),
        ),
        (
            "non_consent_events_ignored",
            [
                {"type": "session.started", "seq": 1, "payload": {"source_mode": "camera"}},
                _make_consent_event(1, "consent.accepted", ["camera"]),
            ],
            frozenset({"camera"}),
        ),
    ],
)
def test_consent_state_fold_sequences(name, events, expected):
    assert consent_state(events) == expected, name


# --- Row 12: Consent requirement (D-S0-03-2) ---------------------------------------------


def test_require_consent_rules():
    ledger = _load_json(LEDGER_PATH)["events"]
    cam_ev = next(e for e in ledger if e["type"] == "cycle.accepted")
    assert cam_ev["execution_mode"] == "camera"

    # Camera session event without active camera scope -> CONSENT_REQUIRED
    assert require_consent(frozenset(), cam_ev) == ["CONSENT_REQUIRED"]
    assert require_consent(frozenset({"microphone"}), cam_ev) == ["CONSENT_REQUIRED"]

    # Active camera scope -> allowed
    st_active = consent_state([_make_consent_event(1, "consent.accepted", ["camera"])])
    assert require_consent(st_active, cam_ev) == []

    # After consent.revoked of camera -> CONSENT_REQUIRED
    st_revoked = consent_state(
        [
            _make_consent_event(1, "consent.accepted", ["camera"]),
            _make_consent_event(2, "consent.revoked", ["camera"]),
        ]
    )
    assert require_consent(st_revoked, cam_ev) == ["CONSENT_REQUIRED"]

    # report_only and simulation session events -> no consent error even with empty state
    rep_ev = copy.deepcopy(next(e for e in ledger if e["type"] == "report.submitted"))
    rep_ev["execution_mode"] = "report_only"
    assert require_consent(frozenset(), rep_ev) == []

    sim_ev = copy.deepcopy(cam_ev)
    sim_ev["execution_mode"] = "simulation"
    assert require_consent(frozenset(), sim_ev) == []

    # Consent events themselves never need prior consent
    assert require_consent(frozenset(), _make_consent_event(1, "consent.accepted", ["camera"])) == []
    assert require_consent(frozenset(), _make_consent_event(2, "consent.revoked", ["camera"])) == []

    # Non-session events need no sensor scope
    rx_ev = next(e for e in ledger if e["type"] == "prescription.published")
    assert require_consent(frozenset(), rx_ev) == []


# --- Row 13 & D-S0-03-4: Codes, HTTP status mapping, and ONEOF -> RULE_VIOLATION ---------


def test_error_codes_and_oneof_http_mapping():
    catalog = {code: meta["http"] for code, meta in _load_json(ERROR_CODES_PATH)["codes"].items()}

    # Every code in EMITTABLE_ERROR_CODES exists in error-codes.v3.json with matching HTTP status
    for code, status in EMITTABLE_ERROR_CODES.items():
        assert code in catalog, f"{code} missing from error-codes.v3.json"
        assert catalog[code] == status, f"HTTP mismatch for {code}: {status} != {catalog[code]}"
        mapped_code, mapped_status, _ = map_validation_code(code)
        assert mapped_code == code
        assert mapped_status == status

    # Collect every code emitted across all INVALID cases + consent + gate
    inv = _load_json(INVALID_PATH)
    observed: set[str] = set()
    for c in inv["events"] + inv["integrity"]:
        observed.update(validate_event(c["event"]))
    for c in inv["entities"]:
        observed.update(validate_entity(c["entity"]))
    for c in inv["entity_chains"]:
        observed.update(validate_entity_chain(c["versions"]))
    observed.update(check_real_data_gate("live", gate_open=False))
    observed.update(require_consent(frozenset(), next(e for e in _load_json(LEDGER_PATH)["events"] if e["type"] == "cycle.accepted")))

    assert "ONEOF" in observed
    for code in observed:
        http_code, http_status, details = map_validation_code(code)
        assert http_code in catalog
        assert catalog[http_code] == http_status
        if code == "ONEOF":
            assert http_code == "RULE_VIOLATION"
            assert http_status == 400
            assert details["validator_code"] == "ONEOF"
        else:
            assert http_code == code

    # Serialized HTTP error for ONEOF preserves "ONEOF" in error.details (D-S0-03-4)
    err = to_http_error("ONEOF", "Draft payload failed oneOf constraint")
    resp = error_response(err)
    assert resp.status_code == 400
    body = json.loads(resp.body.decode("utf-8"))
    assert body["error"]["code"] == "RULE_VIOLATION"
    assert body["error"]["details"]["validator_code"] == "ONEOF"


# --- Row 15: Single copy of ported reference functions across api/src/elo/ ---------------


def test_single_copy_of_ported_reference_functions():
    ref_tree = ast.parse(REF_PY_PATH.read_text(encoding="utf-8"))
    ref_funcs = {node.name for node in ref_tree.body if isinstance(node, ast.FunctionDef)}

    counts: dict[str, list[str]] = {}
    for py_file in sorted((REPO_ROOT / "api" / "src" / "elo").rglob("*.py")):
        tree = ast.parse(py_file.read_text(encoding="utf-8"))
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name in ref_funcs:
                counts.setdefault(node.name, []).append(str(py_file.relative_to(REPO_ROOT)))

    duplicates = {name: locs for name, locs in counts.items() if len(locs) > 1}
    assert duplicates == {}, f"Duplicate REF functions found: {duplicates}"
