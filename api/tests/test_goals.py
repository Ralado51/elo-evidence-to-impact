from datetime import date

import pytest

from elo.contract import Assistance, Environment, Observation, SourceType, Span, Verdict
from elo.goals import Goal, check_goal, render_check
from elo.packs import load_pack
from elo.review import ReviewError, ReviewService

PACK = load_pack()
D = date(2026, 11, 1)


def ob(i, day, env=Environment.CLINIC, a=Assistance.VERBAL_PROMPT, src=SourceType.DIRECT_OBSERVATION, act="dressing_upper"):
    direct = src is SourceType.DIRECT_OBSERVATION
    return Observation(id=f"o{i}", note_id="n", note_version=1, activity=act, action="x", environment=env,
                       assistance=a, observed_on=date(2026, 11, day), source_type=src,
                       observed_by="t" if direct else None, reported_by=None if direct else "mother",
                       span_original=Span(start=0, end=5), quote="orig", quote_sanitized=f"quote {i}")


def goal(env=Environment.CLINIC, a=Assistance.VERBAL_PROMPT):
    return Goal(id="g1", session_id="s", activity="dressing_upper", environment=env, assistance=a,
                measure="direct observation in session", start_date=D, review_date=date(2026, 11, 20))


def test_supported_when_direct_evidence_at_target():
    c = check_goal(goal(), [ob(1, 3)], date(2026, 11, 10), PACK)
    assert c.verdict is Verdict.SUPPORTED and c.latest_direct.observation_id == "o1"
    assert Environment.HOME in c.environments_without_evidence and not c.review_due


def test_other_setting_is_a_gap_not_attainment():
    c = check_goal(goal(env=Environment.HOME), [ob(1, 3)], date(2026, 11, 10), PACK)
    assert c.verdict is Verdict.INSUFFICIENT_EVIDENCE and c.latest_direct is None and c.no_recent_direct


def test_report_only_needs_review_and_is_flagged():
    c = check_goal(goal(env=Environment.HOME), [ob(1, 3, Environment.HOME, src=SourceType.CAREGIVER_REPORT)], date(2026, 11, 10), PACK)
    assert c.verdict is Verdict.NEEDS_REVIEW and c.report_only_environments == [Environment.HOME]


def test_more_help_than_target_is_not_attainment_and_less_help_goes_to_the_therapist():
    more = check_goal(goal(), [ob(1, 3, a=Assistance.PHYSICAL_PARTIAL)], date(2026, 11, 10), PACK)
    assert more.verdict is Verdict.INSUFFICIENT_EVIDENCE
    less = check_goal(goal(), [ob(1, 3, a=Assistance.INDEPENDENT)], date(2026, 11, 10), PACK)
    assert less.verdict is Verdict.NEEDS_REVIEW


def test_future_observations_are_ignored_and_staleness_and_due_date():
    c = check_goal(goal(), [ob(1, 3), ob(2, 25)], date(2026, 11, 26), PACK)
    assert [p.observation_id for p in c.evidence] == ["o1", "o2"] and c.review_due
    c2 = check_goal(goal(), [ob(1, 3), ob(2, 25)], date(2026, 11, 10), PACK)
    assert [p.observation_id for p in c2.evidence] == ["o1"] and c2.days_since_direct == 7 and not c2.no_recent_direct
    assert check_goal(goal(), [ob(1, 3)], date(2026, 11, 30), PACK).no_recent_direct


def test_render_is_bilingual_and_never_judges_progress():
    c = check_goal(goal(), [ob(1, 3)], date(2026, 11, 22), PACK)
    for loc in ("pt", "en"):
        text = render_check(goal(), c, PACK, loc).lower()
        assert "terapeuta" in text or "therapist" in text
        for banned in ("progress", "progresso", "diagn", "melhora", "improv", "recomend", "recommend"):
            assert banned not in text


def test_goal_assessment_is_human_validated_and_audited(tmp_path):
    svc = ReviewService(str(tmp_path / "g.db"))
    svc.save_goal(goal())
    assert svc.get_goal("g1").assistance is Assistance.VERBAL_PROMPT
    with pytest.raises(ReviewError):
        svc.record_goal_assessment("g1", "Raquel", 3, "x", "supported")
    with pytest.raises(ReviewError):
        svc.record_goal_assessment("g1", " ", 0, "x", "supported")
    with pytest.raises(ReviewError):
        svc.record_goal_assessment("g1", "Raquel", 0, " ", "supported")
    svc.record_goal_assessment("g1", "Raquel", 1, "observed twice in session", "supported")
    log = svc.audit("g1")
    assert log[-1]["action"] == "goal_assessed" and log[-1]["actor"] == "Raquel" and "1" in log[-1]["after"]
