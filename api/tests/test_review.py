import sqlite3
from datetime import date

import pytest

from elo.contract import Assistance, Claim, Environment, Note, ReviewState, Verdict
from elo.extraction import ExtractionContext, extract_rules
from elo.packs import load_pack
from elo.privacy import PatientRegistry, PrivacyGate
from elo.review import ReviewError, ReviewService

TEXT = "Pedro vestiu a camiseta na clínica sem assistência física, após instruções verbais."


def service(path=":memory:"):
    reg = PatientRegistry()
    reg.add("patient", "Pedro Souza", "Paciente A")
    s = PrivacyGate(reg).process(TEXT)
    note = Note(id="n1", session_id="s1", original_text=TEXT, sanitized_text=s.text)
    obs = extract_rules(s, note, ExtractionContext(session_date=date(2026, 11, 5)), load_pack()).observations
    svc = ReviewService(path)
    svc.save_note(note)
    svc.save_observations("s1", obs)
    return svc


def claim(cid="c1", env=Environment.CLINIC, a=Assistance.VERBAL_PROMPT):
    return Claim(id=cid, session_id="s1", text="x", activity="dressing_upper", environment=env, assistance=a)


def test_approve_supported():
    svc = service()
    assert svc.propose(claim()).verdict is Verdict.SUPPORTED
    assert svc.approve("c1", "Raquel").review_state is ReviewState.APPROVED
    assert [c.id for c in svc.approved_claims("s1")] == ["c1"]


def test_cannot_approve_without_evidence():
    svc = service()
    assert svc.propose(claim(env=Environment.HOME)).verdict is Verdict.INSUFFICIENT_EVIDENCE
    with pytest.raises(ReviewError):
        svc.approve("c1", "Raquel")
    assert svc.approved_claims("s1") == []


def test_cannot_approve_contradicted():
    svc = service()
    svc.propose(claim(a=Assistance.INDEPENDENT))
    c, r = svc.get("c1")
    assert r.verdict is not Verdict.SUPPORTED
    with pytest.raises(ReviewError):
        svc.approve("c1", "Raquel")


def test_edit_reverifies_and_counts_when_supported():
    svc = service()
    svc.propose(claim(env=Environment.HOME))
    edited, res = svc.edit("c1", "Raquel", reason="only the clinic was observed", environment=Environment.CLINIC)
    assert res.verdict is Verdict.SUPPORTED and edited.review_state is ReviewState.EDITED
    assert edited.origin == "human" and len(svc.approved_claims("s1")) == 1


def test_edit_still_unsupported_stays_pending():
    svc = service()
    svc.propose(claim(env=Environment.HOME))
    edited, res = svc.edit("c1", "Raquel", environment=Environment.SCHOOL)
    assert edited.review_state is ReviewState.PENDING and svc.approved_claims("s1") == []


def test_reject_needs_reason_and_is_final():
    svc = service()
    svc.propose(claim())
    with pytest.raises(ReviewError):
        svc.reject("c1", "Raquel", " ")
    svc.reject("c1", "Raquel", "not what I observed")
    with pytest.raises(ReviewError):
        svc.approve("c1", "Raquel")
    assert svc.approved_claims("s1") == []


def test_actor_required_and_final_states():
    svc = service()
    svc.propose(claim())
    with pytest.raises(ReviewError):
        svc.approve("c1", " ")
    svc.approve("c1", "Raquel")
    with pytest.raises(ReviewError):
        svc.reject("c1", "Raquel", "changed my mind")


def test_edit_rejects_unknown_fields():
    svc = service()
    svc.propose(claim())
    with pytest.raises(ReviewError):
        svc.edit("c1", "Raquel", id="other")


def test_audit_records_everything_and_is_append_only():
    svc = service()
    svc.propose(claim())
    svc.approve("c1", "Raquel", "ok")
    log = svc.audit("c1")
    assert [e["action"] for e in log] == ["proposed", "approved"]
    assert log[1]["actor"] == "Raquel" and log[1]["verdict"] == "supported"
    with pytest.raises(sqlite3.DatabaseError):
        svc.db.execute("UPDATE audit SET actor='x'")
    with pytest.raises(sqlite3.DatabaseError):
        svc.db.execute("DELETE FROM audit")


def test_persists_across_reopen(tmp_path):
    p = str(tmp_path / "e.db")
    svc = service(p)
    svc.propose(claim())
    svc.approve("c1", "Raquel")
    again = ReviewService(p)
    assert again.get("c1")[0].review_state is ReviewState.APPROVED
    assert len(again.audit()) == 2 and again.get("c1")[1].rationale["pt"]
