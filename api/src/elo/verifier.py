"""Context-Aware Evidence Verifier (deterministic, independent of any language model).

It compares the constraints of a claim (activity, environment, level of assistance,
source of the evidence, time) with those of the evidence and says which were met.
Not observed is not the same as achieved: missing evidence is never read as "no".
"""

from __future__ import annotations

from collections.abc import Sequence

from .contract import (
    Assistance,
    Claim,
    ConstraintResult,
    Environment,
    EvidenceLink,
    Observation,
    Relation,
    Verdict,
    VerdictResult,
)

ENV_LABEL = {
    Environment.CLINIC: {"pt": "clínica", "en": "clinic"},
    Environment.HOME: {"pt": "casa", "en": "home"},
    Environment.SCHOOL: {"pt": "escola", "en": "school"},
    Environment.OTHER: {"pt": "outro ambiente", "en": "another setting"},
}

ASSIST_LABEL = {
    Assistance.INDEPENDENT: {"pt": "de forma independente", "en": "independently"},
    Assistance.VERBAL_PROMPT: {"pt": "com instrução verbal", "en": "with verbal prompts"},
    Assistance.GESTURE_PROMPT: {"pt": "com dica gestual", "en": "with gesture prompts"},
    Assistance.PHYSICAL_PARTIAL: {"pt": "com assistência física parcial", "en": "with partial physical assistance"},
    Assistance.PHYSICAL_TOTAL: {"pt": "com assistência física total", "en": "with total physical assistance"},
}

# rule id -> (verdict, pt template, en template). Placeholders: {env}, {assist}, {seen_assist}, {seen_env}, {date}
RULES: dict[str, tuple[Verdict, str, str]] = {
    "activity_not_observed": (
        Verdict.INSUFFICIENT_EVIDENCE,
        "Não há nenhuma observação desta atividade nas notas disponíveis.",
        "There is no observation of this activity in the available notes.",
    ),
    "environment_not_observed": (
        Verdict.INSUFFICIENT_EVIDENCE,
        "A atividade foi observada apenas em outro ambiente ({seen_env}); não há observação em {env}.",
        "The activity was observed only in another setting ({seen_env}); there is no observation in {env}.",
    ),
    "assistance_not_met": (
        Verdict.INSUFFICIENT_EVIDENCE,
        "Em {env}, a observação mais recente ({date}) mostra a atividade {seen_assist}, e não {assist}. "
        "Isso não contradiz a afirmação sobre outro momento, mas também não a sustenta.",
        "In {env}, the latest observation ({date}) shows the activity {seen_assist}, not {assist}. "
        "It does not contradict a statement about another time, but it does not support it either.",
    ),
    "same_event_conflict": (
        Verdict.CONTRADICTED,
        "No mesmo dia ({date}) e ambiente ({env}), a observação direta registra a atividade {seen_assist}, "
        "e não {assist}.",
        "On the same day ({date}) and setting ({env}), the direct observation records the activity "
        "{seen_assist}, not {assist}.",
    ),
    "assistance_level_differs": (
        Verdict.NEEDS_REVIEW,
        "Em {env}, a observação mais recente ({date}) mostra a atividade {seen_assist}, com menos ajuda do que "
        "a afirmada ({assist}). Pode ser evolução ao longo do tempo; a profissional decide.",
        "In {env}, the latest observation ({date}) shows the activity {seen_assist}, with less help than "
        "claimed ({assist}). It may be change over time; the professional decides.",
    ),
    "reported_only": (
        Verdict.NEEDS_REVIEW,
        "O que sustenta a afirmação é um relato, não uma observação direta. A profissional decide se basta.",
        "The only support is a report, not a direct observation. The professional decides whether it is enough.",
    ),
    "source_divergence": (
        Verdict.NEEDS_REVIEW,
        "Relato e observação direta divergem em {env} na data {date}. A profissional decide qual vale.",
        "A report and a direct observation disagree in {env} on {date}. The professional decides which holds.",
    ),
    "conflicting_observations": (
        Verdict.NEEDS_REVIEW,
        "Há observações diretas conflitantes em {env} na data {date}.",
        "There are conflicting direct observations in {env} on {date}.",
    ),
    "all_constraints_met": (
        Verdict.SUPPORTED,
        "Há observação direta da atividade em {env}, {assist}, em {date}.",
        "There is direct observation of the activity in {env}, {assist}, on {date}.",
    ),
}


def _rationale(rule_id: str, claim: Claim, seen_env=None, seen_assist=None, date=None) -> dict[str, str]:
    _, pt, en = RULES[rule_id]
    out = {}
    for lang, tpl in (("pt", pt), ("en", en)):
        out[lang] = tpl.format(
            env=ENV_LABEL[claim.environment][lang],
            assist=ASSIST_LABEL[claim.assistance][lang],
            seen_env=", ".join(ENV_LABEL[e][lang] for e in seen_env) if seen_env else "",
            seen_assist=ASSIST_LABEL[seen_assist][lang] if seen_assist else "",
            date=date.isoformat() if date else "",
        )
    return out


def _result(
    claim: Claim,
    rule_id: str,
    constraints: list[ConstraintResult],
    links: list[EvidenceLink] | None = None,
    **fmt,
) -> VerdictResult:
    return VerdictResult(
        claim_id=claim.id,
        verdict=RULES[rule_id][0],
        rule_id=rule_id,
        constraints=constraints,
        links=links or [],
        rationale=_rationale(rule_id, claim, **fmt),
    )


def _links(claim: Claim, obs: Sequence[Observation], relation: Relation, rule_id: str) -> list[EvidenceLink]:
    return [EvidenceLink(claim_id=claim.id, observation_id=o.id, relation=relation, rule_id=rule_id) for o in obs]


def verify(claim: Claim, observations: Sequence[Observation]) -> VerdictResult:
    """Return exactly one verdict for the claim, with the constraints met and not met."""
    same_activity = [o for o in observations if o.activity == claim.activity]
    if claim.as_of is not None:
        same_activity = [o for o in same_activity if o.observed_on <= claim.as_of]

    def c(name, met, detail) -> ConstraintResult:
        return ConstraintResult(name=name, met=met, detail=detail)

    if not same_activity:
        return _result(
            claim,
            "activity_not_observed",
            [c("activity", False, "no observation of this activity")],
        )

    in_env = [o for o in same_activity if o.environment == claim.environment]
    if not in_env:
        seen = sorted({o.environment for o in same_activity}, key=lambda e: e.value)
        return _result(
            claim,
            "environment_not_observed",
            [
                c("activity", True, "activity observed"),
                c("environment", False, "no observation in the claimed setting"),
            ],
            seen_env=seen,
        )

    latest_date = max(o.observed_on for o in in_env)
    latest = [o for o in in_env if o.observed_on == latest_date]
    same_event = claim.as_of is not None and latest_date == claim.as_of
    time_note = "same day as the claim" if same_event else "latest observation before or without a stated day"

    directs = [o for o in latest if o.is_direct]
    reports = [o for o in latest if not o.is_direct]
    d_match = [o for o in directs if o.assistance == claim.assistance]
    d_miss = [o for o in directs if o.assistance != claim.assistance]
    r_match = [o for o in reports if o.assistance == claim.assistance]
    r_miss = [o for o in reports if o.assistance != claim.assistance]

    base = [c("activity", True, "activity observed"), c("environment", True, "observed in the claimed setting")]

    def with_(assist_met, source_met):
        return base + [
            c("assistance", assist_met, f"claimed {claim.assistance.value}"),
            c("source", source_met, "direct observation" if directs else "report only"),
            c("time", True if same_event else None, time_note),
        ]

    if d_match and d_miss:
        return _result(claim, "conflicting_observations", with_(None, None), date=latest_date)
    if (d_match and r_miss) or (d_miss and r_match and not d_match):
        return _result(claim, "source_divergence", with_(None, None), date=latest_date)
    if d_match:
        return _result(
            claim,
            "all_constraints_met",
            with_(True, True),
            _links(claim, d_match, Relation.SUPPORTS, "all_constraints_met"),
            date=latest_date,
        )
    if r_match:
        return _result(
            claim,
            "reported_only",
            with_(True, False),
            _links(claim, r_match, Relation.SUPPORTS, "reported_only"),
            date=latest_date,
        )

    # No observation in the claimed setting matches the claimed level of assistance.
    seen = (d_miss or r_miss)[0].assistance
    if same_event and d_miss:
        return _result(
            claim,
            "same_event_conflict",
            with_(False, True),
            _links(claim, d_miss, Relation.CONTRADICTS, "same_event_conflict"),
            seen_assist=seen,
            date=latest_date,
        )
    if all(o.assistance.rank < claim.assistance.rank for o in latest):
        return _result(claim, "assistance_level_differs", with_(False, bool(directs)), seen_assist=seen, date=latest_date)
    return _result(claim, "assistance_not_met", with_(False, bool(directs)), seen_assist=seen, date=latest_date)
