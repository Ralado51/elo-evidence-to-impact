#!/usr/bin/env python3
"""Builds CL06.3 contract artifacts (JSON Schemas + catalogs). Reads CL06.1 read-only as a baseline."""
import copy, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from dsl import *
import spec
from spec import ENUMS as E_

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
V1 = os.environ.get("CL06_1_DIR", "/home/claude/elo-knowledge-claude/04_repos/mvp_CL06_1/extracted/shared/contracts")
OUT = os.path.join(ROOT, "contracts")
ALIAS_PAT = "^[A-Za-zÀ-ÖØ-öø-ÿĀ-ž0-9 ._-]+$"   # portable (no \\p{L}: Python re lacks it); documented as a v3 change
SORTED_PROPS = {"evidence_refs", "limitations", "note_refs", "attempt_refs", "erased_event_types"}
def mark_sorted(o):
    if isinstance(o, dict):
        for k, v in list(o.items()):
            if k in SORTED_PROPS and isinstance(v, dict) and v.get("type") == "array": v["x-sorted"] = True
            mark_sorted(v)
    elif isinstance(o, list):
        for v in o: mark_sorted(v)
def w(rel, obj):
    if rel.startswith("schemas/"): mark_sorted(obj)
    p = os.path.join(OUT, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f: json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=False); f.write("\n")
def v1(name):
    with open(os.path.join(V1, "json", name), encoding="utf-8") as f: return json.load(f)

# ---------------- events ----------------
env_props = {
 "event_id": hexs(), "schema_version": C(3), "type": S(), "stream_id": S(pattern="^(session|prescription|consent|review|privacy):[A-Za-z0-9_.-]{8,140}$"),
 "seq": I(1, 1000000000), "prev_hash": hexs(True), "occurred_at": inst(), "t_mono_ms": N(0, 1000000000),
 "actor": O({"role": S(enum=E_["actor_role"]), "id": pat("actor")}),
 "scope": copy.deepcopy(v1("event.cycle.accepted.schema.json")["properties"]["scope"]),
 "source": O({"type": S(enum=E_["source_type"]), "algorithm_version": pat("algo"), "device_hint": S(enum=E_["device_hint"])}, required=["type"]),
 "execution_mode": S(enum=E_["execution_mode"]),                    # PD-03
 "data_origin": S(enum=E_["data_origin"]),                          # PD-03
 "origin_ref": hexs(),                                              # evidence pointer (sha256 of an origin-register entry)
 "hash": hexs(),
}
ENV_OPTIONAL = {"t_mono_ms", "origin_ref"}
def payload_for(t):
    if t in ("measurement.recorded", "evolution.published"): return NEW_PAYLOADS[t]
    p = copy.deepcopy(v1(f"event.{t}.schema.json")["properties"]["payload"])
    if t == "prescription.published":
        p["properties"]["limits_version"] = pat("limits"); p["required"].append("limits_version")
    if t in ("consent.accepted", "consent.revoked"):
        p["properties"]["scopes"] = A(S(enum=E_["consent_scope"]), 1, 2, unique=True); p["required"].append("scopes")
    if t == "cycle.rejected":
        p["properties"]["reason"] = S(enum=E_["cycle_rejection_reason"] + ["handedness_incompatible"])
    return p
E_["cycle_rejection_reason"] = E_["cycle_rejection_reason"]  # (extended in payload_for; kept explicit)
series_item = O({"fact_id": pat("fact"), "content_hash": hexs()})
NEW_PAYLOADS = {
 "measurement.recorded": O({
    "measurement_id": pat("meas"), "measure_kind": S(enum=E_["measure_kind"]), "value": N(-360, 360, True), "unit": S(enum=E_["measure_unit"]),
    "method": pat("key"), "quality": S(enum=E_["quality"]), "quality_reason": S(enum=E_["quality_reason"], nullable=True),
    "protocol_id": S(pattern=P["proto"], nullable=True), "limitation_codes": A(S(pattern="^L[0-9]{2}$"), 1, 8, unique=True),
    "experimental": C(True), "body_segment": S(enum=E_["body_segment"])}),
 "evolution.published": O({
    "evolution_id": pat("evo"), "period_from": date(), "period_to": date(), "comparability_rules_version": S(pattern=r"^cmp-v[0-9]{1,3}$"),
    "series": A(O({"series_key_hash": hexs(), "items": A(series_item, 1, 500)}), 1, 200),
    "assistance_transitions": A(O({"series_key_hash": hexs(), "from_fact_id": pat("fact"), "to_fact_id": pat("fact"),
        "from_level": S(enum=["none", "some", "full"]), "to_level": S(enum=["none", "some", "full"]),
        "direction": S(enum=["less_help_reported", "more_help_reported", "unchanged"])}), 0, 500),
    "note_refs": A(hexs(), 0, 500, unique=True), "content_hash": hexs()}),
}
x_sorted_types = {"summary.published.items"}
EVENT_SCHEMAS = {}
for t in spec.EVENT_TYPES:
    props = copy.deepcopy(env_props); props["type"] = C(t); props["payload"] = payload_for(t)
    req = [k for k in props if k not in ENV_OPTIONAL]
    EVENT_SCHEMAS[t] = sch(f"event.{t}", {"type": "object", "properties": props, "required": req, "additionalProperties": False})
    w(f"schemas/events/{t}.schema.json", EVENT_SCHEMAS[t])
ev_cat = {"catalog_version": "3", "schema_version": 3, "types": spec.EVENT_TYPES, "exec_source_pairs": {"description": "Applies ONLY to capture-only event types (those whose catalog sources are [camera, simulation]) and to session.started. For these, source.type must equal the stream execution_mode (camera or simulation); for session.started with report_only, source.type is participant_report. participant_report events (report.submitted, session.control by participant, etc.) are allowed in a session of ANY execution_mode.", "session_started": spec.EXEC_SOURCE},
  "rules": {
   "session_started_seq": 1, "session_started_mode_equals_envelope_execution_mode": True,
   "non_session_streams_execution_mode": "not_applicable",
   "origin_ref_required_for": ["experimental_capture", "imported_v1"],
   "handedness": "cycle.accepted with handedness.label != prescription.side is a stream-rule violation (HANDEDNESS_INCOMPATIBLE_ACCEPTED); such a cycle MUST be emitted as cycle.rejected with reason handedness_incompatible (PD-04). handedness == null is not incompatible.",
   "live_origin_gate": "data_origin=live is RESERVED: accepted only after the real-data gate (PD-05) is opened by the deployment; contracts alone do not open it.",
   "legacy": "schema_version 2 events (CL06.1) are READ-ONLY legacy; no v3 event may chain onto a v2 stream."},
  "added_in_v3": ["measurement.recorded", "evolution.published"], "removed_in_v3": [],
  "changed_in_v3": {"prescription.published": "payload.limits_version added (required)", "consent.accepted": "payload.scopes added (required)",
                    "consent.revoked": "payload.scopes added (required)", "cycle.rejected": "reason enum += handedness_incompatible",
                    "*": "envelope: schema_version 3; execution_mode added (required); data_origin enum += experimental_capture; origin_ref optional"}}
w("catalogs/event-catalog.v3.json", ev_cat)
w("catalogs/limits.v1.json", spec.LIMITS_V1)
w("catalogs/limitations.v2.json", {"catalog_version": "2", "texts_ptbr": spec.LIMITATIONS, "origin_prefix": spec.ORIGIN_PREFIX, "origin_limitation": spec.ORIGIN_LIMITATION})
w("catalogs/enums.v3.json", {"enums": spec.ENUMS, "removed_roles_must_be_rejected": spec.REMOVED_ROLES})

# ---------------- entities ----------------
ent_common = lambda etype, prefix, payload, has_participant=True: sch(f"entity.{etype}", O({
    "entity_id": S(pattern=f"^{prefix}_{BODY}$"), "entity_type": C(etype), "version": I(1, 100000), "prev_hash": hexs(True),
    "org_id": pat("org"), **({"participant_id": pat("participant")} if has_participant else {}),
    "created_at": inst(), "author": O({"role": S(enum=["participant", "therapist"]), "id": S(pattern="^(p|t)_" + BODY + "$")}),
    "data_origin": S(enum=E_["data_origin"]), "origin_ref": hexs(), "payload": payload, "hash": hexs()},
    optional={"origin_ref"}))
item = O({"item_key": pat("key"), "value_type": S(enum=E_["item_value_type"]), "value": {"type": ["number", "string", "boolean", "null"], "maxLength": 80},
          "unit": S(pattern="^[a-z0-9%/.-]{1,12}$", nullable=True), "source": S(enum=E_["item_source"]),
          "assistance": S(enum=E_["assistance_level_item"]), "not_assessed": B()})
ENTITIES = {
 "participant": ("p", O({"alias": S(min=1, max=40, pattern=ALIAS_PAT), "side": S(enum=E_["side"])}), True),
 "therapist": ("t", O({"display_label": S(min=1, max=40, pattern=ALIAS_PAT)}), False),
 "care_link": ("cl", O({"therapist_id": pat("therapist"), "status": S(enum=E_["link_status"]), "valid_from": date(), "valid_to": date(True)}), True),
 "functional_assessment": ("fa", O({
    "assessment_date": date(), "body_segment": S(enum=E_["body_segment"]), "side": S(enum=E_["side"]),
    "instrument": O({"instrument_id": pat("key"), "instrument_version": S(pattern=r"^[0-9A-Za-z._-]{1,20}$"), "status": S(enum=E_["instrument_status"])}),
    "items": A(item, 1, 200), "therapist_note": S(max=2000, nullable=True)}), True),
 "goal": ("gl", O({
    "goal_text": S(min=1, max=300), "body_segment": S(enum=E_["body_segment"]),
    "target": O({"kind": S(enum=E_["goal_target_kind"]), "value": N(0, 100000, True), "unit": S(pattern="^[a-z0-9%/.-]{1,12}$", nullable=True)}),
    "status": S(enum=E_["goal_status"]), "confirmed_by": S(pattern=P["therapist"], nullable=True), "confirmed_at": S(pattern=P["inst"], nullable=True)}), True),
 "encounter": ("en", O({
    "encounter_date": date(), "modality": S(enum=E_["encounter_modality"]), "duration_min": I(1, 600, True),
    "prescription_ref": {"type": ["object", "null"], "properties": {"prescription_id": pat("rx"), "revision": I(1, 1000)}, "required": ["prescription_id", "revision"], "additionalProperties": False},
    "assessment_ref": S(pattern=f"^fa_{BODY}$", nullable=True), "therapist_note": S(max=2000, nullable=True)}), True),
 "reassessment": ("ra", O({
    "baseline_assessment_ref": S(pattern=f"^fa_{BODY}$"), "current_assessment_ref": S(pattern=f"^fa_{BODY}$"),
    "item_comparability": A(O({"item_key": pat("key"), "comparable": B(), "reason": S(enum=E_["comparability_reason"], nullable=True)}), 1, 200)}), True),
 "instrumental_measurement": ("im", O({
    "measured_at": inst(), "body_segment": S(enum=E_["body_segment"]), "side": S(enum=E_["side"]), "movement_key": pat("key"),
    "value": N(-10000, 10000), "unit": S(pattern="^[a-z0-9%/.-]{1,12}$"), "instrument_label": S(min=1, max=60),
    "method": C("therapist_instrumental_manual"), "assistance": S(enum=E_["assistance_level_item"]), "therapist_note": S(max=500, nullable=True)}), True),
}
draft_base = {
 "draft_kind": S(enum=E_["draft_kind"]), "target": S(enum=E_["draft_target"]), "status": S(enum=E_["draft_status"]),
 "produced_by": S(enum=E_["draft_producer"]), "retention_class": S(enum=E_["retention_class"]),
 "transcript_text": S(max=8000, nullable=True),
 "proposals": A(O({"field_key": pat("key"), "proposed_value": S(max=500), "state": S(enum=["proposed", "missing", "ambiguous"])}), 0, 100),
 "audio_retained": C(False), "engine_label": S(max=60, nullable=True),
 "microphone_consent_ref": hexs(True), "confirmed_entity_ref": S(pattern=f"^(fa|gl|en)_{BODY}$", nullable=True),
 "confirmed_by": S(pattern="^(p|t)_" + BODY + "$", nullable=True)}
voice = copy.deepcopy(draft_base); voice["produced_by"] = C("voice_to_text"); voice["microphone_consent_ref"] = hexs()
nonvoice = copy.deepcopy(draft_base); nonvoice["produced_by"] = S(enum=["assisted_structuring", "manual_form"])
ENTITIES["draft"] = ("dr", ONE(O(voice), O(nonvoice)), True)
for etype, (prefix, payload, hp) in ENTITIES.items():
    ent = ent_common(etype, prefix.replace("p", "p") if etype not in ("participant", "therapist") else prefix, payload, hp)
    if etype == "participant": ent["properties"]["entity_id"] = S(pattern=f"^p_{BODY}$")
    if etype == "therapist": ent["properties"]["entity_id"] = S(pattern=f"^t_{BODY}$")
    w(f"schemas/entities/{etype}.schema.json", ent)
w("registries/instrument-registry.json", {"registry_version": "1", "status": "EXTENSIBLE_PENDING_VALIDATION_WITH_RAQUEL",
  "note": "No clinical instrument is defined by CL06.3. Items are generic (item_key/value_type/unit/source). Instrument-specific fields wait for validation with the occupational therapist.",
  "instruments": [{"instrument_id": "custom_unvalidated", "instrument_version": "0", "status": "unvalidated_custom"}]})
w("registries/units.json", {"registry_version": "1", "units": [{"unit": "1", "meaning": "dimensionless ratio (CL06.1)"}, {"unit": "deg", "meaning": "degrees (angle)"}],
  "note": "Further units require registry revision; entity `unit` accepts a lowercase token pattern so the registry can grow without a schema break."})
print("events", len(EVENT_SCHEMAS), "entities", len(ENTITIES))

# ---------------- facts (catalog v2) ----------------
dump = json.load(open("/home/claude/work/v1_catalog_dump.json", encoding="utf-8"))
V1CAT = dump["catalog"]
CAPSRC = S(enum=["camera", "simulation"]); sid = pat("session"); sdate = date()
FACT_PARAMS = {t: copy.deepcopy(v1(f"fact.{t}.schema.json")["properties"]["params"]) for t in ["F01", "F02", "F03", "F04", "F05", "F06", "F08", "F09"]}
FACT_PARAMS["F01"] = O({"session_id": sid, "session_date_local": sdate, "accepted": I(0, 100), "target": I(1, 100), "capture_source": CAPSRC,
    "algorithm_version": pat("algo"), "calibration_id": pat("cal"), "handedness_mismatch_cycles": I(0, 100), "handedness_unknown_cycles": I(0, 100), "incomplete_upload": B()})
FACT_PARAMS["F05"] = copy.deepcopy(FACT_PARAMS["F05"])   # fields unchanged; semantics of observed_accepted changes only through F01-style counting rule (see catalog)
FACT_PARAMS["F10"] = O({"session_id": sid, "session_date_local": sdate, "measure_kind": C("opening_index"), "value": N(-360, 360), "unit": C("1"),
    "method": pat("key"), "algorithm_version": pat("algo"), "protocol_id": S(pattern=P["proto"], nullable=True), "measurement_quality": S(enum=["usable", "insufficient"]), "experimental": C(True)})
CAT = copy.deepcopy(V1CAT)
for k, v in CAT.items(): v["definition_version"] = 1; v["changed_from_v1"] = False
date_t = "{session_date_local|date}"
CAT["F01"].update({"definition_version": 2, "changed_from_v1": True,
  "semantic_change": "PD-04: cycles with incompatible handedness are not accepted cycles; they arrive as cycle.rejected(reason=handedness_incompatible). `handedness_mismatch_cycles` now counts those rejected cycles (v1: accepted cycles whose label differed). New param handedness_unknown_cycles. Numbers are NOT comparable with F01 v1 mismatch counts.",
  "evidence": CAT["F01"]["evidence"] + [{"role": "incompatible", "type": "cycle.rejected", "select": "ALL cycle.rejected in S with payload.reason = handedness_incompatible (zero or more)"}],
  "derivation": ["accepted = count(cycle.accepted in S)  [stream rule guarantees none has handedness.label ≠ revision.side]",
    "target = revision.target_sets × revision.target_repetitions", "capture_source = start(S).payload.source_mode", "algorithm_version = start(S).source.algorithm_version",
    "calibration_id = effective_calibration(S).payload.calibration_id",
    "handedness_mismatch_cycles = count(cycle.rejected in S where reason = handedness_incompatible)",
    "handedness_unknown_cycles = count(cycle.accepted c in S where c.handedness = null)   [CL06.3-D1: unknown is counted and flagged]",
    "incomplete_upload = gaps(S) is non-empty"],
  "limitations": {"always": ["L01", "L02", "L03"], "when": [{"code": "L06", "param": "incomplete_upload", "eq": True}, {"code": "L17", "param": "handedness_mismatch_cycles", "gt": 0},
      {"code": "L19", "param": "handedness_unknown_cycles", "gt": 0}, {"code": "L13", "param": "capture_source", "eq": "simulation"}]},
  "template": {"text": f"Na sessão de {date_t}, {{capture_source|label:capture_subject}} contou {{accepted|int}} de {{target|int}} ciclos de abrir e fechar a mão prescrita."},
  "highlight": [{"param": "incomplete_upload", "eq": True}, {"param": "handedness_mismatch_cycles", "gt": 0}]})
CAT["F05"].update({"definition_version": 2, "changed_from_v1": True,
  "semantic_change": "observed_accepted counts only cycle.accepted, which under v3 never includes incompatible-handedness cycles (PD-04). Discrepancy rule text unchanged.",
  "evidence": CAT["F05"]["evidence"] + [{"role": "incompatible", "type": "cycle.rejected", "select": "ALL cycle.rejected in S with payload.reason = handedness_incompatible (zero or more)"}]})
CAT["F10"] = {"name": "session_opening_index_experimental", "definition_version": 1, "changed_from_v1": False, "new_in_v2": True, "experimental": True,
  "meaning": "Índice adimensional de abertura da mão registrado pela captura numa sessão. Medida experimental; não é amplitude articular nem ângulo.",
  "evidence": [{"role": "start", "type": "session.started", "select": "start(S)"}, {"role": "measurement", "type": "measurement.recorded", "select": "effective_measurement(S, opening_index) = highest seq"}],
  "preconditions": ["START_PRESENT", "MODE_IS_CAPTURE", "MEASUREMENT_PRESENT", "MEASUREMENT_EXPERIMENTAL"],
  "derivation": ["value, unit, method, protocol_id = effective_measurement.payload.*", "measurement_quality = effective_measurement.payload.quality (usable|insufficient; missing is not derived)", "algorithm_version = effective_measurement.source.algorithm_version"],
  "recompute": "Re-derive; deep equality. Never expressed as a percentage or as recovery.",
  "limitations": {"always": ["L02", "L10", "L18"], "when": []},
  "template": {"text": f"Na sessão de {date_t}, a medida experimental de abertura da mão (índice adimensional) foi {{value|decimal2}}."},
  "highlight": [], "summary_eligible": False,
  "eligibility_note": "Detail-only until the experimental protocol is validated (T7); publication into evolution then needs a catalog revision approved by the PO."}
CAT["F09"]["definition_version"] = 1
PRE = dict(dump["preconditions"]); PRE.update({"MEASUREMENT_PRESENT": "effective_measurement(S, kind) exists.", "MEASUREMENT_EXPERIMENTAL": "effective_measurement.payload.experimental = true."})
w("catalogs/fact-catalog.v2.json", {"catalog_version": "2", "supersedes": "1 (CL06.1, read-only legacy)", "types": CAT, "labels": dump["labels"], "formatters": dump["formatters"],
   "preconditions": PRE, "free_text_params": "forbidden", "closed": True})
fact_shared = lambda t: dict(
  fact_id=pat("fact"), type=C(t), catalog_version=C("2"), params=FACT_PARAMS[t], evidence_refs=A(hexs(), 1, 2000, unique=True),
  scope=copy.deepcopy(v1("fact.F01.schema.json")["properties"]["scope"]), data_origin=S(enum=E_["data_origin"]),
  versions=O({"catalog": C("2"), "verifier": pat("ver"), "algorithm": S(pattern=P["algo"], nullable=True), "definition": I(1, 99)}),
  limitations=A(S(enum=list(spec.LIMITATIONS)), 0, 19, unique=True),
  rendered=O({"text_ptbr": S(min=1, max=400), "limitations_ptbr": A(S(min=1, max=200), 0, 19)}),
  flags=O({"highlight": B(), "summary_eligible": B()}))
for t in CAT:
    props = fact_shared(t); w(f"schemas/facts/fact.{t}.schema.json", sch(f"fact.{t}", O(props)))
    pr = {k: props[k] for k in ["type", "params", "evidence_refs", "scope", "data_origin"]}; pr["catalog_version"] = C("2")
    w(f"schemas/facts/fact-proposal.{t}.schema.json", sch(f"fact-proposal.{t}", O(pr)))

# ---------------- comparability (PD-02 + ajuste 6) ----------------
w("catalogs/comparability-rules.v1.json", {"rules_version": "cmp-v1",
 "purpose": "Descriptive longitudinal comparison between published, reviewed observations. No statistical inference, no prediction, no clinical interpretation (ADR-015).",
 "technical_criteria": {"description": "ALL must be equal for two observations to share one series. Any difference => separate series with a visible notice.",
   "keys": ["participant_id", "body_segment", "laterality", "movement_task", "method", "unit", "protocol", "algorithm_version", "observation_quality_class", "execution_mode", "data_origin_class", "fact_type", "fact_definition_version", "limits_version"],
   "key_notes": {"laterality": "prescribed side (prescription.side); incompatible-handedness cycles are never in a series",
     "observation_quality_class": "usable vs low (F06.low_capture_quality) kept apart",
     "data_origin_class": "synthetic_fixture, experimental_capture, live and imported_v1 are never mixed in one series (PD-03)",
     "execution_mode": "camera and simulation are never mixed",
     "fact_definition_version": "e.g. F01 definition 1 (legacy) vs 2 (PD-04) are never mixed"}},
 "contextual_dimensions": {"description": "Do NOT block comparability. Shown with every item; a change between consecutive items is itself reported as a descriptive indicator.",
   "dimensions": ["assistance_level", "pain_or_fatigue_signalled", "dose_prescribed", "session_end_reason"],
   "assistance_transition": {"source_fact": "F04", "ordinal": ["none", "some", "full"], "output": ["less_help_reported", "more_help_reported", "unchanged"],
     "note": "Reported help is a participant declaration (L04, L15). The indicator states the change in reported help; it is not a clinical judgement and uses no value words.",
     "unreported_handling": "unreported assistance is absent, never zero (RN008): no transition is produced across an unreported session"}},
 "publication": "Only facts effectively approved (ADR-012) with the current content_hash may enter a published evolution (evolution.published). Unreviewed or rejected facts never appear.",
 "forbidden_outputs": ["trend or slope with significance", "recovery prediction", "worsening alert", "global recovery score", "percentage of recovery"],
 "examples_not_comparable": ["F01 definition 1 vs 2", "camera vs simulation", "usable vs low quality capture", "experimental_capture vs live", "different protocol or algorithm_version"]})
w("schemas/progress-series.schema.json", sch("progress-series", O({
  "series_key": O({k: S(max=80) for k in ["participant_id", "body_segment", "laterality", "movement_task", "method", "unit", "protocol", "algorithm_version", "observation_quality_class", "execution_mode", "data_origin_class", "fact_type", "fact_definition_version", "limits_version"]}),
  "series_key_hash": hexs(), "items": A(O({"fact_id": pat("fact"), "content_hash": hexs(), "session_date_local": date(),
     "context": O({"assistance_level": S(enum=["none", "some", "full", "unreported"]), "pain_or_fatigue_signalled": B(), "dose_prescribed": I(1, 100), "session_end_reason": S(enum=E_["end_reason"])})}), 1, 500)})))

# ---------------- errors ----------------
errs = json.load(open("/home/claude/work/v1_errors.json", encoding="utf-8"))
errs["SCHEMA_VERSION_UNSUPPORTED"]["meaning"] = "schema_version is not 3 (version 2 is read-only legacy)."
NEW_ERR = {
 "HANDEDNESS_INCOMPATIBLE_ACCEPTED": (409, "stream", "cycle.accepted with handedness label different from the prescribed side; must be cycle.rejected(handedness_incompatible) (PD-04)."),
 "LIMITS_EXCEEDED": (400, "semantic", "Prescription exceeds the versioned technical limits (sets, repetitions or product) of limits_version."),
 "EXECUTION_MODE_MISMATCH": (400, "semantic", "execution_mode inconsistent with source.type or with session.started source_mode (PD-03)."),
 "ORIGIN_REF_REQUIRED": (400, "semantic", "data_origin experimental_capture or imported_v1 requires origin_ref (evidence pointer)."),
 "REAL_DATA_GATE_CLOSED": (403, "auth", "data_origin live rejected: the real-data gate (security, privacy, retention, legal basis) is not open (PD-05)."),
 "ROLE_NOT_ALLOWED": (403, "auth", "Only roles participant and therapist exist (PD-08); any other role is rejected."),
 "ENTITY_VERSION_CONFLICT": (409, "stream", "Entity version is not previous+1, or an existing version would be overwritten."),
 "ENTITY_CHAIN_BROKEN": (409, "integrity", "Entity prev_hash differs from the hash of the previous version."),
 "ENTITY_HASH_INVALID": (400, "integrity", "Entity hash differs from sha256(canonical(entity without hash))."),
 "GOAL_CONFIRMATION_REQUIRED": (400, "semantic", "achieved_confirmed requires confirmed_by (therapist) and confirmed_at (RN014)."),
 "MICROPHONE_CONSENT_REQUIRED": (403, "auth", "voice_to_text draft without active microphone consent (RN012)."),
 "DRAFT_NOT_CONFIRMED": (409, "review", "A draft cannot become a record or fact without professional/participant confirmation."),
 "COMPARABILITY_VIOLATION": (400, "semantic", "Evolution series mixes observations whose technical criteria differ (cmp rules)."),
 "UNREVIEWED_FACT_IN_EVOLUTION": (409, "review", "Evolution cites a fact not effectively approved for its current content_hash."),
 "LEGACY_STREAM_READ_ONLY": (409, "stream", "schema_version 2 stream: no v3 event may be appended."),
}
for k, (h, l, m) in NEW_ERR.items(): errs[k] = {"http": h, "layer": l, "meaning": m}
w("catalogs/error-codes.v3.json", {"catalog_version": "3", "codes": errs, "added_in_v3": list(NEW_ERR)})

# ---------------- API ----------------
R = lambda *r: list(r)
def ep(id_, m, path, roles, req=None, res=None, errors=(), status="new", notes="", reqs=()):
    return {"id": id_, "method": m, "path": path, "roles": roles, "request": req, "response": res, "errors": list(errors), "status": status, "notes": notes, "prd_requirements": list(reqs)}
ent = lambda n: {"$ref_file": f"schemas/entities/{n}.schema.json"}
body = lambda n: {"payload_of": f"schemas/entities/{n}.schema.json#payload", "participant_id": "path or body"}
API = [
 ep("auth.therapist", "POST", "/api/v3/auth/therapist", ["anonymous"], status="carried", notes="Same as v1 (MVP seeded). Credential storage is an implementation choice."),
 ep("auth.invite", "POST", "/api/v3/auth/invite", ["anonymous"], status="carried", notes="Single use, expiry, stored as hash."),
 ep("participants.create", "POST", "/api/v3/participants", ["therapist"], body("participant"), ent("participant"), ["FORBIDDEN"], "changed", "Also creates the care_link entity (version 1, status active).", ["CLI01", "CLI02"]),
 ep("invites.create", "POST", "/api/v3/invites", ["therapist"], status="carried", reqs=["CLI02"]),
 ep("care_links.revoke", "POST", "/api/v3/care-links/{entity_id}:revoke", ["therapist"], None, ent("care_link"), ["SCOPE_VIOLATION", "NOT_FOUND"], "new", "Creates a new version with status revoked; history preserved (RN004).", ["CLI02"]),
 ep("assessments.create", "POST", "/api/v3/participants/{participant_id}/assessments", ["therapist"], body("functional_assessment"), ent("functional_assessment"), ["SCOPE_VIOLATION", "RULE_VIOLATION"], "new", "Generic items; no clinical instrument is defined by the contract.", ["CLI03", "CLI04"]),
 ep("assessments.revise", "POST", "/api/v3/assessments/{entity_id}/versions", ["therapist"], body("functional_assessment"), ent("functional_assessment"), ["SCOPE_VIOLATION", "ENTITY_VERSION_CONFLICT"], "new", "New version; previous versions immutable (RN004).", ["CLI04", "CLI09"]),
 ep("assessments.list", "GET", "/api/v3/participants/{participant_id}/assessments", ["therapist"], None, {"list_of": "entity.functional_assessment"}, ["SCOPE_VIOLATION"], "new", "", ["CLI09"]),
 ep("goals.create", "POST", "/api/v3/participants/{participant_id}/goals", ["therapist"], body("goal"), ent("goal"), ["SCOPE_VIOLATION", "GOAL_CONFIRMATION_REQUIRED"], "new", "", ["CLI05", "PRG06"]),
 ep("goals.revise", "POST", "/api/v3/goals/{entity_id}/versions", ["therapist"], body("goal"), ent("goal"), ["SCOPE_VIOLATION", "ENTITY_VERSION_CONFLICT", "GOAL_CONFIRMATION_REQUIRED"], "new", "achieved_confirmed requires the therapist's confirmation (RN014).", ["CLI05", "PRG06"]),
 ep("goals.list", "GET", "/api/v3/participants/{participant_id}/goals", ["therapist", "participant"], None, {"list_of": "entity.goal"}, ["SCOPE_VIOLATION"], "new", "Participant sees own goals (simplified view).", ["PRG06", "PRG11"]),
 ep("encounters.create", "POST", "/api/v3/participants/{participant_id}/encounters", ["therapist"], body("encounter"), ent("encounter"), ["SCOPE_VIOLATION", "RULE_VIOLATION"], "new", "modality in_person|remote_external; remote_integrated is P1 and rejected.", ["CLI06", "REM01", "REM02"]),
 ep("encounters.list", "GET", "/api/v3/participants/{participant_id}/encounters", ["therapist"], None, {"list_of": "entity.encounter"}, ["SCOPE_VIOLATION"], "new", "", ["CLI09", "REM04"]),
 ep("reassessments.create", "POST", "/api/v3/participants/{participant_id}/reassessments", ["therapist"], body("reassessment"), ent("reassessment"), ["SCOPE_VIOLATION", "RULE_VIOLATION"], "new", "", ["CLI10", "PRG12"]),
 ep("instrumental.create", "POST", "/api/v3/participants/{participant_id}/instrumental-measurements", ["therapist"], body("instrumental_measurement"), ent("instrumental_measurement"), ["SCOPE_VIOLATION", "RULE_VIOLATION"], "new", "Manual therapist measure; source distinct from automatic measures (A4).", ["MOT11", "CLI04"]),
 ep("drafts.create", "POST", "/api/v3/drafts", ["therapist", "participant"], body("draft"), ent("draft"), ["SCOPE_VIOLATION", "MICROPHONE_CONSENT_REQUIRED", "CONSENT_REQUIRED"], "new", "Draft is never a record or a fact. voice_to_text requires microphone consent; audio is not retained.", ["INT01", "INT02", "INT03", "INT08", "CLI12", "REM06", "ACC06"]),
 ep("drafts.get", "GET", "/api/v3/drafts/{entity_id}", ["therapist", "participant"], None, ent("draft"), ["SCOPE_VIOLATION", "NOT_FOUND"], "new", "Visible only to its author.", ["INT07"]),
 ep("drafts.confirm", "POST", "/api/v3/drafts/{entity_id}:confirm", ["therapist", "participant"], {"corrections": "proposals[] with final values"}, ent("draft"), ["SCOPE_VIOLATION", "RULE_VIOLATION"], "new", "Creates the target entity (therapist) or yields values the participant submits as report.submitted (participant). No autonomous publication.", ["INT07", "INT03"]),
 ep("drafts.discard", "POST", "/api/v3/drafts/{entity_id}:discard", ["therapist", "participant"], None, ent("draft"), ["SCOPE_VIOLATION"], "new", "", ["INT09"]),
 ep("prescriptions.publish", "POST", "/api/v3/prescriptions", ["therapist"], {"draft": "prescription.published payload minus server fields"}, {"prescription_id": "id", "revision": "int", "event_id": "hex"}, ["SCOPE_VIOLATION", "RULE_VIOLATION", "LIMITS_EXCEEDED", "CONFLICT_IMMUTABLE"], "changed", "limits_version assigned by the server from catalogs/limits.v1.json.", ["CLI08", "BTS01"]),
 ep("prescriptions.current", "GET", "/api/v3/participants/{participant_id}/prescription/current", ["participant", "therapist"], status="carried", reqs=["CLI08"]),
 ep("prescriptions.history", "GET", "/api/v3/participants/{participant_id}/prescriptions", ["therapist"], None, {"list_of": "event.prescription.published"}, ["SCOPE_VIOLATION"], "new", "", ["CLI08", "CLI09"]),
 ep("events.batch", "POST", "/api/v3/events:batch", ["participant"], {"events": "array<event v3> 1..500"}, {"results": "array<BatchItem>"},
    ["BATCH_TOO_LARGE", "BATCH_UNORDERED", "SCOPE_VIOLATION", "CONSENT_REQUIRED", "REAL_DATA_GATE_CLOSED", "LEGACY_STREAM_READ_ONLY", "HANDEDNESS_INCOMPATIBLE_ACCEPTED", "EXECUTION_MODE_MISMATCH"], "changed",
    "Only client-authored types. v3 envelope. data_origin live rejected while the real-data gate is closed.", ["BTS02", "MOT01", "PLY01"]),
 ep("sessions.list", "GET", "/api/v3/participants/{participant_id}/sessions", ["therapist"], status="carried", reqs=["BTS09"]),
 ep("facts.list", "GET", "/api/v3/participants/{participant_id}/facts", ["therapist"], None, {"facts": "array<fact v2>", "catalog_version": "2"}, ["SCOPE_VIOLATION"], "changed", "Each fact derived AND verified on read (verifier dependent).", ["EVD01"]),
 ep("facts.evidence", "GET", "/api/v3/facts/{fact_id}/evidence", ["therapist"], status="carried", reqs=["EVD07"]),
 ep("facts.verify", "POST", "/api/v3/facts/verify", ["therapist"], status="carried", notes="Never persists. Verifier dependent.", reqs=["EVD04"]),
 ep("reviews.record", "POST", "/api/v3/reviews", ["therapist"], status="carried", reqs=["EVD08", "EVD09"]),
 ep("summaries.publish", "POST", "/api/v3/summaries", ["therapist"], status="carried", reqs=["EVD10"]),
 ep("summaries.get", "GET", "/api/v3/summaries/{summary_id}", ["participant", "therapist"], status="carried", reqs=["EVD10"]),
 ep("evolution.series", "GET", "/api/v3/participants/{participant_id}/evolution/series", ["therapist"], None, {"list_of": "progress-series", "rules_version": "cmp-v1"}, ["SCOPE_VIOLATION"], "new",
    "Descriptive projection of approved facts under catalogs/comparability-rules.v1.json. No statistics.", ["PRG01", "PRG02", "PRG03", "PRG04", "PRG05", "PRG09", "MOT10"]),
 ep("evolution.publish", "POST", "/api/v3/evolution", ["therapist"], {"participant_id": "id", "period": "dates", "series_keys": "array<hex>"}, {"evolution_id": "id", "content_hash": "hex", "event_id": "hex"},
    ["SCOPE_VIOLATION", "UNREVIEWED_FACT_IN_EVOLUTION", "COMPARABILITY_VIOLATION", "CONTENT_HASH_STALE"], "new", "Publication gate for evolution (PD-02).", ["PRG02", "PRG03", "PRG10", "EVD12", "REM05"]),
 ep("evolution.get", "GET", "/api/v3/evolution/{evolution_id}", ["participant", "therapist"], None, {"event": "evolution.published", "view": "participant: simplified"}, ["SCOPE_VIOLATION", "NOT_FOUND"], "new", "Participant view is a simplified, same-data view (PRG11, RN018).", ["PRG11"]),
 ep("timeline.get", "GET", "/api/v3/participants/{participant_id}/timeline", ["therapist"], None, {"items": "array of {kind, ref, occurred_at, origin_label}"}, ["SCOPE_VIOLATION"], "new", "Unified history: entities + published items. Each item shows data_origin and execution_mode.", ["PRG09", "REM04", "CLI09"]),
 ep("entities.versions", "GET", "/api/v3/entities/{entity_id}/versions", ["therapist"], None, {"list_of": "entity versions"}, ["SCOPE_VIOLATION", "NOT_FOUND"], "new", "Audit trail of an entity.", ["CLI09", "EVD07"]),
 ep("health", "GET", "/api/v3/health", ["anonymous"], None, {"status": "ok", "versions": {"schema": 3, "catalog": "2", "contracts": "3.0.0"}}, [], "changed"),
]
RESERVED = ["POST /api/v3/assistant/structure-report", "POST /api/v3/assistant/draft-selection", "any role other than participant|therapist", "encounter modality remote_integrated (P1)"]
w("api/api-contract.v3.json", {"api_version": "v3", "base_path": "/api/v3", "auth": "Authorization: Bearer <opaque>; principal derived by the server, never read from bodies.",
   "roles": ["participant", "therapist"], "error_body": {"error": {"code": "string", "message": "string", "details": "optional"}}, "limits": {"batch_max_events": 500, "body_max_bytes": 2097152},
   "endpoints": API, "reserved_not_available": RESERVED, "carried_v1_endpoints": 15, "note": "v1 base path /api/v1 is read-only legacy; no v1 write routes exist in v3."})

# ---------------- authorization matrix ----------------
def row(res, act, part, ther, cond): return {"resource": res, "action": act, "participant": part, "therapist": ther, "condition": cond}
AUTHZ = [
 row("participant (entity)", "create", "deny", "allow", "creates care_link v1"), row("participant (entity)", "read", "own", "linked", "active care_link, same org"),
 row("care_link", "create/revoke", "deny", "allow", "therapist is a party"), row("care_link", "read", "own", "linked", ""),
 row("functional_assessment", "create/revise", "deny", "linked", "RN001 two roles; therapist only"), row("functional_assessment", "read", "deny", "linked", "participant sees simplified evolution only"),
 row("goal", "create/revise/confirm", "deny", "linked", "RN014: only the therapist confirms achievement"), row("goal", "read", "own", "linked", "participant: simplified"),
 row("encounter", "create", "deny", "linked", ""), row("encounter", "read", "deny", "linked", ""),
 row("reassessment", "create/read", "deny", "linked", ""), row("instrumental_measurement", "create/read", "deny", "linked", ""),
 row("prescription", "publish", "deny", "linked", "RN003: only therapist changes the prescription; limits enforced"), row("prescription", "read", "own", "linked", ""),
 row("draft", "create/read/confirm/discard", "own (session_report_proposal only)", "own (author)", "draft visible only to its author; voice requires microphone consent"),
 row("event: session/capture/report/consent", "append", "own", "deny", "actor = principal; consent active; schema 3 only; live origin gated"),
 row("event: prescription/review/summary/evolution/privacy", "append", "deny", "server-authored (therapist principal)", "never client-authored"),
 row("fact", "read/verify/evidence", "deny", "linked", ""), row("review", "record", "deny", "linked", "bound to content_hash"),
 row("summary", "publish", "deny", "linked", "publication gate"), row("summary", "read", "own", "linked", ""),
 row("evolution", "series read / publish", "deny", "linked", "publication gate; unreviewed facts rejected"), row("evolution", "read published", "own (simplified)", "linked", ""),
 row("timeline", "read", "deny", "linked", ""), row("health", "read", "allow", "allow", "anonymous allowed"),
 row("any resource", "any", "role caregiver: deny; role supervisor: deny; any role not in {participant, therapist}: ROLE_NOT_ALLOWED", "same", "PD-08"),
 row("companion / acompanhante", "any", "no profile: assisting a participant is expressed only as assistance (reported by the participant)", "n/a", "PD-08; REM15 is P1 and out of v3"),
]
w("api/authorization-matrix.v3.json", {"matrix_version": "3", "legend": {"own": "principal.id == scope.participant_id", "linked": "active care_link (therapist_id, participant_id) in same org",
   "deny": "FORBIDDEN or SCOPE_VIOLATION (403); invisible resources: NOT_FOUND (404)"}, "rows": AUTHZ})
w("VERSIONS.json", {"contracts_version": "3.0.0", "schema_version": 3, "fact_catalog_version": "2", "event_catalog_version": "3", "comparability_rules_version": "cmp-v1",
   "limits_version": "limits-v1", "api_version": "v3", "legacy_read_only": {"schema_version": 2, "fact_catalog_version": "1", "contracts_version": "1.0.0", "api": "v1"},
   "status": "CL06.3 prepared for PO approval; not released to implementation"})
print("api", len(API), "authz", len(AUTHZ))
