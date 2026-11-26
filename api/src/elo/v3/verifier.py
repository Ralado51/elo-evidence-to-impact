"""Single normative fact verifier and derivation engine for Elo CL06.3 v3 (fact-catalog v2).

Written from scratch in Python (S1b-02, PO-F27 option B, D-S1b-02-1) following:
- contracts/CL06_3-r1/contracts/catalogs/fact-catalog.v2.json
- contracts/CL06_3-r1/contracts/catalogs/limitations.v2.json
- contracts/CL06_3-r1/contracts/schemas/facts/*.schema.json
- Selectors and session_date_local semantics specified by CL06.1 facts/catalog.mjs and
  session-states.mjs (specification only, no code copied).

Single truth path: ``verify_fact`` is the sole fact verification function in the v3
layer. ``derive_facts`` and ``FactsService`` always verify every derived candidate
through ``verify_fact``. Never imports legacy ``elo.verifier``, ``elo.home_sessions``,
or ``elo.review``. Never persists or mutates storage.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from elo.canonical import canonicalize, hash_canonical
from elo.v3.authz import AuthzScope, Principal, authorize
from elo.v3.civil_date import is_civil_date
from elo.v3.entities import validate as validate_schema
from elo.v3.errors import V3Error
from elo.v3.session_rules import CAPTURE_MODES, evaluate_session_stream
from elo.v3.validation import check_session_stream

VERIFIER_VERSION = "0.1.0"
FACT_CATALOG_VERSION = "2"

_CONTRACTS_ROOT = Path(__file__).resolve().parents[4] / "contracts" / "CL06_3-r1" / "contracts"
_CATALOG_PATH = _CONTRACTS_ROOT / "catalogs" / "fact-catalog.v2.json"
_LIMITATIONS_PATH = _CONTRACTS_ROOT / "catalogs" / "limitations.v2.json"
_FACT_SCHEMAS_DIR = _CONTRACTS_ROOT / "schemas" / "facts"

_PROPOSAL_KEYS: frozenset[str] = frozenset(
    {"type", "catalog_version", "params", "evidence_refs", "scope", "data_origin"}
)
_CAPTURE_ALGORITHM_FACTS: frozenset[str] = frozenset({"F01", "F05", "F06", "F09", "F10"})
_END_CONTROL_ACTIONS: frozenset[str] = frozenset({"end", "pain", "fatigue", "interrupt"})
_SYMPTOM_ACTIONS: frozenset[str] = frozenset({"pain", "fatigue"})

_PLACEHOLDER_RE = re.compile(r"\{([a-z_]+)(?:\|([a-z0-9]+)((?::[^:{}]+)*))?\}")
_PARTICIPANT_ID_RE = re.compile(r"^p_[A-Za-z0-9-]{8,64}$")
_FACT_ID_RE = re.compile(r"^f_[0-9a-f]{64}$")

VERIFICATION_STEPS: tuple[str, ...] = (
    "SHAPE",
    "TYPE",
    "VERSION",
    "PARAMS",
    "REFS_EXIST",
    "REFS_SCOPE",
    "REFS_TYPE",
    "PRECONDITIONS",
    "EVIDENCE_SET",
    "RECOMPUTE",
)


@lru_cache(maxsize=1)
def load_fact_catalog() -> dict[str, Any]:
    return json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def load_limitations_catalog() -> dict[str, Any]:
    return json.loads(_LIMITATIONS_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def load_fact_proposal_schemas() -> dict[str, dict[str, Any]]:
    schemas: dict[str, dict[str, Any]] = {}
    for p in sorted(_FACT_SCHEMAS_DIR.glob("fact-proposal.*.schema.json")):
        ftype = p.name.split(".")[1]
        schemas[ftype] = json.loads(p.read_text(encoding="utf-8"))
    return schemas


@lru_cache(maxsize=1)
def load_fact_schemas() -> dict[str, dict[str, Any]]:
    schemas: dict[str, dict[str, Any]] = {}
    for p in sorted(_FACT_SCHEMAS_DIR.glob("fact.*.schema.json")):
        ftype = p.name.split(".")[1]
        schemas[ftype] = json.loads(p.read_text(encoding="utf-8"))
    return schemas


def compute_fact_id(proposal_or_fact: Mapping[str, Any]) -> str:
    """Compute normative ``fact_id = 'f_' + hash_canonical(body)``."""
    body = {
        k: proposal_or_fact[k]
        for k in ("catalog_version", "data_origin", "evidence_refs", "params", "scope", "type")
    }
    return f"f_{hash_canonical(body)}"


def compute_content_hash(fact: Mapping[str, Any]) -> str:
    """Compute normative ``content_hash = hash_canonical(full_fact)``."""
    return hash_canonical(dict(fact))


# ---------------------------------------------------------------------------
# Pure value checks & template rendering
# ---------------------------------------------------------------------------


def _is_real_local_date(value: Any) -> bool:
    return is_civil_date(value)


def _scan_value_hygiene(val: Any, path: str = "$") -> tuple[str, str] | None:
    """Detect non-finite floats or control chars / lone surrogates before schema checks."""
    if isinstance(val, bool) or val is None:
        return None
    if isinstance(val, float) and not math.isfinite(val):
        return path, "NON_FINITE"
    if isinstance(val, str):
        for ch in val:
            cp = ord(ch)
            if cp < 0x20 or (0xD800 <= cp <= 0xDFFF):
                return path, "INVALID_CHARACTERS"
        return None
    if isinstance(val, list):
        for idx, item in enumerate(val):
            hit = _scan_value_hygiene(item, f"{path}[{idx}]")
            if hit is not None:
                return hit
        return None
    if isinstance(val, dict):
        for k, v in val.items():
            khit = _scan_value_hygiene(k, f"{path}.{k}")
            if khit is not None:
                return khit
            vhit = _scan_value_hygiene(v, f"{path}.{k}")
            if vhit is not None:
                return vhit
        return None
    return None


def _format_placeholder(
    val: Any,
    formatter: str | None,
    args: list[str],
    labels: Mapping[str, Mapping[str, str]],
) -> str:
    if formatter is None:
        return str(val)
    if formatter == "date":
        yyyy, mm, dd = str(val).split("-")
        return f"{dd}/{mm}/{yyyy}"
    if formatter == "int":
        return str(int(val))
    if formatter == "percent":
        return str(round(float(val) * 100))
    if formatter == "decimal2":
        # Pure, locale-independent PT-BR decimal comma (D-S1b-02-1(d))
        return f"{float(val):.2f}".replace(".", ",")
    if formatter == "count":
        n = int(val)
        singular, plural = args[0], args[1]
        return f"{n} {singular if n == 1 else plural}"
    if formatter == "label":
        table = labels[args[0]]
        return table[str(val)]
    raise ValueError(f"Unsupported template formatter: {formatter!r}")


def _render_fact_text(
    fact_spec: Mapping[str, Any],
    params: Mapping[str, Any],
    data_origin: str,
    labels: Mapping[str, Mapping[str, str]],
    lims_catalog: Mapping[str, Any],
) -> str:
    tmpl = fact_spec["template"]
    if "text" in tmpl:
        raw_text = tmpl["text"]
    else:
        variant_key = str(params[tmpl["variant_by"]])
        raw_text = tmpl["variants"][variant_key]

    def _sub(match: re.Match[str]) -> str:
        param_name = match.group(1)
        fmt = match.group(2)
        raw_args = match.group(3) or ""
        args = raw_args[1:].split(":") if raw_args else []
        return _format_placeholder(params[param_name], fmt, args, labels)

    body = _PLACEHOLDER_RE.sub(_sub, raw_text)
    prefix = lims_catalog["origin_prefix"].get(data_origin, "")
    return f"{prefix}{body}"


def _evaluate_rule_condition(rule: Mapping[str, Any], params: Mapping[str, Any]) -> bool:
    if rule.get("always"):
        return True
    val = params.get(rule["param"])
    if "eq" in rule:
        return val == rule["eq"] and type(val) is type(rule["eq"])
    if "gt" in rule:
        return isinstance(val, (int, float)) and not isinstance(val, bool) and val > rule["gt"]
    return False


# ---------------------------------------------------------------------------
# Normative ledger selectors (CL06.1 facts/catalog.mjs & session-states.mjs)
# ---------------------------------------------------------------------------


def _select_start(session_events: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    for ev in session_events:
        if ev.get("type") == "session.started" and ev.get("seq") == 1:
            return ev
    return None


def _select_terminal(session_events: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    for ev in session_events:
        t = ev.get("type")
        if t == "session.completed":
            return ev
        if t == "session.control" and ev.get("payload", {}).get("action") in _END_CONTROL_ACTIONS:
            return ev
    return None


def _select_effective_calibration(session_events: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    effective: Mapping[str, Any] | None = None
    for ev in session_events:
        t = ev.get("type")
        if t == "session.control" and ev.get("payload", {}).get("action") == "start":
            break
        if t == "calibration.applied":
            effective = ev
    return effective


def _select_effective_report(session_events: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    reports = [ev for ev in session_events if ev.get("type") == "report.submitted"]
    if not reports:
        return None
    return max(reports, key=lambda ev: int(ev["seq"]))


def _select_capture_summaries(session_events: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return [ev for ev in session_events if ev.get("type") == "session.capture_summary"]


def _select_effective_measurement(
    session_events: Sequence[Mapping[str, Any]],
    measure_kind: str = "opening_index",
) -> Mapping[str, Any] | None:
    matches = [
        ev
        for ev in session_events
        if ev.get("type") == "measurement.recorded" and ev.get("payload", {}).get("measure_kind") == measure_kind
    ]
    if not matches:
        return None
    return max(matches, key=lambda ev: int(ev["seq"]))


def _select_gaps(session_events: Sequence[Mapping[str, Any]]) -> list[int]:
    if not session_events:
        return []
    seqs = sorted({int(ev["seq"]) for ev in session_events})
    seen = set(seqs)
    return [s for s in range(1, seqs[-1]) if s not in seen]


def _end_reason_of(terminal_ev: Mapping[str, Any]) -> tuple[str, str | None]:
    if terminal_ev.get("type") == "session.completed":
        return "completed", None
    payload = terminal_ev.get("payload", {})
    action = payload.get("action")
    if action == "end":
        return "ended", None
    if action in _SYMPTOM_ACTIONS:
        return "symptom", None
    return "interrupted", payload.get("interrupt_reason")


def _session_local_date(start_ev: Mapping[str, Any], rx_ev: Mapping[str, Any] | None) -> str:
    occ = str(start_ev["occurred_at"])
    dt_utc = datetime.fromisoformat(occ.replace("Z", "+00:00"))
    tz_name = rx_ev["payload"]["timezone"] if rx_ev is not None else "UTC"
    return dt_utc.astimezone(ZoneInfo(tz_name)).date().isoformat()


def _select_revision(
    events_by_stream: Mapping[str, list[Mapping[str, Any]]],
    scope: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    rx_id = scope.get("prescription_id")
    rx_rev = scope.get("prescription_revision")
    if not isinstance(rx_id, str) or not isinstance(rx_rev, int) or isinstance(rx_rev, bool):
        return None
    for ev in events_by_stream.get(f"prescription:{rx_id}", ()):
        if ev.get("type") == "prescription.published" and ev.get("seq") == rx_rev:
            es = ev.get("scope", {})
            if (
                es.get("org_id") == scope.get("org_id")
                and es.get("participant_id") == scope.get("participant_id")
                and es.get("exercise_id") == scope.get("exercise_id")
            ):
                return ev
    return None


def _index_ledger(
    ledger_events: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, Mapping[str, Any]], dict[str, list[Mapping[str, Any]]]]:
    by_id: dict[str, Mapping[str, Any]] = {}
    by_stream: dict[str, list[Mapping[str, Any]]] = {}
    for ev in ledger_events:
        eid = ev.get("event_id")
        if isinstance(eid, str):
            by_id[eid] = ev
        sid = ev.get("stream_id")
        if isinstance(sid, str):
            by_stream.setdefault(sid, []).append(ev)
    for sid in by_stream:
        by_stream[sid].sort(key=lambda e: int(e["seq"]))
    return by_id, by_stream


# ---------------------------------------------------------------------------
# Preconditions, exact evidence set, and parameter derivation per fact type
# ---------------------------------------------------------------------------


def _stream_check_clean(
    session_events: Sequence[Mapping[str, Any]],
    rx_ev: Mapping[str, Any] | None,
) -> bool:
    if rx_ev is None or not session_events:
        return False
    rx_payload = rx_ev["payload"]
    report = evaluate_session_stream(session_events, rx_payload)
    if report.errors:
        return False
    if check_session_stream(session_events, rx_payload):
        return False
    return True


def _discrepancy_rule_holds(reported: str, observed: int, target: int) -> bool:
    if reported == "complete":
        return observed < target
    if reported == "partial":
        return observed == 0 or observed == target
    if reported == "none":
        return observed > 0
    return False


def _evaluate_preconditions_and_derive(
    fact_type: str,
    session_events: Sequence[Mapping[str, Any]],
    rx_ev: Mapping[str, Any] | None,
    events_by_id: Mapping[str, Mapping[str, Any]],
) -> tuple[bool, list[str] | None, dict[str, Any] | None]:
    """Check all catalog preconditions for ``fact_type`` on ``session_events``.

    Returns ``(ok, sorted_evidence_refs, derived_params)`` when preconditions hold,
    otherwise ``(False, None, None)``.
    """
    cat = load_fact_catalog()
    spec = cat["types"][fact_type]
    preconds: list[str] = list(spec["preconditions"])

    start_ev = _select_start(session_events)
    terminal_ev = _select_terminal(session_events)
    cal_ev = _select_effective_calibration(session_events)
    report_ev = _select_effective_report(session_events)
    summaries = _select_capture_summaries(session_events)
    meas_ev = _select_effective_measurement(session_events, "opening_index")
    gaps = _select_gaps(session_events)

    accepted_cycles = [ev for ev in session_events if ev.get("type") == "cycle.accepted"]
    incompatible_cycles = [
        ev
        for ev in session_events
        if ev.get("type") == "cycle.rejected" and ev.get("payload", {}).get("reason") == "handedness_incompatible"
    ]

    for cond in preconds:
        if cond == "START_PRESENT":
            if start_ev is None:
                return False, None, None
        elif cond == "MODE_IS_CAPTURE":
            if start_ev is None or start_ev.get("payload", {}).get("source_mode") not in CAPTURE_MODES:
                return False, None, None
        elif cond == "TERMINAL_PRESENT":
            if terminal_ev is None:
                return False, None, None
        elif cond == "EFFECTIVE_CALIBRATION_PRESENT":
            if cal_ev is None:
                return False, None, None
            if fact_type == "F09":
                refs = cal_ev.get("payload", {}).get("attempt_refs", [])
                if len(refs) != 2 or any(r not in events_by_id for r in refs):
                    return False, None, None
        elif cond == "EFFECTIVE_REPORT_PRESENT":
            if report_ev is None:
                return False, None, None
        elif cond == "REPORT_EXECUTION_NOT_UNREPORTED":
            if report_ev is None or report_ev.get("payload", {}).get("execution") == "unreported":
                return False, None, None
        elif cond == "REPORT_ASSISTANCE_NOT_UNREPORTED":
            if report_ev is None or report_ev.get("payload", {}).get("assistance") == "unreported":
                return False, None, None
        elif cond == "CAPTURE_SUMMARY_PRESENT":
            if len(summaries) != 1:
                return False, None, None
        elif cond == "CAPTURE_SUMMARY_NONEMPTY":
            if len(summaries) != 1 or int(summaries[0].get("payload", {}).get("frames_total", 0)) <= 0:
                return False, None, None
        elif cond == "TERMINAL_IS_SYMPTOM":
            if (
                terminal_ev is None
                or terminal_ev.get("type") != "session.control"
                or terminal_ev.get("payload", {}).get("action") not in _SYMPTOM_ACTIONS
            ):
                return False, None, None
        elif cond == "STREAM_CHECK_CLEAN":
            if not _stream_check_clean(session_events, rx_ev):
                return False, None, None
        elif cond == "NO_GAPS":
            if gaps:
                return False, None, None
        elif cond == "DISCREPANCY_RULE":
            if rx_ev is None or report_ev is None:
                return False, None, None
            target = int(rx_ev["payload"]["target_sets"]) * int(rx_ev["payload"]["target_repetitions"])
            rep_exec = str(report_ev["payload"]["execution"])
            if not _discrepancy_rule_holds(rep_exec, len(accepted_cycles), target):
                return False, None, None
        elif cond == "MEASUREMENT_PRESENT":
            if meas_ev is None:
                return False, None, None
            mp = meas_ev.get("payload", {})
            if mp.get("quality") not in ("usable", "insufficient"):
                return False, None, None
            if mp.get("value") is None or mp.get("unit") != "1":
                return False, None, None
        elif cond == "MEASUREMENT_EXPERIMENTAL":
            if meas_ev is None or meas_ev.get("payload", {}).get("experimental") is not True:
                return False, None, None
        else:
            raise ValueError(f"Unknown precondition in catalog: {cond!r}")

    assert start_ev is not None
    session_id = str(start_ev["scope"]["session_id"])
    session_date_local = _session_local_date(start_ev, rx_ev)

    if fact_type == "F01":
        assert rx_ev is not None and cal_ev is not None and terminal_ev is not None
        target = int(rx_ev["payload"]["target_sets"]) * int(rx_ev["payload"]["target_repetitions"])
        unknown_hand = sum(1 for c in accepted_cycles if c.get("payload", {}).get("handedness") is None)
        refs = sorted(
            {
                str(start_ev["event_id"]),
                str(rx_ev["event_id"]),
                str(cal_ev["event_id"]),
                str(terminal_ev["event_id"]),
                *(str(c["event_id"]) for c in accepted_cycles),
                *(str(c["event_id"]) for c in incompatible_cycles),
            }
        )
        params = {
            "session_id": session_id,
            "session_date_local": session_date_local,
            "accepted": len(accepted_cycles),
            "target": target,
            "capture_source": start_ev["payload"]["source_mode"],
            "algorithm_version": start_ev["source"]["algorithm_version"],
            "calibration_id": cal_ev["payload"]["calibration_id"],
            "handedness_mismatch_cycles": len(incompatible_cycles),
            "handedness_unknown_cycles": unknown_hand,
            "incomplete_upload": len(gaps) > 0,
        }
        return True, refs, params

    if fact_type == "F02":
        assert terminal_ev is not None
        end_reason, interrupt_reason = _end_reason_of(terminal_ev)
        refs = sorted({str(start_ev["event_id"]), str(terminal_ev["event_id"])})
        params = {
            "session_id": session_id,
            "session_date_local": session_date_local,
            "end_reason": end_reason,
            "interrupt_reason": interrupt_reason,
        }
        return True, refs, params

    if fact_type == "F03":
        assert report_ev is not None
        refs = sorted({str(start_ev["event_id"]), str(report_ev["event_id"])})
        params = {
            "session_id": session_id,
            "session_date_local": session_date_local,
            "execution": report_ev["payload"]["execution"],
        }
        return True, refs, params

    if fact_type == "F04":
        assert report_ev is not None
        refs = sorted({str(start_ev["event_id"]), str(report_ev["event_id"])})
        params = {
            "session_id": session_id,
            "session_date_local": session_date_local,
            "assistance": report_ev["payload"]["assistance"],
            "reporter_role": report_ev["payload"]["reporter_role"],
        }
        return True, refs, params

    if fact_type == "F05":
        assert rx_ev is not None and terminal_ev is not None and report_ev is not None
        target = int(rx_ev["payload"]["target_sets"]) * int(rx_ev["payload"]["target_repetitions"])
        refs = sorted(
            {
                str(start_ev["event_id"]),
                str(rx_ev["event_id"]),
                str(terminal_ev["event_id"]),
                str(report_ev["event_id"]),
                *(str(c["event_id"]) for c in accepted_cycles),
                *(str(c["event_id"]) for c in incompatible_cycles),
            }
        )
        params = {
            "session_id": session_id,
            "session_date_local": session_date_local,
            "reported_execution": report_ev["payload"]["execution"],
            "observed_accepted": len(accepted_cycles),
            "target": target,
            "capture_source": start_ev["payload"]["source_mode"],
        }
        return True, refs, params

    if fact_type == "F06":
        summary_ev = summaries[0]
        sp = summary_ev["payload"]
        refs = sorted({str(start_ev["event_id"]), str(summary_ev["event_id"])})
        params = {
            "session_id": session_id,
            "session_date_local": session_date_local,
            "usable_fraction": sp["usable_fraction"],
            "lost_events": sp["lost_events"],
            "fps_mean": sp["fps_mean"],
            "fps_min": sp["fps_min"],
            "low_capture_quality": float(sp["usable_fraction"]) < 0.5,
        }
        return True, refs, params

    if fact_type == "F08":
        assert terminal_ev is not None
        refs = sorted({str(start_ev["event_id"]), str(terminal_ev["event_id"])})
        params = {
            "session_id": session_id,
            "session_date_local": session_date_local,
            "symptom": terminal_ev["payload"]["action"],
        }
        return True, refs, params

    if fact_type == "F09":
        assert cal_ev is not None
        cp = cal_ev["payload"]
        refs = sorted({str(start_ev["event_id"]), str(cal_ev["event_id"]), *(str(r) for r in cp["attempt_refs"])})
        params = {
            "session_id": session_id,
            "session_date_local": session_date_local,
            "calibration_id": cp["calibration_id"],
            "open": cp["open"],
            "closed": cp["closed"],
            "span": cp["span"],
            "min_span_required": cp["min_span_required"],
        }
        return True, refs, params

    if fact_type == "F10":
        assert meas_ev is not None
        mp = meas_ev["payload"]
        refs = sorted({str(start_ev["event_id"]), str(meas_ev["event_id"])})
        params = {
            "session_id": session_id,
            "session_date_local": session_date_local,
            "measure_kind": mp["measure_kind"],
            "value": mp["value"],
            "unit": mp["unit"],
            "method": mp["method"],
            "algorithm_version": meas_ev["source"]["algorithm_version"],
            "protocol_id": mp["protocol_id"],
            "measurement_quality": mp["quality"],
            "experimental": mp["experimental"],
        }
        return True, refs, params

    raise ValueError(f"Unsupported fact type: {fact_type!r}")


def _build_verified_fact(
    proposal: Mapping[str, Any],
    start_ev: Mapping[str, Any],
    session_events: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, Any], str]:
    cat = load_fact_catalog()
    lims_cat = load_limitations_catalog()
    fact_type = str(proposal["type"])
    spec = cat["types"][fact_type]
    params = dict(proposal["params"])
    data_origin = str(proposal["data_origin"])

    lim_set: set[str] = set(spec["limitations"]["always"])
    for cond in spec["limitations"]["when"]:
        if _evaluate_rule_condition(cond, params):
            lim_set.add(cond["code"])
    origin_lim = lims_cat["origin_limitation"].get(data_origin)
    if origin_lim:
        lim_set.add(origin_lim)
    limitations = sorted(lim_set)

    text_ptbr = _render_fact_text(spec, params, data_origin, cat["labels"], lims_cat)
    limitations_ptbr = [lims_cat["texts_ptbr"][code] for code in limitations]

    highlight = any(_evaluate_rule_condition(rule, params) for rule in spec["highlight"])
    summary_eligible = bool(spec["summary_eligible"])

    algorithm: str | None = None
    if fact_type == "F10":
        meas_ev = _select_effective_measurement(session_events, "opening_index")
        algorithm = meas_ev["source"].get("algorithm_version") if meas_ev is not None else None
    elif fact_type in _CAPTURE_ALGORITHM_FACTS:
        algorithm = start_ev.get("source", {}).get("algorithm_version")

    fact_id = compute_fact_id(proposal)
    fact: dict[str, Any] = {
        "fact_id": fact_id,
        "type": fact_type,
        "catalog_version": FACT_CATALOG_VERSION,
        "params": params,
        "evidence_refs": list(proposal["evidence_refs"]),
        "scope": dict(proposal["scope"]),
        "data_origin": data_origin,
        "versions": {
            "catalog": FACT_CATALOG_VERSION,
            "verifier": VERIFIER_VERSION,
            "algorithm": algorithm,
            "definition": int(spec["definition_version"]),
        },
        "limitations": limitations,
        "rendered": {
            "text_ptbr": text_ptbr,
            "limitations_ptbr": limitations_ptbr,
        },
        "flags": {
            "highlight": highlight,
            "summary_eligible": summary_eligible,
        },
    }
    schema_errs = validate_schema(load_fact_schemas()[fact_type], fact)
    if schema_errs:
        raise ValueError(f"Constructed fact {fact_type} failed schema check: {schema_errs}")
    return fact, compute_content_hash(fact)


# ---------------------------------------------------------------------------
# SINGLE NORMATIVE FACT VERIFICATION FUNCTION (Row 5, D-S1b-02-1)
# ---------------------------------------------------------------------------


def _reject(code: str, step: str) -> dict[str, Any]:
    return {
        "valid": False,
        "code": code,
        "step": step,
        "fact": None,
        "content_hash": None,
    }


def verify_fact(
    proposal: Any,
    ledger_events: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Single normative verifier for a CL06.3 v3 fact proposal against ``ledger_events``.

    Follows D-S1b-02-1(b) step order:
    SHAPE / TYPE / PARAMS -> REFS_EXIST -> REFS_SCOPE -> REFS_TYPE ->
    PRECONDITIONS -> EVIDENCE_SET -> RECOMPUTE.

    Returns ``{"valid": bool, "code": str|None, "step": str|None, "fact": dict|None, "content_hash": str|None}``.
    Never mutates ``proposal`` or ``ledger_events`` and never persists anything.
    """
    cat = load_fact_catalog()
    prop_schemas = load_fact_proposal_schemas()

    # 1. SHAPE / TYPE / PARAMS (stateless proposal checks)
    if not isinstance(proposal, Mapping):
        return _reject("TYPE", "SHAPE")

    hygiene = _scan_value_hygiene(proposal)
    if hygiene is not None:
        hpath, hcode = hygiene
        return _reject(hcode, "PARAMS" if hpath.startswith("$.params") else "SHAPE")

    for k in proposal.keys():
        if k not in _PROPOSAL_KEYS:
            return _reject("UNKNOWN_FIELD", "SHAPE")

    ftype = proposal.get("type")
    if not isinstance(ftype, str) or ftype not in cat["types"]:
        if "type" not in proposal:
            return _reject("MISSING_FIELD", "SHAPE")
        if not isinstance(ftype, str):
            return _reject("TYPE", "SHAPE")
        return _reject("UNKNOWN_TYPE", "TYPE")

    schema_errs = validate_schema(prop_schemas[ftype], dict(proposal))
    if schema_errs:
        err_path, err_code = schema_errs[0]
        step = "PARAMS" if err_path.startswith("$.params") else "SHAPE"
        return _reject(err_code, step)

    params = proposal["params"]
    scope = proposal["scope"]
    if not _is_real_local_date(params["session_date_local"]):
        return _reject("INVALID_INSTANT", "PARAMS")
    if params["session_id"] != scope["session_id"]:
        return _reject("SCOPE_INVALID", "PARAMS")
    if ftype == "F02":
        if (params["end_reason"] == "interrupted") != (params["interrupt_reason"] is not None):
            return _reject("RULE_VIOLATION", "PARAMS")

    # Index stored ledger events (read-only)
    events_by_id, events_by_stream = _index_ledger(ledger_events)
    evidence_refs: list[str] = list(proposal["evidence_refs"])

    # 2. REFS_EXIST -> REF_MISSING
    cited_events: list[Mapping[str, Any]] = []
    for ref in evidence_refs:
        ev = events_by_id.get(ref)
        if ev is None:
            return _reject("REF_MISSING", "REFS_EXIST")
        cited_events.append(ev)

    # 3. REFS_SCOPE -> REF_OUT_OF_SCOPE
    prop_origin = proposal["data_origin"]
    for ev in cited_events:
        es = ev.get("scope", {})
        in_scope = es.get("org_id") == scope["org_id"] and es.get("participant_id") == scope["participant_id"]
        if ev.get("type") == "prescription.published":
            in_scope = (
                in_scope
                and es.get("prescription_id") == scope["prescription_id"]
                and es.get("prescription_revision") == scope["prescription_revision"]
                and es.get("exercise_id") == scope["exercise_id"]
            )
        else:
            in_scope = (
                in_scope
                and es.get("session_id") == scope["session_id"]
                and es.get("prescription_id") == scope["prescription_id"]
                and es.get("prescription_revision") == scope["prescription_revision"]
                and es.get("exercise_id") == scope["exercise_id"]
            )
        if not in_scope or ev.get("data_origin") != prop_origin:
            return _reject("REF_OUT_OF_SCOPE", "REFS_SCOPE")

    # 4. REFS_TYPE -> REF_WRONG_TYPE
    admissible_types: set[str] = set()
    for role_spec in cat["types"][ftype]["evidence"]:
        t_val = role_spec["type"]
        if isinstance(t_val, list):
            admissible_types.update(t_val)
        else:
            admissible_types.add(t_val)
    for ev in cited_events:
        if ev.get("type") not in admissible_types:
            return _reject("REF_WRONG_TYPE", "REFS_TYPE")

    # 5. PRECONDITIONS -> PRECONDITION_FAILED
    session_stream_id = f"session:{scope['session_id']}"
    session_events = [
        ev
        for ev in events_by_stream.get(session_stream_id, ())
        if ev.get("scope", {}).get("org_id") == scope["org_id"]
        and ev.get("scope", {}).get("participant_id") == scope["participant_id"]
    ]
    start_ev = _select_start(session_events)
    if start_ev is not None:
        ss = start_ev.get("scope", {})
        if (
            ss.get("prescription_id") != scope["prescription_id"]
            or ss.get("prescription_revision") != scope["prescription_revision"]
            or ss.get("exercise_id") != scope["exercise_id"]
            or start_ev.get("data_origin") != prop_origin
        ):
            return _reject("PRECONDITION_FAILED", "PRECONDITIONS")

    rx_ev = _select_revision(events_by_stream, scope)
    ok, expected_refs, expected_params = _evaluate_preconditions_and_derive(
        ftype,
        session_events,
        rx_ev,
        events_by_id,
    )
    if not ok or expected_refs is None or expected_params is None:
        return _reject("PRECONDITION_FAILED", "PRECONDITIONS")

    # 6. EVIDENCE_SET -> EVIDENCE_SET_MISMATCH
    if evidence_refs != expected_refs:
        return _reject("EVIDENCE_SET_MISMATCH", "EVIDENCE_SET")

    # 7. RECOMPUTE -> RECOMPUTE_MISMATCH
    if canonicalize(dict(params)) != canonicalize(expected_params):
        return _reject("RECOMPUTE_MISMATCH", "RECOMPUTE")

    # Verified -> build full rendered fact & content_hash
    assert start_ev is not None
    fact, content_hash = _build_verified_fact(proposal, start_ev, session_events)
    return {
        "valid": True,
        "code": None,
        "step": None,
        "fact": fact,
        "content_hash": content_hash,
    }


# ---------------------------------------------------------------------------
# Fact derivation (always verified through verify_fact)
# ---------------------------------------------------------------------------


def derive_facts(
    ledger_events: Sequence[Mapping[str, Any]],
    *,
    participant_id: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Derive and verify every fact whose preconditions hold across session streams in ``ledger_events``.

    Every candidate is verified via ``verify_fact`` (single truth path).
    Returns ``(facts, content_hashes_by_fact_id)`` in deterministic order ``(session_id, fact_type)``.
    """
    cat = load_fact_catalog()
    fact_types = list(cat["types"].keys())
    events_by_id, events_by_stream = _index_ledger(ledger_events)

    session_streams = sorted(sid for sid in events_by_stream if sid.startswith("session:"))
    verified_facts: list[dict[str, Any]] = []
    content_hashes: dict[str, str] = {}

    for sid in session_streams:
        s_events = events_by_stream[sid]
        start_ev = _select_start(s_events)
        if start_ev is None:
            continue
        scope = dict(start_ev["scope"])
        if participant_id is not None and scope.get("participant_id") != participant_id:
            continue
        rx_ev = _select_revision(events_by_stream, scope)
        data_origin = str(start_ev["data_origin"])

        for ftype in fact_types:
            ok, expected_refs, expected_params = _evaluate_preconditions_and_derive(
                ftype,
                s_events,
                rx_ev,
                events_by_id,
            )
            if not ok or expected_refs is None or expected_params is None:
                continue
            local_date = str(expected_params["session_date_local"])
            if date_from is not None and local_date < date_from:
                continue
            if date_to is not None and local_date > date_to:
                continue
            proposal = {
                "type": ftype,
                "catalog_version": FACT_CATALOG_VERSION,
                "params": expected_params,
                "evidence_refs": expected_refs,
                "scope": scope,
                "data_origin": data_origin,
            }
            res = verify_fact(proposal, ledger_events)
            if res["valid"] and res["fact"] is not None and res["content_hash"] is not None:
                fact = res["fact"]
                verified_facts.append(fact)
                content_hashes[fact["fact_id"]] = res["content_hash"]

    return verified_facts, content_hashes


# ---------------------------------------------------------------------------
# HTTP Service Facade for facts.list, facts.evidence, facts.verify
# ---------------------------------------------------------------------------


class FactsService:
    """Read-only service backing ``facts.list``, ``facts.evidence``, and ``facts.verify``."""

    def __init__(self, store: Any) -> None:
        self.store = store

    def _require_therapist_role(self, principal: Principal) -> None:
        decision = authorize(principal, "fact", "read/verify/evidence", AuthzScope())
        if not decision.allowed and decision.code in ("FORBIDDEN", "ROLE_NOT_ALLOWED", "UNAUTHENTICATED"):
            raise V3Error(decision.code, decision.reason)

    def _authorize_participant_scope(
        self,
        principal: Principal,
        participant_id: str,
        *,
        org_id: str | None = None,
    ) -> None:
        self._require_therapist_role(principal)
        if not _PARTICIPANT_ID_RE.fullmatch(participant_id):
            raise V3Error("NOT_FOUND", "Participant not found.")

        p_ent = self.store.get_latest_entity(participant_id, entity_type="participant")
        has_evs = self.store.has_events_for_participant(participant_id)
        if p_ent is None and not has_evs:
            raise V3Error("NOT_FOUND", "Participant not found.")

        effective_org = org_id if org_id is not None else (p_ent["org_id"] if p_ent is not None else None)
        links = self.store.latest_care_links(participant_id=participant_id)
        decision = authorize(
            principal,
            "fact",
            "read/verify/evidence",
            AuthzScope(participant_id=participant_id, org_id=effective_org, is_read_by_id=False),
            links=links,
        )
        if not decision.allowed:
            assert decision.code is not None
            raise V3Error(decision.code, decision.reason)

    def list_facts(
        self,
        participant_id: str,
        principal: Principal,
        *,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> dict[str, Any]:
        """Derive and verify all facts for ``participant_id`` on read (D-S1b-02-1(c))."""
        self._authorize_participant_scope(principal, participant_id)
        if date_from is not None and not _is_real_local_date(date_from):
            raise V3Error("INVALID_INSTANT", "Query parameter 'from' must be a valid YYYY-MM-DD date.")
        if date_to is not None and not _is_real_local_date(date_to):
            raise V3Error("INVALID_INSTANT", "Query parameter 'to' must be a valid YYYY-MM-DD date.")

        events = self.store.get_participant_events(participant_id)
        facts, _ = derive_facts(
            events,
            participant_id=participant_id,
            date_from=date_from,
            date_to=date_to,
        )
        return {
            "facts": facts,
            "catalog_version": FACT_CATALOG_VERSION,
        }

    def get_evidence(self, fact_id: str, principal: Principal) -> dict[str, Any]:
        """Return ``{fact_id, events}`` for a verified fact visible to ``principal`` (D-S1b-02-1(c),(e)).

        Unentitled therapists (unlinked / revoked / other-org) and unknown fact IDs receive 404 NOT_FOUND.
        """
        self._require_therapist_role(principal)
        if not _FACT_ID_RE.fullmatch(fact_id):
            raise V3Error("NOT_FOUND", "Fact not found.")

        # Determine participants with an active care_link to this therapist in the same org
        all_links = self.store.latest_care_links()
        candidate_pids = sorted(
            {
                lk.participant_id
                for lk in all_links
                if lk.therapist_id == principal.id and lk.org_id == principal.org_id and lk.status == "active"
            }
        )
        for pid in candidate_pids:
            links = self.store.latest_care_links(participant_id=pid)
            decision = authorize(
                principal,
                "fact",
                "read/verify/evidence",
                AuthzScope(participant_id=pid, org_id=principal.org_id, is_read_by_id=True),
                links=links,
            )
            if not decision.allowed:
                continue
            p_events = self.store.get_participant_events(pid)
            facts, _ = derive_facts(p_events, participant_id=pid)
            for fact in facts:
                if fact["fact_id"] == fact_id:
                    by_id = {ev["event_id"]: ev for ev in p_events}
                    cited = [by_id[eid] for eid in fact["evidence_refs"] if eid in by_id]
                    return {"fact_id": fact_id, "events": cited}

        raise V3Error("NOT_FOUND", "Fact not found.")

    def verify_proposal(self, proposal: Any, principal: Principal) -> dict[str, Any]:
        """Verify ``proposal`` without persisting anything (D-S1b-02-1(c), Row 7)."""
        self._require_therapist_role(principal)
        if isinstance(proposal, Mapping):
            scope = proposal.get("scope")
            if isinstance(scope, Mapping):
                pid = scope.get("participant_id")
                org = scope.get("org_id")
                if isinstance(pid, str) and _PARTICIPANT_ID_RE.fullmatch(pid):
                    self._authorize_participant_scope(
                        principal,
                        pid,
                        org_id=org if isinstance(org, str) else None,
                    )
        # Read-only lookup across ledger events (so REFS_SCOPE distinguishes REF_OUT_OF_SCOPE vs REF_MISSING)
        ledger_events = self.store.get_all_events()
        return verify_fact(proposal, ledger_events)
