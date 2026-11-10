"""Generate benchmark/goal_cases.json: goal checks over time (synthetic; labels by construction).

Each case: a goal, dated notes, a check date, and what the check must show. The notes use plain
phrasing the deterministic extractor reads, so this measures the goal logic (latest direct
evidence, gaps, report-only, staleness, due date, future notes), not extraction.
"""

import json
from datetime import date, timedelta
from pathlib import Path

D0 = date(2026, 9, 1)
NAME = "Davi"
ENV_PT = {"clinic": "na clínica", "home": "em casa", "school": "na escola"}
LVL_PT = {"independent": "sozinho", "verbal_prompt": "com instruções verbais", "gesture_prompt": "com dicas gestuais",
          "physical_partial": "com assistência física parcial"}
ENVS = ["clinic", "home", "school"]
cases = []


def dt(n):
    return (D0 + timedelta(days=n)).isoformat()


def direct(env, lvl):
    return f"{NAME} vestiu a camiseta {ENV_PT[env]} {LVL_PT[lvl]}."


def report(env, lvl):
    return f"A mãe relatou que {ENV_PT[env]} {NAME} vestiu a camiseta {LVL_PT[lvl]}."


def add(cid, goal_env, goal_lvl, notes, as_of, review, verdict, *, recent=None, due=False, gaps=None, report_only=None,
        latest=None, activity="dressing_upper", note_activity_text=None):
    seen = {n[3] for n in notes if n[3]}
    cases.append({
        "id": cid,
        "goal": {"activity": activity, "environment": goal_env, "assistance": goal_lvl, "measure": "direct observation",
                 "start_date": dt(0), "review_date": review},
        "notes": [{"id": f"{cid}-n{i+1}", "date": d, "text": t} for i, (d, t, _, _) in enumerate(notes)],
        "as_of": as_of,
        "expected": {"verdict": verdict, "no_recent_direct": recent, "review_due": due,
                     "environments_without_evidence": gaps, "report_only_environments": report_only or [],
                     "latest_direct_date": latest},
        "label_status": "constructed; pending clinical review",
    })


# notes are (date, text, _, env_seen_for_goal_activity)
def n(day, text, env=None):
    return (dt(day), text, None, env)


add("g01", "clinic", "verbal_prompt", [n(7, direct("clinic", "verbal_prompt"), "clinic")], dt(14), dt(29), "supported",
    recent=False, gaps=["home", "school"], latest=dt(7))
add("g02", "clinic", "verbal_prompt", [n(0, direct("clinic", "physical_partial"), "clinic"), n(7, direct("clinic", "gesture_prompt"), "clinic"),
    n(14, direct("clinic", "verbal_prompt"), "clinic")], dt(15), dt(29), "supported", recent=False, gaps=["home", "school"], latest=dt(14))
add("g03", "clinic", "verbal_prompt", [n(0, direct("clinic", "verbal_prompt"), "clinic"), n(7, direct("clinic", "independent"), "clinic"),
    n(14, direct("clinic", "gesture_prompt"), "clinic")], dt(15), dt(29), "insufficient_evidence", recent=False, gaps=["home", "school"], latest=dt(14))
add("g04", "clinic", "verbal_prompt", [n(7, direct("clinic", "independent"), "clinic")], dt(9), dt(29), "needs_review",
    recent=False, gaps=["home", "school"], latest=dt(7))
add("g05", "home", "verbal_prompt", [n(7, report("home", "verbal_prompt"), "home")], dt(14), dt(29), "needs_review",
    recent=True, gaps=["clinic", "school"], report_only=["home"], latest=None)
add("g06", "home", "verbal_prompt", [n(7, direct("clinic", "verbal_prompt"), "clinic")], dt(14), dt(29), "insufficient_evidence",
    recent=True, gaps=["home", "school"], latest=None)
add("g07", "clinic", "verbal_prompt", [n(0, direct("clinic", "verbal_prompt"), "clinic")], dt(30), dt(44), "supported",
    recent=True, gaps=["home", "school"], latest=dt(0))
add("g08", "clinic", "verbal_prompt", [n(7, direct("clinic", "verbal_prompt"), "clinic")], dt(34), dt(30), "supported",
    recent=True, due=True, gaps=["home", "school"], latest=dt(7))
add("g09", "clinic", "verbal_prompt", [n(7, f"{NAME} usou a colher na clínica com instruções verbais.")], dt(14), dt(29),
    "insufficient_evidence", recent=True, gaps=["clinic", "home", "school"], latest=None)
add("g10", "clinic", "verbal_prompt", [n(7, direct("clinic", "verbal_prompt"), "clinic"), n(49, direct("clinic", "independent"), "clinic")],
    dt(14), dt(29), "supported", recent=False, gaps=["home", "school"], latest=dt(7))
add("g11", "home", "independent", [n(7, direct("home", "verbal_prompt"), "home"), n(7, report("home", "independent"), "home")],
    dt(9), dt(29), "needs_review", recent=False, gaps=["clinic", "school"], latest=dt(7))
add("g12", "clinic", "verbal_prompt", [n(7, direct("clinic", "verbal_prompt"), "clinic"), n(8, report("home", "independent"), "home")],
    dt(11), dt(29), "supported", recent=False, gaps=["school"], report_only=["home"], latest=dt(7))
add("g13", "clinic", "verbal_prompt", [n(7, direct("clinic", "verbal_prompt"), "clinic"), n(7, direct("clinic", "independent"), "clinic")],
    dt(9), dt(29), "needs_review", recent=False, gaps=["home", "school"], latest=dt(7))
add("g14", "clinic", "verbal_prompt", [n(7, direct("clinic", "verbal_prompt"), "clinic")], dt(7), dt(29), "supported",
    recent=False, gaps=["home", "school"], latest=dt(7))
add("g15", "clinic", "verbal_prompt", [n(7, "Davi put on the shirt at the clinic with verbal prompts.", "clinic")], dt(14), dt(29), "supported",
    recent=False, gaps=["home", "school"], latest=dt(7))
add("g16", "school", "verbal_prompt", [n(7, direct("clinic", "verbal_prompt"), "clinic")], dt(34), dt(29), "insufficient_evidence",
    recent=True, due=True, gaps=["home", "school"], latest=None)
add("g17", "school", "independent", [n(7, f"A professora relatou que na escola {NAME} vestiu a camiseta sozinho.", "school")], dt(14), dt(29),
    "needs_review", recent=True, gaps=["clinic", "home"], report_only=["school"], latest=None)

out = Path(__file__).parent / "goal_cases.json"
out.write_text(json.dumps(cases, ensure_ascii=False, indent=1), encoding="utf-8")
print(len(cases), "goal cases")
