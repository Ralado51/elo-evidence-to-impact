from datetime import date

import pytest
from pydantic import ValidationError

from elo.contract import (
    Assistance,
    Environment,
    Note,
    Observation,
    SourceType,
    Span,
    VerdictResult,
    Verdict,
)

TEXT = "In the clinic, the child put on the t-shirt without physical assistance after verbal prompts."
NOTE = Note(id="n1", session_id="s1", version=1, original_text=TEXT, sanitized_text=TEXT)


def obs(**kw) -> Observation:
    base = dict(
        id="o1",
        note_id="n1",
        note_version=1,
        activity="dressing_upper",
        action="put on t-shirt",
        environment=Environment.CLINIC,
        assistance=Assistance.VERBAL_PROMPT,
        observed_on=date(2026, 11, 2),
        source_type=SourceType.DIRECT_OBSERVATION,
        observed_by="therapist-1",
        span_original=Span(start=0, end=len(TEXT)),
        quote=TEXT,
    )
    base.update(kw)
    return Observation(**base)


def test_span_must_be_ordered():
    with pytest.raises(ValidationError):
        Span(start=5, end=5)
    with pytest.raises(ValidationError):
        Span(start=7, end=3)


def test_direct_observation_requires_observer():
    with pytest.raises(ValidationError):
        obs(observed_by=None)


def test_report_requires_reporter():
    with pytest.raises(ValidationError):
        obs(source_type=SourceType.CAREGIVER_REPORT, observed_by=None, reported_by=None)
    ok = obs(source_type=SourceType.CAREGIVER_REPORT, observed_by=None, reported_by="mother")
    assert not ok.is_direct


def test_assistance_is_ordered_from_independent_to_total():
    ranks = [a.rank for a in Assistance]
    assert ranks == sorted(ranks)
    assert Assistance.INDEPENDENT.rank < Assistance.VERBAL_PROMPT.rank < Assistance.PHYSICAL_TOTAL.rank


def test_check_against_accepts_matching_quote():
    obs().check_against(NOTE)


def test_check_against_rejects_wrong_quote():
    bad = obs(quote="something the note never said")
    with pytest.raises(ValueError):
        bad.check_against(NOTE)


def test_check_against_rejects_other_version():
    with pytest.raises(ValueError):
        obs(note_version=2).check_against(NOTE)


def test_check_against_rejects_span_outside_text():
    far = obs(span_original=Span(start=0, end=len(TEXT) + 10))
    with pytest.raises(ValueError):
        far.check_against(NOTE)


def test_verdict_result_needs_both_languages():
    with pytest.raises(ValidationError):
        VerdictResult(
            claim_id="c1",
            verdict=Verdict.SUPPORTED,
            rule_id="r",
            constraints=[],
            rationale={"pt": "só em português"},
        )
