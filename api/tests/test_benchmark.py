from elo.benchmark import VERDICTS, load_cases, run_case, run_oracle, summarize


def test_dataset_integrity():
    cases = load_cases()
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids)) >= 50
    assert {c["split"] for c in cases} == {"dev", "eval"}
    assert {c["locale"] for c in cases} == {"pt", "en"}
    assert {c["expected_verdict"] for c in cases} == set(VERDICTS)
    assert any(c["difficulty"] == "hard" for c in cases if c["split"] == "dev")
    assert any(c["difficulty"] == "hard" for c in cases if c["split"] == "eval")
    assert all("pending clinical review" in c["label_status"] for c in cases)


def test_labels_agree_with_verifier_when_extraction_is_perfect():
    bad = [c["id"] for c in load_cases() if run_oracle(c) != c["expected_verdict"]]
    assert bad == []


def test_rules_baseline_is_sane_on_easy_cases_and_honest_about_hard_ones():
    rows = [run_case(c, "rules") for c in load_cases()]
    s = summarize(rows)
    assert s["by_difficulty"]["easy"]["verdict_accuracy"] >= 0.95
    assert s["unsafe_supported"] or s["by_difficulty"]["hard"]["verdict_accuracy"] == 1.0
    assert set(s["confusion_matrix"]) == set(VERDICTS)
