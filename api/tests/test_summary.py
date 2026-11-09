from datetime import date

import pytest

from elo.contract import Assistance, Claim, Environment, ReviewState
from elo.packs import load_pack
from elo.summary import build_family_summary

PACK = load_pack()


def c(cid, env=Environment.CLINIC, a=Assistance.VERBAL_PROMPT, state=ReviewState.APPROVED, text="free text"):
    return Claim(id=cid, session_id="s", text=text, activity="dressing_upper", environment=env,
                 assistance=a, review_state=state)


def test_pt_and_en_lines():
    pt = build_family_summary([c("c1")], PACK, "pt", "Paciente A")
    en = build_family_summary([c("c1")], PACK, "en", "Paciente A")
    assert "Vestir a parte de cima na clínica: com lembretes falados." in pt.render()
    assert "Upper-body dressing at the clinic: with spoken reminders." in en.render()
    assert pt.source_claim_ids == ["c1"]


def test_gaps_name_what_was_not_registered():
    r = build_family_summary([c("c1")], PACK, "pt", "Paciente A").render()
    assert "ainda sem registro em casa" in r and "ainda sem registro na escola" in r
    assert "ainda sem registro na clínica" not in r


def test_only_approved_claims_accepted():
    for st in (ReviewState.PENDING, ReviewState.REJECTED):
        with pytest.raises(ValueError):
            build_family_summary([c("c1", state=st)], PACK, "pt", "X")
    build_family_summary([c("c1", state=ReviewState.EDITED)], PACK, "pt", "X")


def test_free_text_never_leaks():
    r = build_family_summary([c("c1", text="Pedro Souza will certainly improve")], PACK, "en", "Paciente A").render()
    assert "Pedro" not in r and "improve" not in r


def test_empty_summary_and_disclaimer():
    s = build_family_summary([], PACK, "en", "Paciente A")
    r = s.render()
    assert "no reviewed records" in r and "not a diagnosis" in r and not s.gaps


def test_dedupes_and_dates():
    cs = [c("c1"), c("c2"), c("c3", env=Environment.HOME, a=Assistance.INDEPENDENT)]
    s = build_family_summary(cs, PACK, "pt", "Paciente A")
    assert len(s.lines) == 2 and any("em casa: sem ajuda" in l.text for l in s.lines)
    d = Claim(id="c4", session_id="s", text="t", activity="feeding", environment=Environment.HOME,
              assistance=Assistance.INDEPENDENT, as_of=date(2026, 11, 5), review_state=ReviewState.APPROVED)
    assert "(2026-11-05)" in build_family_summary([d], PACK, "pt", "X").render()


def test_unsupported_locale():
    with pytest.raises(ValueError):
        build_family_summary([], PACK, "es", "X")
