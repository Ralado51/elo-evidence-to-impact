"""Privacy Gate tests. All names and identifiers below are fictional."""

import pytest

from elo.contract import Span
from elo.privacy import PatientRegistry, PrivacyBlocked, PrivacyError, PrivacyGate, SanitizedText


@pytest.fixture
def gate() -> PrivacyGate:
    reg = PatientRegistry()
    reg.add("patient", "Pedro Henrique Souza", "Child-01", aliases=("Pedrinho",))
    reg.add("guardian", "Maria Aparecida Souza", "Caregiver-01")
    reg.allow("Camila")  # synthetic therapist name that may appear
    return PrivacyGate(reg)


REGISTERED = ["Pedro", "Henrique", "Souza", "Pedrinho", "Maria", "Aparecida"]


def assert_clean(sanitized: SanitizedText) -> None:
    low = sanitized.text.lower()
    for name in REGISTERED:
        assert name.lower() not in low, name


# --- pseudonymization -----------------------------------------------------------------


def test_registered_names_are_replaced_by_pseudonyms(gate):
    s = gate.process("Pedro vestiu a camiseta. Maria disse que em casa ele pede ajuda.")
    assert s.text == "Child-01 vestiu a camiseta. Caregiver-01 disse que em casa ele pede ajuda."
    assert_clean(s)


def test_full_name_wins_over_its_parts(gate):
    s = gate.process("Pedro Henrique Souza fez a tarefa.")
    assert s.text == "Child-01 fez a tarefa."


def test_matching_ignores_case_and_accents(gate):
    reg = PatientRegistry()
    reg.add("patient", "João Pedro Álvares", "Child-02")
    s = PrivacyGate(reg).process("JOAO fez a tarefa e joão repetiu; ALVARES ajudou.")
    assert "joao" not in s.text.lower().replace("child-02", "")
    assert s.text.count("Child-02") == 3


def test_alias_is_replaced(gate):
    assert gate.process("Pedrinho riu.").text == "Child-01 riu."


def test_whole_words_only(gate):
    reg = PatientRegistry()
    reg.add("patient", "Ana Lima", "Child-03")
    s = PrivacyGate(reg).process("Ana comeu banana e Lima não.")
    assert s.text == "Child-03 comeu banana e Child-03 não."


def test_particles_alone_are_not_names(gate):
    s = gate.process("A mochila da escola é do menino.")
    assert s.text == "A mochila da escola é do menino."


def test_pseudonyms_must_be_unique():
    reg = PatientRegistry()
    reg.add("patient", "Ana Lima", "P-1")
    with pytest.raises(ValueError):
        reg.add("guardian", "Rita Lima", "P-1")


def test_restore_is_local_display_only(gate):
    s = gate.process("Pedro vestiu a camiseta.")
    assert gate.registry.restore(s.text) == "Pedro Henrique Souza vestiu a camiseta."


# --- fail closed ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, kind",
    [
        ("CPF 123.456.789-09 do responsável.", "cpf"),
        ("CPF 12345678909 do responsável.", "cpf"),
        ("Ligar para (11) 91234-5678.", "phone"),
        ("Ligar para 11 91234-5678.", "phone"),
        ("Escrever para mae.fulana@example.com.", "email"),
        ("CEP 09010-000.", "postal_code"),
        ("RG 12.345.678-9.", "rg"),
        ("Nascido em 12/03/2019.", "birth_date"),
        ("Data de nascimento: 12/03/2019", "birth_date"),
        ("Mora na Rua das Flores, 123.", "address"),
        ("Av. Brasil 4500 fica perto.", "address"),
        ("Atendimento com a Dra. Fulana.", "title_name"),
        ("A mãe Fulana relatou melhora.", "relative_name"),
        ("The mother Mary reported progress.", "relative_name"),
        ("Protocolo 202611091234.", "long_number"),
        ("Siga @fulana_exemplo no Instagram.", "social_handle"),
    ],
)
def test_unregistered_identifiers_block_the_text(gate, text, kind):
    with pytest.raises(PrivacyBlocked) as err:
        gate.process(text)
    assert kind in {f.kind for f in err.value.findings}


def test_blocked_error_never_contains_the_sensitive_text(gate):
    secret = "123.456.789-09"
    with pytest.raises(PrivacyBlocked) as err:
        gate.process(f"CPF {secret}.")
    assert secret not in str(err.value)
    assert all(secret not in repr(f) for f in err.value.findings)


def test_normal_clinical_text_passes(gate):
    text = (
        "Em 02/11/2026, na clínica, a criança de 3 anos e 2 meses vestiu a camiseta sem "
        "assistência física, após instruções verbais. Duração: 10-12 min; 2 tentativas."
    )
    assert gate.process(text).text == text


def test_registered_relative_is_replaced_not_blocked(gate):
    s = gate.process("A mãe Maria relatou que em casa ele pede ajuda.")
    assert "Caregiver-01" in s.text
    assert_clean(s)


def test_allowlisted_name_is_not_blocked(gate):
    assert gate.process("Atendimento com a Dra. Camila.").text == "Atendimento com a Dra. Camila."


def test_inspect_reports_without_raising(gate):
    result = gate.inspect("Pedro, CPF 123.456.789-09.")
    assert result.blocked
    assert "Child-01" in result.text


# --- only the gate can issue text for a model ----------------------------------------


def test_sanitized_text_cannot_be_built_by_hand():
    with pytest.raises(PrivacyError):
        SanitizedText(text="Pedro", replacements=())


# --- offsets --------------------------------------------------------------------------


def test_offsets_round_trip_for_text_outside_names(gate):
    original = "Pedro vestiu a camiseta sem ajuda."
    s = gate.process(original)
    start = original.index("camiseta")
    span = Span(start=start, end=start + len("camiseta"))
    mapped = s.to_sanitized(span)
    assert s.text[mapped.start : mapped.end] == "camiseta"
    back = s.to_original(mapped)
    assert original[back.start : back.end] == "camiseta"


def test_partial_overlap_with_a_pseudonym_expands_to_the_whole_name(gate):
    original = "Pedro Henrique Souza vestiu a camiseta."
    s = gate.process(original)  # "Child-01 vestiu a camiseta."
    inside = Span(start=2, end=5)  # part of "Child-01"
    back = s.to_original(inside)
    assert original[back.start : back.end] == "Pedro Henrique Souza"


def test_offsets_with_several_replacements_of_different_lengths(gate):
    original = "Pedro e Maria viram a camiseta; depois Pedro saiu."
    s = gate.process(original)
    for word in ("viram", "camiseta", "depois", "saiu"):
        a = original.index(word)
        sp = s.to_sanitized(Span(start=a, end=a + len(word)))
        assert s.text[sp.start : sp.end] == word
        bk = s.to_original(sp)
        assert original[bk.start : bk.end] == word


def test_replacements_are_recorded_with_roles(gate):
    s = gate.process("Pedro e Maria chegaram.")
    assert [(r.role, r.pseudonym) for r in s.replacements] == [("patient", "Child-01"), ("guardian", "Caregiver-01")]


# --- property: nothing registered survives -------------------------------------------


@pytest.mark.parametrize(
    "note",
    [
        "Pedro começou bem. Depois Pedrinho pediu ajuda. Maria observou.",
        "PEDRO HENRIQUE SOUZA vestiu a camiseta.",
        "Souza, Maria Aparecida, assinou o termo.",
        "Na escola, o Pedro guardou a mochila; a mãe Maria Aparecida confirmou.",
    ],
)
def test_no_registered_string_survives(gate, note):
    assert_clean(gate.process(note))


def test_registered_name_inside_a_handle_or_with_underscore_is_replaced():
    reg = PatientRegistry()
    reg.add("patient", "Pedro Souza", "Child-01")
    s = PrivacyGate(reg).process("conta pedro_souza e Pedro-Souza")
    assert "pedro" not in s.text.lower().replace("child-01", "")


def test_known_limit_a_bare_unregistered_name_is_not_detected(gate):
    # Documented limit: without a title, relation word or pattern, an unregistered name passes.
    # This is one reason the competition uses synthetic data only.
    assert gate.process("Lucas ajudou o Pedro.").text == "Lucas ajudou o Child-01."
