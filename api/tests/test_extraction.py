import json
from datetime import date

import pytest

from elo.contract import Assistance, Environment, Note, SourceType, Verdict, Claim
from elo.extraction import (ExtractionContext, ExtractionError, extract_rules,
                            extract_with_llm)
from elo.packs import load_pack
from elo.privacy import PatientRegistry, PrivacyError, PrivacyGate
from elo.verifier import verify

PACK = load_pack()
CTX = ExtractionContext(session_date=date(2026, 11, 5))


def prep(text):
    reg = PatientRegistry()
    reg.add("patient", "Pedro Souza", "Paciente A")
    gate = PrivacyGate(reg)
    s = gate.process(text)
    note = Note(id="n1", session_id="s1", original_text=text, sanitized_text=s.text)
    return s, note, reg


def test_headline_pt():
    s, note, _ = prep("Pedro vestiu a camiseta na clínica sem assistência física, após instruções verbais.")
    r = extract_rules(s, note, CTX, PACK)
    assert len(r.observations) == 1
    o = r.observations[0]
    assert (o.activity, o.environment, o.assistance) == ("dressing_upper", Environment.CLINIC, Assistance.VERBAL_PROMPT)
    assert o.is_direct and "Pedro" in o.quote and "Pedro" not in o.quote_sanitized


def test_headline_en():
    s, note, _ = prep("Pedro put on the shirt at the clinic with verbal prompts.")
    o = extract_rules(s, note, CTX, PACK).observations[0]
    assert o.assistance is Assistance.VERBAL_PROMPT and o.environment is Environment.CLINIC


def test_unclear_assistance_rejected():
    s, note, _ = prep("Pedro vestiu a camiseta na clínica.")
    r = extract_rules(s, note, CTX, PACK)
    assert not r.observations and r.rejected[0].reason == "assistance_unclear"


def test_unclear_environment_rejected_then_default():
    s, note, _ = prep("Pedro vestiu a camiseta com dicas verbais.")
    assert extract_rules(s, note, CTX, PACK).rejected[0].reason == "environment_unclear"
    ctx = ExtractionContext(session_date=date(2026, 11, 5), default_environment=Environment.CLINIC)
    assert extract_rules(s, note, ctx, PACK).observations[0].environment is Environment.CLINIC


def test_caregiver_report_source():
    s, note, _ = prep("A mãe relatou que em casa Pedro vestiu a camiseta sozinho.")
    o = extract_rules(s, note, CTX, PACK).observations[0]
    assert o.source_type is SourceType.CAREGIVER_REPORT and o.reported_by


def test_end_to_end_gap():
    s, note, _ = prep("Pedro vestiu a camiseta na clínica sem assistência física, após instruções verbais.")
    obs = extract_rules(s, note, CTX, PACK).observations
    claim = Claim(id="c1", session_id="s1", text="x", activity="dressing_upper",
                  environment=Environment.HOME, assistance=Assistance.VERBAL_PROMPT)
    assert verify(claim, obs).verdict is Verdict.INSUFFICIENT_EVIDENCE


def test_plain_str_refused():
    _, note, _ = prep("Pedro vestiu a camiseta na clínica.")
    with pytest.raises(PrivacyError):
        extract_rules(note.sanitized_text, note, CTX, PACK)


class Fake:
    def __init__(self, payload):
        self.payload, self.seen = payload, []

    def complete_json(self, system, user):
        self.seen.append(system + user)
        return self.payload if isinstance(self.payload, str) else json.dumps(self.payload)


def item(**kw):
    d = dict(activity="dressing_upper", action="vestiu", environment="clinic",
             assistance="verbal_prompt", source_type="direct_observation",
             reported_by=None, quote="vestiu a camiseta na clínica")
    d.update(kw)
    return d


def test_llm_valid_and_prompt_has_no_name():
    s, note, _ = prep("Pedro vestiu a camiseta na clínica, após instruções verbais.")
    f = Fake({"observations": [item()]})
    r = extract_with_llm(f, s, note, CTX, PACK)
    assert r.observations[0].extracted_by == "llm"
    assert "Pedro" not in f.seen[0] and "Paciente A" in f.seen[0]


@pytest.mark.parametrize("bad,reason", [
    (item(quote="inventou algo"), "quote_not_found"),
    (item(activity="flying"), "unknown_activity"),
    (item(assistance="magic"), "invalid_value"),
])
def test_llm_rejections(bad, reason):
    s, note, _ = prep("Pedro vestiu a camiseta na clínica, após instruções verbais.")
    r = extract_with_llm(Fake({"observations": [bad]}), s, note, CTX, PACK)
    assert not r.observations and r.rejected[0].reason == reason


def test_llm_malformed_json():
    s, note, _ = prep("Pedro vestiu a camiseta na clínica.")
    with pytest.raises(ExtractionError):
        extract_with_llm(Fake("not json"), s, note, CTX, PACK)


def test_llm_duplicate_quote_uses_distinct_spans():
    text = "Pedro vestiu a camiseta na clínica. Pedro vestiu a camiseta na clínica."
    s, note, _ = prep(text)
    r = extract_with_llm(Fake({"observations": [item(), item()]}), s, note, CTX, PACK)
    a, b = (o.span_original for o in r.observations)
    assert a.end <= b.start


def test_llm_disagreement_flagged():
    s, note, _ = prep("Pedro vestiu a camiseta na clínica com instruções verbais.")
    r = extract_with_llm(Fake({"observations": [item(assistance="independent", quote="vestiu a camiseta na clínica com instruções verbais")]}), s, note, CTX, PACK)
    assert any(f.kind == "rules_disagree_assistance" for f in r.flags)


@pytest.mark.skipif(not __import__("os").environ.get("LLM_BASE_URL"), reason="no LLM configured")
def test_live_model_never_breaks_the_contract():
    from elo.llm import OpenAICompatibleClient
    client = OpenAICompatibleClient.from_env()
    s, note, _ = prep("Pedro vestiu a camiseta na clínica sem assistência física, após instruções verbais.")
    try:
        r = extract_with_llm(client, s, note, CTX, PACK)
    except ExtractionError:
        return  # a weak model may return bad JSON; that must fail closed, not crash
    for o in r.observations:
        o.check_against(note)


# --- consensus ---
from elo.extraction import extract_consensus  # noqa: E402


def test_consensus_accepts_only_agreement():
    s, note, _ = prep("Pedro vestiu a camiseta na clínica com instruções verbais.")
    q = "Pedro vestiu a camiseta na clínica com instruções verbais.".replace("Pedro", "Paciente A")
    r = extract_consensus(Fake({"observations": [item(quote=q)]}), s, note, CTX, PACK)
    assert len(r.observations) == 1 and r.observations[0].extracted_by == "both" and not r.review


def test_consensus_sends_disagreement_to_review():
    s, note, _ = prep("Pedro vestiu a camiseta na clínica com instruções verbais.")
    q = "Paciente A vestiu a camiseta na clínica com instruções verbais."
    r = extract_consensus(Fake({"observations": [item(quote=q, assistance="independent")]}), s, note, CTX, PACK)
    assert not r.observations and [x.kind for x in r.review] == ["fields_differ"]


def test_consensus_rules_only_and_llm_only_are_not_evidence():
    s, note, _ = prep("Pedro vestiu a camiseta na clínica com instruções verbais.")
    r = extract_consensus(Fake({"observations": []}), s, note, CTX, PACK)
    assert not r.observations and [x.kind for x in r.review] == ["rules_only"]
    s2, note2, _ = prep("Pedro escovou os dentes na clínica. Precisou de instruções verbais.")
    q = "Paciente A escovou os dentes na clínica."
    r2 = extract_consensus(Fake({"observations": [item(activity="toothbrushing", quote=q)]}), s2, note2, CTX, PACK)
    assert not r2.observations and [x.kind for x in r2.review] == ["llm_only"]


def test_code_decides_source_not_the_model():
    s, note, _ = prep("A mãe relatou que em casa Pedro vestiu a camiseta sozinho.")
    q = "A mãe relatou que em casa Paciente A vestiu a camiseta sozinho."
    wrong = item(quote=q, environment="home", assistance="independent", source_type="direct_observation")
    r = extract_with_llm(Fake({"observations": [wrong]}), s, note, CTX, PACK)
    assert r.observations[0].source_type is SourceType.CAREGIVER_REPORT and r.observations[0].reported_by
    assert any(f.kind == "model_source_overridden" for f in r.flags)


def test_hand_guiding_is_partial_physical_help():
    s, note, _ = prep("Pedro escovou os dentes em casa quase sozinho, mas a mãe guiou a mão dele.")
    o = extract_rules(s, note, CTX, PACK).observations[0]
    assert o.assistance is Assistance.PHYSICAL_PARTIAL


def test_markers_block_unsafe_independence_in_rules_and_in_the_model_path():
    for text in ("Pedro não conseguiu vestir a camiseta sozinho na clínica.",
                 "Pedro quase vestiu a camiseta sozinho na escola.",
                 "A meta é que Pedro vista a camiseta sozinho em casa.",
                 "Se Pedro vestir a camiseta sozinho em casa, será reforçado."):
        s, note, _ = prep(text)
        assert not extract_rules(s, note, CTX, PACK).observations, text
        env = "home" if "casa" in text else "clinic" if "clínica" in text else "school"
        q = text.replace("Pedro", "Paciente A")
        r = extract_with_llm(Fake({"observations": [item(quote=q, environment=env, assistance="independent")]}), s, note, CTX, PACK)
        assert not r.observations and r.rejected, text


def test_failure_marker_does_not_hide_real_help():
    s, note, _ = prep("Pedro escovou os dentes em casa quase sozinho, mas a mãe guiou a mão dele.")
    assert extract_rules(s, note, CTX, PACK).observations[0].assistance is Assistance.PHYSICAL_PARTIAL


def test_family_report_phrases():
    s, note, _ = prep("Segundo a avó, Pedro usou a colher sozinho em casa.")
    assert extract_rules(s, note, CTX, PACK).observations[0].source_type is SourceType.CAREGIVER_REPORT
