"""Read-only explanations of authorized, published CMP-19 evolution snapshots."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .authz import Principal
from .errors import V3Error

if TYPE_CHECKING:
    from .evolution import EvolutionTimelineService


def explain_published_evolution(
    service: EvolutionTimelineService, evolution_id: str, principal: Principal
) -> dict[str, Any]:
    """Build therapist-facing provenance from the historical publication.

    The existing service authorizes access and provides the frozen publication.
    This layer does not repartition, join current facts, or infer a change from
    absent entries. The participant's simplified view remains a separate surface.
    """
    if principal.role != "therapist":
        raise V3Error("NOT_FOUND", "Evolution not found.")
    return describe_publication(service.get_evolution(evolution_id, principal))


def describe_publication(result: dict[str, Any]) -> dict[str, Any]:
    """Explain an already authorized therapist publication."""
    event = result["event"]
    payload = event["payload"]

    summaries = []
    for series in payload["series"]:
        key_hash = series["series_key_hash"]
        key = result["series_keys"][key_hash]
        references = [
            {"fact_id": item["fact_id"], "content_hash": item["content_hash"]}
            for item in series["items"]
        ]
        by_id = {item["fact_id"]: item for item in references}

        def provenance(change: dict[str, Any]) -> dict[str, Any]:
            return {
                "from_fact": dict(by_id[change["from_fact_id"]]),
                "to_fact": dict(by_id[change["to_fact_id"]]),
            }

        changes = [
            {**provenance(change), "dimension": change["dimension"],
             "from": change["from"], "to": change["to"]}
            for change in result["context_changes"].get(key_hash, [])
        ]
        assistance = [
            {**provenance(change), "direction": change["direction"]}
            for change in payload["assistance_transitions"]
            if change["series_key_hash"] == key_hash
        ]
        if len(references) < 2:
            status = "insufficient_items"
        elif changes or assistance:
            status = "published_descriptions_available"
        else:
            status = "no_published_description"
        summaries.append({
            "series_key_hash": key_hash,
            "technical_key": dict(key),
            "published_facts": references,
            "context_changes": changes,
            "reported_assistance": assistance,
            "status": status,
        })

    return {
        "publication": {
            "evolution_id": payload["evolution_id"],
            "event_id": event["event_id"],
            "content_hash": payload["content_hash"],
            "data_origin": event["data_origin"],
            "period_from": payload["period_from"],
            "period_to": payload["period_to"],
            "comparability_rules_version": payload["comparability_rules_version"],
        },
        "status": "published_series_available" if summaries else "insufficient_items",
        "series": summaries,
        "separations": [
            {"kind": notice["kind"], "series_key_hashes": list(notice["series_key_hashes"]),
             "differing_keys": list(notice["differing_keys"])}
            for notice in result["notices"]
        ],
    }
