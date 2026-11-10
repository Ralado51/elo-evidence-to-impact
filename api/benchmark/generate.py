"""Generate benchmark/cases.json deterministically (synthetic data only).

Labels come from how each case is CONSTRUCTED (what the note says, what the claim says),
not from running the system. They are pending clinical review by the occupational therapist.
Hard cases are written to break the deterministic rules on purpose; they are reported separately.
Split: a case is `eval` when sha1(id) % 3 == 0, otherwise `dev`. Rules/prompts may be tuned on
`dev` only; `eval` is run once at the end.
"""

import hashlib
import json
import random
from datetime import date, timedelta
from pathlib import Path

NAME = "Davi"  # synthetic; registered in the runner as "Davi Moreira"
D0 = date(2026, 10, 20)

ACT = {  # slug: (pt, en)
    "dressing_upper": ("vestiu a camiseta", "put on the shirt"),
    "dressing_lower": ("vestiu a calça", "put on the pants"),
    "feeding": ("usou a colher", "used the spoon"),
    "toothbrushing": ("escovou os dentes", "brushed his teeth"),
    "handwriting": ("escreveu as letras com o lápis", "wrote the letters with the pencil"),
    "toileting": ("usou o banheiro", "used the bathroom"),
}
ENV = {"clinic": ("na clínica", "at the clinic"), "home": ("em casa", "at home"), "school": ("na escola", "at school")}
LEVEL = {
    "independent": ("sozinho", "on his own"),
    "verbal_prompt": ("com instruções verbais", "with verbal prompts"),
    "gesture_prompt": ("com dicas gestuais", "with gesture prompts"),
    "physical_partial": ("com assistência física parcial", "with partial physical assistance"),
    "physical_total": ("com assistência física total", "with total physical assistance"),
}
LEVELS = list(LEVEL)
ACTS = list(ACT)
ENVS = list(ENV)
cases = []


def d(n):
    return (D0 + timedelta(days=n)).isoformat()


def direct(loc, act, env, lvl):
    i = 0 if loc == "pt" else 1
    return f"{NAME} {ACT[act][i]} {ENV[env][i]} {LEVEL[lvl][i]}."


def report(loc, act, env, lvl):
    if loc == "pt":
        return f"A mãe relatou que {ENV[env][0]} {NAME} {ACT[act][0]} {LEVEL[lvl][0]}."
    return f"The mother reported that {ENV[env][1]} {NAME} {ACT[act][1]} {LEVEL[lvl][1]}."


def obs(note, act, env, lvl, src="direct_observation"):
    return {"note_id": note, "activity": act, "environment": env, "assistance": lvl, "source_type": src}


def add(cid, category, difficulty, loc, notes, claim, verdict, observations):
    cases.append({
        "id": cid, "category": category, "difficulty": difficulty, "locale": loc,
        "notes": [{"id": f"{cid}-n{i+1}", "date": dt, "text": tx} for i, (dt, tx) in enumerate(notes)],
        "claim": claim, "expected_verdict": verdict, "expected_observations": observations,
        "label_status": "constructed; pending clinical review",
    })


def claim(act, env, lvl, as_of):
    return {"activity": act, "environment": env, "assistance": lvl, "as_of": as_of}


rng = random.Random(7)


def pick(n):
    return [(rng.choice(ACTS), rng.choice(ENVS), rng.choice(LEVELS), "pt" if i % 2 == 0 else "en") for i in range(n)]


for i, (a, e, l, loc) in enumerate(pick(8)):  # supported
    cid = f"sup-{i+1:02d}"
    add(cid, "supported", "easy", loc, [(d(i), direct(loc, a, e, l))], claim(a, e, l, d(i)), "supported", [obs(f"{cid}-n1", a, e, l)])

for i, (a, e, l, loc) in enumerate(pick(6)):  # environment gap
    cid = f"env-{i+1:02d}"
    other = rng.choice([x for x in ENVS if x != e])
    add(cid, "environment_gap", "easy", loc, [(d(i), direct(loc, a, e, l))], claim(a, other, l, d(i)), "insufficient_evidence", [obs(f"{cid}-n1", a, e, l)])

for i, (a, e, l, loc) in enumerate(pick(4)):  # activity never observed
    cid = f"act-{i+1:02d}"
    other = rng.choice([x for x in ACTS if x != a])
    add(cid, "activity_not_observed", "easy", loc, [(d(i), direct(loc, a, e, l))], claim(other, e, l, d(i)), "insufficient_evidence", [obs(f"{cid}-n1", a, e, l)])

for i, (a, e, l, loc) in enumerate(pick(6)):  # same-day direct conflict
    cid = f"con-{i+1:02d}"
    other = rng.choice([x for x in LEVELS if x != l])
    add(cid, "same_day_contradiction", "easy", loc, [(d(i), direct(loc, a, e, l))], claim(a, e, other, d(i)), "contradicted", [obs(f"{cid}-n1", a, e, l)])

for i in range(4):  # earlier observation was MORE assisted than the later claim: not supported
    loc = "pt" if i % 2 == 0 else "en"
    a, e = ACTS[i], ENVS[i % 3]
    cid = f"old-{i+1:02d}"
    add(cid, "earlier_more_assisted", "easy", loc, [(d(i), direct(loc, a, e, "physical_partial"))], claim(a, e, "verbal_prompt", d(i + 14)), "insufficient_evidence", [obs(f"{cid}-n1", a, e, "physical_partial")])

for i in range(4):  # earlier observation was MORE independent than the claim: professional decides
    loc = "pt" if i % 2 == 0 else "en"
    a, e = ACTS[i + 1], ENVS[(i + 1) % 3]
    cid = f"ind-{i+1:02d}"
    add(cid, "earlier_more_independent", "easy", loc, [(d(i), direct(loc, a, e, "independent"))], claim(a, e, "verbal_prompt", d(i + 14)), "needs_review", [obs(f"{cid}-n1", a, e, "independent")])

for i, (a, e, l, loc) in enumerate(pick(4)):  # caregiver report only
    cid = f"rep-{i+1:02d}"
    add(cid, "report_only", "easy", loc, [(d(i), report(loc, a, e, l))], claim(a, e, l, d(i)), "needs_review", [obs(f"{cid}-n1", a, e, l, "caregiver_report")])

for i in range(3):  # report and direct observation disagree
    loc = "pt" if i % 2 == 0 else "en"
    a, e = ACTS[i], "home"
    cid = f"div-{i+1:02d}"
    add(cid, "source_divergence", "easy", loc,
        [(d(i), direct(loc, a, e, "verbal_prompt")), (d(i), report(loc, a, e, "independent"))],
        claim(a, e, "independent", d(i)), "needs_review",
        [obs(f"{cid}-n1", a, e, "verbal_prompt"), obs(f"{cid}-n2", a, e, "independent", "caregiver_report")])

NEG = [  # negation the rules must read correctly
    ("pt", "Davi vestiu a camiseta na clínica sem assistência física, após instruções verbais.", "dressing_upper", "clinic", "verbal_prompt"),
    ("pt", "Davi usou a colher na escola e não precisou de ajuda física, apenas de instruções verbais.", "feeding", "school", "verbal_prompt"),
    ("en", "Davi put on the pants at the clinic without physical help, only verbal prompts.", "dressing_lower", "clinic", "verbal_prompt"),
    ("pt", "Davi vestiu a camiseta na clínica sem ajuda física, apenas gestos.", "dressing_upper", "clinic", "gesture_prompt"),
]
for i, (loc, text, a, e, l) in enumerate(NEG):
    cid = f"neg-{i+1:02d}"
    add(cid, "negation", "easy", loc, [(d(i), text)], claim(a, e, l, d(i)), "supported", [obs(f"{cid}-n1", a, e, l)])

ROB = [  # accents, case, mixed language
    ("pt", "DAVI VESTIU A CAMISETA NA CLINICA COM INSTRUCOES VERBAIS.", "dressing_upper", "clinic", "verbal_prompt"),
    ("pt", "Davi escovou os dentes em casa com instrucoes verbais.", "toothbrushing", "home", "verbal_prompt"),
    ("pt", "Davi vestiu a camiseta at school com verbal prompts.", "dressing_upper", "school", "verbal_prompt"),
]
for i, (loc, text, a, e, l) in enumerate(ROB):
    cid = f"rob-{i+1:02d}"
    add(cid, "robustness", "easy", loc, [(d(i), text)], claim(a, e, l, d(i)), "supported", [obs(f"{cid}-n1", a, e, l)])

# ---- hard cases (written to break the rules; labels by what the note actually says) ----
H = []
H.append(("hand_guided", "pt", [("Davi escovou os dentes em casa quase sozinho, mas a mãe guiou a mão dele.")], ("toothbrushing", "home", "independent"), "contradicted", [("toothbrushing", "home", "physical_partial", "direct_observation")]))
H.append(("goal_not_observation", "pt", [("A meta é que Davi vista a camiseta sozinho em casa.")], ("dressing_upper", "home", "independent"), "insufficient_evidence", []))
H.append(("goal_not_observation", "en", [("Goal: Davi will wear the shirt on his own at home.")], ("dressing_upper", "home", "independent"), "insufficient_evidence", []))
H.append(("hypothetical", "pt", [("Se Davi usar a colher sozinho na escola, o lanche será mais rápido.")], ("feeding", "school", "independent"), "insufficient_evidence", []))
H.append(("other_person", "pt", [("O irmão de Davi vestiu a camiseta sozinho em casa.")], ("dressing_upper", "home", "independent"), "insufficient_evidence", []))
H.append(("failed_attempt", "pt", [("Davi não conseguiu vestir a calça sozinho na escola.")], ("dressing_lower", "school", "independent"), "insufficient_evidence", []))
H.append(("reported_negative", "pt", [("A mãe relatou que em casa Davi não veste a camiseta sozinho.")], ("dressing_upper", "home", "independent"), "insufficient_evidence", []))
H.append(("cross_sentence", "pt", [("Davi escovou os dentes na clínica. Precisou de instruções verbais.")], ("toothbrushing", "clinic", "verbal_prompt"), "supported", [("toothbrushing", "clinic", "verbal_prompt", "direct_observation")]))
H.append(("two_activities", "pt", [("Davi vestiu a camiseta e a calça na clínica com instruções verbais.")], ("dressing_upper", "clinic", "verbal_prompt"), "supported", [("dressing_upper", "clinic", "verbal_prompt", "direct_observation"), ("dressing_lower", "clinic", "verbal_prompt", "direct_observation")]))
H.append(("comparison_with_past", "pt", [("Hoje Davi vestiu a camiseta na clínica sozinho, diferente da semana passada, quando precisou de ajuda física.")], ("dressing_upper", "clinic", "independent"), "supported", [("dressing_upper", "clinic", "independent", "direct_observation")]))
H.append(("hand_guided", "en", [("Davi brushed his teeth at home almost on his own, but the mother guided his hand.")], ("toothbrushing", "home", "independent"), "contradicted", [("toothbrushing", "home", "physical_partial", "direct_observation")]))
for i, (cat, loc, texts, cl, verdict, exp) in enumerate(H):
    cid = f"hard-{i+1:02d}"
    add(cid, cat, "hard", loc, [(d(i), t) for t in texts], claim(cl[0], cl[1], cl[2], d(i)), verdict,
        [obs(f"{cid}-n1", a, e, l, s) for a, e, l, s in exp])

# ---- round 2: new kinds of hard cases, written after the prompt/pack were tuned on round 1.
# Nothing in the pack or the prompt was changed for them. They measure generalization. ----
R2 = [
    ("almost_achieved", "pt", [("Davi quase conseguiu escovar os dentes sozinho em casa.")], ("toothbrushing", "home", "independent"), "insufficient_evidence", []),
    ("almost_achieved", "en", [("Davi almost put on the shirt on his own at school.")], ("dressing_upper", "school", "independent"), "insufficient_evidence", []),
    ("temporal_order", "pt", [("Hoje Davi vestiu a calça na escola sozinho; na semana passada precisou de instruções verbais.")], ("dressing_lower", "school", "independent"), "supported", [("dressing_lower", "school", "independent", "direct_observation")]),
    ("environment_implicit", "pt", [("Na sessão de hoje, Davi vestiu a camiseta com instruções verbais.")], ("dressing_upper", "clinic", "verbal_prompt"), "insufficient_evidence", []),
    ("unlisted_synonym", "pt", [("Davi vestiu a camiseta na clínica, apenas com lembretes da terapeuta.")], ("dressing_upper", "clinic", "verbal_prompt"), "supported", [("dressing_upper", "clinic", "verbal_prompt", "direct_observation")]),
    ("unlisted_independent_phrase", "en", [("Davi did not need help to put on his shirt at school.")], ("dressing_upper", "school", "independent"), "supported", [("dressing_upper", "school", "independent", "direct_observation")]),
    ("unlisted_report_phrase", "pt", [("Segundo a avó, Davi usou a colher sozinho em casa.")], ("feeding", "home", "independent"), "needs_review", [("feeding", "home", "independent", "caregiver_report")]),
    ("unlisted_report_phrase", "en", [("According to his grandmother, Davi used the spoon on his own at home.")], ("feeding", "home", "independent"), "needs_review", [("feeding", "home", "independent", "caregiver_report")]),
    ("unlisted_hand_guiding", "pt", [("Davi escovou os dentes na clínica, mas a terapeuta conduziu o movimento da mão.")], ("toothbrushing", "clinic", "independent"), "contradicted", [("toothbrushing", "clinic", "physical_partial", "direct_observation")]),
]
for i, (cat, loc, texts, cl, verdict, exp) in enumerate(R2):
    cid = f"r2-{i+1:02d}"
    add(cid, cat, "hard", loc, [(d(i), t) for t in texts], claim(cl[0], cl[1], cl[2], d(i)), verdict,
        [obs(f"{cid}-n1", a, e, l, s) for a, e, l, s in exp])

# observation dated after the claim does not count
add("r2-10", "observation_after_claim", "hard", "pt", [(d(5), direct("pt", "dressing_upper", "clinic", "verbal_prompt"))],
    claim("dressing_upper", "clinic", "verbal_prompt", d(2)), "insufficient_evidence", [obs("r2-10-n1", "dressing_upper", "clinic", "verbal_prompt")])
# progress over time: latest observation is the one that counts
prog = [(d(0), direct("pt", "dressing_upper", "clinic", "physical_partial")), (d(7), direct("pt", "dressing_upper", "clinic", "verbal_prompt")),
        (d(14), direct("pt", "dressing_upper", "clinic", "independent"))]
add("r2-11", "progress_over_time", "hard", "pt", prog, claim("dressing_upper", "clinic", "independent", d(14)), "supported",
    [obs("r2-11-n1", "dressing_upper", "clinic", "physical_partial"), obs("r2-11-n2", "dressing_upper", "clinic", "verbal_prompt"), obs("r2-11-n3", "dressing_upper", "clinic", "independent")])
reg = [(d(0), direct("en", "dressing_upper", "clinic", "independent")), (d(7), direct("en", "dressing_upper", "clinic", "verbal_prompt"))]
add("r2-12", "latest_overrides", "hard", "en", reg, claim("dressing_upper", "clinic", "independent", d(10)), "insufficient_evidence",
    [obs("r2-12-n1", "dressing_upper", "clinic", "independent"), obs("r2-12-n2", "dressing_upper", "clinic", "verbal_prompt")])
# ---- round 3: kinds of difficulty not covered by any marker or cue added so far ----
R3 = [
    ("wish_not_event", "pt", "A mãe espera que Davi consiga usar a colher sozinho na escola.", ("feeding", "school", "independent"), "insufficient_evidence", []),
    ("need_not_event", "pt", "Davi precisa aprender a escovar os dentes sozinho em casa.", ("toothbrushing", "home", "independent"), "insufficient_evidence", []),
    ("other_person", "pt", "A colega de Davi vestiu a calça sozinha na escola.", ("dressing_lower", "school", "independent"), "insufficient_evidence", []),
    ("refusal", "pt", "Davi recusou vestir a camiseta na clínica, mesmo sem ajuda.", ("dressing_upper", "clinic", "independent"), "insufficient_evidence", []),
    ("unlisted_synonym", "pt", "Davi escreveu as letras na escola apenas com orientação oral.", ("handwriting", "school", "verbal_prompt"), "supported", [("handwriting", "school", "verbal_prompt", "direct_observation")]),
    ("unlisted_report_phrase", "pt", "De acordo com a professora, Davi usou o banheiro sozinho na escola.", ("toileting", "school", "independent"), "needs_review", [("toileting", "school", "independent", "professional_report")]),
    ("plan_not_event", "en", "Plan: practice putting on the shirt on his own at the clinic.", ("dressing_upper", "clinic", "independent"), "insufficient_evidence", []),
    ("unlisted_physical_help", "pt", "Davi vestiu a calça na escola com a terapeuta segurando o quadril dele.", ("dressing_lower", "school", "independent"), "contradicted", [("dressing_lower", "school", "physical_partial", "direct_observation")]),
]
for i, (cat, loc, text, cl, verdict, exp) in enumerate(R3):
    cid = f"r3-{i+1:02d}"
    add(cid, cat, "hard", loc, [(d(i), text)], claim(cl[0], cl[1], cl[2], d(i)), verdict,
        [obs(f"{cid}-n1", a, e, l, s) for a, e, l, s in exp])


# ---- round 4: SEALED. Written after every fix above, forced into `eval`, never run during tuning. ----
R4 = [
    ("reported_negative", "en", "The teacher said Davi could not button the shirt at school.", ("dressing_upper", "school", "independent"), "insufficient_evidence", []),
    ("habitual_report", "pt", "Davi costuma vestir a camiseta sozinho em casa, diz a mãe.", ("dressing_upper", "home", "independent"), "needs_review", [("dressing_upper", "home", "independent", "caregiver_report")]),
    ("uncertain_statement", "pt", "Não ficou claro se Davi escovou os dentes sozinho em casa.", ("toothbrushing", "home", "independent"), "insufficient_evidence", []),
    ("other_person", "en", "His sister put on the pants on her own at home.", ("dressing_lower", "home", "independent"), "insufficient_evidence", []),
    ("future_plan", "pt", "Na próxima semana vamos treinar a colher na escola sem ajuda.", ("feeding", "school", "independent"), "insufficient_evidence", []),
    ("unlisted_synonym", "en", "Davi put on the shirt at the clinic with only spoken reminders.", ("dressing_upper", "clinic", "verbal_prompt"), "supported", [("dressing_upper", "clinic", "verbal_prompt", "direct_observation")]),
]
for i, (cat, loc, text, cl, verdict, exp) in enumerate(R4):
    cid = f"r4-{i+1:02d}"
    add(cid, cat, "hard", loc, [(d(i), text)], claim(cl[0], cl[1], cl[2], d(i)), verdict,
        [obs(f"{cid}-n1", a, e, l, s) for a, e, l, s in exp])

# ---- round 5: SEALED, written after the trailing-attribution fix. Two cases use phrasing the fix does NOT cover. ----
R5 = [
    ("trailing_attribution", "pt", "Davi vestiu a calça sozinho na escola, conta a professora.", ("dressing_lower", "school", "independent"), "needs_review", [("dressing_lower", "school", "independent", "professional_report")]),
    ("trailing_attribution", "en", "The mother says Davi brushed his teeth on his own at home.", ("toothbrushing", "home", "independent"), "needs_review", [("toothbrushing", "home", "independent", "caregiver_report")]),
    ("unlisted_attribution", "pt", "Pelo que a vó contou, Davi usou a colher sozinho em casa.", ("feeding", "home", "independent"), "needs_review", [("feeding", "home", "independent", "caregiver_report")]),
    ("trailing_attribution", "pt", "Davi usou a colher na escola com instruções verbais, informa a professora.", ("feeding", "school", "verbal_prompt"), "needs_review", [("feeding", "school", "verbal_prompt", "professional_report")]),
    ("therapist_speech_is_not_a_report", "pt", "A terapeuta disse a Davi para vestir a camiseta e ele vestiu na clínica sozinho.", ("dressing_upper", "clinic", "independent"), "supported", [("dressing_upper", "clinic", "independent", "direct_observation")]),
    ("unlisted_attribution", "pt", "Davi vestiu a camiseta em casa, de acordo com os vizinhos, sozinho.", ("dressing_upper", "home", "independent"), "needs_review", [("dressing_upper", "home", "independent", "caregiver_report")]),
]
for i, (cat, loc, text, cl, verdict, exp) in enumerate(R5):
    cid = f"r5-{i+1:02d}"
    add(cid, cat, "hard", loc, [(d(i), text)], claim(cl[0], cl[1], cl[2], d(i)), verdict,
        [obs(f"{cid}-n1", a, e, l, s) for a, e, l, s in exp])

for c in cases:
    c["split"] = "eval" if int(hashlib.sha1(c["id"].encode()).hexdigest(), 16) % 3 == 0 else "dev"

for c in cases:
    if c["id"].startswith(("r4-", "r5-")):
        c["split"] = "eval"
for c in cases:
    if c["id"].startswith("r2-"):
        c["round"] = 2
    elif c["id"].startswith("r3-"):
        c["round"] = 3
    elif c["id"].startswith("r4-"):
        c["round"] = 4
    elif c["id"].startswith("r5-"):
        c["round"] = 5
out = Path(__file__).parent / "cases.json"
out.write_text(json.dumps(cases, ensure_ascii=False, indent=1), encoding="utf-8")
print(len(cases), "cases;", sum(c["split"] == "eval" for c in cases), "eval")
