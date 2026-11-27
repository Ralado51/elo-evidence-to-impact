"""In-memory S4 draft preparation for synthetic source text."""
from dataclasses import dataclass
from typing import Literal, Protocol

from .entities import load_entity_schema, validate


@dataclass(frozen=True)
class DraftSource:
    text: str
    role: Literal["participant", "therapist"]
    author_ref: str
    data_origin: Literal["synthetic_fixture"]


@dataclass(frozen=True)
class Suggestion:
    field_key: str
    start: int
    end: int
    state: Literal["proposed", "ambiguous"]


class AssistanceProvider(Protocol):
    def structure(self, text: str, field_keys: tuple[str, ...]) -> tuple[Suggestion, ...]:
        """Locate complete source lines with zero-based, end-exclusive code point offsets."""
        ...


def prepare_draft(
    source: DraftSource,
    *,
    target: str,
    field_keys: tuple[str, ...],
    provider: AssistanceProvider | None = None,
    manual_values: dict[str, str] | None = None,
) -> dict:
    """Return an editable local payload and provenance, with no persistence capability."""
    entity_schema = load_entity_schema("draft")["properties"]
    prefix = {"participant": "p_", "therapist": "t_"}.get(source.role)
    if (source.data_origin != "synthetic_fixture" or prefix is None
            or not isinstance(source.author_ref, str) or not source.author_ref.startswith(prefix)
            or validate(entity_schema["author"], {"role": source.role, "id": source.author_ref})
            or not isinstance(source.text, str) or len(source.text) > 8000
            or len(field_keys) > 100 or len(set(field_keys)) != len(field_keys)
            or (manual_values is not None and (provider is not None or set(manual_values) - set(field_keys)))):
        raise ValueError("Invalid synthetic draft input")
    if source.role == "participant" and target != "session_report":
        raise ValueError("Participant draft must target a session report")

    proposals = {
        key: {"field_key": key, "proposed_value": "", "state": "missing"} for key in field_keys
    }
    payload = {
        "draft_kind": "session_report_proposal" if target == "session_report" else "structured_extraction",
        "target": target,
        "status": "draft",
        "produced_by": "manual_form" if provider is None else "assisted_structuring",
        "retention_class": "session_only",
        "transcript_text": source.text,
        "proposals": list(proposals.values()),
        "audio_retained": False,
        "engine_label": None,
        "microphone_consent_ref": None,
        "confirmed_entity_ref": None,
        "confirmed_by": None,
    }
    schema = entity_schema["payload"]
    if validate(schema, payload):
        raise ValueError("Invalid draft target or requested fields")

    spans = {}
    if provider is not None:
        try:
            results = provider.structure(source.text, field_keys)
        except Exception:
            return {"status": "manual_available", "reason": "provider_unavailable"}
        if not isinstance(results, tuple) or len(results) > len(field_keys):
            return {"status": "manual_available", "reason": "provider_output_invalid"}
        for item in results:
            if (not isinstance(item, Suggestion) or type(item.field_key) is not str
                    or item.field_key not in proposals or item.field_key in spans
                    or type(item.start) is not int or type(item.end) is not int
                    or not 0 <= item.start < item.end <= len(source.text)
                    or (item.start > 0 and source.text[item.start - 1] != "\n")
                    or (item.end < len(source.text) and source.text[item.end] != "\n")
                    or "\n" in source.text[item.start:item.end]
                    or not source.text[item.start:item.end].strip()
                    or item.state not in ("proposed", "ambiguous")):
                return {"status": "manual_available", "reason": "provider_output_invalid"}
            spans[item.field_key] = (item.start, item.end)
            proposals[item.field_key].update(
                proposed_value=source.text[item.start:item.end], state=item.state
            )
    elif manual_values is not None:
        for key, value in manual_values.items():
            proposals[key].update(proposed_value=value, state="proposed")

    if validate(schema, payload):
        if provider is not None:
            return {"status": "manual_available", "reason": "provider_output_invalid"}
        raise ValueError("Invalid manual draft values")
    return {
        "status": "ready_for_human_review",
        "payload": payload,
        "provenance": {
            "author": {"role": source.role, "id": source.author_ref},
            "data_origin": source.data_origin,
            "spans": spans,
        },
    }
