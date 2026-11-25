"""Tests for S1a-03: Encounters, reassessments, and instrumental measurements.

Covers ACCEPTANCE rows 1-9 (row 13 is the Verifier's independent HTTP probe).
All credentials, tokens, and entity payloads are synthetic and generated at test time.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from elo.api import create_app
from elo.v3.clinical import DEFAULT_CLINICAL_REGISTRY
from elo.v3.entities import build_entity, load_event_catalog, new_id
from elo.v3.errors import EMITTABLE_ERROR_CODES
from elo.v3.store import sha256_token

REPO_ROOT = Path(__file__).resolve().parents[2]
PKG = REPO_ROOT / "contracts" / "CL06_3-r1"
CONTRACTS = PKG / "contracts"
API_CONTRACT_PATH = CONTRACTS / "api" / "api-contract.v3.json"
ENCOUNTER_SCHEMA_PATH = CONTRACTS / "schemas" / "entities" / "encounter.schema.json"
REASSESSMENT_SCHEMA_PATH = CONTRACTS / "schemas" / "entities" / "reassessment.schema.json"
INSTRUMENTAL_SCHEMA_PATH = CONTRACTS / "schemas" / "entities" / "instrumental_measurement.schema.json"
REF_PY_PATH = PKG / "reference" / "python" / "elo_ref.py"

S1A_03_ROUTE_IDS = {
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
    spec = importlib.util.spec_from_file_location("s1a_03_cl06_3_elo_ref", REF_PY_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _valid_fa_payload(*, date_str: str = "2026-11-23", note: str | None = None) -> dict:
    return {
        "assessment_date": date_str,
        "body_segment": "hand",
        "side": "right",
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
            }
        ],
        "therapist_note": note,
    }


def _valid_encounter_payload(
    *,
    encounter_date: str = "2026-11-23",
    modality: str = "in_person",
    duration_min: int | None = 30,
    prescription_ref: dict | None = None,
    assessment_ref: str | None = None,
    therapist_note: str | None = "Synthetic encounter note.",
) -> dict:
    return {
        "encounter_date": encounter_date,
        "modality": modality,
        "duration_min": duration_min,
        "prescription_ref": prescription_ref,
        "assessment_ref": assessment_ref,
        "therapist_note": therapist_note,
    }


def _valid_reassessment_payload(
    *,
    baseline_ref: str,
    current_ref: str,
    item_comparability: list[dict] | None = None,
) -> dict:
    return {
        "baseline_assessment_ref": baseline_ref,
        "current_assessment_ref": current_ref,
        "item_comparability": item_comparability
        if item_comparability is not None
        else [
            {"item_key": "grip_open_close_free", "comparable": True, "reason": None},
            {"item_key": "wrist_extension", "comparable": False, "reason": "method_differs"},
        ],
    }


def _valid_instrumental_payload(
    *,
    measured_at: str = "2026-11-25T10:15:00.000Z",
    body_segment: str = "wrist",
    side: str = "right",
    movement_key: str = "wrist_extension",
    value: float | int = 42.5,
    unit: str = "deg",
    instrument_label: str = "manual goniometer (synthetic)",
    method: str = "therapist_instrumental_manual",
    assistance: str = "none",
    therapist_note: str | None = "Synthetic manual measure.",
) -> dict:
    return {
        "measured_at": measured_at,
        "body_segment": body_segment,
        "side": side,
        "movement_key": movement_key,
        "value": value,
        "unit": unit,
        "instrument_label": instrument_label,
        "method": method,
        "assistance": assistance,
        "therapist_note": therapist_note,
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
        {"therapist_id": t1_id, "username": "t_s3_1", "password": t1_pw, "org_id": org_a, "display_label": "Therapist S3-1"},
        {"therapist_id": t2_id, "username": "t_s3_2", "password": t2_pw, "org_id": org_a, "display_label": "Therapist S3-2"},
        {"therapist_id": t3_id, "username": "t_s3_3", "password": t3_pw, "org_id": org_b, "display_label": "Therapist S3-3"},
    ]
    monkeypatch.setenv("ELO_V3_THERAPIST_SEEDS", json.dumps(seeds))
    app = create_app(":memory:")
    client = TestClient(app)

    def login(u: str, p: str) -> str:
        r = client.post("/api/v3/auth/therapist", json={"username": u, "password": p})
        assert r.status_code == 200
        return r.json()["token"]

    t1_tok = login("t_s3_1", t1_pw)
    t2_tok = login("t_s3_2", t2_pw)
    t3_tok = login("t_s3_3", t3_pw)

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

    p1, cl1_id, p1_tok = mk_participant(t1_tok, "S3 P1")
    p2, cl2_id, p2_tok = mk_participant(t2_tok, "S3 P2")

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


def _create_assessment(client: TestClient, tok: str, participant_id: str, *, date_str: str = "2026-11-23") -> dict:
    r = client.post(
        f"/api/v3/participants/{participant_id}/assessments",
        headers={"Authorization": f"Bearer {tok}"},
        json=_valid_fa_payload(date_str=date_str),
    )
    assert r.status_code == 201, r.text
    return r.json()


def _collect_v3_routes(app) -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path, ops in app.openapi().get("paths", {}).items():
        if path.startswith("/api/v3"):
            for method in ops:
                if method.upper() not in ("HEAD", "OPTIONS"):
                    found.add((method.upper(), path))
    return found


# --- Row 1 & Row 2: Routes match API contract & registry-only generic service ------------


def test_s1a03_routes_match_contract_and_use_generic_registry(monkeypatch):
    api_doc = _load_json(API_CONTRACT_PATH)
    by_id = {ep["id"]: ep for ep in api_doc["endpoints"]}
    expected_routes = {(by_id[rid]["method"], by_id[rid]["path"]) for rid in S1A_03_ROUTE_IDS}

    app, _, _ = _make_seeded_app(monkeypatch)
    assert _collect_v3_routes(app) == expected_routes

    assert by_id["encounters.create"]["method"] == "POST"
    assert by_id["encounters.create"]["path"] == "/api/v3/participants/{participant_id}/encounters"
    assert by_id["encounters.create"]["roles"] == ["therapist"]

    assert by_id["encounters.list"]["method"] == "GET"
    assert by_id["encounters.list"]["path"] == "/api/v3/participants/{participant_id}/encounters"
    assert by_id["encounters.list"]["roles"] == ["therapist"]

    assert by_id["reassessments.create"]["method"] == "POST"
    assert by_id["reassessments.create"]["path"] == "/api/v3/participants/{participant_id}/reassessments"
    assert by_id["reassessments.create"]["roles"] == ["therapist"]

    assert by_id["instrumental.create"]["method"] == "POST"
    assert by_id["instrumental.create"]["path"] == "/api/v3/participants/{participant_id}/instrumental-measurements"
    assert by_id["instrumental.create"]["roles"] == ["therapist"]

    # Row 2: all 3 types registered in DEFAULT_CLINICAL_REGISTRY; no entity-type branching in ClinicalEntityService
    for et, prefix in (
        ("encounter", "en"),
        ("reassessment", "ra"),
        ("instrumental_measurement", "im"),
    ):
        assert et in DEFAULT_CLINICAL_REGISTRY
        assert DEFAULT_CLINICAL_REGISTRY[et].id_prefix == prefix
        assert DEFAULT_CLINICAL_REGISTRY[et].allow_revise is False

    clinical_src = (REPO_ROOT / "api" / "src" / "elo" / "v3" / "clinical.py").read_text(encoding="utf-8")
    tree = ast.parse(clinical_src)
    cls_node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "ClinicalEntityService")
    for node in ast.walk(cls_node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            assert node.value not in (
                "functional_assessment",
                "goal",
                "encounter",
                "reassessment",
                "instrumental_measurement",
            )


# --- Row 3: Entities conform to REF, server-owned fields, manual instrumental isolation --


@pytest.mark.parametrize("wrapped", [False, True])
def test_create_encounter_reassessment_instrumental_ref_parity(monkeypatch, wrapped):
    ref = _load_ref()
    cat = load_event_catalog()
    en_schema = _load_json(ENCOUNTER_SCHEMA_PATH)
    ra_schema = _load_json(REASSESSMENT_SCHEMA_PATH)
    im_schema = _load_json(INSTRUMENTAL_SCHEMA_PATH)

    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    fa1 = _create_assessment(client, ctx["t1_tok"], ctx["p1_id"], date_str="2026-11-20")
    fa2 = _create_assessment(client, ctx["t1_tok"], ctx["p1_id"], date_str="2026-11-25")

    spoof_envelope = {
        "entity_id": "en_spoofed1234",
        "version": 99,
        "prev_hash": "a" * 64,
        "org_id": ctx["org_b"],
        "participant_id": ctx["p2_id"],
        "created_at": "2000-01-01T00:00:00.000Z",
        "author": {"role": "participant", "id": ctx["p2_id"]},
        "data_origin": "live",
        "hash": "b" * 64,
    }

    def body_for(payload: dict) -> dict:
        if wrapped:
            return {**spoof_envelope, "payload": payload}
        return {**spoof_envelope, **payload}

    # 1. Encounter
    en_resp = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/encounters",
        headers=hdrs,
        json=body_for(_valid_encounter_payload(modality="remote_external", assessment_ref=fa1["entity_id"])),
    )
    assert en_resp.status_code == 201, en_resp.text
    en = en_resp.json()
    assert en["entity_id"].startswith("en_") and en["entity_id"] != "en_spoofed1234"
    assert en["entity_type"] == "encounter"
    assert en["version"] == 1
    assert en["prev_hash"] is None
    assert en["org_id"] == ctx["org_a"]
    assert en["participant_id"] == ctx["p1_id"]
    assert en["author"] == {"role": "therapist", "id": ctx["t1_id"]}
    assert en["data_origin"] == "synthetic_fixture"
    assert en["hash"] == ref.compute_entity_hash(en)
    assert ref.validate(en_schema, en) == []
    assert ref.check_entity_semantics(en, cat, real_data_gate_open=False) == []

    # 2. Reassessment
    ra_resp = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/reassessments",
        headers=hdrs,
        json=body_for(_valid_reassessment_payload(baseline_ref=fa1["entity_id"], current_ref=fa2["entity_id"])),
    )
    assert ra_resp.status_code == 201, ra_resp.text
    ra = ra_resp.json()
    assert ra["entity_id"].startswith("ra_")
    assert ra["entity_type"] == "reassessment"
    assert ra["version"] == 1
    assert ra["prev_hash"] is None
    assert ra["org_id"] == ctx["org_a"]
    assert ra["participant_id"] == ctx["p1_id"]
    assert ra["author"] == {"role": "therapist", "id": ctx["t1_id"]}
    assert ra["data_origin"] == "synthetic_fixture"
    assert ra["hash"] == ref.compute_entity_hash(ra)
    assert ref.validate(ra_schema, ra) == []
    assert ref.check_entity_semantics(ra, cat, real_data_gate_open=False) == []

    # 3. Instrumental measurement (manual therapist measure; produces no events/facts)
    im_resp = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/instrumental-measurements",
        headers=hdrs,
        json=body_for(_valid_instrumental_payload()),
    )
    assert im_resp.status_code == 201, im_resp.text
    im = im_resp.json()
    assert im["entity_id"].startswith("im_")
    assert im["entity_type"] == "instrumental_measurement"
    assert im["version"] == 1
    assert im["prev_hash"] is None
    assert im["org_id"] == ctx["org_a"]
    assert im["participant_id"] == ctx["p1_id"]
    assert im["author"] == {"role": "therapist", "id": ctx["t1_id"]}
    assert im["data_origin"] == "synthetic_fixture"
    assert im["payload"]["method"] == "therapist_instrumental_manual"
    assert im["hash"] == ref.compute_entity_hash(im)
    assert ref.validate(im_schema, im) == []
    assert ref.check_entity_semantics(im, cat, real_data_gate_open=False) == []

    # Zero events produced in ledger by creating clinical entities (including instrumental measurement)
    assert app.state.v3_store.get_all_events() == []

    # All three entities readable through entities.versions by linked therapist
    for ent in (en, ra, im):
        rv = client.get(f"/api/v3/entities/{ent['entity_id']}/versions", headers=hdrs)
        assert rv.status_code == 200
        assert rv.json() == [ent]


# --- Row 4: Encounter modality enum enforcement ------------------------------------------


def test_encounter_modality_accepts_only_in_person_and_remote_external(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    for ok_mod in ("in_person", "remote_external"):
        r = client.post(
            f"/api/v3/participants/{ctx['p1_id']}/encounters",
            headers=hdrs,
            json=_valid_encounter_payload(modality=ok_mod),
        )
        assert r.status_code == 201, r.text
        assert r.json()["payload"]["modality"] == ok_mod

    before_count = len(app.state.v3_store.list_latest_entities("encounter", ctx["p1_id"]))
    assert before_count == 2

    bad_modalities = [
        ("remote_integrated", "ENUM"),
        ("telehealth", "ENUM"),
        ("hybrid", "ENUM"),
        ("", "ENUM"),
        (None, "NULL_NOT_ALLOWED"),
        (123, "TYPE"),
    ]
    for bad_mod, expected_code in bad_modalities:
        r = client.post(
            f"/api/v3/participants/{ctx['p1_id']}/encounters",
            headers=hdrs,
            json=_valid_encounter_payload(modality=bad_mod),
        )
        _assert_error(r, 400, expected_code)

    assert len(app.state.v3_store.list_latest_entities("encounter", ctx["p1_id"])) == before_count


# --- Row 5 & Row 6: Assessment references and prescription_ref=null (D-S1a-03-1) ---------


def test_encounter_and_reassessment_reference_integrity_and_prescription_null(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    fa1 = _create_assessment(client, ctx["t1_tok"], ctx["p1_id"], date_str="2026-11-20")
    fa2 = _create_assessment(client, ctx["t1_tok"], ctx["p1_id"], date_str="2026-11-24")
    fa_other = _create_assessment(client, ctx["t2_tok"], ctx["p2_id"], date_str="2026-11-22")

    # Non-assessment entities owned by p1
    goal_p1 = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/goals",
        headers=t1_hdrs,
        json={
            "goal_text": "Synthetic goal for ref check",
            "body_segment": "hand",
            "target": {"kind": "descriptive_text", "value": None, "unit": None},
            "status": "active",
            "confirmed_by": None,
            "confirmed_at": None,
        },
    ).json()
    im_p1 = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/instrumental-measurements",
        headers=t1_hdrs,
        json=_valid_instrumental_payload(),
    ).json()
    en_seed = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/encounters",
        headers=t1_hdrs,
        json=_valid_encounter_payload(assessment_ref=None, prescription_ref=None),
    )
    assert en_seed.status_code == 201
    en_p1 = en_seed.json()

    # Valid encounter with assessment_ref pointing to same-participant assessment
    en_with_fa = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/encounters",
        headers=t1_hdrs,
        json=_valid_encounter_payload(assessment_ref=fa1["entity_id"], prescription_ref=None),
    )
    assert en_with_fa.status_code == 201
    assert en_with_fa.json()["payload"]["assessment_ref"] == fa1["entity_id"]
    assert en_with_fa.json()["payload"]["prescription_ref"] is None

    # Row 5: Invalid encounter.assessment_ref -> 400 RULE_VIOLATION, nothing stored
    bad_en_refs = [
        new_id("fa"),               # unknown fa id
        fa_other["entity_id"],      # another participant's functional_assessment
        goal_p1["entity_id"],       # existing non-assessment entity (goal)
        im_p1["entity_id"],         # existing non-assessment entity (instrumental_measurement)
        en_p1["entity_id"],         # existing non-assessment entity (encounter)
        ctx["p1_id"],               # existing non-assessment entity (participant)
    ]
    for bad_ref in bad_en_refs:
        r = client.post(
            f"/api/v3/participants/{ctx['p1_id']}/encounters",
            headers=t1_hdrs,
            json=_valid_encounter_payload(assessment_ref=bad_ref),
        )
        _assert_error(r, 400, "RULE_VIOLATION")

    # Row 6: Non-null prescription_ref -> 400 RULE_VIOLATION, nothing stored
    r_rx = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/encounters",
        headers=t1_hdrs,
        json=_valid_encounter_payload(
            prescription_ref={"prescription_id": "rx_fixture-0001", "revision": 1},
            assessment_ref=fa1["entity_id"],
        ),
    )
    _assert_error(r_rx, 400, "RULE_VIOLATION")
    assert len(app.state.v3_store.list_latest_entities("encounter", ctx["p1_id"])) == 2

    # Row 5: Invalid reassessment references -> 400 RULE_VIOLATION, nothing stored
    bad_ra_pairs = [
        (fa1["entity_id"], fa1["entity_id"]),          # baseline == current
        (new_id("fa"), fa2["entity_id"]),              # unknown baseline
        (fa1["entity_id"], new_id("fa")),              # unknown current
        (fa_other["entity_id"], fa2["entity_id"]),     # baseline belongs to another participant
        (fa1["entity_id"], fa_other["entity_id"]),     # current belongs to another participant
        (goal_p1["entity_id"], fa2["entity_id"]),      # baseline is non-assessment entity
        (fa1["entity_id"], goal_p1["entity_id"]),      # current is non-assessment entity
        (im_p1["entity_id"], en_p1["entity_id"]),      # both non-assessment entities
        (ctx["p1_id"], fa2["entity_id"]),              # baseline is participant entity
    ]
    for b_ref, c_ref in bad_ra_pairs:
        r = client.post(
            f"/api/v3/participants/{ctx['p1_id']}/reassessments",
            headers=t1_hdrs,
            json=_valid_reassessment_payload(baseline_ref=b_ref, current_ref=c_ref),
        )
        _assert_error(r, 400, "RULE_VIOLATION")

    assert app.state.v3_store.list_latest_entities("reassessment", ctx["p1_id"]) == []

    # Valid reassessment with distinct same-participant functional_assessments
    r_ra_ok = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/reassessments",
        headers=t1_hdrs,
        json=_valid_reassessment_payload(baseline_ref=fa1["entity_id"], current_ref=fa2["entity_id"]),
    )
    assert r_ra_ok.status_code == 201
    assert len(app.state.v3_store.list_latest_entities("reassessment", ctx["p1_id"])) == 1


# --- Row 7: Encounter list returns latest version ordered by (created_at, entity_id) -----


def test_encounters_list_returns_latest_versions_ordered_by_created_at_then_id(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    t2_hdrs = {"Authorization": f"Bearer {ctx['t2_tok']}"}

    # Empty list initially
    r0 = client.get(f"/api/v3/participants/{ctx['p1_id']}/encounters", headers=t1_hdrs)
    assert r0.status_code == 200
    assert r0.json() == []

    # Seed another participant's encounter to prove participant isolation
    assert (
        client.post(
            f"/api/v3/participants/{ctx['p2_id']}/encounters",
            headers=t2_hdrs,
            json=_valid_encounter_payload(therapist_note="P2 encounter"),
        ).status_code
        == 201
    )

    # Create two encounters via HTTP
    e1 = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/encounters",
        headers=t1_hdrs,
        json=_valid_encounter_payload(modality="in_person", therapist_note="E1"),
    ).json()
    time.sleep(0.005)
    e2 = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/encounters",
        headers=t1_hdrs,
        json=_valid_encounter_payload(modality="remote_external", therapist_note="E2"),
    ).json()

    # Insert deterministic same-timestamp tie-break entities AND a v2 of e1 directly into store
    # to verify latest-version projection and deterministic (created_at, entity_id) ordering.
    store = app.state.v3_store
    same_ts = "2026-11-25T11:00:00.000Z"
    e_tie_b = build_entity(
        entity_type="encounter",
        entity_id="en_tiebreak0002",
        version=1,
        prev_hash=None,
        org_id=ctx["org_a"],
        participant_id=ctx["p1_id"],
        author_role="therapist",
        author_id=ctx["t1_id"],
        data_origin="synthetic_fixture",
        payload=_valid_encounter_payload(therapist_note="Tie B"),
        created_at=same_ts,
    )
    e_tie_a = build_entity(
        entity_type="encounter",
        entity_id="en_tiebreak0001",
        version=1,
        prev_hash=None,
        org_id=ctx["org_a"],
        participant_id=ctx["p1_id"],
        author_role="therapist",
        author_id=ctx["t1_id"],
        data_origin="synthetic_fixture",
        payload=_valid_encounter_payload(therapist_note="Tie A"),
        created_at=same_ts,
    )
    e1_v2 = build_entity(
        entity_type="encounter",
        entity_id=e1["entity_id"],
        version=2,
        prev_hash=e1["hash"],
        org_id=ctx["org_a"],
        participant_id=ctx["p1_id"],
        author_role="therapist",
        author_id=ctx["t1_id"],
        data_origin="synthetic_fixture",
        payload=_valid_encounter_payload(modality="remote_external", therapist_note="E1 revised"),
        created_at="2026-11-25T23:59:59.000Z",
    )
    store.insert_entity_version(e_tie_b, existing=[])
    store.insert_entity_version(e_tie_a, existing=[])
    store.insert_entity_version(e1_v2, existing=[e1])

    r_list = client.get(f"/api/v3/participants/{ctx['p1_id']}/encounters", headers=t1_hdrs)
    assert r_list.status_code == 200
    items = r_list.json()
    expected = sorted([e1_v2, e2, e_tie_a, e_tie_b], key=lambda x: (x["created_at"], x["entity_id"]))
    assert items == expected
    # Confirm tie-break order: en_tiebreak0001 precedes en_tiebreak0002
    ids = [it["entity_id"] for it in items]
    assert ids.index("en_tiebreak0001") < ids.index("en_tiebreak0002")
    # Confirm only latest version (v2) of e1 appears
    e1_matches = [it for it in items if it["entity_id"] == e1["entity_id"]]
    assert len(e1_matches) == 1 and e1_matches[0]["version"] == 2


# --- Row 8: Authorization across all four routes -----------------------------------------


def test_authorization_matrix_all_four_s1a03_routes(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    t1_hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}
    t2_hdrs = {"Authorization": f"Bearer {ctx['t2_tok']}"}  # unlinked same org
    t3_hdrs = {"Authorization": f"Bearer {ctx['t3_tok']}"}  # other org
    p1_hdrs = {"Authorization": f"Bearer {ctx['p1_tok']}"}
    p2_hdrs = {"Authorization": f"Bearer {ctx['p2_tok']}"}

    fa1 = _create_assessment(client, ctx["t1_tok"], ctx["p1_id"], date_str="2026-11-20")
    fa2 = _create_assessment(client, ctx["t1_tok"], ctx["p1_id"], date_str="2026-11-24")

    en_body = _valid_encounter_payload(assessment_ref=fa1["entity_id"])
    ra_body = _valid_reassessment_payload(baseline_ref=fa1["entity_id"], current_ref=fa2["entity_id"])
    im_body = _valid_instrumental_payload()

    def call_all_four(pid: str, headers: dict | None = None):
        h = headers or {}
        return [
            client.post(f"/api/v3/participants/{pid}/encounters", headers=h, json=en_body),
            client.get(f"/api/v3/participants/{pid}/encounters", headers=h),
            client.post(f"/api/v3/participants/{pid}/reassessments", headers=h, json=ra_body),
            client.post(f"/api/v3/participants/{pid}/instrumental-measurements", headers=h, json=im_body),
        ]

    # 1. Anonymous -> 401 UNAUTHENTICATED
    for r in call_all_four(ctx["p1_id"]):
        _assert_error(r, 401, "UNAUTHENTICATED")

    # 2. Forged stored roles -> 403 ROLE_NOT_ALLOWED
    future = (datetime.now(timezone.utc) + timedelta(seconds=3600)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    for forged_role in ("caregiver", "supervisor", "admin"):
        raw = secrets.token_urlsafe(32)
        app.state.v3_store.db.execute(
            "INSERT INTO v3_tokens (token_hash, role, principal_id, org_id, expires_at, revoked, created_at) VALUES (?,?,?,?,?,0,?)",
            (sha256_token(raw), forged_role, ctx["t1_id"], ctx["org_a"], future, now),
        )
        app.state.v3_store.db.commit()
        for r in call_all_four(ctx["p1_id"], {"Authorization": f"Bearer {raw}"}):
            _assert_error(r, 403, "ROLE_NOT_ALLOWED")

    # 3. Participant (own, other, unknown) -> 403 FORBIDDEN on all 4 routes
    unknown_pid = new_id("p")
    for hdrs in (p1_hdrs, p2_hdrs):
        for pid in (ctx["p1_id"], ctx["p2_id"], unknown_pid):
            for r in call_all_four(pid, hdrs):
                _assert_error(r, 403, "FORBIDDEN")

    # 4. Unknown participant (therapist) -> 404 NOT_FOUND on all 4 routes
    for r in call_all_four(unknown_pid, t1_hdrs):
        _assert_error(r, 404, "NOT_FOUND")

    # 5. Unlinked same-org therapist (t2) & other-org therapist (t3) -> 403 SCOPE_VIOLATION on all 4 routes
    for other_hdrs in (t2_hdrs, t3_hdrs):
        for r in call_all_four(ctx["p1_id"], other_hdrs):
            _assert_error(r, 403, "SCOPE_VIOLATION")

    # 6. Revoked-link therapist -> 403 SCOPE_VIOLATION on all 4 routes
    assert client.post(f"/api/v3/care-links/{ctx['cl1_id']}:revoke", headers=t1_hdrs, json={}).status_code == 200
    for r in call_all_four(ctx["p1_id"], t1_hdrs):
        _assert_error(r, 403, "SCOPE_VIOLATION")


# --- Row 9: Schema validation per type; nothing stored on failure ------------------------


def test_schema_validation_rejects_invalid_payloads_and_stores_nothing(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    hdrs = {"Authorization": f"Bearer {ctx['t1_tok']}"}

    fa1 = _create_assessment(client, ctx["t1_tok"], ctx["p1_id"], date_str="2026-11-20")
    fa2 = _create_assessment(client, ctx["t1_tok"], ctx["p1_id"], date_str="2026-11-24")

    def mut(base_fn, fn):
        p = base_fn()
        fn(p)
        return p

    # Encounter invalid cases
    en_cases = [
        ("bad_date_pattern", mut(_valid_encounter_payload, lambda p: p.__setitem__("encounter_date", "23-11-2026")), "PATTERN"),
        ("duration_zero", mut(_valid_encounter_payload, lambda p: p.__setitem__("duration_min", 0)), "OUT_OF_RANGE"),
        ("duration_too_high", mut(_valid_encounter_payload, lambda p: p.__setitem__("duration_min", 601)), "OUT_OF_RANGE"),
        ("duration_bool", mut(_valid_encounter_payload, lambda p: p.__setitem__("duration_min", True)), "TYPE"),
        ("note_too_long", mut(_valid_encounter_payload, lambda p: p.__setitem__("therapist_note", "x" * 2001)), "LENGTH"),
        ("unknown_field_video_url", mut(_valid_encounter_payload, lambda p: p.__setitem__("video_url", "https://example.invalid")), "UNKNOWN_FIELD"),
        ("missing_modality", mut(_valid_encounter_payload, lambda p: p.pop("modality")), "MISSING_FIELD"),
        ("bad_assessment_ref_pattern", mut(_valid_encounter_payload, lambda p: p.__setitem__("assessment_ref", "bad-ref")), "PATTERN"),
        ("bad_prescription_ref_type", mut(_valid_encounter_payload, lambda p: p.__setitem__("prescription_ref", "rx_12345678")), "TYPE"),
    ]
    for _, payload, expected_code in en_cases:
        r = client.post(f"/api/v3/participants/{ctx['p1_id']}/encounters", headers=hdrs, json=payload)
        _assert_error(r, 400, expected_code)
    assert app.state.v3_store.list_latest_entities("encounter", ctx["p1_id"]) == []

    # Reassessment invalid cases
    def base_ra():
        return _valid_reassessment_payload(baseline_ref=fa1["entity_id"], current_ref=fa2["entity_id"])

    ra_cases = [
        ("empty_item_comparability", mut(base_ra, lambda p: p.__setitem__("item_comparability", [])), "LENGTH"),
        ("bad_item_key", mut(base_ra, lambda p: p["item_comparability"][0].__setitem__("item_key", "BAD KEY")), "PATTERN"),
        ("non_bool_comparable", mut(base_ra, lambda p: p["item_comparability"][0].__setitem__("comparable", "yes")), "TYPE"),
        ("bad_reason_enum", mut(base_ra, lambda p: p["item_comparability"][1].__setitem__("reason", "unknown_reason")), "ENUM"),
        ("missing_current_ref", mut(base_ra, lambda p: p.pop("current_assessment_ref")), "MISSING_FIELD"),
        ("unknown_field", mut(base_ra, lambda p: p.__setitem__("extra", 1)), "UNKNOWN_FIELD"),
        ("bad_ref_pattern", mut(base_ra, lambda p: p.__setitem__("baseline_assessment_ref", "not-a-fa-id")), "PATTERN"),
        ("null_baseline_ref", mut(base_ra, lambda p: p.__setitem__("baseline_assessment_ref", None)), "NULL_NOT_ALLOWED"),
    ]
    for _, payload, expected_code in ra_cases:
        r = client.post(f"/api/v3/participants/{ctx['p1_id']}/reassessments", headers=hdrs, json=payload)
        _assert_error(r, 400, expected_code)
    assert app.state.v3_store.list_latest_entities("reassessment", ctx["p1_id"]) == []

    # Instrumental measurement invalid cases
    im_cases = [
        ("wrong_method_camera", mut(_valid_instrumental_payload, lambda p: p.__setitem__("method", "camera")), "LITERAL"),
        ("wrong_method_auto", mut(_valid_instrumental_payload, lambda p: p.__setitem__("method", "automatic")), "LITERAL"),
        ("bad_measured_at", mut(_valid_instrumental_payload, lambda p: p.__setitem__("measured_at", "2026-11-25")), "PATTERN"),
        ("bad_body_segment", mut(_valid_instrumental_payload, lambda p: p.__setitem__("body_segment", "elbow")), "ENUM"),
        ("bad_side", mut(_valid_instrumental_payload, lambda p: p.__setitem__("side", "both")), "ENUM"),
        ("bad_movement_key", mut(_valid_instrumental_payload, lambda p: p.__setitem__("movement_key", "Wrist-Ext")), "PATTERN"),
        ("value_too_high", mut(_valid_instrumental_payload, lambda p: p.__setitem__("value", 10001)), "OUT_OF_RANGE"),
        ("value_too_low", mut(_valid_instrumental_payload, lambda p: p.__setitem__("value", -10001)), "OUT_OF_RANGE"),
        ("value_bool", mut(_valid_instrumental_payload, lambda p: p.__setitem__("value", True)), "TYPE"),
        ("bad_unit_pattern", mut(_valid_instrumental_payload, lambda p: p.__setitem__("unit", "BAD UNIT!")), "PATTERN"),
        ("empty_instrument_label", mut(_valid_instrumental_payload, lambda p: p.__setitem__("instrument_label", "")), "LENGTH"),
        ("long_instrument_label", mut(_valid_instrumental_payload, lambda p: p.__setitem__("instrument_label", "i" * 61)), "LENGTH"),
        ("bad_assistance", mut(_valid_instrumental_payload, lambda p: p.__setitem__("assistance", "minimal")), "ENUM"),
        ("long_note", mut(_valid_instrumental_payload, lambda p: p.__setitem__("therapist_note", "n" * 501)), "LENGTH"),
        ("missing_method", mut(_valid_instrumental_payload, lambda p: p.pop("method")), "MISSING_FIELD"),
        ("unknown_field", mut(_valid_instrumental_payload, lambda p: p.__setitem__("camera_fps", 30)), "UNKNOWN_FIELD"),
    ]
    for _, payload, expected_code in im_cases:
        r = client.post(f"/api/v3/participants/{ctx['p1_id']}/instrumental-measurements", headers=hdrs, json=payload)
        _assert_error(r, 400, expected_code)

    # Non-finite float rejected with 400 NON_FINITE
    raw_nan = json.dumps(_valid_instrumental_payload()).replace("42.5", "NaN")
    r_nan = client.post(
        f"/api/v3/participants/{ctx['p1_id']}/instrumental-measurements",
        headers={**hdrs, "Content-Type": "application/json"},
        content=raw_nan,
    )
    _assert_error(r_nan, 400, "NON_FINITE")

    assert app.state.v3_store.list_latest_entities("instrumental_measurement", ctx["p1_id"]) == []
