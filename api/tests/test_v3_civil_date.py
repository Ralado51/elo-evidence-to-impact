"""ARQ-01 / CMP-04: civil-date (YYYY-MM-DD) validation has one owner (``elo.v3.civil_date``).

Covers D03/FIX-01: an impossible calendar date (e.g. 2026-02-30) must be rejected by the backend on every
write surface, never normalized, and must persist nothing. Vectors are shared with the JS front
(``web/tests/fixtures/civil_date_vectors.json``). All data is synthetic.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from test_v3_clinical import (  # reused fixtures (no duplicated setup)
    _make_seeded_app,
    _valid_fa_payload,
)

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "web" / "tests" / "fixtures" / "civil_date_vectors.json").read_text("utf-8"))


def _post(client, ctx, path, body):
    return client.post(f"/api/v3/participants/{ctx['p1_id']}/{path}", headers={"Authorization": f"Bearer {ctx['t1_tok']}"}, json=body)


def _encounter(date_str: str) -> dict:
    return {"encounter_date": date_str, "modality": "in_person", "duration_min": 30, "prescription_ref": None, "assessment_ref": None, "therapist_note": None}


IMPOSSIBLE = ["2026-02-30", "2026-02-29", "1900-02-29", "2026-04-31", "2026-00-10", "2026-13-10", "2026-01-00", "2026-01-32", "0000-01-01"]


# ---- Backend behaviour through the real API (reproduces D03 on the pre-fix baseline) ----------------------------
@pytest.mark.parametrize("bad", IMPOSSIBLE)
def test_assessment_rejects_impossible_calendar_dates_and_persists_nothing(monkeypatch, bad):
    app, client, ctx = _make_seeded_app(monkeypatch)
    r = _post(client, ctx, "assessments", _valid_fa_payload(date_str=bad))
    assert r.status_code == 400, f"{bad}: expected 400, got {r.status_code} {r.text[:200]}"
    assert r.json()["error"]["code"] in ("RULE_VIOLATION", "PATTERN")
    assert "assessment_date" in r.json()["error"]["message"]
    assert app.state.v3_store.list_latest_entities("functional_assessment", ctx["p1_id"]) == []


@pytest.mark.parametrize("bad", ["2026-02-30", "2026-04-31"])
def test_encounter_rejects_impossible_calendar_dates(monkeypatch, bad):
    app, client, ctx = _make_seeded_app(monkeypatch)
    r = _post(client, ctx, "encounters", _encounter(bad))
    assert r.status_code == 400 and "encounter_date" in r.json()["error"]["message"]
    assert app.state.v3_store.list_latest_entities("encounter", ctx["p1_id"]) == []


@pytest.mark.parametrize("ok", ["2024-02-29", "2000-02-29", "2026-02-28", "2026-12-31"])
def test_assessment_accepts_real_dates_including_leap_days_unchanged(monkeypatch, ok):
    _, client, ctx = _make_seeded_app(monkeypatch)
    r = _post(client, ctx, "assessments", _valid_fa_payload(date_str=ok))
    assert r.status_code == 201, r.text
    assert r.json()["payload"]["assessment_date"] == ok, "the stored date must be exactly what was sent"


def test_revision_cannot_introduce_an_impossible_date(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    first = _post(client, ctx, "assessments", _valid_fa_payload(date_str="2026-02-28"))
    assert first.status_code == 201
    eid = first.json()["entity_id"]
    r = client.post(f"/api/v3/assessments/{eid}/versions", headers={"Authorization": f"Bearer {ctx['t1_tok']}"}, json=_valid_fa_payload(date_str="2026-02-30"))
    assert r.status_code == 400
    latest = app.state.v3_store.list_latest_entities("functional_assessment", ctx["p1_id"])
    assert len(latest) == 1 and latest[0]["version"] == 1 and latest[0]["payload"]["assessment_date"] == "2026-02-28"


def test_schema_pattern_failures_keep_their_existing_code(monkeypatch):
    _, client, ctx = _make_seeded_app(monkeypatch)
    r = _post(client, ctx, "assessments", _valid_fa_payload(date_str="23-11-2026"))
    assert r.status_code == 400 and r.json()["error"]["code"] == "PATTERN"


# ---- Shared module (fails with ImportError on the pre-fix baseline) --------------------------------------------
def test_parse_civil_date_vectors():
    from elo.v3.civil_date import is_civil_date, parse_civil_date

    for v in VECTORS["valid"]:
        assert is_civil_date(v), v
        assert parse_civil_date(v).isoformat() == v, f"{v} must round-trip exactly"
    for v in VECTORS["invalid"] + VECTORS["non_string"]:
        assert not is_civil_date(v), repr(v)
        assert parse_civil_date(v) is None, repr(v)


def test_range_vectors():
    from elo.v3.civil_date import is_range_inverted

    for a, b in VECTORS["ranges"]["ok"]:
        assert not is_range_inverted(a, b), (a, b)
    for a, b in VECTORS["ranges"]["inverted"]:
        assert is_range_inverted(a, b), (a, b)
    assert not is_range_inverted("2026-02-30", "2026-01-01"), "an invalid bound is reported as invalid, not as an inverted range"


def test_entity_check_is_derived_from_the_contract_schema_not_a_hardcoded_field_list():
    from elo.v3.civil_date import check_entity_civil_dates
    from elo.v3.entities import load_entity_schema

    for etype, field in (("functional_assessment", "assessment_date"), ("encounter", "encounter_date")):
        schema = load_entity_schema(etype)
        bad = check_entity_civil_dates(schema, {"payload": {field: "2026-02-30"}})
        assert [(i.path, i.reason) for i in bad] == [(f"payload.{field}", "invalid_calendar_date")]
        assert check_entity_civil_dates(schema, {"payload": {field: "2024-02-29"}}) == []
    care = load_entity_schema("care_link")
    inv = check_entity_civil_dates(care, {"payload": {"valid_from": "2026-05-02", "valid_to": "2026-05-01"}})
    assert [(i.path, i.reason) for i in inv] == [("payload.valid_to", "range_inverted")]
    assert check_entity_civil_dates(care, {"payload": {"valid_from": "2026-05-01", "valid_to": None}}) == []
    # instants are a different type: they are never civil-date fields
    assert check_entity_civil_dates(load_entity_schema("functional_assessment"), {"created_at": "2026-02-30T00:00:00.000Z", "payload": {}}) == []


def test_no_module_keeps_a_private_civil_date_parser():
    """Guard against concurrent rules: only civil_date.py may combine the date regex with date.fromisoformat."""
    root = Path(__file__).resolve().parents[1] / "src" / "elo" / "v3"
    offenders = []
    for p in sorted(root.glob("*.py")):
        if p.name in ("civil_date.py", "authz.py"):  # authz reads server-written care_link dates (trusted)
            continue
        text = p.read_text("utf-8")
        if "fromisoformat(" in text and "[0-9]{4}-[0-9]{2}-[0-9]{2}" in text:
            offenders.append(p.name)
    assert offenders == [], f"private civil-date parsers found (use elo.v3.civil_date): {offenders}"
