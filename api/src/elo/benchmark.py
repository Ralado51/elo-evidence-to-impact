"""Benchmark engine: runs the full pipeline (gate -> extraction -> verifier) on synthetic cases.

Headline safety metrics (a wrong "supported" or "contradicted" is worse than an abstention):
* unsafe_supported: predicted `supported` but the truth is not `supported`.
* false_contradicted: predicted `contradicted` but the truth is not `contradicted`.
Abstentions (items the extractor declined) are counted and listed, never hidden.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

from .contract import Claim, Note, Observation, Span
from .extraction import (ExtractionContext, ExtractionError, LLMClient, extract_consensus, extract_rules,
                         extract_with_llm)
from .packs import load_pack
from .privacy import PatientRegistry, PrivacyBlocked, PrivacyGate
from .verifier import verify

CASES_PATH = Path(__file__).resolve().parents[2] / "benchmark" / "cases.json"
VERDICTS = ["supported", "contradicted", "insufficient_evidence", "needs_review"]


def load_cases(split: str | None = None) -> list[dict]:
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    return [c for c in cases if split in (None, "all", c["split"])]


def _key(o) -> tuple:
    return (o["note_id"], o["activity"], o["environment"], o["assistance"], o["source_type"])


def oracle_observations(case: dict) -> list[Observation]:
    """Observations exactly as labeled: lets us check the labels against the verifier alone."""
    texts = {n["id"]: n for n in case["notes"]}
    out = []
    for i, e in enumerate(case["expected_observations"]):
        n = texts[e["note_id"]]
        direct = e["source_type"] == "direct_observation"
        out.append(Observation(
            id=f"o{i}", note_id=n["id"], note_version=1, activity=e["activity"], action=e["activity"],
            environment=e["environment"], assistance=e["assistance"], observed_on=date.fromisoformat(n["date"]),
            source_type=e["source_type"], observed_by="therapist" if direct else None,
            reported_by=None if direct else "caregiver",
            span_original=Span(start=0, end=len(n["text"])), quote=n["text"]))
    return out


def run_case(case: dict, mode: str = "rules", client: LLMClient | None = None) -> dict:
    reg = PatientRegistry()
    reg.add("patient", "Davi Moreira", "Paciente A")
    gate, pack = PrivacyGate(reg), load_pack()
    observations: list[Observation] = []
    rejected = flags = blocked = failed = review = 0
    reasons: Counter = Counter()
    for n in case["notes"]:
        try:
            s = gate.process(n["text"])
        except PrivacyBlocked:
            blocked += 1
            continue
        note = Note(id=n["id"], session_id=case["id"], original_text=n["text"], sanitized_text=s.text)
        ctx = ExtractionContext(session_date=date.fromisoformat(n["date"]))
        try:
            if mode == "rules":
                r = extract_rules(s, note, ctx, pack)
            elif mode == "llm":
                r = extract_with_llm(client, s, note, ctx, pack)
            else:
                r = extract_consensus(client, s, note, ctx, pack)
        except ExtractionError:
            failed += 1
            continue
        observations += r.observations
        rejected += len(r.rejected)
        reasons.update(x.reason for x in r.rejected)
        review += len(r.review)
        flags += len(r.flags)
    c = case["claim"]
    claim = Claim(id=case["id"], session_id=case["id"], text="benchmark", activity=c["activity"],
                  environment=c["environment"], assistance=c["assistance"],
                  as_of=date.fromisoformat(c["as_of"]) if c["as_of"] else None)
    verdict = verify(claim, observations).verdict.value
    got = Counter(_key({"note_id": o.note_id, "activity": o.activity, "environment": o.environment.value,
                        "assistance": o.assistance.value, "source_type": o.source_type.value}) for o in observations)
    want = Counter(_key(o) for o in case["expected_observations"])
    tp = sum((got & want).values())
    field_errors: Counter = Counter()
    for g in (got - want):
        w = next((x for x in want if x[:2] == g[:2]), None)
        if w is None:
            field_errors["no_such_observation"] += 1
            continue
        for name, a, b in zip(("environment", "assistance", "source_type"), g[2:], w[2:]):
            if a != b:
                field_errors[name] += 1
    return {"id": case["id"], "category": case["category"], "difficulty": case["difficulty"], "split": case["split"], "round": case.get("round", 1),
            "expected": case["expected_verdict"], "predicted": verdict, "tp": tp,
            "fp": sum(got.values()) - tp, "fn": sum(want.values()) - tp,
            "abstentions": rejected, "reasons": dict(reasons), "field_errors": dict(field_errors), "review_items": review, "flags": flags, "blocked": blocked, "failed": failed}


def run_oracle(case: dict) -> str:
    c = case["claim"]
    claim = Claim(id=case["id"], session_id=case["id"], text="benchmark", activity=c["activity"],
                  environment=c["environment"], assistance=c["assistance"],
                  as_of=date.fromisoformat(c["as_of"]) if c["as_of"] else None)
    return verify(claim, oracle_observations(case)).verdict.value


def _ratio(a: int, b: int) -> float | None:
    return round(a / b, 3) if b else None


def summarize(rows: list[dict]) -> dict:
    n = len(rows)
    matrix: dict[str, dict[str, int]] = {e: {p: 0 for p in VERDICTS} for e in VERDICTS}
    for r in rows:
        matrix[r["expected"]][r["predicted"]] += 1
    tp, fp, fn = (sum(r[k] for r in rows) for k in ("tp", "fp", "fn"))
    unsafe = [r["id"] for r in rows if r["predicted"] == "supported" and r["expected"] != "supported"]
    false_c = [r["id"] for r in rows if r["predicted"] == "contradicted" and r["expected"] != "contradicted"]
    missed = [r["id"] for r in rows if r["expected"] == "supported" and r["predicted"] != "supported"]
    by_difficulty = {}
    for diff in ("easy", "hard"):
        sub = [r for r in rows if r["difficulty"] == diff]
        by_difficulty[diff] = {"cases": len(sub), "verdict_accuracy": _ratio(sum(r["expected"] == r["predicted"] for r in sub), len(sub))}
    by_round = {}
    for rd in sorted({r["round"] for r in rows}):
        sub = [r for r in rows if r["round"] == rd and r["difficulty"] == "hard"]
        by_round[f"round_{rd}_hard"] = {"cases": len(sub), "verdict_accuracy": _ratio(sum(r["expected"] == r["predicted"] for r in sub), len(sub)),
                                        "unsafe_supported": sum(r["predicted"] == "supported" and r["expected"] != "supported" for r in sub)}
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_cat[r["category"]].append(r)
    return {
        "cases": n,
        "verdict_accuracy": _ratio(sum(r["expected"] == r["predicted"] for r in rows), n),
        "unsafe_supported": unsafe, "false_contradicted": false_c, "missed_support": missed,
        "extraction": {"precision": _ratio(tp, tp + fp), "recall": _ratio(tp, tp + fn), "tp": tp, "fp": fp, "fn": fn},
        "abstentions": sum(r["abstentions"] for r in rows),
        "rejection_reasons": dict(sum((Counter(r["reasons"]) for r in rows), Counter())),
        "field_errors": dict(sum((Counter(r["field_errors"]) for r in rows), Counter())),
        "review_items": sum(r["review_items"] for r in rows), "flags": sum(r["flags"] for r in rows),
        "model_failures": sum(r["failed"] for r in rows),
        "by_difficulty": by_difficulty, "by_round": by_round,
        "by_category": {k: _ratio(sum(r["expected"] == r["predicted"] for r in v), len(v)) for k, v in sorted(by_cat.items())},
        "confusion_matrix": matrix,
    }
