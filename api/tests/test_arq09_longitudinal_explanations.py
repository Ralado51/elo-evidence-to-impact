"""Synthetic ARQ-09 explanations using the existing CMP-19 read/authorization path."""
from copy import deepcopy

import pytest

from elo.canonical import hash_canonical
from elo.v3.authz import CareLinkView, Principal
from elo.v3.errors import V3Error
from elo.v3.evolution import EvolutionTimelineService, compute_split_notices, load_comparability_rules
from elo.v3.longitudinal_explanations import explain_published_evolution

ORG = "o_fixture01"
PATIENT = "p_fixture01"
THERAPIST = Principal("therapist", "t_fixture01", ORG)
EVOLUTION = "evo_fixture01"
IDS = [f"f_{i:064x}" for i in range(1, 5)]
HASHES = [f"{i:064x}" for i in range(5, 9)]


class SnapshotStore:
    def __init__(self):
        keys = load_comparability_rules()["technical_criteria"]["keys"]
        key = dict.fromkeys(keys, "fixture")
        key.update(participant_id=PATIENT, movement_task="organizar-a-mesa", fact_type="F04",
                   laterality="right", method="reported_assistance", fact_definition_version="2",
                   data_origin_class="synthetic_fixture")
        other_key = {**key, "laterality": "left"}
        right, left = hash_canonical(key), hash_canonical(other_key)
        self.right, self.left = right, left
        self.event = {
            "event_id": "a" * 64, "scope": {"org_id": ORG, "participant_id": PATIENT},
            "data_origin": "synthetic_fixture",
            "payload": {
                "evolution_id": EVOLUTION, "content_hash": "b" * 64, "period_from": "2026-11-01",
                "period_to": "2026-11-30", "comparability_rules_version": "cmp-v1",
                "note_refs": ["sensitive-fixture-omit"],
                "series": [
                    {"series_key_hash": digest, "items": [
                        {"fact_id": IDS[i], "content_hash": HASHES[i]} for i in indexes
                    ]}
                    for digest, indexes in [(right, [0, 1, 2]), (left, [3])]
                ],
                "assistance_transitions": [
                    {"series_key_hash": right, "from_fact_id": IDS[i], "to_fact_id": IDS[i + 1],
                     "direction": direction}
                    for i, direction in enumerate(("more_help_reported", "less_help_reported"))
                ],
            },
        }
        self.snapshot = {
            "series_keys": {right: key, left: other_key},
            "notices": compute_split_notices([(right, key), (left, other_key)]),
            "context_changes": {right: [
                {"from_fact_id": IDS[0], "to_fact_id": IDS[1],
                 "dimension": "assistance_level", "from": "some", "to": "full"},
                {"from_fact_id": IDS[1], "to_fact_id": IDS[2],
                 "dimension": "assistance_level", "from": "full", "to": "some"},
            ]},
        }

    def get_evolution_record(self, evolution_id):
        if evolution_id == EVOLUTION:
            return self.event, None, self.snapshot
        return None

    def latest_care_links(self, *, participant_id):
        assert participant_id == PATIENT
        return [CareLinkView("cl_fixture01", ORG, PATIENT, THERAPIST.id, "active", "2020-01-01")]


def test_explains_existing_partitions_and_intermediate_changes_by_version():
    store = SnapshotStore()
    original = deepcopy((store.event, store.snapshot))
    result = explain_published_evolution(EvolutionTimelineService(store), EVOLUTION, THERAPIST)
    right, left = result["series"]
    assert [right["series_key_hash"], left["series_key_hash"]] == [store.right, store.left]
    assert len(right["technical_key"]) == 14
    assert result["separations"][0]["differing_keys"] == ["laterality"]
    assert [item["direction"] for item in right["reported_assistance"]] == [
        "more_help_reported", "less_help_reported",
    ]
    assert right["context_changes"][1]["from_fact"] == {"fact_id": IDS[1], "content_hash": HASHES[1]}
    assert right["context_changes"][1]["to_fact"] == {"fact_id": IDS[2], "content_hash": HASHES[2]}
    assert left["status"] == "insufficient_items"
    assert left["reported_assistance"] == []
    assert result["publication"]["data_origin"] == "synthetic_fixture"
    assert "sensitive-fixture-omit" not in repr(result)
    right["published_facts"][0]["content_hash"] = "changed"
    result["separations"][0]["differing_keys"].clear()
    assert (store.event, store.snapshot) == original


def test_absence_of_a_published_variation_is_not_stability_or_zero():
    store = SnapshotStore()
    store.event["payload"]["assistance_transitions"] = []
    store.snapshot["context_changes"] = {}
    view = explain_published_evolution(EvolutionTimelineService(store), EVOLUTION, THERAPIST)
    assert view["series"][0]["status"] == "no_published_description"
    assert view["series"][0]["context_changes"] == []
    assert view["series"][0]["reported_assistance"] == []
    assert len(view["series"][0]["published_facts"]) == 3


@pytest.mark.parametrize("principal", [
    Principal("therapist", "t_other001", ORG),
    Principal("therapist", THERAPIST.id, "o_other001"),
    Principal("participant", PATIENT, ORG),
])
def test_internal_provenance_stays_unavailable_across_roles_links_and_organizations(principal):
    with pytest.raises(V3Error) as error:
        explain_published_evolution(EvolutionTimelineService(SnapshotStore()), EVOLUTION, principal)
    assert error.value.code == "NOT_FOUND"


def test_unknown_publication_does_not_produce_an_explanation():
    with pytest.raises(V3Error) as error:
        explain_published_evolution(EvolutionTimelineService(SnapshotStore()), "evo_missing01", THERAPIST)
    assert error.value.code == "NOT_FOUND"
