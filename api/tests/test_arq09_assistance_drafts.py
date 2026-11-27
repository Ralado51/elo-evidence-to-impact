import json
from dataclasses import replace
from pathlib import Path

import pytest

from elo.v3.assistance_drafts import DraftSource, Suggestion, prepare_draft
from elo.v3.entities import load_entity_schema, validate

LINE = "Não completou com a mão esquerda."
SOURCE = DraftSource(LINE + "\nLado não confirmado.", "therapist", "t_fixture01", "synthetic_fixture")
FIELDS = ("execution", "laterality", "assistance")


class SyntheticProvider:
    def structure(self, text, keys):
        assert text == SOURCE.text and keys == FIELDS
        return (
            Suggestion("execution", 0, len(LINE), "proposed"),
            Suggestion("laterality", len(LINE) + 1, len(text), "ambiguous"),
        )


def test_verbatim_negation_laterality_ambiguity_provenance_and_schema():
    result = prepare_draft(SOURCE, target="encounter", field_keys=FIELDS, provider=SyntheticProvider())
    draft = result["payload"]
    assert not validate(load_entity_schema("draft")["properties"]["payload"], draft)
    assert draft["proposals"] == [
        {"field_key": "execution", "proposed_value": LINE, "state": "proposed"},
        {"field_key": "laterality", "proposed_value": "Lado não confirmado.", "state": "ambiguous"},
        {"field_key": "assistance", "proposed_value": "", "state": "missing"},
    ]
    assert draft["status"] == "draft"
    assert result["status"] == "ready_for_human_review"
    assert draft["confirmed_by"] is None and draft["confirmed_entity_ref"] is None
    assert result["provenance"]["author"]["id"] == SOURCE.author_ref
    assert result["provenance"]["data_origin"] == "synthetic_fixture"
    assert result["provenance"]["spans"]["execution"] == (0, len(LINE))


@pytest.mark.parametrize("output", [
    {"status": "confirmed"},
    (Suggestion("execution", 4, len(LINE), "proposed"),),
    (Suggestion("other", 0, len(LINE), "proposed"),),
    (Suggestion("execution", False, len(LINE), "proposed"),),
    (Suggestion("execution", 0, len(LINE), "proposed"),) * 2,
])
def test_invalid_output_keeps_manual_path(output):
    class Invalid:
        def structure(self, *_):
            return output
    assert prepare_draft(SOURCE, target="encounter", field_keys=FIELDS, provider=Invalid()) == {
        "status": "manual_available", "reason": "provider_output_invalid",
    }


def test_failure_is_sanitized_and_manual_keeps_explicit_zero():
    class Unavailable:
        def structure(self, *_):
            raise RuntimeError("internal value must not leak")
    assert prepare_draft(SOURCE, target="encounter", field_keys=FIELDS, provider=Unavailable()) == {
        "status": "manual_available", "reason": "provider_unavailable",
    }
    result = prepare_draft(SOURCE, target="encounter", field_keys=FIELDS, manual_values={"assistance": "0"})
    assert result["payload"]["produced_by"] == "manual_form"
    assert result["payload"]["proposals"][-1]["proposed_value"] == "0"
    assert result["payload"]["proposals"][0]["state"] == "missing"


def test_rejects_non_synthetic_source_and_out_of_role_target():
    with pytest.raises(ValueError):
        prepare_draft(replace(SOURCE, data_origin="live"), target="encounter", field_keys=FIELDS)
    participant = replace(SOURCE, role="participant", author_ref="p_fixture01")
    with pytest.raises(ValueError):
        prepare_draft(participant, target="goal", field_keys=FIELDS)
    assert prepare_draft(participant, target="session_report", field_keys=FIELDS)["payload"]["draft_kind"] == "session_report_proposal"


def test_browser_example_is_the_validated_synthetic_provider_output():
    fixture = Path(__file__).resolve().parents[2] / "web/v3/assistance/draft_fixture.mjs"
    module = fixture.read_text(encoding="utf-8").strip()
    assert module.startswith("export default ") and module.endswith(";")
    rendered = json.loads(module[len("export default "):-1])
    result = prepare_draft(SOURCE, target="encounter", field_keys=FIELDS, provider=SyntheticProvider())
    assert rendered == result["payload"]
