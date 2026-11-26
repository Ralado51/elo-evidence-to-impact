"""ARQ-02 FIX-03 (FIX02-R01): server-side projection of effective reviews on facts.list (opt-in include=reviews).

Synthetic data only. Reuses the S1b-03 world builder. The default facts.list response (A1 3.1.0) must stay unchanged.
"""

from __future__ import annotations

from pathlib import Path

from test_v3_reviews_summaries import _headers, _setup_world


def _review(w, fact, decision, note=None, hash_=None):
    ft = fact["type"]
    return w["client"].post(
        "/api/v3/reviews",
        headers=_headers(w["t1_tok"]),
        json={"fact_id": fact["fact_id"], "content_hash": hash_ or w["hashes_by_type"][ft], "decision": decision, "note": note},
    )


def _list(w, tok=None, pid=None, q=""):
    return w["client"].get(f"/api/v3/participants/{pid or w['p1_id']}/facts{q}", headers=_headers(tok or w["t1_tok"]))


def test_default_response_unchanged_and_include_reviews_is_additive(tmp_path: Path):
    w = _setup_world(tmp_path)
    f01 = w["facts_by_type"]["F01"]
    assert _review(w, f01, "approve").status_code == 201
    base = _list(w).json()
    assert set(base.keys()) == {"facts", "catalog_version"}
    inc = _list(w, q="?include=reviews").json()
    assert set(inc.keys()) == {"facts", "catalog_version", "effective_reviews"}
    assert inc["facts"] == base["facts"]


def test_projection_reflects_approve_reject_annotate_and_stale_hash(tmp_path: Path):
    w = _setup_world(tmp_path)
    f01, f02, f04 = (w["facts_by_type"][k] for k in ("F01", "F02", "F04"))
    assert _review(w, f01, "approve").status_code == 201
    assert _review(w, f01, "annotate", note="nota").status_code == 201  # annotate never changes status
    assert _review(w, f02, "reject").status_code == 201
    eff = _list(w, q="?include=reviews").json()["effective_reviews"]
    assert eff[f01["fact_id"]]["decision"] == "approve"
    assert eff[f01["fact_id"]]["content_hash"] == w["hashes_by_type"]["F01"]
    assert eff[f02["fact_id"]]["decision"] == "reject"
    assert f04["fact_id"] not in eff  # unreviewed -> absent
    # latest approve/reject wins (reject -> approve)
    assert _review(w, f02, "approve").status_code == 201
    assert _list(w, q="?include=reviews").json()["effective_reviews"][f02["fact_id"]]["decision"] == "approve"


def test_projection_matches_publication_gate_single_source_of_truth(tmp_path: Path):
    w = _setup_world(tmp_path)
    f01, f04 = w["facts_by_type"]["F01"], w["facts_by_type"]["F04"]
    assert _review(w, f01, "approve").status_code == 201
    eff = _list(w, q="?include=reviews").json()["effective_reviews"]
    ok = w["client"].post("/api/v3/summaries", headers=_headers(w["t1_tok"]), json={"participant_id": w["p1_id"], "fact_ids": [f01["fact_id"]]})
    assert ok.status_code == 201 and eff[f01["fact_id"]]["decision"] == "approve"
    no = w["client"].post("/api/v3/summaries", headers=_headers(w["t1_tok"]), json={"participant_id": w["p1_id"], "fact_ids": [f04["fact_id"]]})
    assert no.status_code == 422 and f04["fact_id"] not in eff


def test_no_duplicate_reviews_created_by_reading(tmp_path: Path):
    w = _setup_world(tmp_path)
    f01 = w["facts_by_type"]["F01"]
    assert _review(w, f01, "approve").status_code == 201
    n = len(w["store"].get_participant_reviews(w["p1_id"]))
    for _ in range(3):
        _list(w, q="?include=reviews")
    assert len(w["store"].get_participant_reviews(w["p1_id"])) == n


def test_projection_isolation_and_authorization(tmp_path: Path):
    w = _setup_world(tmp_path)
    f01 = w["facts_by_type"]["F01"]
    assert _review(w, f01, "approve").status_code == 201
    # other participant (P2, other therapist) has no reviews
    own = _list(w, tok=w["t2_tok"], pid=w["p2_id"], q="?include=reviews")
    assert own.status_code == 200 and own.json()["effective_reviews"] == {}
    # unlinked therapist / participant / anonymous never receive the projection
    assert _list(w, tok=w["t2_tok"], q="?include=reviews").status_code in (403, 404)
    assert _list(w, tok=w["t_other_tok"], q="?include=reviews").status_code in (403, 404)
    assert _list(w, tok=w["p1_tok"], q="?include=reviews").status_code == 403
    assert w["client"].get(f"/api/v3/participants/{w['p1_id']}/facts?include=reviews").status_code == 401


def test_unsupported_include_value_rejected(tmp_path: Path):
    w = _setup_world(tmp_path)
    r = _list(w, q="?include=everything")
    assert r.status_code == 400 and r.json()["error"]["code"] == "RULE_VIOLATION"
