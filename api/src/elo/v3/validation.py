"""CL06.3 v3 unified validation layer, real-data gate, and consent state/requirement.

Origin-Source: contracts/CL06_3/reference/python/elo_ref.py
Origin-SHA256: a88f324099523f4cc66f24cf5c9ecdcc5b8f69ec5999418d9a1635955d3439a0
Origin-License: Apache-2.0
Origin-Attribution: Airton Justino O. Junior (Elo CL06.3 contract package; ported per PO-F10)

Ported functions in this module: ``check_event_semantics``, ``check_session_stream``
(and constants ``STREAM_OF``, ``START_SOURCE``).
Reuses ``check_event_integrity`` from ``elo.canonical`` and ``validate``,
``check_entity_semantics``, ``check_entity_chain`` from ``elo.v3.entities`` without duplication.
Standard library only.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from collections.abc import Set as AbstractSet
from functools import lru_cache
from typing import Any

from elo.canonical import CanonicalizationError, check_event_integrity
from elo.v3.entities import (
    CONTRACTS_R1,
    ENTITY_PREFIX,
    check_entity_chain,
    check_entity_semantics,
    load_entity_schema,
    load_event_catalog,
    validate,
)

# Single explicit server setting governing the PD-05 real-data gate (closed by default).
REAL_DATA_GATE_ENV = "ELO_V3_REAL_DATA_GATE_OPEN"

STREAM_OF = {
    "session": lambda e: "session:" + e["scope"].get("session_id", ""),
    "prescription": lambda e: "prescription:" + e["scope"].get("prescription_id", ""),
    "consent": lambda e: "consent:" + e["scope"]["participant_id"],
    "review": lambda e: "review:%s.%s" % (e["actor"]["id"], e["scope"]["participant_id"]),
    "privacy": lambda e: "privacy:" + e["scope"]["participant_id"],
}
START_SOURCE = {
    "camera": "camera",
    "simulation": "simulation",
    "report_only": "participant_report",
}


def is_real_data_gate_open(env: Mapping[str, str] | None = None) -> bool:
    """Return True iff the explicit server setting opens the PD-05 real-data gate.

    Closed by default and in every committed configuration. Must only be read at
    server/app startup, never from request bodies, headers, or query parameters.
    """
    source = os.environ if env is None else env
    raw = source.get(REAL_DATA_GATE_ENV, "")
    return isinstance(raw, str) and raw.strip().lower() in ("1", "true", "yes")


def check_real_data_gate(data_origin: str | None, *, gate_open: bool = False) -> list[str]:
    """Enforce the PD-05 real-data gate for any event or entity data_origin."""
    if data_origin == "live" and not gate_open:
        return ["REAL_DATA_GATE_CLOSED"]
    return []


@lru_cache(maxsize=32)
def load_event_schema(event_type: str) -> dict[str, Any] | None:
    """Load an r1 event JSON schema by event type, or None if unknown."""
    cat = load_event_catalog()
    if event_type not in cat["types"]:
        return None
    path = CONTRACTS_R1 / "schemas" / "events" / f"{event_type}.schema.json"
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def load_limits_catalog() -> dict[str, Any]:
    """Load the r1 technical prescription limits catalog."""
    path = CONTRACTS_R1 / "catalogs" / "limits.v1.json"
    return json.loads(path.read_text(encoding="utf-8"))


def check_event_semantics(
    e: dict[str, Any],
    cat: dict[str, Any],
    limits: dict[str, Any],
    real_data_gate_open: bool = False,
) -> list[str]:
    """Stateless cross-field rules for one v3 event (ported from reference/python/elo_ref.py)."""
    errs: list[str] = []
    t = cat["types"][e["type"]]
    if e["actor"]["role"] not in t["actors"]:
        errs.append("ACTOR_NOT_ALLOWED")
    if e["source"]["type"] not in t["sources"]:
        errs.append("SOURCE_NOT_ALLOWED")
    sc = e["scope"]
    for k in t["scope"]["required"]:
        if k not in sc:
            errs.append("SCOPE_INVALID")
    for k in t["scope"]["forbidden"]:
        if k in sc:
            errs.append("SCOPE_INVALID")
    if e["stream_id"] != STREAM_OF[t["stream"]](e):
        errs.append("STREAM_MISMATCH")
    alg = t["algorithm"]
    has = "algorithm_version" in e["source"]
    if (
        (alg == "required" and not has)
        or (alg == "forbidden" and has)
        or (alg == "capture-only" and has != (e["source"]["type"] in ("camera", "simulation")))
    ):
        errs.append("VERSION_MISMATCH")
    mono = "t_mono_ms" in e
    if (t["mono"] == "required" and not mono) or (t["mono"] == "forbidden" and mono):
        errs.append("RULE_VIOLATION")
    em = e["execution_mode"]
    if t["stream"] != "session":
        if em != "not_applicable":
            errs.append("EXECUTION_MODE_MISMATCH")
    else:
        if em == "not_applicable":
            errs.append("EXECUTION_MODE_MISMATCH")
        if e["type"] == "session.started":
            if e["seq"] != 1:
                errs.append("RULE_VIOLATION")
            if e["payload"]["source_mode"] != em or START_SOURCE[em] != e["source"]["type"]:
                errs.append("EXECUTION_MODE_MISMATCH")
            if (em == "report_only") != (e["payload"]["capture_context"] is None):
                errs.append("RULE_VIOLATION")
        elif t["sources"] == ["camera", "simulation"] and e["source"]["type"] != em:
            errs.append("EXECUTION_MODE_MISMATCH")
    if e["data_origin"] in cat["rules"]["origin_ref_required_for"] and "origin_ref" not in e:
        errs.append("ORIGIN_REF_REQUIRED")
    errs.extend(check_real_data_gate(e["data_origin"], gate_open=real_data_gate_open))
    if e["type"] == "prescription.published":
        p = e["payload"]
        if (
            p["limits_version"] != limits["limits_version"]
            or p["target_sets"] > limits["max_sets"]
            or p["target_repetitions"] > limits["max_repetitions"]
            or p["target_sets"] * p["target_repetitions"] > limits["max_product"]
        ):
            errs.append("LIMITS_EXCEEDED")
        if e["seq"] != p["revision"] or sc.get("prescription_revision") != p["revision"]:
            errs.append("RULE_VIOLATION")
        if (p["supersedes_revision"] if p["revision"] > 1 else None) != (
            p["revision"] - 1 if p["revision"] > 1 else None
        ):
            errs.append("RULE_VIOLATION")
    return sorted(set(errs))


def check_session_stream(events: Sequence[dict[str, Any]], prescription_payload: dict[str, Any]) -> list[str]:
    """Stream-level rules for one session stream (ported from reference/python/elo_ref.py)."""
    errs: list[str] = []
    side = prescription_payload["side"]
    start = next((e for e in events if e["type"] == "session.started"), None)
    for e in events:
        if start and e["execution_mode"] != start["execution_mode"]:
            errs.append("EXECUTION_MODE_MISMATCH")
        if e["type"] == "cycle.accepted":
            h = e["payload"]["handedness"]
            if h is not None and h["label"] != side:
                errs.append("HANDEDNESS_INCOMPATIBLE_ACCEPTED")
        if e["type"] == "cycle.rejected" and e["payload"]["reason"] == "handedness_incompatible":
            h = e["payload"]["handedness"]
            if h is None or h["label"] == side:
                errs.append("RULE_VIOLATION")
    return sorted(set(errs))


def validate_event(event: Any, *, gate_open: bool = False) -> list[str]:
    """Validate one CL06.3 v3 event (schema + integrity + stateless semantics).

    Never raises (D-S0-03-3). Returns the sorted deduplicated code list equal to the
    reference composition (schema codes, plus integrity codes and semantics codes only
    where each stage can run). Retains ``ONEOF`` if emitted by schema validation (D-S0-03-4).
    """
    if not isinstance(event, dict):
        return ["TYPE"]
    if "type" not in event:
        return ["MISSING_FIELD"]
    event_type = event["type"]
    if not isinstance(event_type, str):
        return ["TYPE"]
    schema = load_event_schema(event_type)
    if schema is None:
        return ["UNKNOWN_TYPE"]

    codes: set[str] = set()
    try:
        codes.update(code for _, code in validate(schema, event))
    except CanonicalizationError:
        codes.add("NON_CANONICAL")
    except Exception:
        codes.add("RULE_VIOLATION")

    try:
        codes.update(check_event_integrity(event))
    except CanonicalizationError:
        codes.add("NON_CANONICAL")
    except Exception:
        pass

    try:
        codes.update(
            check_event_semantics(
                event,
                load_event_catalog(),
                load_limits_catalog(),
                real_data_gate_open=gate_open,
            )
        )
    except Exception:
        pass

    return sorted(codes)


def validate_entity(entity: Any, *, gate_open: bool = False) -> list[str]:
    """Validate one CL06.3 v3 entity (schema + stateless semantics).

    Never raises (D-S0-03-3). Returns the sorted deduplicated code list equal to the
    reference composition (schema codes, plus semantics codes where that stage can run).
    Retains ``ONEOF`` for exact parity with REF and INVALID.entities (D-S0-03-4).
    """
    if not isinstance(entity, dict):
        return ["TYPE"]
    if "entity_type" not in entity:
        return ["MISSING_FIELD"]
    entity_type = entity["entity_type"]
    if not isinstance(entity_type, str):
        return ["TYPE"]
    if entity_type not in ENTITY_PREFIX:
        return ["UNKNOWN_TYPE"]

    schema = load_entity_schema(entity_type)
    codes: set[str] = set()
    try:
        codes.update(code for _, code in validate(schema, entity))
    except CanonicalizationError:
        codes.add("NON_CANONICAL")
    except Exception:
        codes.add("RULE_VIOLATION")

    try:
        codes.update(
            check_entity_semantics(
                entity,
                load_event_catalog(),
                real_data_gate_open=gate_open,
            )
        )
    except Exception:
        pass

    return sorted(codes)


def validate_entity_chain(versions: Sequence[dict[str, Any]]) -> list[str]:
    """Validate an entity version chain without raising."""
    try:
        return check_entity_chain(list(versions))
    except Exception:
        return ["ENTITY_CHAIN_BROKEN"]


# ---------------- Consent fold and requirement (D-S0-03-2) ----------------


def consent_state(events: Sequence[dict[str, Any]]) -> frozenset[str]:
    """Fold a participant's consent stream ordered by ``seq`` into active scopes (D-S0-03-2).

    ``consent.accepted`` adds its ``payload.scopes``; ``consent.revoked`` removes them;
    latest ``seq`` wins. Repeated accept is idempotent; revoke without prior accept leaves
    no scope.
    """
    consent_events = [
        e
        for e in events
        if isinstance(e, dict) and e.get("type") in ("consent.accepted", "consent.revoked")
    ]
    ordered = sorted(consent_events, key=lambda e: e["seq"])
    active: set[str] = set()
    for e in ordered:
        payload = e.get("payload")
        scopes = payload.get("scopes", ()) if isinstance(payload, dict) else ()
        if e["type"] == "consent.accepted":
            active.update(scopes)
        elif e["type"] == "consent.revoked":
            active.difference_update(scopes)
    return frozenset(active)


def require_consent(state: AbstractSet[str], event: dict[str, Any]) -> list[str]:
    """Check whether ``event`` has the required active consent scopes (D-S0-03-2).

    - Consent events (``consent.accepted``, ``consent.revoked``) never need prior consent.
    - Session-stream events with ``execution_mode == "camera"`` require active ``"camera"``
      scope, else ``["CONSENT_REQUIRED"]``.
    - ``report_only`` and ``simulation`` session events require no sensor scope.
    - Non-session stream events require no sensor scope here.
    """
    if not isinstance(event, dict):
        return []
    event_type = event.get("type")
    if event_type in ("consent.accepted", "consent.revoked"):
        return []

    cat = load_event_catalog()
    type_meta = cat["types"].get(event_type) if isinstance(event_type, str) else None
    if type_meta is not None:
        is_session_stream = type_meta["stream"] == "session"
    else:
        stream_id = event.get("stream_id")
        is_session_stream = isinstance(stream_id, str) and stream_id.startswith("session:")

    if not is_session_stream:
        return []

    if event.get("execution_mode") == "camera":
        if "camera" not in state:
            return ["CONSENT_REQUIRED"]
    return []
