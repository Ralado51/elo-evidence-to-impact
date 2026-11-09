"""Critical cases for the Context-Aware Evidence Verifier (synthetic data only)."""

from datetime import date

from elo.contract import (
    Assistance,
    Claim,
    Environment,
    Observation,
    Relation,
    SourceType,
    Span,
    Verdict,
)
from elo.verifier import verify

ACT = "dressing_upper"


def o(
    oid="o1",
    env=Environment.CLINIC,
    assist=Assistance.VERBAL_PROMPT,
    day=date(2026, 11, 2),
    source=SourceType.DIRECT_OBSERVATION,
    activity=ACT,
) -> Observation:
    direct = source is SourceType.DIRECT_OBSERVATION
    return Observation(
        id=oid,
        note_id="n-" + oid,
        note_version=1,
        activity=activity,
        action="put on t-shirt",
        environment=env,
        assistance=assist,
        observed_on=day,
        source_type=source,
        observed_by="therapist-1" if direct else None,
        reported_by=None if direct else "mother",
        span_original=Span(start=0, end=10),
        quote="synthetic!!",
    )


def claim(env=Environment.HOME, assist=Assistance.INDEPENDENT, as_of=None, activity=ACT) -> Claim:
    return Claim(
        id="c1",
        session_id="s1",
        text="synthetic claim",
        activity=activity,
        environment=env,
        assistance=assist,
        as_of=as_of,
    )


def constraint(result, name):
    return next(c for c in result.constraints if c.name == name)


# --- the headline case ---------------------------------------------------------------


def test_clinic_with_verbal_prompts_does_not_support_independence_at_home():
    r = verify(claim(Environment.HOME, Assistance.INDEPENDENT), [o(env=Environment.CLINIC)])
    assert r.verdict is Verdict.INSUFFICIENT_EVIDENCE
    assert r.rule_id == "environment_not_observed"
    assert constraint(r, "activity").met is True
    assert constraint(r, "environment").met is False
    assert "clínica" in r.rationale["pt"] and "clinic" in r.rationale["en"]


def test_no_observation_of_the_activity_is_insufficient_not_contradicted():
    r = verify(claim(), [o(activity="feeding")])
    assert r.verdict is Verdict.INSUFFICIENT_EVIDENCE
    assert r.rule_id == "activity_not_observed"


def test_empty_evidence_is_insufficient():
    assert verify(claim(), []).verdict is Verdict.INSUFFICIENT_EVIDENCE


# --- supported -----------------------------------------------------------------------


def test_direct_observation_in_the_claimed_setting_and_level_supports():
    ev = o(env=Environment.HOME, assist=Assistance.INDEPENDENT)
    r = verify(claim(), [ev])
    assert r.verdict is Verdict.SUPPORTED
    assert [(l.observation_id, l.relation) for l in r.links] == [("o1", Relation.SUPPORTS)]
    assert all(c.met for c in r.constraints if c.name in {"activity", "environment", "assistance", "source"})


def test_support_requires_the_same_activity():
    r = verify(claim(), [o(env=Environment.HOME, assist=Assistance.INDEPENDENT, activity="feeding")])
    assert r.verdict is Verdict.INSUFFICIENT_EVIDENCE


# --- assistance level ----------------------------------------------------------------


def test_more_assisted_observation_does_not_support_independence():
    r = verify(claim(), [o(env=Environment.HOME, assist=Assistance.VERBAL_PROMPT)])
    assert r.verdict is Verdict.INSUFFICIENT_EVIDENCE
    assert r.rule_id == "assistance_not_met"
    assert constraint(r, "assistance").met is False


def test_less_assisted_observation_than_claimed_goes_to_review():
    r = verify(
        claim(assist=Assistance.PHYSICAL_PARTIAL),
        [o(env=Environment.HOME, assist=Assistance.INDEPENDENT)],
    )
    assert r.verdict is Verdict.NEEDS_REVIEW
    assert r.rule_id == "assistance_level_differs"


# --- time: change over time is not contradiction -------------------------------------


def test_progress_across_sessions_is_not_a_contradiction():
    s1 = o("o1", Environment.HOME, Assistance.PHYSICAL_PARTIAL, date(2026, 10, 5))
    s5 = o("o5", Environment.HOME, Assistance.VERBAL_PROMPT, date(2026, 11, 2))
    # a statement about the first session is still supported by the first session
    r1 = verify(claim(Environment.HOME, Assistance.PHYSICAL_PARTIAL, as_of=date(2026, 10, 5)), [s1, s5])
    assert r1.verdict is Verdict.SUPPORTED
    # a later statement with the old level is not "contradicted": it goes to review
    r2 = verify(claim(Environment.HOME, Assistance.PHYSICAL_PARTIAL, as_of=date(2026, 11, 20)), [s1, s5])
    assert r2.verdict is Verdict.NEEDS_REVIEW
    assert r2.verdict is not Verdict.CONTRADICTED


def test_latest_observation_is_the_one_that_counts_without_a_stated_day():
    s1 = o("o1", Environment.HOME, Assistance.PHYSICAL_PARTIAL, date(2026, 10, 5))
    s5 = o("o5", Environment.HOME, Assistance.VERBAL_PROMPT, date(2026, 11, 2))
    r = verify(claim(Environment.HOME, Assistance.VERBAL_PROMPT), [s1, s5])
    assert r.verdict is Verdict.SUPPORTED
    assert [l.observation_id for l in r.links] == ["o5"]


def test_observations_after_the_stated_day_are_ignored():
    later = o("o9", Environment.HOME, Assistance.INDEPENDENT, date(2026, 12, 1))
    r = verify(claim(as_of=date(2026, 11, 2)), [later])
    assert r.verdict is Verdict.INSUFFICIENT_EVIDENCE
    assert r.rule_id == "activity_not_observed"


def test_same_event_with_different_level_is_contradicted():
    ev = o("o5", Environment.HOME, Assistance.VERBAL_PROMPT, date(2026, 11, 2))
    r = verify(claim(Environment.HOME, Assistance.INDEPENDENT, as_of=date(2026, 11, 2)), [ev])
    assert r.verdict is Verdict.CONTRADICTED
    assert r.rule_id == "same_event_conflict"
    assert [(l.observation_id, l.relation) for l in r.links] == [("o5", Relation.CONTRADICTS)]


# --- who observed it -----------------------------------------------------------------


def test_caregiver_report_alone_goes_to_review_not_supported():
    rep = o(env=Environment.HOME, assist=Assistance.INDEPENDENT, source=SourceType.CAREGIVER_REPORT)
    r = verify(claim(), [rep])
    assert r.verdict is Verdict.NEEDS_REVIEW
    assert r.rule_id == "reported_only"
    assert constraint(r, "source").met is False


def test_report_and_direct_observation_that_disagree_go_to_review():
    day = date(2026, 11, 2)
    direct = o("d1", Environment.HOME, Assistance.VERBAL_PROMPT, day)
    rep = o("r1", Environment.HOME, Assistance.INDEPENDENT, day, SourceType.CAREGIVER_REPORT)
    r = verify(claim(), [direct, rep])
    assert r.verdict is Verdict.NEEDS_REVIEW
    assert r.rule_id == "source_divergence"


def test_direct_observation_with_agreeing_report_is_supported():
    day = date(2026, 11, 2)
    direct = o("d1", Environment.HOME, Assistance.INDEPENDENT, day)
    rep = o("r1", Environment.HOME, Assistance.INDEPENDENT, day, SourceType.CAREGIVER_REPORT)
    assert verify(claim(), [direct, rep]).verdict is Verdict.SUPPORTED


def test_conflicting_direct_observations_go_to_review():
    day = date(2026, 11, 2)
    a = o("a", Environment.HOME, Assistance.INDEPENDENT, day)
    b = o("b", Environment.HOME, Assistance.VERBAL_PROMPT, day)
    r = verify(claim(), [a, b])
    assert r.verdict is Verdict.NEEDS_REVIEW
    assert r.rule_id == "conflicting_observations"


# --- invariants ----------------------------------------------------------------------


def test_every_verdict_has_a_rationale_in_both_languages_and_a_rule():
    cases = [
        (claim(), []),
        (claim(), [o(env=Environment.CLINIC)]),
        (claim(), [o(env=Environment.HOME, assist=Assistance.INDEPENDENT)]),
        (claim(), [o(env=Environment.HOME, assist=Assistance.VERBAL_PROMPT)]),
        (claim(), [o(env=Environment.HOME, assist=Assistance.INDEPENDENT, source=SourceType.CAREGIVER_REPORT)]),
    ]
    for cl, ev in cases:
        r = verify(cl, ev)
        assert r.rule_id and r.rationale["pt"] and r.rationale["en"]
        assert r.claim_id == "c1"


def test_verifier_does_not_change_its_inputs():
    ev = [o(env=Environment.HOME, assist=Assistance.INDEPENDENT)]
    cl = claim()
    before = (cl.model_dump(), [e.model_dump() for e in ev])
    verify(cl, ev)
    assert (cl.model_dump(), [e.model_dump() for e in ev]) == before
