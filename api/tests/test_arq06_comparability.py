"""Blocking characterization of the frozen comparability key consumed by Progress."""
import pytest

from elo.canonical import hash_canonical
from elo.v3.evolution import (
    check_series_comparability,
    load_comparability_rules,
    load_progress_series_schema,
)

KEYS = load_comparability_rules()["technical_criteria"]["keys"]
KEY = dict.fromkeys(KEYS, "synthetic_value")


def test_catalog_and_wire_schema_require_the_same_fourteen_technical_keys():
    schema = load_progress_series_schema()["properties"]["series_key"]
    assert len(KEYS) == 14
    assert set(KEYS) == set(schema["required"])
    assert set(KEYS) == set(schema["properties"])
    assert not set(KEYS) & set(load_comparability_rules()["contextual_dimensions"]["dimensions"])
    assert check_series_comparability([KEY, dict(reversed(list(KEY.items())))], declared_hash=hash_canonical(KEY)) == (True, None)


@pytest.mark.parametrize("dimension", KEYS)
def test_each_technical_dimension_is_required_to_match(dimension):
    other = {**KEY, dimension: "different_synthetic_value"}
    assert check_series_comparability([KEY, other]) == (False, "COMPARABILITY_VIOLATION")
    assert check_series_comparability([other], declared_hash=hash_canonical(KEY)) == (False, "COMPARABILITY_VIOLATION")
