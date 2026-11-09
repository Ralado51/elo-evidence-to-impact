"""Family summary: controlled templates over APPROVED claims only (pt-BR / en).

No free generation. Each line is built from structured fields of a human-approved claim
(never from the claim's free text), so it can only say what was verified and approved.
It states where something was NOT yet registered, in neutral words, and never diagnoses,
predicts, evaluates progress or recommends.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .contract import Assistance, Claim, Environment, ReviewState
from .packs import Pack

LOCALES = ("pt", "en")
ENVIRONMENTS = (Environment.CLINIC, Environment.HOME, Environment.SCHOOL)

_ENV = {
    "pt": {Environment.CLINIC: "na clínica", Environment.HOME: "em casa",
           Environment.SCHOOL: "na escola", Environment.OTHER: "em outro local"},
    "en": {Environment.CLINIC: "at the clinic", Environment.HOME: "at home",
           Environment.SCHOOL: "at school", Environment.OTHER: "somewhere else"},
}
_ASSIST = {
    "pt": {
        Assistance.INDEPENDENT: "sem ajuda",
        Assistance.VERBAL_PROMPT: "com lembretes falados",
        Assistance.GESTURE_PROMPT: "com gestos de apoio",
        Assistance.PHYSICAL_PARTIAL: "com ajuda física parcial",
        Assistance.PHYSICAL_TOTAL: "com ajuda física total",
    },
    "en": {
        Assistance.INDEPENDENT: "without help",
        Assistance.VERBAL_PROMPT: "with spoken reminders",
        Assistance.GESTURE_PROMPT: "with gesture cues",
        Assistance.PHYSICAL_PARTIAL: "with partial physical help",
        Assistance.PHYSICAL_TOTAL: "with full physical help",
    },
}
_TEXT = {
    "pt": {
        "title": "Resumo da sessão",
        "registered": "O que foi registrado e revisado",
        "gaps": "Ainda sem registro",
        "gap": "{activity}: ainda sem registro {env}.",
        "none": "Ainda não há registros revisados desta sessão.",
        "note": "Este resumo lista apenas o que foi observado ou relatado e revisado pela equipe. "
                "Não é um diagnóstico nem uma avaliação de evolução.",
    },
    "en": {
        "title": "Session summary",
        "registered": "What was recorded and reviewed",
        "gaps": "Not yet recorded",
        "gap": "{activity}: not yet recorded {env}.",
        "none": "There are no reviewed records for this session yet.",
        "note": "This summary lists only what the team observed or was told and then reviewed. "
                "It is not a diagnosis or an assessment of progress.",
    },
}


@dataclass(frozen=True)
class SummaryLine:
    text: str
    claim_id: str


@dataclass
class FamilySummary:
    locale: str
    title: str
    lines: list[SummaryLine] = field(default_factory=list)
    gaps: list[str] = field(default_factory=list)
    empty_message: str | None = None
    note: str = ""

    @property
    def source_claim_ids(self) -> list[str]:
        return [l.claim_id for l in self.lines]

    def render(self) -> str:
        t = _TEXT[self.locale]
        out = [self.title, ""]
        if self.empty_message:
            out.append(self.empty_message)
        else:
            out += [t["registered"] + ":"] + [f"- {l.text}" for l in self.lines]
        if self.gaps:
            out += ["", t["gaps"] + ":"] + [f"- {g}" for g in self.gaps]
        out += ["", self.note]
        return "\n".join(out)


def build_family_summary(claims: list[Claim], pack: Pack, locale: str, child_label: str) -> FamilySummary:
    if locale not in LOCALES:
        raise ValueError("unsupported locale")
    for c in claims:
        if c.review_state not in (ReviewState.APPROVED, ReviewState.EDITED):
            raise ValueError("the family summary accepts only approved claims")
        if c.activity not in pack.activities:
            raise ValueError("claim activity is not in the pack")
    t = _TEXT[locale]
    summary = FamilySummary(locale=locale, title=f"{t['title']} — {child_label}", note=t["note"])
    if not claims:
        summary.empty_message = t["none"]
        return summary

    seen: set[tuple] = set()
    covered: dict[str, set[Environment]] = {}
    for c in sorted(claims, key=lambda c: (c.activity, str(c.as_of), c.id)):
        key = (c.activity, c.environment, c.assistance, c.as_of)
        covered.setdefault(c.activity, set()).add(c.environment)
        if key in seen:
            continue
        seen.add(key)
        label = pack.activities[c.activity].label[locale]
        when = f" ({c.as_of.isoformat()})" if c.as_of else ""
        summary.lines.append(
            SummaryLine(f"{label} {_ENV[locale][c.environment]}: {_ASSIST[locale][c.assistance]}{when}.", c.id)
        )
    for activity in sorted(covered):
        for env in ENVIRONMENTS:
            if env not in covered[activity]:
                summary.gaps.append(
                    t["gap"].format(activity=pack.activities[activity].label[locale], env=_ENV[locale][env])
                )
    return summary
