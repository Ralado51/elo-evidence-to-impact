"""Descriptive longitudinal evolution, publication gate, and unified timeline (CL06.3 v3, S1-01).

Implements D-S1-01-1..7 (DECISIONS-E3.md) and R1..R14 (DECISIONS-E3-rev2.md):
- ``evolution.series`` (GET /api/v3/participants/{participant_id}/evolution/series):
  Projects currently effectively-approved summary-eligible facts from terminal sessions
  under ``comparability-rules.v1.json`` (``cmp-v1``), validated against
  ``progress-series.schema.json``, with split notices and context-change indicators.
- ``evolution.publish`` (POST /api/v3/evolution):
  Enforces replay precedence (R12), ``series_keys`` and explicit ``series`` modes,
  D-S1-01-3 item precedence (404 NOT_FOUND -> 422 FACT_NOT_SUMMARY_ELIGIBLE ->
  409 CONTENT_HASH_STALE -> 409 UNREVIEWED_FACT_IN_EVOLUTION ->
  400 COMPARABILITY_VIOLATION -> 400 RULE_VIOLATION), R10 common-origin enforcement,
  R2/R11 unreported-assistance barrier (``NO_TRANSITION_PRODUCED``), R14 ``origin_ref``,
  and atomic storage of one server-authored ``evolution.published`` event + R7 snapshot.
- ``evolution.get`` (GET /api/v3/evolution/{evolution_id}):
  Serves strictly from the stored event + R7 historical snapshot (never current facts):
  * Linked therapist -> ``{event, series_keys, notices, context_changes}``.
  * Own participant -> simplified view (no hashes, note_refs, or actor ids; transitions
    and context_changes nested per series; notices indexed by series_indexes).
  * Unentitled / other / unknown -> 404 NOT_FOUND (D-S0-02-1).
- ``timeline.get`` (GET /api/v3/participants/{participant_id}/timeline):
  Therapist-only unified history of clinical entity versions (rank 0) and published
  events (rank 1) ordered by ``(occurred_at, source_rank, kind, ref)`` (R3, R4).

Single truth path: derives and re-verifies facts exclusively through ``elo.v3.verifier``
and folds reviews through ``elo.v3.reviews.resolve_effective_reviews``. Zero legacy imports.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Any

from elo.canonical import compute_event_hash, compute_event_id, hash_canonical

from .authz import ALLOWED_ROLES, AuthzScope, Principal, authorize
from .entities import new_id, utc_now_ms, validate as validate_schema
from .errors import V3Error
from .reviews import resolve_effective_reviews
from .store import V3Store
from .verifier import (
    _end_reason_of,
    _select_effective_report,
    _select_start,
    _select_terminal,
    _session_local_date,
    derive_facts,
    load_fact_catalog,
    load_limitations_catalog,
    verify_fact,
)

COMPARABILITY_RULES_VERSION = "cmp-v1"
NO_TRANSITION_PRODUCED = "NO_TRANSITION_PRODUCED"

_CONTRACTS_ROOT = Path(__file__).resolve().parents[4] / "contracts" / "CL06_3-r1" / "contracts"
_CMP_RULES_PATH = _CONTRACTS_ROOT / "catalogs" / "comparability-rules.v1.json"
_PROGRESS_SERIES_SCHEMA_PATH = _CONTRACTS_ROOT / "schemas" / "progress-series.schema.json"

_PARTICIPANT_ID_RE = re.compile(r"^p_[A-Za-z0-9-]{8,64}$")
_EVOLUTION_ID_RE = re.compile(r"^evo_[A-Za-z0-9-]{8,64}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")

_METHOD_UNIT_BY_FACT: dict[str, tuple[str, str]] = {
    "F01": ("cycle_count", "cycles"),
    "F02": ("end_reason", "category"),
    "F03": ("reported_execution", "category"),
    "F04": ("reported_assistance", "ordinal"),
    "F05": ("report_observation_discrepancy", "category"),
    "F06": ("tracking_quality", "fraction"),
    "F08": ("symptom", "category"),
}

_ASSISTANCE_ORDINAL: dict[str, int] = {
    "none": 0,
    "some": 1,
    "full": 2,
}

_TIMELINE_ENTITY_TYPES: tuple[str, ...] = (
    "functional_assessment",
    "goal",
    "encounter",
    "reassessment",
    "instrumental_measurement",
)

_TIMELINE_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "prescription.published",
        "summary.published",
        "evolution.published",
    }
)

_ORIGIN_REF_ORIGINS: frozenset[str] = frozenset({"experimental_capture", "imported_v1"})

_SERVER_OWNED_ENVELOPE_FIELDS: frozenset[str] = frozenset(
    {
        "event_id",
        "schema_version",
        "type",
        "stream_id",
        "seq",
        "prev_hash",
        "occurred_at",
        "t_mono_ms",
        "actor",
        "scope",
        "source",
        "execution_mode",
        "data_origin",
        "origin_ref",
        "hash",
    }
)

_EVOLUTION_PUBLISH_ALLOWED_FIELDS: frozenset[str] = frozenset(
    {
        "participant_id",
        "period",
        "period_from",
        "period_to",
        "series_keys",
        "series",
        "evolution_id",
        "note_refs",
    }
)


@lru_cache(maxsize=1)
def load_comparability_rules() -> dict[str, Any]:
    return json.loads(_CMP_RULES_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def load_progress_series_schema() -> dict[str, Any]:
    return json.loads(_PROGRESS_SERIES_SCHEMA_PATH.read_text(encoding="utf-8"))


def origin_label_for(data_origin: str) -> str:
    """Return trimmed PT-BR origin label from limitations.v2 ('' for live; D-S1-01-6)."""
    lims = load_limitations_catalog()
    return str(lims["origin_prefix"].get(data_origin, "")).strip()


def origin_prefix_for(data_origin: str) -> str:
    """Return raw origin_prefix from limitations.v2 (D-S1-01-5)."""
    lims = load_limitations_catalog()
    return str(lims["origin_prefix"].get(data_origin, ""))


def _is_valid_date_str(value: Any) -> bool:
    if not isinstance(value, str) or not _DATE_RE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def _require_valid_principal(principal: Principal | None) -> Principal:
    if principal is None:
        raise V3Error("UNAUTHENTICATED", "Authentication required.")
    if principal.role not in ALLOWED_ROLES:
        raise V3Error("ROLE_NOT_ALLOWED", f"Role {principal.role!r} is not allowed (PD-08).")
    return principal


def _enforce_decision(decision: Any) -> None:
    if not decision.allowed:
        assert decision.code is not None
        raise V3Error(decision.code, decision.reason)


def _proposal_from_fact(fact: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "type": fact["type"],
        "catalog_version": fact["catalog_version"],
        "params": fact["params"],
        "evidence_refs": fact["evidence_refs"],
        "scope": fact["scope"],
        "data_origin": fact["data_origin"],
    }


@dataclass(frozen=True)
class _SessionMeta:
    session_id: str
    participant_id: str
    movement_task: str
    laterality: str
    execution_mode: str
    data_origin: str
    origin_ref: str | None
    limits_version: str
    dose_prescribed: int
    session_date_local: str
    start_occurred_at: str
    session_end_reason: str
    pain_or_fatigue_signalled: bool
    assistance_level: str  # "none" | "some" | "full" | "unreported"
    f06_low_quality: bool | None  # True / False if F06 exists, else None

    @property
    def session_order_key(self) -> tuple[str, str, str]:
        return (self.session_date_local, self.start_occurred_at, self.session_id)


@dataclass(frozen=True)
class _ProjectedItem:
    fact_id: str
    content_hash: str
    fact_type: str
    session_id: str
    session_date_local: str
    start_occurred_at: str
    series_key: dict[str, str]
    series_key_hash: str
    context: dict[str, Any]
    text_ptbr: str
    limitations_ptbr: list[str]
    origin_ref: str | None

    @property
    def order_key(self) -> tuple[str, str, str, str]:
        """R11 unified item order: (session_date_local, start(S).occurred_at, session_id, fact_id)."""
        return (self.session_date_local, self.start_occurred_at, self.session_id, self.fact_id)

    @property
    def session_order_key(self) -> tuple[str, str, str]:
        return (self.session_date_local, self.start_occurred_at, self.session_id)


def build_series_key(
    fact: Mapping[str, Any],
    *,
    start_ev: Mapping[str, Any],
    rx_ev: Mapping[str, Any],
    f06_low_quality: bool | None = None,
) -> dict[str, str] | None:
    """Compute the 14-field cmp-v1 series_key for a summary-eligible fact (D-S1-01-1).

    Returns ``None`` if the fact is not eligible (F09/F10) or its movement_task is not
    ``"organizar-a-mesa"``.
    """
    fact_type = str(fact["type"])
    if fact_type not in _METHOD_UNIT_BY_FACT:
        return None
    if not fact.get("flags", {}).get("summary_eligible", False):
        return None

    rx_payload = rx_ev["payload"]
    movement_task = str(rx_payload["exercise_id"])
    if movement_task != "organizar-a-mesa":
        return None
    body_segment = "hand"

    laterality = str(rx_payload["side"])
    method, unit = _METHOD_UNIT_BY_FACT[fact_type]
    protocol = "none"

    versions = fact.get("versions", {})
    alg_val = versions.get("algorithm")
    algorithm_version = str(alg_val) if alg_val is not None else "none"

    execution_mode = str(start_ev["execution_mode"])
    data_origin_class = str(start_ev["data_origin"])

    if execution_mode in ("camera", "simulation"):
        if f06_low_quality is True:
            observation_quality_class = "low"
        elif f06_low_quality is False:
            observation_quality_class = "usable"
        else:
            observation_quality_class = "unknown"
    else:
        observation_quality_class = "not_applicable"

    def_ver = versions.get("definition")
    if def_ver is None:
        cat = load_fact_catalog()
        def_ver = cat["types"].get(fact_type, {}).get("definition_version", 1)
    fact_definition_version = str(def_ver)

    limits_ver = versions.get("limits") or rx_payload["limits_version"]
    limits_version = str(limits_ver)

    return {
        "participant_id": str(fact["scope"]["participant_id"]),
        "body_segment": body_segment,
        "laterality": laterality,
        "movement_task": movement_task,
        "method": method,
        "unit": unit,
        "protocol": protocol,
        "algorithm_version": algorithm_version,
        "observation_quality_class": observation_quality_class,
        "execution_mode": execution_mode,
        "data_origin_class": data_origin_class,
        "fact_type": fact_type,
        "fact_definition_version": fact_definition_version,
        "limits_version": limits_version,
    }


def check_series_comparability(
    series_keys: Sequence[Mapping[str, str]],
    *,
    declared_hash: str | None = None,
) -> tuple[bool, str | None]:
    """Check whether all ``series_keys`` are comparable (share one cmp-v1 key hash)."""
    if not series_keys:
        return True, None
    hashes = [hash_canonical(dict(sk)) for sk in series_keys]
    if len(set(hashes)) > 1:
        return False, "COMPARABILITY_VIOLATION"
    if declared_hash is not None and hashes[0] != declared_hash:
        return False, "COMPARABILITY_VIOLATION"
    return True, None


def compute_assistance_transition(
    from_item: Mapping[str, Any],
    to_item: Mapping[str, Any],
    *,
    series_key_hash: str,
    in_scope_sessions: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    """Compute a descriptive assistance transition for consecutive items (D-S1-01-4, R2, R11).

    Returns ``{"produced": True, "code": None, "transition": {...}}`` when both levels are
    in ``{none, some, full}`` and no unreported in-scope session lies strictly between
    ``from_item`` and ``to_item`` in R11 order.

    Returns ``{"produced": False, "code": "NO_TRANSITION_PRODUCED", "transition": None}``
    when either item has ``"unreported"`` assistance or an unreported in-scope session acts
    as a barrier strictly between them. Non-fatal by design.
    """
    from_level = str(from_item.get("assistance_level", "unreported"))
    to_level = str(to_item.get("assistance_level", "unreported"))
    if from_level not in _ASSISTANCE_ORDINAL or to_level not in _ASSISTANCE_ORDINAL:
        return {"produced": False, "code": NO_TRANSITION_PRODUCED, "transition": None}

    from_order = _extract_session_order_key(from_item)
    to_order = _extract_session_order_key(to_item)
    if from_order is not None and to_order is not None and in_scope_sessions:
        for sess in in_scope_sessions:
            if str(sess.get("assistance_level", "unreported")) != "unreported":
                continue
            s_order = _extract_session_order_key(sess)
            if s_order is not None and from_order < s_order < to_order:
                return {"produced": False, "code": NO_TRANSITION_PRODUCED, "transition": None}

    from_ord = _ASSISTANCE_ORDINAL[from_level]
    to_ord = _ASSISTANCE_ORDINAL[to_level]
    if to_ord < from_ord:
        direction = "less_help_reported"
    elif to_ord > from_ord:
        direction = "more_help_reported"
    else:
        direction = "unchanged"

    return {
        "produced": True,
        "code": None,
        "transition": {
            "series_key_hash": series_key_hash,
            "from_fact_id": str(from_item["fact_id"]),
            "to_fact_id": str(to_item["fact_id"]),
            "from_level": from_level,
            "to_level": to_level,
            "direction": direction,
        },
    }


def _extract_session_order_key(obj: Mapping[str, Any]) -> tuple[str, str, str] | None:
    if "session_order_key" in obj and isinstance(obj["session_order_key"], tuple):
        return obj["session_order_key"]
    d = obj.get("session_date_local")
    occ = obj.get("start_occurred_at")
    sid = obj.get("session_id")
    if isinstance(d, str) and isinstance(occ, str) and isinstance(sid, str):
        return (d, occ, sid)
    return None


def _in_scope_sessions_for_key(
    series_key: Mapping[str, str],
    sessions: Sequence[_SessionMeta],
) -> list[dict[str, Any]]:
    """Return R2 in-scope terminal sessions matching (movement_task, laterality, execution_mode, data_origin_class, limits_version)."""
    matched: list[dict[str, Any]] = []
    for s in sessions:
        if (
            s.participant_id == series_key["participant_id"]
            and s.movement_task == series_key["movement_task"]
            and s.laterality == series_key["laterality"]
            and s.execution_mode == series_key["execution_mode"]
            and s.data_origin == series_key["data_origin_class"]
            and s.limits_version == series_key["limits_version"]
        ):
            matched.append(
                {
                    "session_id": s.session_id,
                    "session_date_local": s.session_date_local,
                    "start_occurred_at": s.start_occurred_at,
                    "session_order_key": s.session_order_key,
                    "assistance_level": s.assistance_level,
                }
            )
    matched.sort(key=lambda x: x["session_order_key"])
    return matched


def compute_split_notices(
    ordered_series: Sequence[tuple[str, Mapping[str, str]]],
) -> list[dict[str, Any]]:
    """Compute descriptive series_split notices for series sharing (participant_id, movement_task, fact_type) (R9, R13)."""
    cmp_keys: list[str] = list(load_comparability_rules()["technical_criteria"]["keys"])
    groups: dict[tuple[str, str, str], list[tuple[str, Mapping[str, str]]]] = {}
    for sk_hash, sk in ordered_series:
        gkey = (str(sk["participant_id"]), str(sk["movement_task"]), str(sk["fact_type"]))
        groups.setdefault(gkey, []).append((sk_hash, sk))

    notices: list[dict[str, Any]] = []
    for entries in groups.values():
        if len(entries) < 2:
            continue
        hashes = sorted(h for h, _ in entries)
        differing = [k for k in cmp_keys if len({str(sk[k]) for _, sk in entries}) > 1]
        notices.append(
            {
                "kind": "series_split",
                "series_key_hashes": hashes,
                "differing_keys": differing,
            }
        )
    notices.sort(key=lambda n: n["series_key_hashes"][0])
    return notices


def _compute_series_context_changes(
    items: Sequence[_ProjectedItem],
    in_scope_sessions: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Compute descriptive context_changes between consecutive items in R11 order, then cmp-v1 dimension order (R9, R13)."""
    dims: list[str] = list(load_comparability_rules()["contextual_dimensions"]["dimensions"])
    changes: list[dict[str, Any]] = []
    for idx in range(len(items) - 1):
        a = items[idx]
        b = items[idx + 1]
        for dim in dims:
            val_a = a.context[dim]
            val_b = b.context[dim]
            if dim == "assistance_level":
                tr = compute_assistance_transition(
                    {
                        "fact_id": a.fact_id,
                        "assistance_level": val_a,
                        "session_order_key": a.session_order_key,
                    },
                    {
                        "fact_id": b.fact_id,
                        "assistance_level": val_b,
                        "session_order_key": b.session_order_key,
                    },
                    series_key_hash=a.series_key_hash,
                    in_scope_sessions=in_scope_sessions,
                )
                if not tr["produced"]:
                    continue
            if val_a != val_b:
                changes.append(
                    {
                        "from_fact_id": a.fact_id,
                        "to_fact_id": b.fact_id,
                        "dimension": dim,
                        "from": val_a,
                        "to": val_b,
                    }
                )
    return changes


def _compute_series_assistance_transitions(
    sk_hash: str,
    series_key: Mapping[str, str],
    items: Sequence[_ProjectedItem],
    in_scope_sessions: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Compute F04 assistance_transitions in R11 order honoring R2 barrier (D-S1-01-4, R2, R11)."""
    if series_key["fact_type"] != "F04":
        return []
    transitions: list[dict[str, Any]] = []
    for idx in range(len(items) - 1):
        a = items[idx]
        b = items[idx + 1]
        res = compute_assistance_transition(
            {
                "fact_id": a.fact_id,
                "assistance_level": a.context["assistance_level"],
                "session_order_key": a.session_order_key,
            },
            {
                "fact_id": b.fact_id,
                "assistance_level": b.context["assistance_level"],
                "session_order_key": b.session_order_key,
            },
            series_key_hash=sk_hash,
            in_scope_sessions=in_scope_sessions,
        )
        if res["produced"] and res["transition"] is not None:
            transitions.append(res["transition"])
    return transitions


def _build_session_index(
    participant_events: Sequence[Mapping[str, Any]],
    derived_facts: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, _SessionMeta], dict[str, Mapping[str, Any]], dict[str, Mapping[str, Any]]]:
    """Index terminal sessions, start events, and prescription revisions for one participant."""
    by_stream: dict[str, list[Mapping[str, Any]]] = {}
    rx_index: dict[tuple[str, int], Mapping[str, Any]] = {}
    for ev in participant_events:
        sid = str(ev["stream_id"])
        by_stream.setdefault(sid, []).append(ev)
        if ev.get("type") == "prescription.published":
            sc = ev.get("scope", {})
            rx_id = sc.get("prescription_id")
            rx_rev = sc.get("prescription_revision")
            if isinstance(rx_id, str) and isinstance(rx_rev, int):
                rx_index[(rx_id, rx_rev)] = ev

    for evs in by_stream.values():
        evs.sort(key=lambda e: int(e["seq"]))

    f06_low_by_session: dict[str, bool] = {}
    for fact in derived_facts:
        if fact.get("type") == "F06":
            s_id = str(fact["scope"]["session_id"])
            f06_low_by_session[s_id] = bool(fact["params"].get("low_capture_quality", False))

    sessions: dict[str, _SessionMeta] = {}
    starts_by_sid: dict[str, Mapping[str, Any]] = {}
    rx_by_sid: dict[str, Mapping[str, Any]] = {}

    for stream_id, s_events in by_stream.items():
        if not stream_id.startswith("session:"):
            continue
        start_ev = _select_start(s_events)
        if start_ev is None:
            continue
        sc = start_ev["scope"]
        session_id = str(sc["session_id"])
        rx_ev = rx_index.get((str(sc["prescription_id"]), int(sc["prescription_revision"])))
        if rx_ev is None:
            continue
        starts_by_sid[session_id] = start_ev
        rx_by_sid[session_id] = rx_ev

        terminal_ev = _select_terminal(s_events)
        if terminal_ev is None:
            continue

        end_reason, _ = _end_reason_of(terminal_ev)
        pain_or_fatigue = bool(
            terminal_ev.get("type") == "session.control"
            and terminal_ev.get("payload", {}).get("action") in ("pain", "fatigue")
        )
        eff_report = _select_effective_report(s_events)
        assistance = (
            str(eff_report["payload"]["assistance"])
            if eff_report is not None and isinstance(eff_report.get("payload", {}).get("assistance"), str)
            else "unreported"
        )
        rx_payload = rx_ev["payload"]
        dose_prescribed = int(rx_payload["target_sets"]) * int(rx_payload["target_repetitions"])
        session_date_local = _session_local_date(start_ev, rx_ev)
        orig_ref = start_ev.get("origin_ref")
        sessions[session_id] = _SessionMeta(
            session_id=session_id,
            participant_id=str(sc["participant_id"]),
            movement_task=str(rx_payload["exercise_id"]),
            laterality=str(rx_payload["side"]),
            execution_mode=str(start_ev["execution_mode"]),
            data_origin=str(start_ev["data_origin"]),
            origin_ref=str(orig_ref) if isinstance(orig_ref, str) else None,
            limits_version=str(rx_payload["limits_version"]),
            dose_prescribed=dose_prescribed,
            session_date_local=session_date_local,
            start_occurred_at=str(start_ev["occurred_at"]),
            session_end_reason=end_reason,
            pain_or_fatigue_signalled=pain_or_fatigue,
            assistance_level=assistance,
            f06_low_quality=f06_low_by_session.get(session_id),
        )

    return sessions, starts_by_sid, rx_by_sid


def _project_fact_item(
    fact: Mapping[str, Any],
    content_hash: str,
    sessions: Mapping[str, _SessionMeta],
    starts_by_sid: Mapping[str, Mapping[str, Any]],
    rx_by_sid: Mapping[str, Mapping[str, Any]],
) -> _ProjectedItem | None:
    """Project one verified fact into a ``_ProjectedItem`` if eligible & from a terminal session."""
    session_id = str(fact["scope"]["session_id"])
    sess = sessions.get(session_id)
    start_ev = starts_by_sid.get(session_id)
    rx_ev = rx_by_sid.get(session_id)
    if sess is None or start_ev is None or rx_ev is None:
        return None
    sk = build_series_key(fact, start_ev=start_ev, rx_ev=rx_ev, f06_low_quality=sess.f06_low_quality)
    if sk is None:
        return None
    sk_hash = hash_canonical(sk)
    context = {
        "assistance_level": sess.assistance_level,
        "pain_or_fatigue_signalled": sess.pain_or_fatigue_signalled,
        "dose_prescribed": sess.dose_prescribed,
        "session_end_reason": sess.session_end_reason,
    }
    return _ProjectedItem(
        fact_id=str(fact["fact_id"]),
        content_hash=content_hash,
        fact_type=str(fact["type"]),
        session_id=session_id,
        session_date_local=str(fact["params"]["session_date_local"]),
        start_occurred_at=sess.start_occurred_at,
        series_key=sk,
        series_key_hash=sk_hash,
        context=context,
        text_ptbr=str(fact["rendered"]["text_ptbr"]),
        limitations_ptbr=list(fact["rendered"]["limitations_ptbr"]),
        origin_ref=sess.origin_ref,
    )


def _extract_publish_body(body: dict[str, Any]) -> dict[str, Any]:
    """Extract client fields from flat body or ``{"payload": ...}``, rejecting contradictions."""
    if "payload" in body:
        raw_payload = body["payload"]
        if raw_payload is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'payload' must not be null.")
        if not isinstance(raw_payload, dict):
            raise V3Error("TYPE", "Field 'payload' must be a JSON object.")
        for key in body:
            if key not in ("payload", "participant_id", "evolution_id") and key not in _SERVER_OWNED_ENVELOPE_FIELDS:
                raise V3Error("UNKNOWN_FIELD", f"Unknown request field: {key!r}.")
        out = {
            k: v
            for k, v in raw_payload.items()
            if k not in ("content_hash", "comparability_rules_version", "assistance_transitions")
        }
        for shared_key in ("participant_id", "evolution_id"):
            if shared_key in body:
                top_val = body[shared_key]
                if shared_key in out and out[shared_key] is not None and top_val is not None and out[shared_key] != top_val:
                    raise V3Error("RULE_VIOLATION", f"Contradictory {shared_key!r} values in request.")
                if shared_key not in out or out[shared_key] is None:
                    out[shared_key] = top_val
    else:
        out = {
            k: v
            for k, v in body.items()
            if k not in _SERVER_OWNED_ENVELOPE_FIELDS
            and k not in ("content_hash", "comparability_rules_version", "assistance_transitions")
        }

    for key in out:
        if key not in _EVOLUTION_PUBLISH_ALLOWED_FIELDS:
            raise V3Error("UNKNOWN_FIELD", f"Unknown evolution publish field: {key!r}.")
    return out


def _parse_publish_period(clean_body: Mapping[str, Any]) -> tuple[str, str]:
    """Parse period / period_from / period_to; differing aliases or invalid/inverted range -> 400 RULE_VIOLATION."""
    flat_from: str | None = None
    if "period_from" in clean_body:
        raw = clean_body["period_from"]
        if raw is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'period_from' must not be null.")
        if not isinstance(raw, str):
            raise V3Error("TYPE", "Field 'period_from' must be a string.")
        if not _is_valid_date_str(raw):
            raise V3Error("RULE_VIOLATION", "Field 'period_from' must be a valid YYYY-MM-DD date.")
        flat_from = raw

    flat_to: str | None = None
    if "period_to" in clean_body:
        raw = clean_body["period_to"]
        if raw is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'period_to' must not be null.")
        if not isinstance(raw, str):
            raise V3Error("TYPE", "Field 'period_to' must be a string.")
        if not _is_valid_date_str(raw):
            raise V3Error("RULE_VIOLATION", "Field 'period_to' must be a valid YYYY-MM-DD date.")
        flat_to = raw

    nested_from: str | None = None
    nested_to: str | None = None
    if "period" in clean_body:
        p_obj = clean_body["period"]
        if p_obj is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'period' must not be null.")
        if not isinstance(p_obj, dict):
            raise V3Error("TYPE", "Field 'period' must be a JSON object.")
        for pk in p_obj:
            if pk not in ("from", "to", "period_from", "period_to"):
                raise V3Error("UNKNOWN_FIELD", f"Unknown field in 'period': {pk!r}.")

        def _read_bound(primary: str, alias: str) -> str | None:
            vals: list[str] = []
            for key in (primary, alias):
                if key in p_obj:
                    val = p_obj[key]
                    if val is None:
                        raise V3Error("NULL_NOT_ALLOWED", f"Field 'period.{key}' must not be null.")
                    if not isinstance(val, str):
                        raise V3Error("TYPE", f"Field 'period.{key}' must be a string.")
                    if not _is_valid_date_str(val):
                        raise V3Error("RULE_VIOLATION", f"Field 'period.{key}' must be a valid YYYY-MM-DD date.")
                    vals.append(val)
            if len(vals) == 2 and vals[0] != vals[1]:
                raise V3Error("RULE_VIOLATION", f"Contradictory 'period.{primary}' and 'period.{alias}' values.")
            return vals[0] if vals else None

        nested_from = _read_bound("from", "period_from")
        nested_to = _read_bound("to", "period_to")

    if flat_from is not None and nested_from is not None and flat_from != nested_from:
        raise V3Error("RULE_VIOLATION", "Contradictory 'period_from' and 'period.from' in evolution publish request.")
    if flat_to is not None and nested_to is not None and flat_to != nested_to:
        raise V3Error("RULE_VIOLATION", "Contradictory 'period_to' and 'period.to' in evolution publish request.")

    period_from = flat_from if flat_from is not None else nested_from
    period_to = flat_to if flat_to is not None else nested_to
    if period_from is None or period_to is None:
        raise V3Error("MISSING_FIELD", "Both period start ('from'/'period_from') and end ('to'/'period_to') are required.")
    if period_to < period_from:
        raise V3Error("RULE_VIOLATION", "period_to must not be earlier than period_from.")
    return period_from, period_to


def _build_participant_evolution_view(
    event: Mapping[str, Any],
    snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    """Project immutable stored event + R7 snapshot into participant simplified view (D-S1-01-5, R8, R9, R13).

    Contains zero hashes, zero note_refs, zero actor ids, and zero fact_ids.
    """
    payload = event["payload"]
    series_keys: Mapping[str, Mapping[str, str]] = snapshot["series_keys"]
    series_items: Mapping[str, Sequence[Mapping[str, Any]]] = snapshot["series_items"]
    therapist_notices: Sequence[Mapping[str, Any]] = snapshot["notices"]
    therapist_ctx_changes: Mapping[str, Sequence[Mapping[str, Any]]] = snapshot["context_changes"]

    ordered_hashes = [str(s["series_key_hash"]) for s in payload["series"]]
    index_by_hash = {h: idx for idx, h in enumerate(ordered_hashes)}

    participant_notices: list[dict[str, Any]] = []
    for n in therapist_notices:
        indexes = sorted(index_by_hash[h] for h in n["series_key_hashes"] if h in index_by_hash)
        if len(indexes) >= 2:
            participant_notices.append(
                {
                    "kind": str(n["kind"]),
                    "series_indexes": indexes,
                    "differing_keys": list(n["differing_keys"]),
                }
            )
    participant_notices.sort(key=lambda n: n["series_indexes"][0])

    participant_series: list[dict[str, Any]] = []
    for s in payload["series"]:
        sk_hash = str(s["series_key_hash"])
        sk = series_keys[sk_hash]
        snap_items = series_items[sk_hash]
        date_by_fid = {str(it["fact_id"]): str(it["session_date_local"]) for it in snap_items}

        nested_transitions = [
            {
                "from_date": date_by_fid[str(tr["from_fact_id"])],
                "to_date": date_by_fid[str(tr["to_fact_id"])],
                "direction": str(tr["direction"]),
            }
            for tr in payload["assistance_transitions"]
            if str(tr["series_key_hash"]) == sk_hash
            and str(tr["from_fact_id"]) in date_by_fid
            and str(tr["to_fact_id"]) in date_by_fid
        ]

        nested_ctx_changes = [
            {
                "from_date": date_by_fid[str(cc["from_fact_id"])],
                "to_date": date_by_fid[str(cc["to_fact_id"])],
                "dimension": str(cc["dimension"]),
                "from": cc["from"],
                "to": cc["to"],
            }
            for cc in therapist_ctx_changes.get(sk_hash, ())
            if str(cc["from_fact_id"]) in date_by_fid and str(cc["to_fact_id"]) in date_by_fid
        ]

        data_origin_class = str(sk["data_origin_class"])
        participant_series.append(
            {
                "data_origin_class": data_origin_class,
                "execution_mode": str(sk["execution_mode"]),
                "origin_prefix": origin_prefix_for(data_origin_class),
                "items": [
                    {
                        "session_date_local": str(it["session_date_local"]),
                        "text_ptbr": str(it["text_ptbr"]),
                        "limitations_ptbr": list(it["limitations_ptbr"]),
                        "context": dict(it["context"]),
                    }
                    for it in snap_items
                ],
                "assistance_transitions": nested_transitions,
                "context_changes": nested_ctx_changes,
            }
        )

    return {
        "evolution_id": str(payload["evolution_id"]),
        "published_at": str(event["occurred_at"]),
        "period": {
            "from": str(payload["period_from"]),
            "to": str(payload["period_to"]),
        },
        "series": participant_series,
        "notices": participant_notices,
    }


class EvolutionTimelineService:
    """Service backing ``evolution.series``, ``evolution.publish``, ``evolution.get``, and ``timeline.get``."""

    def __init__(self, store: V3Store) -> None:
        self.store = store

    def _resolve_participant_org(self, participant_id: str) -> str | None:
        p_ent = self.store.get_latest_entity(participant_id, entity_type="participant")
        if p_ent is not None:
            return str(p_ent["org_id"])
        evs = self.store.get_participant_events(participant_id)
        if evs:
            org = evs[0].get("scope", {}).get("org_id")
            return str(org) if isinstance(org, str) else None
        return None

    def _authorize_therapist_participant(
        self,
        principal: Principal | None,
        resource: str,
        action: str,
        participant_id: str,
    ) -> tuple[Principal, str]:
        caller = _require_valid_principal(principal)
        role_dec = authorize(caller, resource, action, AuthzScope())
        if not role_dec.allowed and role_dec.code in ("FORBIDDEN", "ROLE_NOT_ALLOWED", "UNAUTHENTICATED"):
            raise V3Error(role_dec.code, role_dec.reason)

        if not _PARTICIPANT_ID_RE.fullmatch(participant_id):
            raise V3Error("NOT_FOUND", "Participant not found.")

        org_id = self._resolve_participant_org(participant_id)
        if org_id is None:
            raise V3Error("NOT_FOUND", "Participant not found.")

        links = self.store.latest_care_links(participant_id=participant_id)
        decision = authorize(
            caller,
            resource,
            action,
            AuthzScope(participant_id=participant_id, org_id=org_id, is_read_by_id=False),
            links=links,
        )
        _enforce_decision(decision)
        return caller, org_id

    def authorize_publish_role(self, principal: Principal | None) -> Principal:
        caller = _require_valid_principal(principal)
        decision = authorize(caller, "evolution", "series read / publish", AuthzScope())
        if not decision.allowed and decision.code in ("FORBIDDEN", "ROLE_NOT_ALLOWED", "UNAUTHENTICATED"):
            raise V3Error(decision.code, decision.reason)
        return caller

    def _project_approved_series(
        self,
        participant_id: str,
        *,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> tuple[
        list[tuple[str, dict[str, str], list[_ProjectedItem]]],
        dict[str, _SessionMeta],
        list[dict[str, Any]],
        dict[str, dict[str, Any]],
        dict[str, str],
        set[str],
        dict[str, Mapping[str, Any]],
        dict[str, Mapping[str, Any]],
        dict[str, Mapping[str, Any]],
    ]:
        p_events = self.store.get_participant_events(participant_id)
        review_events = self.store.get_participant_reviews(participant_id)
        seen_fact_ids, effective_reviews = resolve_effective_reviews(review_events)

        facts, content_hashes = derive_facts(p_events, participant_id=participant_id)
        facts_by_id = {f["fact_id"]: f for f in facts}
        sessions, starts_by_sid, rx_by_sid = _build_session_index(p_events, facts)

        grouped: dict[str, tuple[dict[str, str], list[_ProjectedItem]]] = {}
        for fact in facts:
            fid = str(fact["fact_id"])
            cur_hash = content_hashes[fid]
            eff = effective_reviews.get(fid)
            if eff is None or eff["payload"]["decision"] != "approve" or eff["payload"]["content_hash"] != cur_hash:
                continue
            item = _project_fact_item(fact, cur_hash, sessions, starts_by_sid, rx_by_sid)
            if item is None:
                continue
            if date_from is not None and item.session_date_local < date_from:
                continue
            if date_to is not None and item.session_date_local > date_to:
                continue
            if item.series_key_hash not in grouped:
                grouped[item.series_key_hash] = (item.series_key, [])
            grouped[item.series_key_hash][1].append(item)

        ordered_series: list[tuple[str, dict[str, str], list[_ProjectedItem]]] = []
        for sk_hash in sorted(grouped.keys()):
            sk, items = grouped[sk_hash]
            items.sort(key=lambda it: it.order_key)
            if items:
                ordered_series.append((sk_hash, sk, items))

        return (
            ordered_series,
            sessions,
            review_events,
            facts_by_id,
            content_hashes,
            seen_fact_ids,
            effective_reviews,
            starts_by_sid,
            rx_by_sid,
        )

    # ------------------------------------------------------------------
    # 1. evolution.series (GET /api/v3/participants/{participant_id}/evolution/series)
    # ------------------------------------------------------------------

    def list_series(
        self,
        participant_id: str,
        principal: Principal | None,
        *,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> dict[str, Any]:
        """Return descriptive approved progress-series with split notices and context_changes (D-S1-01-2, R5, R9, R13)."""
        self._authorize_therapist_participant(
            principal,
            "evolution",
            "series read / publish",
            participant_id,
        )

        if date_from is not None and not _is_valid_date_str(date_from):
            raise V3Error("RULE_VIOLATION", "Query parameter 'from' must be a valid YYYY-MM-DD date.")
        if date_to is not None and not _is_valid_date_str(date_to):
            raise V3Error("RULE_VIOLATION", "Query parameter 'to' must be a valid YYYY-MM-DD date.")
        if date_from is not None and date_to is not None and date_to < date_from:
            raise V3Error("RULE_VIOLATION", "Query parameter 'to' must not be earlier than 'from'.")

        ordered_series, sessions, *_ = self._project_approved_series(
            participant_id,
            date_from=date_from,
            date_to=date_to,
        )

        schema = load_progress_series_schema()
        all_sessions = list(sessions.values())
        series_out: list[dict[str, Any]] = []
        context_changes_out: dict[str, list[dict[str, Any]]] = {}

        for sk_hash, sk, items in ordered_series:
            ps_obj = {
                "series_key": sk,
                "series_key_hash": sk_hash,
                "items": [
                    {
                        "fact_id": it.fact_id,
                        "content_hash": it.content_hash,
                        "session_date_local": it.session_date_local,
                        "context": dict(it.context),
                    }
                    for it in items
                ],
            }
            errs = validate_schema(schema, ps_obj)
            if errs:
                raise V3Error("INTERNAL", f"Constructed progress-series failed schema validation: {errs}")
            series_out.append(ps_obj)
            in_scope = _in_scope_sessions_for_key(sk, all_sessions)
            context_changes_out[sk_hash] = _compute_series_context_changes(items, in_scope)

        notices = compute_split_notices([(sk_hash, sk) for sk_hash, sk, _ in ordered_series])
        return {
            "series": series_out,
            "rules_version": COMPARABILITY_RULES_VERSION,
            "notices": notices,
            "context_changes": context_changes_out,
        }

    # ------------------------------------------------------------------
    # 2. evolution.publish (POST /api/v3/evolution)
    # ------------------------------------------------------------------

    def publish_evolution(
        self,
        body: dict[str, Any],
        principal: Principal | None,
    ) -> tuple[dict[str, Any], int]:
        """Validate publication gate and store immutable ``evolution.published`` + R7 snapshot."""
        caller = self.authorize_publish_role(principal)
        clean_body = _extract_publish_body(body)

        # participant_id required -> authorize scope BEFORE item gates (D-S1-01-3, R12)
        if "participant_id" not in clean_body:
            raise V3Error("MISSING_FIELD", "Missing required field 'participant_id'.")
        pid_raw = clean_body["participant_id"]
        if pid_raw is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'participant_id' must not be null.")
        if not isinstance(pid_raw, str):
            raise V3Error("TYPE", "Field 'participant_id' must be a string.")
        if not _PARTICIPANT_ID_RE.fullmatch(pid_raw):
            raise V3Error("PATTERN", "Field 'participant_id' must match ^p_[A-Za-z0-9-]{8,64}$.")
        participant_id = pid_raw

        _, org_id = self._authorize_therapist_participant(
            caller,
            "evolution",
            "series read / publish",
            participant_id,
        )

        # Shape & period checks (D-S1-01-3, R1, R6, R12)
        period_from, period_to = _parse_publish_period(clean_body)

        req_evo_id = clean_body.get("evolution_id")
        if req_evo_id is not None:
            if not isinstance(req_evo_id, str):
                raise V3Error("TYPE", "Field 'evolution_id' must be a string.")
            if not _EVOLUTION_ID_RE.fullmatch(req_evo_id):
                raise V3Error("PATTERN", "Field 'evolution_id' must match ^evo_[A-Za-z0-9-]{8,64}$.")
            evolution_id = req_evo_id
            explicit_evo_id = True
        else:
            evolution_id = new_id("evo")
            explicit_evo_id = False

        # note_refs: unique 64-char hex strings; duplicates -> 400 RULE_VIOLATION (R6)
        raw_note_refs = clean_body.get("note_refs", [])
        if raw_note_refs is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'note_refs' must not be null.")
        if not isinstance(raw_note_refs, list):
            raise V3Error("TYPE", "Field 'note_refs' must be an array.")
        if len(raw_note_refs) > 500:
            raise V3Error("LENGTH", "Field 'note_refs' exceeds maximum length of 500.")
        for nref in raw_note_refs:
            if not isinstance(nref, str):
                raise V3Error("TYPE", "Items in 'note_refs' must be strings.")
            if not _SHA256_RE.fullmatch(nref):
                raise V3Error("PATTERN", "Items in 'note_refs' must be 64-char hex sha256 strings.")
        if len(set(raw_note_refs)) != len(raw_note_refs):
            raise V3Error("RULE_VIOLATION", "Duplicate note_ref in 'note_refs'.")
        sorted_note_refs = sorted(raw_note_refs)

        # Selection: series_keys and/or explicit series (D-S1-01-3, R6)
        parsed_series_keys: list[str] | None = None
        parsed_explicit_series: list[tuple[str, list[tuple[str, str]]]] | None = None

        if "series_keys" in clean_body:
            raw_sks = clean_body["series_keys"]
            if raw_sks is None:
                raise V3Error("NULL_NOT_ALLOWED", "Field 'series_keys' must not be null.")
            if not isinstance(raw_sks, list):
                raise V3Error("TYPE", "Field 'series_keys' must be an array.")
            if len(raw_sks) < 1 or len(raw_sks) > 200:
                raise V3Error("LENGTH", "Field 'series_keys' must contain between 1 and 200 keys.")
            for skh in raw_sks:
                if skh is None:
                    raise V3Error("NULL_NOT_ALLOWED", "Items in 'series_keys' must not be null.")
                if not isinstance(skh, str):
                    raise V3Error("TYPE", "Items in 'series_keys' must be strings.")
                if not _SHA256_RE.fullmatch(skh):
                    raise V3Error("PATTERN", "Items in 'series_keys' must be 64-char hex sha256 strings.")
            if len(set(raw_sks)) != len(raw_sks):
                raise V3Error("RULE_VIOLATION", "Duplicate series_key_hash in 'series_keys'.")
            parsed_series_keys = list(raw_sks)

        if "series" in clean_body:
            raw_series = clean_body["series"]
            if raw_series is None:
                raise V3Error("NULL_NOT_ALLOWED", "Field 'series' must not be null.")
            if not isinstance(raw_series, list):
                raise V3Error("TYPE", "Field 'series' must be an array.")
            if len(raw_series) < 1 or len(raw_series) > 200:
                raise V3Error("LENGTH", "Field 'series' must contain between 1 and 200 entries.")
            seen_sk_hashes: set[str] = set()
            seen_fids: set[str] = set()
            parsed_explicit_series = []
            for entry in raw_series:
                if entry is None:
                    raise V3Error("NULL_NOT_ALLOWED", "Entries in 'series' must not be null.")
                if not isinstance(entry, dict):
                    raise V3Error("TYPE", "Entries in 'series' must be JSON objects.")
                for ek in entry:
                    if ek not in ("series_key_hash", "items"):
                        raise V3Error("UNKNOWN_FIELD", f"Unknown field in series entry: {ek!r}.")
                if "series_key_hash" not in entry:
                    raise V3Error("MISSING_FIELD", "Missing required field 'series_key_hash' in series entry.")
                if "items" not in entry:
                    raise V3Error("MISSING_FIELD", "Missing required field 'items' in series entry.")
                skh = entry["series_key_hash"]
                if skh is None:
                    raise V3Error("NULL_NOT_ALLOWED", "Field 'series_key_hash' must not be null.")
                if not isinstance(skh, str):
                    raise V3Error("TYPE", "Field 'series_key_hash' must be a string.")
                if not _SHA256_RE.fullmatch(skh):
                    raise V3Error("PATTERN", "Field 'series_key_hash' must be a 64-char hex sha256 string.")
                if skh in seen_sk_hashes:
                    raise V3Error("RULE_VIOLATION", f"Duplicate series_key_hash in 'series': {skh!r}.")
                seen_sk_hashes.add(skh)

                raw_items = entry["items"]
                if raw_items is None:
                    raise V3Error("NULL_NOT_ALLOWED", "Field 'items' must not be null.")
                if not isinstance(raw_items, list):
                    raise V3Error("TYPE", "Field 'items' must be an array.")
                if len(raw_items) < 1 or len(raw_items) > 500:
                    raise V3Error("LENGTH", "Series 'items' must contain between 1 and 500 entries.")
                req_items: list[tuple[str, str]] = []
                for it in raw_items:
                    if it is None:
                        raise V3Error("NULL_NOT_ALLOWED", "Series item must not be null.")
                    if not isinstance(it, dict):
                        raise V3Error("TYPE", "Series item must be a JSON object.")
                    for ik in it:
                        if ik not in ("fact_id", "content_hash"):
                            raise V3Error("UNKNOWN_FIELD", f"Unknown field in series item: {ik!r}.")
                    if "fact_id" not in it:
                        raise V3Error("MISSING_FIELD", "Missing required field 'fact_id' in series item.")
                    if "content_hash" not in it:
                        raise V3Error("MISSING_FIELD", "Missing required field 'content_hash' in series item.")
                    fid = it["fact_id"]
                    ch = it["content_hash"]
                    if fid is None or ch is None:
                        raise V3Error("NULL_NOT_ALLOWED", "Item 'fact_id' and 'content_hash' must not be null.")
                    if not isinstance(fid, str) or not isinstance(ch, str):
                        raise V3Error("TYPE", "Item 'fact_id' and 'content_hash' must be strings.")
                    if fid in seen_fids:
                        raise V3Error("RULE_VIOLATION", f"Duplicate fact_id in request: {fid!r}.")
                    seen_fids.add(fid)
                    req_items.append((fid, ch))
                parsed_explicit_series.append((skh, req_items))

        if parsed_series_keys is None and parsed_explicit_series is None:
            raise V3Error("MISSING_FIELD", "Either 'series_keys' or 'series' must be supplied.")

        if parsed_series_keys is not None and parsed_explicit_series is not None:
            if set(parsed_series_keys) != {skh for skh, _ in parsed_explicit_series}:
                raise V3Error(
                    "RULE_VIOLATION",
                    "Contradictory 'series_keys' and 'series' in evolution publish request.",
                )

        # R12 request fingerprint & replay precedence (BEFORE any item gates!)
        if parsed_explicit_series is not None:
            fp_selection: Any = [
                {
                    "series_key_hash": skh,
                    "items": [
                        {"fact_id": fid, "content_hash": ch}
                        for fid, ch in sorted(items, key=lambda pair: pair[0])
                    ],
                }
                for skh, items in sorted(parsed_explicit_series, key=lambda entry: entry[0])
            ]
        else:
            assert parsed_series_keys is not None
            fp_selection = sorted(parsed_series_keys)

        request_fingerprint = hash_canonical(
            {
                "participant_id": participant_id,
                "period_from": period_from,
                "period_to": period_to,
                "selection": fp_selection,
                "note_refs": sorted_note_refs,
            }
        )

        if explicit_evo_id:
            existing = self.store.get_evolution_record(evolution_id)
            if existing is not None:
                ex_event, ex_fp, _ = existing
                ex_scope = ex_event["scope"]
                if (
                    ex_scope["org_id"] == org_id
                    and ex_scope["participant_id"] == participant_id
                    and ex_fp == request_fingerprint
                ):
                    return (
                        {
                            "evolution_id": evolution_id,
                            "content_hash": ex_event["payload"]["content_hash"],
                            "event_id": ex_event["event_id"],
                        },
                        200,
                    )
                raise V3Error(
                    "CONFLICT_IMMUTABLE",
                    f"Evolution {evolution_id!r} is already published with different content.",
                )

        # Load current participant ledger state, facts, and reviews
        (
            all_projected_series,
            sessions,
            review_events,
            facts_by_id,
            content_hashes,
            seen_fact_ids,
            effective_reviews,
            starts_by_sid,
            rx_by_sid,
        ) = self._project_approved_series(participant_id)
        p_events = self.store.get_participant_events(participant_id)

        # Validate note_refs: each must be the event hash of a review.recorded for this participant (D-S1-01-3)
        review_hashes = {str(ev["hash"]) for ev in review_events}
        for nref in sorted_note_refs:
            if nref not in review_hashes:
                raise V3Error(
                    "RULE_VIOLATION",
                    f"note_ref {nref!r} is not the event hash of a review.recorded for this participant.",
                )

        # Resolve selected series via series_keys mode OR explicit mode
        selected_series: list[tuple[str, dict[str, str], list[_ProjectedItem]]] = []

        if parsed_explicit_series is None:
            # series_keys mode (D-S1-01-3, R5)
            assert parsed_series_keys is not None
            projected_by_hash = {skh: (sk, items) for skh, sk, items in all_projected_series}
            for skh in parsed_series_keys:
                if skh not in projected_by_hash:
                    raise V3Error("NOT_FOUND", f"Series key {skh!r} is not currently projected for participant.")
                sk, all_items = projected_by_hash[skh]
                in_period = [it for it in all_items if period_from <= it.session_date_local <= period_to]
                if not in_period:
                    raise V3Error(
                        "RULE_VIOLATION",
                        f"Series {skh!r} has no approved items within period {period_from}..{period_to}.",
                    )
                in_period.sort(key=lambda it: it.order_key)
                selected_series.append((skh, sk, in_period))
        else:
            # Explicit mode — D-S1-01-3 item precedence in exact request order (first failure wins)
            for declared_sk_hash, req_items in parsed_explicit_series:
                resolved_items: list[_ProjectedItem] = []
                series_sk: dict[str, str] | None = None

                for fid, req_chash in req_items:
                    cur_fact = facts_by_id.get(fid)
                    eff = effective_reviews.get(fid)

                    # 1. Unknown fact -> 404 NOT_FOUND; previously seen/reviewed but no longer derived -> 409 CONTENT_HASH_STALE
                    if cur_fact is None:
                        if fid not in seen_fact_ids:
                            raise V3Error("NOT_FOUND", f"Fact {fid!r} not found.")
                        raise V3Error(
                            "CONTENT_HASH_STALE",
                            f"Fact {fid!r} is no longer derived from the current ledger.",
                        )

                    # Single truth path re-verification
                    recheck = verify_fact(_proposal_from_fact(cur_fact), p_events)
                    if not recheck["valid"] or recheck["fact"] is None or recheck["content_hash"] is None:
                        if fid not in seen_fact_ids:
                            raise V3Error("NOT_FOUND", f"Fact {fid!r} not found.")
                        raise V3Error(
                            "CONTENT_HASH_STALE",
                            f"Fact {fid!r} no longer verifies against the current ledger.",
                        )
                    cur_verified_fact = recheck["fact"]
                    cur_hash = str(recheck["content_hash"])

                    # 2. F09 / F10 -> 422 FACT_NOT_SUMMARY_ELIGIBLE
                    if not cur_verified_fact["flags"].get("summary_eligible", False):
                        raise V3Error(
                            "FACT_NOT_SUMMARY_ELIGIBLE",
                            f"Fact {fid!r} of type {cur_verified_fact['type']!r} is not eligible for evolution.",
                        )

                    # 3. content_hash != current, or approved only under older hash -> 409 CONTENT_HASH_STALE
                    if req_chash != cur_hash:
                        raise V3Error(
                            "CONTENT_HASH_STALE",
                            f"Requested content_hash for fact {fid!r} does not match current content_hash.",
                        )
                    if (
                        eff is not None
                        and eff["payload"]["decision"] == "approve"
                        and eff["payload"]["content_hash"] != cur_hash
                    ):
                        raise V3Error(
                            "CONTENT_HASH_STALE",
                            f"Approving review for fact {fid!r} cites a stale content_hash.",
                        )

                    # 4. Latest review is not an approval of the current hash -> 409 UNREVIEWED_FACT_IN_EVOLUTION
                    if (
                        eff is None
                        or eff["payload"]["decision"] != "approve"
                        or eff["payload"]["content_hash"] != cur_hash
                    ):
                        raise V3Error(
                            "UNREVIEWED_FACT_IN_EVOLUTION",
                            f"Fact {fid!r} does not have a current approving review.",
                        )

                    # 5. Comparability: computed key hash != declared_sk_hash, or two items in one series differ
                    projected = _project_fact_item(cur_verified_fact, cur_hash, sessions, starts_by_sid, rx_by_sid)
                    if projected is None:
                        raise V3Error(
                            "RULE_VIOLATION",
                            f"Fact {fid!r} cannot be projected into a progress series (non-terminal session or unsupported task).",
                        )
                    comp_keys = [*(it.series_key for it in resolved_items), projected.series_key]
                    ok_cmp, cmp_code = check_series_comparability(comp_keys, declared_hash=declared_sk_hash)
                    if not ok_cmp:
                        assert cmp_code is not None
                        raise V3Error(
                            cmp_code,
                            f"Fact {fid!r} does not match comparability key {declared_sk_hash!r}.",
                        )

                    # 6. Item outside the period -> 400 RULE_VIOLATION
                    if not (period_from <= projected.session_date_local <= period_to):
                        raise V3Error(
                            "RULE_VIOLATION",
                            f"Fact {fid!r} date {projected.session_date_local!r} is outside period {period_from}..{period_to}.",
                        )

                    series_sk = projected.series_key
                    resolved_items.append(projected)

                assert series_sk is not None
                resolved_items.sort(key=lambda it: it.order_key)
                selected_series.append((declared_sk_hash, series_sk, resolved_items))

        # R10: common data_origin across all published series (mixed origins -> 400 COMPARABILITY_VIOLATION)
        origins = {sk["data_origin_class"] for _, sk, _ in selected_series}
        if len(origins) != 1:
            raise V3Error(
                "COMPARABILITY_VIOLATION",
                "Mixed data_origin classes cannot be combined in one evolution publication (PD-03).",
            )
        common_origin = next(iter(origins))

        # R6 ordering: series ascending by series_key_hash, items in R11 order, transitions in series then item order
        selected_series.sort(key=lambda entry: entry[0])
        all_sessions = list(sessions.values())

        assistance_transitions: list[dict[str, Any]] = []
        context_changes: dict[str, list[dict[str, Any]]] = {}
        series_keys_map: dict[str, dict[str, str]] = {}
        series_items_snap: dict[str, list[dict[str, Any]]] = {}
        cited_origin_refs: set[str] = set()

        for sk_hash, sk, items in selected_series:
            series_keys_map[sk_hash] = dict(sk)
            in_scope = _in_scope_sessions_for_key(sk, all_sessions)
            assistance_transitions.extend(_compute_series_assistance_transitions(sk_hash, sk, items, in_scope))
            context_changes[sk_hash] = _compute_series_context_changes(items, in_scope)
            series_items_snap[sk_hash] = [
                {
                    "fact_id": it.fact_id,
                    "session_date_local": it.session_date_local,
                    "text_ptbr": it.text_ptbr,
                    "limitations_ptbr": list(it.limitations_ptbr),
                    "context": dict(it.context),
                }
                for it in items
            ]
            for it in items:
                if it.origin_ref is not None:
                    cited_origin_refs.add(it.origin_ref)

        notices = compute_split_notices([(sk_hash, sk) for sk_hash, sk, _ in selected_series])

        # R14: origin_ref for experimental_capture / imported_v1 only
        envelope_origin_ref: str | None = None
        if common_origin in _ORIGIN_REF_ORIGINS:
            if len(cited_origin_refs) == 1:
                envelope_origin_ref = next(iter(cited_origin_refs))
            elif len(cited_origin_refs) > 1:
                envelope_origin_ref = hash_canonical(sorted(cited_origin_refs))

        payload_wo_hash: dict[str, Any] = {
            "evolution_id": evolution_id,
            "period_from": period_from,
            "period_to": period_to,
            "comparability_rules_version": COMPARABILITY_RULES_VERSION,
            "series": [
                {
                    "series_key_hash": sk_hash,
                    "items": [
                        {"fact_id": it.fact_id, "content_hash": it.content_hash}
                        for it in items
                    ],
                }
                for sk_hash, _, items in selected_series
            ],
            "assistance_transitions": assistance_transitions,
            "note_refs": sorted_note_refs,
        }
        evo_content_hash = hash_canonical(payload_wo_hash)
        payload = {**payload_wo_hash, "content_hash": evo_content_hash}

        snapshot: dict[str, Any] = {
            "series_keys": series_keys_map,
            "series_items": series_items_snap,
            "notices": notices,
            "context_changes": context_changes,
        }

        stream_id = f"review:{caller.id}.{participant_id}"
        now_ms = utc_now_ms()

        def _build_evolution(seq: int, prev_hash: str | None) -> dict[str, Any]:
            ev_wo_hash: dict[str, Any] = {
                "event_id": compute_event_id(stream_id, seq),
                "schema_version": 3,
                "type": "evolution.published",
                "stream_id": stream_id,
                "seq": seq,
                "prev_hash": prev_hash,
                "occurred_at": now_ms,
                "actor": {"role": "therapist", "id": caller.id},
                "scope": {"org_id": org_id, "participant_id": participant_id},
                "source": {"type": "therapist"},
                "execution_mode": "not_applicable",
                "data_origin": common_origin,
                "payload": payload,
            }
            if envelope_origin_ref is not None:
                ev_wo_hash["origin_ref"] = envelope_origin_ref
            return {**ev_wo_hash, "hash": compute_event_hash(ev_wo_hash)}

        stored_event, created = self.store.publish_evolution_event(
            stream_id=stream_id,
            evolution_id=evolution_id,
            org_id=org_id,
            participant_id=participant_id,
            content_hash=evo_content_hash,
            request_fingerprint=request_fingerprint,
            snapshot=snapshot,
            build_event_fn=_build_evolution,
        )
        return (
            {
                "evolution_id": evolution_id,
                "content_hash": stored_event["payload"]["content_hash"],
                "event_id": stored_event["event_id"],
            },
            201 if created else 200,
        )

    # ------------------------------------------------------------------
    # 3. evolution.get (GET /api/v3/evolution/{evolution_id})
    # ------------------------------------------------------------------

    def get_evolution(self, evolution_id: str, principal: Principal | None) -> dict[str, Any]:
        """Serve published evolution from event + R7 historical snapshot (D-S1-01-5, R7, R8, R9, R13)."""
        caller = _require_valid_principal(principal)
        if not _EVOLUTION_ID_RE.fullmatch(evolution_id):
            raise V3Error("NOT_FOUND", "Evolution not found.")

        record = self.store.get_evolution_record(evolution_id)
        if record is None:
            raise V3Error("NOT_FOUND", "Evolution not found.")

        event, _, snapshot = record
        participant_id = str(event["scope"]["participant_id"])
        org_id = str(event["scope"]["org_id"])

        links = self.store.latest_care_links(participant_id=participant_id)
        decision = authorize(
            caller,
            "evolution",
            "read published",
            AuthzScope(participant_id=participant_id, org_id=org_id, is_read_by_id=True),
            links=links,
        )
        _enforce_decision(decision)

        if snapshot is None:
            raise V3Error("INTERNAL", f"Snapshot missing for evolution {evolution_id!r}.")

        if caller.role == "therapist":
            return {
                "event": event,
                "series_keys": snapshot["series_keys"],
                "notices": snapshot["notices"],
                "context_changes": snapshot["context_changes"],
            }

        return _build_participant_evolution_view(event, snapshot)

    # ------------------------------------------------------------------
    # 4. timeline.get (GET /api/v3/participants/{participant_id}/timeline)
    # ------------------------------------------------------------------

    def get_timeline(self, participant_id: str, principal: Principal | None) -> dict[str, Any]:
        """Return therapist-only unified history of clinical entities + published events (D-S1-01-6, R3, R4)."""
        _, org_id = self._authorize_therapist_participant(
            principal,
            "timeline",
            "read",
            participant_id,
        )

        ranked_items: list[tuple[tuple[str, int, str, str], dict[str, Any]]] = []

        # Rank 0: every stored version of clinical entities (excluding participant, therapist, care_link, draft)
        entities = self.store.list_participant_entity_versions(
            participant_id,
            _TIMELINE_ENTITY_TYPES,
            org_id=org_id,
        )
        for ent in entities:
            kind = str(ent["entity_type"])
            ref = f"{ent['entity_id']}@v{ent['version']}"
            occurred_at = str(ent["created_at"])
            data_origin = str(ent["data_origin"])
            item = {
                "kind": kind,
                "ref": ref,
                "occurred_at": occurred_at,
                "origin_label": origin_label_for(data_origin),
                "data_origin": data_origin,
                "execution_mode": "not_applicable",
            }
            ranked_items.append(((occurred_at, 0, kind, ref), item))

        # Rank 1: published events (prescription.published, summary.published, evolution.published)
        p_events = self.store.get_participant_events(participant_id)
        for ev in p_events:
            ev_type = str(ev.get("type", ""))
            if ev_type not in _TIMELINE_EVENT_TYPES:
                continue
            if ev.get("scope", {}).get("org_id") != org_id:
                continue
            ref = str(ev["event_id"])
            occurred_at = str(ev["occurred_at"])
            data_origin = str(ev["data_origin"])
            execution_mode = str(ev["execution_mode"])
            item = {
                "kind": ev_type,
                "ref": ref,
                "occurred_at": occurred_at,
                "origin_label": origin_label_for(data_origin),
                "data_origin": data_origin,
                "execution_mode": execution_mode,
            }
            ranked_items.append(((occurred_at, 1, ev_type, ref), item))

        ranked_items.sort(key=lambda pair: pair[0])
        return {"items": [item for _, item in ranked_items]}
