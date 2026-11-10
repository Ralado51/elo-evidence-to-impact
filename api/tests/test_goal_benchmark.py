from elo.benchmark import load_goal_cases, run_goal_case, summarize_goals


def test_goal_cases_are_well_formed():
    cases = load_goal_cases()
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids)) >= 15
    assert {c["expected"]["verdict"] for c in cases} >= {"supported", "needs_review", "insufficient_evidence"}
    assert all("pending clinical review" in c["label_status"] for c in cases)


def test_goal_logic_matches_hand_labeled_expectations():
    s = summarize_goals([run_goal_case(c) for c in load_goal_cases()])
    assert s["failures"] == [], s["failures"]
    assert s["unsafe_supported"] == []
