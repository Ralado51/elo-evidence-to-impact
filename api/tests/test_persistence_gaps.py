from datetime import date

import pytest

from elo.attendance import adherence
from elo.contract import Assistance, Environment, Observation, SourceType, Span
from elo.gaps import evidence_map
from elo.packs import load_pack
from elo.privacy import PrivacyBlocked, PrivacyGate
from elo.registry_store import PersistentRegistry
from elo.review import ReviewError, ReviewService


def test_registry_persists_and_still_masks(tmp_path):
    p = str(tmp_path / "reg.db")
    r = PersistentRegistry(p)
    r.add("patient", "Davi Moreira", "Paciente A", ("Dadá",))
    r.allow("Raquel")
    again = PersistentRegistry(p)
    assert again.pseudonyms() == [{"pseudonym": "Paciente A", "role": "patient"}]
    assert "full_name" not in str(again.pseudonyms())
    s = PrivacyGate(again).process("Davi e Dadá vestiram a camiseta.")
    assert "Davi" not in s.text and "Dadá" not in s.text
    assert again.is_allowed("Raquel")
    with pytest.raises(ValueError):
        again.add("patient", "Outro", "Paciente A")
    with pytest.raises(PrivacyBlocked):
        PrivacyGate(again).process("Telefone (11) 98888-7777.")


def test_cases_and_attendance_are_audited(tmp_path):
    svc = ReviewService(str(tmp_path / "c.db"))
    svc.create_case("c1", "Paciente A")
    assert svc.list_cases()[0]["label"] == "Paciente A"
    with pytest.raises(ReviewError):
        svc.set_attendance("c1", "2026-09-01", "maybe", "Raquel")
    with pytest.raises(ReviewError):
        svc.set_attendance("c1", "2026-09-01", "attended", " ")
    with pytest.raises(ReviewError):
        svc.set_attendance("nope", "2026-09-01", "attended", "Raquel")
    svc.set_attendance("c1", "2026-09-01", "attended", "Raquel")
    assert svc.attendance("c1") == [{"day": "2026-09-01", "status": "attended"}]
    assert svc.audit("c1")[-1]["action"] == "attendance_set"


def test_adherence_rule_is_explicit():
    recs = [{"status": s} for s in ["attended"] * 5 + ["absent_justified", "not_held"]]
    a = adherence(recs)
    assert (a["offered"], a["rate"], a["not_held"]) == (6, 0.833, 1) and "excluded" in a["rule"]
    assert adherence([])["rate"] is None


def _o(i, act, env, src=SourceType.DIRECT_OBSERVATION, day=3, month=9):
    direct = src is SourceType.DIRECT_OBSERVATION
    return Observation(id=f"o{i}", note_id="n", note_version=1, activity=act, action="x", environment=env,
                       assistance=Assistance.VERBAL_PROMPT, observed_on=date(2026, month, day), source_type=src,
                       observed_by="t" if direct else None, reported_by=None if direct else "m",
                       span_original=Span(start=0, end=2), quote="q")


def test_evidence_map_shows_direct_report_only_and_none():
    pack = load_pack()
    rows = evidence_map([_o(1, "feeding", Environment.CLINIC), _o(2, "feeding", Environment.HOME, SourceType.CAREGIVER_REPORT),
                         _o(3, "feeding", Environment.CLINIC, month=10)], pack)
    cell = {(r["activity"], r["environment"]): r for r in rows}
    assert len(rows) == len(pack.activities) * 3
    assert cell[("feeding", "clinic")]["status"] == "direct" and cell[("feeding", "clinic")]["periods"] == {
        "2026-09": {"direct": 1, "report": 0}, "2026-10": {"direct": 1, "report": 0}}
    assert cell[("feeding", "home")]["status"] == "report_only" and cell[("feeding", "home")]["last_direct"] is None
    assert cell[("feeding", "school")]["status"] == "none"
    assert evidence_map([_o(1, "feeding", Environment.CLINIC, month=10)], pack, as_of=date(2026, 9, 30))[0]["status"] == "none"
