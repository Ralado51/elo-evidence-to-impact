"""Home sessions: evidence from exercise done between therapy sessions (synthetic data only).

A home session produces two kinds of evidence:

- sensor events: repetitions counted on the patient's own device (camera, phone, watch).
  Only numbers leave the device; no image, video or raw landmark is ever stored.
- a one-tap patient report at the end ("done", "hard", "not finished").

Evidence levels (occupational therapy):
  1 movement observed by a sensor
  2 prescribed exercise performed (sensors can support up to here)
  3 activity done independently (needs a patient report, always labelled as a report, or a therapist observation)
  4 functional progress (the therapist's judgement; never written by the system)

The checker is deterministic and independent of any language model. It reuses the engine's
verdicts: a claim that can go to the therapist is ``supported``; anything else says why not.
Not observed is not the same as not done.
"""

from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field

from .contract import Verdict


class SensorSource(str, Enum):
    CAMERA = "camera"
    PHONE = "phone"
    WATCH = "watch"


class ReportAnswer(str, Enum):
    DONE = "done"
    HARD = "hard"
    NOT_FINISHED = "not_finished"


SENSOR_MAX_LEVEL = 2
REPORT_MAX_LEVEL = 3
SYSTEM_MAX_LEVEL = 3  # level 4 is the therapist's


class HomePlan(BaseModel):
    exercise: str = Field(min_length=1)
    reps_per_session: int = Field(gt=0)
    sessions: list[str] = Field(min_length=1)  # planned session ids, e.g. ["mon", "wed", "fri"]


class SensorEvent(BaseModel):
    id: str
    session: str
    source: SensorSource
    day: date
    reps: int = Field(ge=0)
    atypical: int = Field(ge=0, default=0)  # repetitions counted but measured far from the session's pattern


class PatientReport(BaseModel):
    id: str
    session: str
    day: date
    answer: ReportAnswer


Kind = Literal["reps", "sessions_done", "not_observed", "not_done", "independent", "progress", "conflict"]


class HomeClaim(BaseModel):
    id: str
    text: str = Field(min_length=1)
    kind: Kind
    level: int = Field(ge=1, le=4)
    value: int | None = None
    session: str | None = None
    evidence: list[str] = Field(default_factory=list)
    flags_conflict: bool = False


class HomeResult(BaseModel):
    claim_id: str
    verdict: Verdict
    reasons: list[dict]  # [{"rule": ..., "pt": ..., "en": ...}]

    @property
    def deliverable(self) -> bool:
        return self.verdict is Verdict.SUPPORTED


# rule id -> (verdict, pt, en). Placeholders are filled with str.format.
RULES: dict[str, tuple[Verdict, str, str]] = {
    "unknown_evidence": (Verdict.INSUFFICIENT_EVIDENCE,
                         "Cita eventos que não existem: {ids}.",
                         "Cites events that do not exist: {ids}."),
    "no_evidence": (Verdict.INSUFFICIENT_EVIDENCE,
                    "Nenhuma evidência citada.",
                    "No evidence cited."),
    "therapist_only": (Verdict.NEEDS_REVIEW,
                       "Evolução funcional (nível 4) é avaliação da terapeuta; o sistema não escreve.",
                       "Functional progress (level 4) is the therapist's judgement; the system does not write it."),
    "level_above_sources": (Verdict.INSUFFICIENT_EVIDENCE,
                            "Nível {level} acima do que as fontes citadas sustentam (máximo {top}).",
                            "Level {level} is above what the cited sources support (max {top})."),
    "reps_need_sensor": (Verdict.INSUFFICIENT_EVIDENCE,
                         "Contagem de repetições precisa de evento de sensor.",
                         "A repetition count needs a sensor event."),
    "value_missing": (Verdict.INSUFFICIENT_EVIDENCE,
                      "A afirmação não informa o número.",
                      "The claim does not state the number."),
    "reps_mismatch": (Verdict.CONTRADICTED,
                      "Afirma {value} repetições; os eventos citados somam {total}.",
                      "Claims {value} repetitions; the cited events add up to {total}."),
    "sessions_mismatch": (Verdict.CONTRADICTED,
                          "Afirma {value} sessões; os eventos de sensor citados cobrem {n}.",
                          "Claims {value} sessions; the cited sensor events cover {n}."),
    "absence_is_not_no": (Verdict.INSUFFICIENT_EVIDENCE,
                          "Falta de dado não sustenta \"não fez\". Use \"não observado\".",
                          "Missing data does not support \"did not do\". Use \"not observed\"."),
    "session_was_observed": (Verdict.CONTRADICTED,
                             "A sessão {session} tem eventos; ela foi observada.",
                             "Session {session} has events; it was observed."),
    "independence_needs_report": (Verdict.INSUFFICIENT_EVIDENCE,
                                  "Independência pede relato do paciente ou observação da terapeuta; sensor mostra só movimento.",
                                  "Independence needs a patient report or a therapist observation; sensors only show movement."),
    "hidden_conflict": (Verdict.NEEDS_REVIEW,
                        "Na sessão {session}, sensor e relato divergem; a frase precisa dizer isso.",
                        "In session {session}, sensor and report disagree; the sentence must say so."),
    "no_conflict": (Verdict.CONTRADICTED,
                    "A sessão {session} não tem divergência entre sensor e relato.",
                    "Session {session} has no disagreement between sensor and report."),
}

_SEVERITY = [Verdict.CONTRADICTED, Verdict.INSUFFICIENT_EVIDENCE, Verdict.NEEDS_REVIEW]


def _reason(rule: str, **kw) -> dict:
    verdict, pt, en = RULES[rule]
    kw_pt = {**kw, **({"session": _name(kw["session"], 0)} if kw.get("session") else {})}  # "quarta", not "wed"
    kw_en = {**kw, **({"session": _name(kw["session"], 1)} if kw.get("session") else {})}
    return {"rule": rule, "verdict": verdict.value, "pt": pt.format(**kw_pt), "en": en.format(**kw_en)}


def session_conflict(session: str, plan: HomePlan, events: list[SensorEvent], reports: list[PatientReport]) -> bool:
    """True when the sensor and the patient's last report disagree on whether the session was completed."""
    sens = [e for e in events if e.session == session]
    rep = [r for r in reports if r.session == session]
    if not sens or not rep:
        return False
    sensor_done = sum(e.reps for e in sens) >= plan.reps_per_session
    report_done = rep[-1].answer is not ReportAnswer.NOT_FINISHED
    return sensor_done != report_done


def check(claim: HomeClaim, plan: HomePlan, events: list[SensorEvent], reports: list[PatientReport]) -> HomeResult:
    by_id: dict[str, SensorEvent | PatientReport] = {e.id: e for e in events} | {r.id: r for r in reports}
    cited = [by_id[i] for i in claim.evidence if i in by_id]
    missing = [i for i in claim.evidence if i not in by_id]
    sensors = [c for c in cited if isinstance(c, SensorEvent)]
    reasons: list[dict] = []

    if missing:
        reasons.append(_reason("unknown_evidence", ids=", ".join(missing)))
    if claim.level > SYSTEM_MAX_LEVEL or claim.kind == "progress":
        reasons.append(_reason("therapist_only"))
    if claim.kind in ("reps", "sessions_done", "independent", "conflict") and not cited:
        reasons.append(_reason("no_evidence"))
    if cited and claim.level <= SYSTEM_MAX_LEVEL:
        top = max(SENSOR_MAX_LEVEL if isinstance(c, SensorEvent) else REPORT_MAX_LEVEL for c in cited)
        if claim.level > top:
            reasons.append(_reason("level_above_sources", level=claim.level, top=top))

    if claim.kind == "reps":
        total = sum(e.reps for e in sensors)
        if not sensors:
            reasons.append(_reason("reps_need_sensor"))
        elif claim.value is None:
            reasons.append(_reason("value_missing"))
        elif claim.value != total:
            reasons.append(_reason("reps_mismatch", value=claim.value, total=total))
    elif claim.kind == "sessions_done":
        n = len({e.session for e in sensors})
        if claim.value is None:
            reasons.append(_reason("value_missing"))
        elif claim.value != n:
            reasons.append(_reason("sessions_mismatch", value=claim.value, n=n))
    elif claim.kind == "not_done":
        reasons.append(_reason("absence_is_not_no"))
    elif claim.kind == "not_observed":
        if any(e.session == claim.session for e in events):
            reasons.append(_reason("session_was_observed", session=claim.session))
    elif claim.kind == "independent":
        if not any(isinstance(c, PatientReport) for c in cited):
            reasons.append(_reason("independence_needs_report"))
    elif claim.kind == "conflict":
        if not session_conflict(claim.session or "", plan, events, reports):
            reasons.append(_reason("no_conflict", session=claim.session))

    if claim.kind in ("reps", "sessions_done") and not claim.flags_conflict:
        for s in sorted({e.session for e in sensors}):
            if session_conflict(s, plan, events, reports):
                reasons.append(_reason("hidden_conflict", session=s))

    if not reasons:
        return HomeResult(claim_id=claim.id, verdict=Verdict.SUPPORTED, reasons=[])
    worst = min((Verdict(r["verdict"]) for r in reasons), key=_SEVERITY.index)
    return HomeResult(claim_id=claim.id, verdict=worst, reasons=reasons)


def week_view(plan: HomePlan, events: list[SensorEvent], reports: list[PatientReport]) -> list[dict]:
    """Per planned session: observed or not, repetitions, report, conflict, atypical count."""
    rows = []
    for s in plan.sessions:
        sens = [e for e in events if e.session == s]
        rep = [r for r in reports if r.session == s]
        rows.append({
            "session": s,
            "observed": bool(sens),
            "reps": sum(e.reps for e in sens) if sens else None,
            "target": plan.reps_per_session,
            "report": rep[-1].answer.value if rep else None,
            "conflict": session_conflict(s, plan, events, reports),
            "atypical": sum(e.atypical for e in sens),
        })
    return rows


# ---------------------------------------------------------------- the sentence the therapist reads
# The model's own wording is never delivered: a model can tick a harmless field and still write
# "significant improvement". The deliverable sentence is built here, from the fields that were verified.
_SESSION_NAMES = {"mon": ("segunda", "Monday"), "tue": ("terça", "Tuesday"), "wed": ("quarta", "Wednesday"),
                  "thu": ("quinta", "Thursday"), "fri": ("sexta", "Friday"), "sat": ("sábado", "Saturday"), "sun": ("domingo", "Sunday")}


def _name(session: str, lang: int) -> str:
    return _SESSION_NAMES.get(session, (session, session))[lang]


def _join(names: list[str], lang: int) -> str:
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + (" e " if lang == 0 else " and ") + names[-1]


def render(claim: HomeClaim, plan: HomePlan, events: list[SensorEvent], reports: list[PatientReport]) -> dict | None:
    """Fixed sentence for a claim that passed ``check``; None for kinds that are never delivered as a sentence.

    Call it only for ``supported`` claims. Nothing here reads ``claim.text``.
    """
    by_id: dict[str, SensorEvent | PatientReport] = {e.id: e for e in events} | {r.id: r for r in reports}
    cited = [by_id[i] for i in claim.evidence if i in by_id]
    sens = [c for c in cited if isinstance(c, SensorEvent)]
    reps_ = [c for c in cited if isinstance(c, PatientReport)]
    sessions = sorted({c.session for c in cited}) if cited else ([claim.session] if claim.session else [])
    names = lambda lang: _join([_name(s, lang) for s in sessions], lang)  # noqa: E731
    k = claim.kind
    if k == "reps":
        return {"pt": f"{names(0).capitalize()}: {claim.value} repetições contadas pelo sensor.",
                "en": f"{names(1)}: {claim.value} repetitions counted by the sensor."}
    if k == "sessions_done":
        n = len({e.session for e in sens})
        return {"pt": f"{n} de {len(plan.sessions)} sessões previstas observadas pelo sensor.",
                "en": f"{n} of {len(plan.sessions)} planned sessions observed by the sensor."}
    if k == "not_observed":
        s = claim.session or ""
        return {"pt": f"Sessão {_name(s, 0)} não observada (sem dado do sensor nem relato).",
                "en": f"Session {_name(s, 1)} not observed (no sensor data and no report)."}
    if k == "independent" and reps_:
        rs = sorted({r.session for r in reps_})
        return {"pt": f"{_join([_name(s, 0) for s in rs], 0).capitalize()}: o paciente relata ter feito o exercício (relato, não observação).",
                "en": f"{_join([_name(s, 1) for s in rs], 1)}: the patient reports having done the exercise (a report, not an observation)."}
    if k == "conflict":
        s = claim.session or ""
        return {"pt": f"Sessão {_name(s, 0)}: sensor e relato do paciente divergem.",
                "en": f"Session {_name(s, 1)}: the sensor and the patient's report disagree."}
    return None  # not_done and progress are never delivered as a system sentence


# ---------------------------------------------------------------- facts the therapist always gets
# A verifier stops what a model writes wrongly; it cannot force what the model leaves out. These lines
# come from the events and reports directly, so a divergence or a missing session is never omitted.
_ANS = {"done": ("fez", "did it"), "hard": ("fez, foi difícil", "did it, it was hard"), "not_finished": ("não terminou", "did not finish")}


def facts(plan: HomePlan, events: list[SensorEvent], reports: list[PatientReport]) -> list[dict]:
    out = []
    for row in week_view(plan, events, reports):
        s = row["session"]
        if row["observed"]:
            atyp = row["atypical"]
            out.append({"kind": "sensor", "session": s,
                        "pt": f"{_name(s, 0).capitalize()}: {row['reps']} de {row['target']} repetições contadas pelo sensor" + (f" ({atyp} atípicas)." if atyp else "."),
                        "en": f"{_name(s, 1)}: {row['reps']} of {row['target']} repetitions counted by the sensor" + (f" ({atyp} atypical)." if atyp else ".")})
        else:
            out.append({"kind": "not_observed", "session": s, "pt": f"{_name(s, 0).capitalize()}: não observada pelo sensor.",
                        "en": f"{_name(s, 1)}: not observed by the sensor."})
        if row["report"]:
            a = _ANS[row["report"]]
            out.append({"kind": "report", "session": s, "pt": f"{_name(s, 0).capitalize()}: o paciente relata que {a[0]} (relato, não observação).",
                        "en": f"{_name(s, 1)}: the patient reports they {a[1]} (a report, not an observation)."})
        if row["conflict"]:
            out.append({"kind": "conflict", "session": s, "pt": f"{_name(s, 0).capitalize()}: sensor e relato do paciente divergem.",
                        "en": f"{_name(s, 1)}: the sensor and the patient's report disagree."})
    return out


def report_lines(plan: HomePlan, events: list[SensorEvent], reports: list[PatientReport], extra: list[dict | None]) -> list[dict]:
    """Facts first, then the sentences of verified model claims, without repeats."""
    lines, seen = [], set()
    for item in facts(plan, events, reports) + [e for e in extra if e]:
        if item["pt"] in seen:
            continue
        seen.add(item["pt"]); lines.append({"pt": item["pt"], "en": item["en"]})
    return lines
