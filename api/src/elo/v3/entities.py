"""CL06.3 v3 entity validation, hashing, chain verification, and builders.

Origin-Source: contracts/CL06_3/reference/python/elo_ref.py
Origin-SHA256: a88f324099523f4cc66f24cf5c9ecdcc5b8f69ec5999418d9a1635955d3439a0
Origin-License: Apache-2.0
Origin-Attribution: Airton Justino O. Junior (Elo CL06.3 contract package; ported per PO-F10)

Ported functions: ``validate``, ``compute_entity_hash``, ``check_entity_semantics``,
``check_entity_chain`` (and helpers ``_type_ok``, ``ENTITY_PREFIX``).
Standard library only plus ``elo.canonical``.
"""

from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from elo.canonical import canonicalize, hash_canonical

REPO_ROOT = Path(__file__).resolve().parents[4]
CONTRACTS_R1 = REPO_ROOT / "contracts" / "CL06_3-r1" / "contracts"
CONTRACTS_A2 = REPO_ROOT / "contracts" / "CL06_3-A2" / "contracts"
A2_ENTITY_SCHEMAS = frozenset({"goal"})

ENTITY_PREFIX: dict[str, str] = {
    "participant": "p",
    "therapist": "t",
    "care_link": "cl",
    "functional_assessment": "fa",
    "goal": "gl",
    "encounter": "en",
    "reassessment": "ra",
    "instrumental_measurement": "im",
    "draft": "dr",
}


def _type_ok(t: str, v: Any) -> bool:
    if t == "null":
        return v is None
    if t == "boolean":
        return isinstance(v, bool)
    if t == "integer":
        return isinstance(v, int) and not isinstance(v, bool)
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == "string":
        return isinstance(v, str)
    if t == "array":
        return isinstance(v, list)
    if t == "object":
        return isinstance(v, dict)
    return False


def validate(schema: dict[str, Any], value: Any, root: dict[str, Any] | None = None, path: str = "$") -> list[tuple[str, str]]:
    """JSON Schema subset validator ported from CL06.3 reference/python/elo_ref.py."""
    root = root or schema
    errs: list[tuple[str, str]] = []
    if "$ref" in schema:
        ref = schema["$ref"]
        assert ref.startswith("#/$defs/"), ref
        return validate(root["$defs"][ref[8:]], value, root, path)
    if "oneOf" in schema:
        ok = [validate(s, value, root, path) for s in schema["oneOf"]]
        if sum(1 for e in ok if not e) != 1:
            errs.append((path, "ONEOF"))
        return errs
    if "const" in schema and (value != schema["const"] or type(value) is not type(schema["const"])):
        return [(path, "LITERAL")]
    if "type" in schema:
        ts = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_type_ok(t, value) for t in ts):
            return [(path, "NULL_NOT_ALLOWED" if value is None else "TYPE")]
    if "enum" in schema and value not in schema["enum"]:
        errs.append((path, "ENUM"))
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errs.append((path, "PATTERN"))
        if "minLength" in schema and len(value) < schema["minLength"]:
            errs.append((path, "LENGTH"))
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errs.append((path, "LENGTH"))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errs.append((path, "OUT_OF_RANGE"))
        if "maximum" in schema and value > schema["maximum"]:
            errs.append((path, "OUT_OF_RANGE"))
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errs.append((path, "LENGTH"))
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errs.append((path, "LENGTH"))
        if schema.get("uniqueItems") and len({canonicalize(i) for i in value}) != len(value):
            errs.append((path, "DUPLICATE_ITEM"))
        if schema.get("x-sorted") and any(value[i] >= value[i + 1] for i in range(len(value) - 1)):
            errs.append((path, "NOT_SORTED"))
        if "items" in schema:
            for i, it in enumerate(value):
                errs += validate(schema["items"], it, root, f"{path}[{i}]")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for r in schema.get("required", []):
            if r not in value:
                errs.append((f"{path}.{r}", "MISSING_FIELD"))
        for k, v in value.items():
            if k in props:
                errs += validate(props[k], v, root, f"{path}.{k}")
            elif schema.get("additionalProperties") is False:
                errs.append((f"{path}.{k}", "UNKNOWN_FIELD"))
    return errs


def compute_entity_hash(ent: dict[str, Any]) -> str:
    """Compute SHA-256 of canonical entity JSON excluding ``hash`` (CL06.3)."""
    return hash_canonical({k: v for k, v in ent.items() if k != "hash"})


def check_entity_semantics(ent: dict[str, Any], cat: dict[str, Any], real_data_gate_open: bool = False) -> list[str]:
    """Validate CL06.3 entity semantics (ported from reference/python/elo_ref.py)."""
    errs: list[str] = []
    if ent["entity_id"].split("_")[0] != ENTITY_PREFIX[ent["entity_type"]]:
        errs.append("RULE_VIOLATION")
    if ent["hash"] != compute_entity_hash(ent):
        errs.append("ENTITY_HASH_INVALID")
    if (ent["version"] == 1) != (ent["prev_hash"] is None):
        errs.append("ENTITY_CHAIN_BROKEN")
    if ent["data_origin"] in cat["rules"]["origin_ref_required_for"] and "origin_ref" not in ent:
        errs.append("ORIGIN_REF_REQUIRED")
    if ent["data_origin"] == "live" and not real_data_gate_open:
        errs.append("REAL_DATA_GATE_CLOSED")
    p = ent["payload"]
    if ent["entity_type"] == "goal":
        achieved = p["status"] == "achieved_confirmed"
        if achieved != (p["confirmed_by"] is not None and p["confirmed_at"] is not None) or (
            p["confirmed_by"] is None
        ) != (p["confirmed_at"] is None):
            errs.append("GOAL_CONFIRMATION_REQUIRED")
        if achieved and ent["author"]["role"] != "therapist":
            errs.append("GOAL_CONFIRMATION_REQUIRED")
    if (
        ent["entity_type"]
        in ("care_link", "functional_assessment", "goal", "encounter", "reassessment", "instrumental_measurement")
        and ent["author"]["role"] != "therapist"
    ):
        errs.append("ROLE_NOT_ALLOWED")
    if ent["entity_type"] == "draft" and p["status"] == "confirmed" and (p["confirmed_by"] is None):
        errs.append("DRAFT_NOT_CONFIRMED")
    if (
        ent["entity_type"] == "draft"
        and p["draft_kind"] == "session_report_proposal"
        and ent["author"]["role"] != "participant"
    ):
        errs.append("ROLE_NOT_ALLOWED")
    return sorted(set(errs))


def check_entity_chain(versions: list[dict[str, Any]]) -> list[str]:
    """Validate entity version sequence and prev_hash links (ported from reference/python/elo_ref.py)."""
    errs: list[str] = []
    vs = sorted(versions, key=lambda v: v["version"])
    for i, v in enumerate(vs):
        if v["version"] != i + 1:
            errs.append("ENTITY_VERSION_CONFLICT")
        if i > 0 and v["prev_hash"] != vs[i - 1]["hash"]:
            errs.append("ENTITY_CHAIN_BROKEN")
    return sorted(set(errs))


@lru_cache(maxsize=16)
def load_entity_schema(entity_type: str) -> dict[str, Any]:
    # A2 candidate (3.2.0): ``goal`` gains an optional ``deadline``. The A2 schema is a strict superset of r1, so every
    # legacy record stays valid; r1 files themselves are never modified.
    if entity_type in A2_ENTITY_SCHEMAS:
        return json.loads((CONTRACTS_A2 / "schemas" / "entities" / f"{entity_type}.schema.json").read_text(encoding="utf-8"))
    path = CONTRACTS_R1 / "schemas" / "entities" / f"{entity_type}.schema.json"
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def load_event_catalog() -> dict[str, Any]:
    path = CONTRACTS_R1 / "catalogs" / "event-catalog.v3.json"
    return json.loads(path.read_text(encoding="utf-8"))


def utc_now_ms() -> str:
    """Return UTC timestamp matching CL06.3 pattern YYYY-MM-DDTHH:MM:SS.mmmZ."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def new_id(prefix: str) -> str:
    """Generate a schema-valid opaque entity/org identifier (<prefix>_<16 hex>)."""
    return f"{prefix}_{secrets.token_hex(8)}"


def build_entity(
    *,
    entity_type: str,
    entity_id: str,
    version: int,
    prev_hash: str | None,
    org_id: str,
    author_role: str,
    author_id: str,
    data_origin: str,
    payload: dict[str, Any],
    participant_id: str | None = None,
    origin_ref: str | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Construct a hashed CL06.3 versioned entity dict."""
    ent: dict[str, Any] = {
        "entity_id": entity_id,
        "entity_type": entity_type,
        "version": version,
        "prev_hash": prev_hash,
        "org_id": org_id,
        "created_at": created_at or utc_now_ms(),
        "author": {"role": author_role, "id": author_id},
        "data_origin": data_origin,
        "payload": payload,
    }
    if participant_id is not None:
        ent["participant_id"] = participant_id
    if origin_ref is not None:
        ent["origin_ref"] = origin_ref
    ent["hash"] = compute_entity_hash(ent)
    return ent
