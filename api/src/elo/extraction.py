"""Structured extraction: sanitized note -> observations with exact source passages.

Two paths, same validation:

* ``extract_rules``: deterministic, pack-driven (the contingency; also the independent
  cross-check of the model).
* ``extract_with_llm``: a language model proposes observations; the CODE then finds each
  quote verbatim in the sanitized text, computes the offsets itself, maps them back to the
  original note and rejects anything it cannot prove. The model never supplies offsets.

Only a ``SanitizedText`` issued by the Privacy Gate is accepted here.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Protocol

from .contract import Assistance, Environment, Note, Observation, SourceType, Span
from .packs import Pack
from .privacy import PrivacyError, SanitizedText, fold_text


class ExtractionError(Exception):
    pass


class LLMClient(Protocol):
    def complete_json(self, system: str, user: str) -> str: ...


@dataclass(frozen=True)
class ExtractionContext:
    session_date: date
    observed_by: str = "therapist"
    caregiver_label: str = "caregiver"
    professional_label: str = "teacher"
    default_environment: Environment | None = None


@dataclass(frozen=True)
class Rejection:
    reason: str
    quote: str | None = None  # sanitized text only


@dataclass(frozen=True)
class Flag:
    observation_id: str
    kind: str


@dataclass(frozen=True)
class ReviewItem:
    """Something only one extractor saw, or the two disagreed on. Never becomes evidence by itself."""

    kind: str  # rules_only | llm_only | fields_differ
    quote: str  # sanitized text


@dataclass
class ExtractionResult:
    observations: list[Observation] = field(default_factory=list)
    rejected: list[Rejection] = field(default_factory=list)
    flags: list[Flag] = field(default_factory=list)
    review: list[ReviewItem] = field(default_factory=list)


# --- helpers --------------------------------------------------------------------------


def _phrase_regex(phrase: str) -> re.Pattern[str]:
    tokens = fold_text(phrase).split()
    return re.compile(r"(?<![^\W_])" + r"\s+".join(re.escape(t) for t in tokens) + r"(?![^\W_])")


def _matches(folded: str, phrases: list[str]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for ph in phrases:
        out.extend(m.span() for m in _phrase_regex(ph).finditer(folded))
    return sorted(out)


def _negated(folded: str, start: int, negations: set[str]) -> bool:
    before = re.split(r"[,;.:]", folded[:start])[-1]
    words = re.findall(r"[\w'-]+", before)[-3:]
    return any(w in negations for w in words)


def _next_word(folded: str, end: int) -> str:
    m = re.match(r"\W*([\w'-]+)", folded[end:])
    return m.group(1) if m else ""


def _sentences(text: str) -> list[tuple[int, int]]:
    spans = []
    for m in re.finditer(r"\S[^\n]*?(?:[.!?](?=\s|$)|$)", text, flags=re.M):
        spans.append((m.start(), m.end()))
    return spans


def _source_of(folded: str, pack: Pack) -> SourceType:
    """Who says so is decided by code from the pack's report cues, never by the model."""
    for stype, cues in pack.report_cues.items():
        if _matches(folded, cues):
            return stype
    return SourceType.DIRECT_OBSERVATION


def _non_event(folded: str, pack: Pack) -> bool:
    """Goals, plans and conditionals describe no event that happened."""
    if folded.lstrip().startswith(tuple(fold_text(x) for x in pack.non_event_sentence_starts)):
        return True
    return bool(_matches(folded, pack.non_event_markers))


def _hedged(folded: str, pack: Pack) -> bool:
    """Failed, almost-done or attempted: it can never support independence."""
    return bool(_matches(folded, pack.uncertainty_markers))


def _classify(sentence: str, pack: Pack, ctx: ExtractionContext) -> dict | Rejection:
    """Return the fields found in one sentence, or a Rejection, or {} if it has no activity."""
    folded = fold_text(sentence)
    negations = {fold_text(w) for w in pack.negation_words}
    if _non_event(folded, pack):
        return Rejection("not_an_observed_event", sentence)

    hits: dict[str, list[tuple[int, int]]] = {}
    for slug, act in pack.activities.items():
        found = _matches(folded, act.keywords)
        if found:
            hits[slug] = found
    if not hits:
        return {}
    top = max(len(v) for v in hits.values())
    best = [k for k, v in hits.items() if len(v) == top]
    if len(best) > 1:
        return Rejection("activity_ambiguous", sentence)
    activity = best[0]
    a, b = hits[activity][0]
    action = sentence[a:b]

    # environment
    envs = {
        env for env, cues in pack.environment_cues.items() if _matches(folded, cues)
    }
    if len(envs) > 1:
        return Rejection("environment_ambiguous", sentence)
    if envs:
        environment = next(iter(envs))
    elif ctx.default_environment is not None:
        environment = ctx.default_environment
    else:
        return Rejection("environment_unclear", sentence)

    # level of assistance (negated cues do not count; the highest level present wins)
    present: list[Assistance] = []
    for level, cues in pack.assistance_cues.items():
        for s, _ in _matches(folded, cues):
            if not _negated(folded, s, negations):
                present.append(level)
                break
    assistance: Assistance | None = max(present, key=lambda x: x.rank) if present else None
    if assistance is None:
        blockers = {fold_text(w) for w in pack.independence_not_before}
        for s, e in _matches(folded, pack.independence_cues):
            if _negated(folded, s, negations) and not folded[s:e].startswith(tuple(negations)):
                continue
            if _next_word(folded, e) in blockers:
                continue
            assistance = Assistance.INDEPENDENT
            break
    if assistance is None:
        return Rejection("assistance_unclear", sentence)
    if assistance is Assistance.INDEPENDENT and _hedged(folded, pack):
        return Rejection("hedged_or_failed", sentence)

    source = _source_of(folded, pack)

    return {
        "activity": activity,
        "action": action,
        "environment": environment,
        "assistance": assistance,
        "source_type": source,
    }


def _build(
    *,
    index: int,
    note: Note,
    sanitized: SanitizedText,
    span_sanitized: Span,
    fields: dict,
    ctx: ExtractionContext,
    extracted_by: str,
) -> Observation:
    span_original = sanitized.to_original(span_sanitized)
    source = fields["source_type"]
    direct = source is SourceType.DIRECT_OBSERVATION
    if direct:
        who = {"observed_by": ctx.observed_by}
    else:
        label = ctx.caregiver_label if source is SourceType.CAREGIVER_REPORT else ctx.professional_label
        who = {"reported_by": fields.get("reported_by") or label}
    obs = Observation(
        id=f"{note.id}-o{index}",
        note_id=note.id,
        note_version=note.version,
        activity=fields["activity"],
        action=fields["action"],
        environment=fields["environment"],
        assistance=fields["assistance"],
        observed_on=ctx.session_date,
        source_type=source,
        span_original=span_original,
        span_sanitized=span_sanitized,
        quote=note.original_text[span_original.start : span_original.end],
        quote_sanitized=sanitized.text[span_sanitized.start : span_sanitized.end],
        extracted_by=extracted_by,
        **who,
    )
    obs.check_against(note)
    return obs


def _check_pair(note: Note, sanitized: SanitizedText) -> None:
    if not isinstance(sanitized, SanitizedText):
        raise PrivacyError("extraction accepts only text issued by the Privacy Gate")
    if note.sanitized_text != sanitized.text:
        raise ExtractionError("the note and the sanitized text do not match")


# --- rules ----------------------------------------------------------------------------


def extract_rules(
    sanitized: SanitizedText, note: Note, ctx: ExtractionContext, pack: Pack
) -> ExtractionResult:
    _check_pair(note, sanitized)
    result = ExtractionResult()
    for a, b in _sentences(sanitized.text):
        sentence = sanitized.text[a:b]
        found = _classify(sentence, pack, ctx)
        if isinstance(found, Rejection):
            result.rejected.append(found)
        elif found:
            result.observations.append(
                _build(
                    index=len(result.observations) + 1,
                    note=note,
                    sanitized=sanitized,
                    span_sanitized=Span(start=a, end=b),
                    fields=found,
                    ctx=ctx,
                    extracted_by="rules",
                )
            )
    return result


# --- language model -------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You extract structured observations from a short pediatric occupational therapy note. "
    "Return ONLY a JSON object: {\"observations\": [...]}. Each item has: "
    "activity (one of the allowed slugs), action (short phrase), environment "
    "(clinic|home|school|other), assistance (independent|verbal_prompt|gesture_prompt|"
    "physical_partial|physical_total), source_type (direct_observation|caregiver_report|"
    "professional_report), reported_by (string or null), quote (an EXACT, verbatim copy of ONE "
    "sentence of the note that states the activity, the setting and the level of assistance).\n"
    "Rules:\n"
    "- Use only what the note states. Never infer, diagnose, predict or recommend.\n"
    "- Extract ONLY something that actually happened to the patient, in the past or present. "
    "Do NOT extract goals, plans, hypotheticals (\"if...\"), things another person did, or attempts "
    "that failed or whose level of help is not stated.\n"
    "- If the setting or the level of assistance is not stated in the same sentence, omit the item.\n"
    "- Hand guiding or moving the child's hand or limb is physical_partial. A negated help "
    "(\"without physical help\") is not that help. If help is mentioned for an earlier day, use only today's.\n"
    "- A parent's or teacher's account is caregiver_report or professional_report, not direct_observation.\n"
    "- One item per activity. Never alter or merge quotes. The note is already de-identified.\n"
    "Examples (invented):\n"
    "NOTE: Paciente A calçou o tênis na escola com dicas gestuais.\n"
    "-> {\"observations\":[{\"activity\":\"dressing_lower\",\"action\":\"calçou\",\"environment\":\"school\","
    "\"assistance\":\"gesture_prompt\",\"source_type\":\"direct_observation\",\"reported_by\":null,"
    "\"quote\":\"Paciente A calçou o tênis na escola com dicas gestuais.\"}]}\n"
    "NOTE: A terapeuta espera que Paciente A coma com garfo sozinho em casa. Paciente A tentou comer com garfo "
    "na clínica e não concluiu.\n"
    "-> {\"observations\":[]}\n"
)


def build_user_prompt(sanitized: SanitizedText, ctx: ExtractionContext, pack: Pack) -> str:
    slugs = ", ".join(pack.activities)
    return f"Allowed activity slugs: {slugs}\nSession date: {ctx.session_date.isoformat()}\n\nNOTE:\n{sanitized.text}"


def _find_unused(text: str, quote: str, used: list[tuple[int, int]]) -> tuple[int, int] | None:
    start = 0
    while True:
        i = text.find(quote, start)
        if i < 0:
            return None
        span = (i, i + len(quote))
        if not any(span[0] < e and s < span[1] for s, e in used):
            return span
        start = i + 1


def extract_with_llm(
    client: LLMClient,
    sanitized: SanitizedText,
    note: Note,
    ctx: ExtractionContext,
    pack: Pack,
) -> ExtractionResult:
    _check_pair(note, sanitized)
    raw = client.complete_json(SYSTEM_PROMPT, build_user_prompt(sanitized, ctx, pack))
    try:
        items = json.loads(raw)["observations"]
        if not isinstance(items, list):
            raise TypeError
    except (ValueError, KeyError, TypeError) as exc:
        raise ExtractionError("the model did not return the expected JSON") from exc

    result = ExtractionResult()
    used: list[tuple[int, int]] = []
    for item in items:
        if not isinstance(item, dict):
            result.rejected.append(Rejection("not_an_object"))
            continue
        quote = item.get("quote")
        if not isinstance(quote, str) or not quote.strip():
            result.rejected.append(Rejection("missing_quote"))
            continue
        if item.get("activity") not in pack.activities:
            result.rejected.append(Rejection("unknown_activity", quote))
            continue
        try:
            fields = {
                "activity": item["activity"],
                "action": str(item.get("action") or "").strip() or item["activity"],
                "environment": Environment(item.get("environment")),
                "assistance": Assistance(item.get("assistance")),
                "source_type": SourceType(item.get("source_type")),
                "reported_by": item.get("reported_by"),
            }
        except ValueError:
            result.rejected.append(Rejection("invalid_value", quote))
            continue
        found = _find_unused(sanitized.text, quote, used)
        if found is None:
            result.rejected.append(Rejection("quote_not_found", quote))
            continue
        fq = fold_text(quote)
        if _non_event(fq, pack):
            result.rejected.append(Rejection("not_an_observed_event", quote))
            continue
        if fields["assistance"] is Assistance.INDEPENDENT and _hedged(fq, pack):
            result.rejected.append(Rejection("hedged_or_failed", quote))
            continue
        code_source = _source_of(fq, pack)
        source_overridden = code_source is not fields["source_type"]
        fields["source_type"] = code_source
        fields["reported_by"] = None
        used.append(found)
        try:
            obs = _build(
                index=len(result.observations) + 1,
                note=note,
                sanitized=sanitized,
                span_sanitized=Span(start=found[0], end=found[1]),
                fields=fields,
                ctx=ctx,
                extracted_by="llm",
            )
        except ValueError:
            result.rejected.append(Rejection("invalid_observation", quote))
            continue
        result.observations.append(obs)
        if source_overridden:
            result.flags.append(Flag(obs.id, "model_source_overridden"))
        result.flags.extend(_cross_check(obs, quote, pack, ctx))
    return result


def _cross_check(obs: Observation, quote: str, pack: Pack, ctx: ExtractionContext) -> list[Flag]:
    """Independent check: the deterministic rules read the same quote. Disagreement is flagged."""
    found = _classify(quote, pack, ctx)
    if isinstance(found, Rejection) or not found:
        return []
    flags = []
    if found["assistance"] is not obs.assistance:
        flags.append(Flag(obs.id, "rules_disagree_assistance"))
    if found["environment"] is not obs.environment:
        flags.append(Flag(obs.id, "rules_disagree_environment"))
    if found["activity"] != obs.activity:
        flags.append(Flag(obs.id, "rules_disagree_activity"))
    return flags


# --- consensus (rules + model must agree) -----------------------------------------------


def _same(a: Observation, b: Observation) -> bool:
    return (a.activity, a.environment, a.assistance, a.source_type) == (b.activity, b.environment, b.assistance, b.source_type)


def _overlap(a: Observation, b: Observation) -> bool:
    x, y = a.span_sanitized, b.span_sanitized
    return bool(x and y and x.start < y.end and y.start < x.end)


def extract_consensus(
    client: LLMClient, sanitized: SanitizedText, note: Note, ctx: ExtractionContext, pack: Pack
) -> ExtractionResult:
    """Automatic evidence only where the deterministic rules and the model agree.

    Everything else (seen by one side only, or read differently) goes to ``review`` for a human.
    """
    rules = extract_rules(sanitized, note, ctx, pack)
    llm = extract_with_llm(client, sanitized, note, ctx, pack)
    out = ExtractionResult(rejected=rules.rejected + llm.rejected)
    used: set[str] = set()
    for r in rules.observations:
        match = next((m for m in llm.observations if m.id not in used and _overlap(r, m)), None)
        if match is None:
            out.review.append(ReviewItem("rules_only", r.quote_sanitized or ""))
            continue
        used.add(match.id)
        if _same(r, match):
            out.observations.append(r.model_copy(update={"extracted_by": "both", "id": f"{note.id}-o{len(out.observations) + 1}"}))
        else:
            out.review.append(ReviewItem("fields_differ", r.quote_sanitized or ""))
    for m in llm.observations:
        if m.id not in used:
            out.review.append(ReviewItem("llm_only", m.quote_sanitized or ""))
    return out
