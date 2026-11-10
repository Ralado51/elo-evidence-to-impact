"""Goals and assisted check: what the evidence shows for a goal, never a clinical judgment.

A goal says: who, which occupation, in which setting, at which level of assistance, how it is
measured and when it is reviewed. The check lines up the evidence for it (direct observations,
reports, gaps, staleness). It does NOT rate progress, score GAS, predict or recommend: the GAS
rating and the conclusion are entered by the therapist and logged (see review.py).
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from .contract import Assistance, Environment, Observation, SourceType, Verdict
from .packs import Pack
from .summary import _ASSIST, _ENV, ENVIRONMENTS
from .verifier import verify
from .contract import Claim


class Goal(BaseModel):
    id: str
    session_id: str  # the patient/case the goal belongs to
    activity: str
    environment: Environment
    assistance: Assistance  # target level of assistance
    measure: str = Field(min_length=1)  # how progress will be known (therapist's words)
    baseline: str = ""
    start_date: date
    review_date: date


class EvidencePoint(BaseModel):
    observation_id: str
    observed_on: date
    environment: Environment
    assistance: Assistance
    source_type: SourceType
    quote: str  # sanitized text, safe to show to a model; the original stays in the note


class GoalCheck(BaseModel):
    goal_id: str
    as_of: date
    verdict: Verdict
    rule_id: str
    rationale: dict[str, str]
    evidence: list[EvidencePoint]
    latest_direct: EvidencePoint | None
    environments_without_evidence: list[Environment]
    report_only_environments: list[Environment]
    days_since_direct: int | None
    no_recent_direct: bool
    review_due: bool


def check_goal(
    goal: Goal, observations: list[Observation], as_of: date, pack: Pack, stale_days: int = 14
) -> GoalCheck:
    obs = [o for o in observations if o.activity == goal.activity and o.observed_on <= as_of]
    result = verify(
        Claim(id=goal.id, session_id=goal.session_id, text="goal", activity=goal.activity,
              environment=goal.environment, assistance=goal.assistance, as_of=None),
        obs,
    )
    points = [
        EvidencePoint(observation_id=o.id, observed_on=o.observed_on, environment=o.environment,
                      assistance=o.assistance, source_type=o.source_type, quote=o.quote_sanitized or "")
        for o in sorted(obs, key=lambda o: (o.observed_on, o.id))
    ]
    in_env_direct = [p for p in points if p.environment == goal.environment and p.source_type is SourceType.DIRECT_OBSERVATION]
    latest_direct = in_env_direct[-1] if in_env_direct else None
    days = (as_of - latest_direct.observed_on).days if latest_direct else None
    seen = {p.environment for p in points}
    direct_seen = {p.environment for p in points if p.source_type is SourceType.DIRECT_OBSERVATION}
    return GoalCheck(
        goal_id=goal.id, as_of=as_of, verdict=result.verdict, rule_id=result.rule_id, rationale=result.rationale,
        evidence=points, latest_direct=latest_direct,
        environments_without_evidence=[e for e in ENVIRONMENTS if e not in seen],
        report_only_environments=[e for e in ENVIRONMENTS if e in seen and e not in direct_seen],
        days_since_direct=days,
        no_recent_direct=latest_direct is None or (days is not None and days > stale_days),
        review_due=goal.review_date <= as_of,
    )


_T = {
    "pt": {
        "goal": "Meta: {act} {env}, {assist}.",
        "verdict": {"supported": "Evidência direta sustenta a meta no nível-alvo.",
                    "contradicted": "Há observação direta que contradiz a meta.",
                    "insufficient_evidence": "Ainda sem evidência suficiente para a meta.",
                    "needs_review": "A evidência pede a decisão da terapeuta."},
        "latest": "Última observação direta no ambiente da meta: {date}, {assist}.",
        "no_direct": "Não há observação direta no ambiente da meta.",
        "stale": "Sem observação direta recente ({days} dias).",
        "gap": "Sem registro {env}.",
        "report_only": "Só relato, sem observação direta, {env}.",
        "due": "A data de reavaliação já chegou ({date}).",
        "human": "A conclusão e a pontuação são da terapeuta.",
    },
    "en": {
        "goal": "Goal: {act} {env}, {assist}.",
        "verdict": {"supported": "Direct evidence supports the goal at the target level.",
                    "contradicted": "A direct observation contradicts the goal.",
                    "insufficient_evidence": "Not enough evidence for the goal yet.",
                    "needs_review": "The evidence needs the therapist's decision."},
        "latest": "Latest direct observation in the goal's setting: {date}, {assist}.",
        "no_direct": "There is no direct observation in the goal's setting.",
        "stale": "No recent direct observation ({days} days).",
        "gap": "Nothing recorded {env}.",
        "report_only": "Report only, no direct observation, {env}.",
        "due": "The reassessment date has arrived ({date}).",
        "human": "The conclusion and the rating are the therapist's.",
    },
}


def render_check(goal: Goal, check: GoalCheck, pack: Pack, locale: str) -> str:
    t = _T[locale]
    lines = [t["goal"].format(act=pack.activities[goal.activity].label[locale], env=_ENV[locale][goal.environment],
                              assist=_ASSIST[locale][goal.assistance]),
             t["verdict"][check.verdict.value]]
    if check.latest_direct:
        lines.append(t["latest"].format(date=check.latest_direct.observed_on.isoformat(),
                                        assist=_ASSIST[locale][check.latest_direct.assistance]))
        if check.no_recent_direct:
            lines.append(t["stale"].format(days=check.days_since_direct))
    else:
        lines.append(t["no_direct"])
    lines += [t["gap"].format(env=_ENV[locale][e]) for e in check.environments_without_evidence]
    lines += [t["report_only"].format(env=_ENV[locale][e]) for e in check.report_only_environments]
    if check.review_due:
        lines.append(t["due"].format(date=goal.review_date.isoformat()))
    lines.append(t["human"])
    return "\n".join(f"- {l}" for l in lines)
