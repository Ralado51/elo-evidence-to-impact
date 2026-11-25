#!/usr/bin/env python3
"""Builds CL06.3 fixtures (valid, invalid, adversarial, vectors, origin register). Deterministic."""
import copy, hashlib, json, os, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "reference/python"))
import elo_ref as R
FX = os.path.join(ROOT, "fixtures")
def w(rel, obj):
    p = os.path.join(FX, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f: json.dump(obj, f, ensure_ascii=False, indent=1); f.write("\n")
ORG, PID, TID, RX = "o_fixture-0001", "p_fixture-0001", "t_fixture-0001", "rx_fixture-0001"
CAM = {"type": "camera", "algorithm_version": "c05-hand-2", "device_hint": "desktop-chrome"}
REPSRC = {"type": "participant_report"}

# ---------- hand-written canonicalization vectors (expected values written BEFORE running any implementation) ----------
VEC = [
 ("C01-key-order", {"b": 1, "a": [3, 2, 1], "c": {"z": None, "y": True}}, '{"a":[3,2,1],"b":1,"c":{"y":true,"z":null}}'),
 ("C02-numbers-cl061", {"int": 4, "dec": 0.87, "small": 1e-7, "big": 1e21, "neg": -2.5}, '{"big":1e+21,"dec":0.87,"int":4,"neg":-2.5,"small":1e-7}'),
 ("C03-unicode", {"texto": "Cansaço é sinalização", "é": 1, "e": 2}, '{"e":2,"texto":"Cansaço é sinalização","é":1}'),
 ("C04-escapes", {"q": "a\"b\\c\nd"}, '{"q":"a\\"b\\\\c\\nd"}'),
 ("C05-event-id-slot", {"stream_id": "session:s_fixture-0001", "seq": 1}, '{"seq":1,"stream_id":"session:s_fixture-0001"}'),
 ("N01-zero-and-negzero", [0, -0.0], "[0,0]"),
 ("N02-rfc8785-333333333.33333329", [333333333.33333329], "[333333333.3333333]"),
 ("N03-1e30", [1e30], "[1e+30]"), ("N04-4.50", [4.50], "[4.5]"), ("N05-2e-3", [2e-3], "[0.002]"),
 ("N06-1e-27", [1e-27], "[1e-27]"), ("N07-1e20-boundary", [1e20, 1e21], "[100000000000000000000,1e+21]"),
 ("N08-small-boundary", [0.000001, 0.0000001], "[0.000001,1e-7]"),
 ("N09-max-double", [1.7976931348623157e308], "[1.7976931348623157e+308]"), ("N10-min-subnormal", [5e-324], "[5e-324]"),
 ("N11-safe-int", [9007199254740991, -9007199254740991], "[9007199254740991,-9007199254740991]"),
 ("N12-0.1+0.2", [0.30000000000000004], "[0.30000000000000004]"), ("N13-float-int", [1.0, 100.0, 12345.0], "[1,100,12345]"),
 ("N14-int-beyond-safe-parsed-as-double", [2**60], "[1152921504606847000]"),
 ("S01-astral-key-order", {"～": 1, "\U0001F600": 2}, '{"😀":2,"～":1}'),     # UTF-16 order puts U+1F600 (D83D..) before U+FF5E
 ("S02-control-chars", {"c": "\u0001\u001f\u007f\b\f\t\r"}, '{"c":"\\u0001\\u001f\x7f\\b\\f\\t\\r"}'),
 ("S03-slash-and-nonascii", {"a": "/é "}, '{"a":"/é "}'),
 ("S04-empty", [{}, [], "", None, True, False], '[{},[],"",null,true,false]'),
 ("S05-nested-order", {"z": {"b": [{"d": 1, "c": 2}], "a": {}}, "a": 0}, '{"a":0,"z":{"a":{},"b":[{"c":2,"d":1}]}}'),
]

vec = [{"id": i, "value": v, "canonical": c, "sha256": hashlib.sha256(c.encode()).hexdigest()} for i, v, c in VEC]
# Python cannot hold NaN in strict JSON: rejection vectors are described, not serialized
w("valid/canonical-vectors.v3.json", {"description": "Hand-written expected canonical strings. sha256 computed with hashlib/node:crypto, independent of the canonicalizers. Inherits C01-C05 from CL06.1.",
   "vectors": vec, "must_reject": [{"id": "X01-nan", "kind": "non-finite", "note": "NaN"}, {"id": "X02-infinity", "kind": "non-finite", "note": "Infinity"},
   {"id": "X03-lone-surrogate", "kind": "string", "note": "U+D800 alone"}]})

# ---------- event builder ----------
T0 = 1795600000000
def iso(ms): 
    import datetime
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (ms % 1000)
def sc(**k): return {"org_id": ORG, "participant_id": PID, **k}
def chain(stream_id, specs):
    out = []; prev = None
    for i, s in enumerate(specs, 1):
        e = {"event_id": R.compute_event_id(stream_id, i), "schema_version": 3, "type": s["type"], "stream_id": stream_id, "seq": i, "prev_hash": prev,
             "occurred_at": iso(T0 + s.get("dt", i * 1000)), **({"t_mono_ms": s["mono"]} if "mono" in s else {}),
             "actor": s["actor"], "scope": s["scope"], "source": s["source"], "execution_mode": s["em"], "data_origin": s.get("origin", "synthetic_fixture"),
             "payload": s["payload"]}
        if "origin_ref" in s: e["origin_ref"] = s["origin_ref"]
        e["hash"] = R.compute_event_hash(e); prev = e["hash"]; out.append(e)
    return out
PART = {"role": "participant", "id": PID}; THER = {"role": "therapist", "id": TID}
rx_payload = {"participant_id": PID, "exercise_id": "organizar-a-mesa", "permitted_movement": "hand_open_close", "side": "right", "target_sets": 1, "target_repetitions": 4,
  "sessions_per_week": 5, "valid_from": "2026-11-23", "valid_to": "2026-12-21", "timezone": "America/Sao_Paulo", "min_calibration_span": None,
  "instructions_ptbr": "Abra e feche a mão no seu ritmo. Pare se doer.", "prescription_id": RX, "revision": 1, "supersedes_revision": None,
  "created_by": TID, "created_at": iso(T0), "limits_version": "limits-v1"}
rxs = chain(f"prescription:{RX}", [{"type": "prescription.published", "actor": THER, "scope": sc(prescription_id=RX, prescription_revision=1, exercise_id="organizar-a-mesa"), "source": {"type": "therapist"}, "em": "not_applicable", "payload": rx_payload, "dt": 0}])
cons = chain(f"consent:{PID}", [{"type": "consent.accepted", "actor": PART, "scope": sc(), "source": REPSRC, "em": "not_applicable", "payload": {"consent_version": "consent-2026-11-23-v1", "scopes": ["camera"]}, "dt": 500}])
SA, SB = "s_fixture-0001", "s_fixture-0002"
SCA = sc(session_id=SA, prescription_id=RX, prescription_revision=1, exercise_id="organizar-a-mesa")
SCB = sc(session_id=SB, prescription_id=RX, prescription_revision=1, exercise_id="organizar-a-mesa")
def cyc(i, side, extra=None):
    p = {"cycle_index": i, "calibration_id": "cal_fixture-0001", "open_peak_n": 0.9, "closed_trough_n": 0.04, "armed_to_close_ms": 620, "frames": 30, "usable_frames": 30,
         "handedness": {"label": side, "score": 0.97}}
    p.update(extra or {}); return p
a = lambda t, p, mono, **k: {"type": t, "actor": PART, "scope": SCA, "source": CAM, "em": "camera", "payload": p, "mono": mono, **k}
specsA = [
 {"type": "session.started", "actor": PART, "scope": SCA, "source": CAM, "em": "camera", "mono": 0,
  "payload": {"source_mode": "camera", "prescription_id": RX, "prescription_revision": 1, "capture_context": {"device_hint": "desktop-chrome", "frame_width": 640, "frame_height": 480}}},
 a("calibration.attempted", {"attempt": 1, "posture": "open", "n_samples": 33, "median": 1.9, "mad": 0.02, "accepted": True, "reason": None}, 100),
 a("calibration.attempted", {"attempt": 2, "posture": "closed", "n_samples": 33, "median": 0.8, "mad": 0.02, "accepted": True, "reason": None}, 200),
]
specsA[0]["scope"] = SCA
sessA_head = chain(f"session:{SA}", specsA)
refs = sorted([sessA_head[1]["event_id"], sessA_head[2]["event_id"]])
specsA.append(a("calibration.applied", {"calibration_id": "cal_fixture-0001", "open": 1.9, "closed": 0.8, "span": 1.1, "open_samples": 33, "closed_samples": 33, "attempt_refs": refs, "min_span_required": None}, 300))
specsA.append(a("session.control", {"action": "start", "interrupt_reason": None}, 400))
specsA.append(a("cycle.accepted", cyc(1, "right"), 1000)); specsA.append(a("cycle.accepted", cyc(2, "right"), 2000))
specsA.append(a("cycle.rejected", cyc(3, "left", {"reason": "handedness_incompatible"}), 3000))      # PD-04: preserved, flagged, not counted
specsA.append(a("cycle.accepted", cyc(4, "right"), 4000)); specsA.append(a("cycle.accepted", cyc(5, "right"), 5000))
specsA.append(a("session.completed", {"accepted": 4, "target": 4}, 5100))
specsA.append(a("session.capture_summary", {"frames_total": 360, "fps_mean": 24.1, "fps_min": 11.2, "usable_fraction": 0.87, "lost_events": 1}, 5200))
specsA.append(a("measurement.recorded", {"measurement_id": "ms_fixture-0001", "measure_kind": "opening_index", "value": 1.1, "unit": "1", "method": "landmark_ratio_v1",
    "quality": "usable", "quality_reason": None, "protocol_id": None, "limitation_codes": ["L10", "L18"], "experimental": True, "body_segment": "hand"}, 5300))
specsA.append({"type": "report.submitted", "actor": PART, "scope": SCA, "source": REPSRC, "em": "camera", "payload": {"execution": "complete", "assistance": "some", "reporter_role": "participant"}})
sessA = chain(f"session:{SA}", specsA)
b = lambda t, p: {"type": t, "actor": PART, "scope": SCB, "source": REPSRC, "em": "report_only", "payload": p}
sessB = chain(f"session:{SB}", [b("session.started", {"source_mode": "report_only", "prescription_id": RX, "prescription_revision": 1, "capture_context": None}),
    b("session.control", {"action": "start", "interrupt_reason": None}), b("session.control", {"action": "end", "interrupt_reason": None}),
    b("report.submitted", {"execution": "partial", "assistance": "none", "reporter_role": "participant"})])
# hand-written oracle for the FUTURE verifier (F01 v2 for session A) - shape/id/hash only here
ev = {e["seq"]: e for e in sessA}
f01_refs = sorted([ev[1]["event_id"], rxs[0]["event_id"], ev[4]["event_id"], ev[6]["event_id"], ev[7]["event_id"], ev[9]["event_id"], ev[10]["event_id"], ev[11]["event_id"], ev[8]["event_id"]])
FS = {"org_id": ORG, "participant_id": PID, "session_id": SA, "prescription_id": RX, "prescription_revision": 1, "exercise_id": "organizar-a-mesa"}
f01p = {"session_id": SA, "session_date_local": "2026-11-24", "accepted": 4, "target": 4, "capture_source": "camera", "algorithm_version": "c05-hand-2",
        "calibration_id": "cal_fixture-0001", "handedness_mismatch_cycles": 1, "handedness_unknown_cycles": 0, "incomplete_upload": False}
f01 = {"type": "F01", "catalog_version": "2", "params": f01p, "evidence_refs": f01_refs, "scope": FS, "data_origin": "synthetic_fixture"}
fid = "f_" + R.hash_canonical({"catalog_version": "2", "data_origin": "synthetic_fixture", "evidence_refs": f01_refs, "params": f01p, "scope": FS, "type": "F01"})
fact01 = {"fact_id": fid, **f01, "versions": {"catalog": "2", "verifier": "0.0.0", "algorithm": "c05-hand-2", "definition": 2}, "limitations": ["L01", "L02", "L03", "L11", "L17"],
  "rendered": {"text_ptbr": "[Dados sintéticos] Na sessão de 24/11/2026, a câmera contou 4 de 4 ciclos de abrir e fechar a mão prescrita.",
               "limitations_ptbr": ["Contagem automática experimental, não validada clinicamente.", "O ciclo é medido em relação à calibração feita no próprio dia.",
                 "A câmera não identifica quem fez o movimento nem se houve ajuda.", "Dados sintéticos de demonstração; não se referem a uma pessoa real.",
                 "Ciclos com lateralidade incompatível com a prescrição não são contados como cumprimento."]}, "flags": {"highlight": True, "summary_eligible": True}}
fact01["limitations"].sort()
chash = R.hash_canonical(fact01)
w("expected/facts.oracle.v3.json", {"description": "HAND-WRITTEN expectations for the FUTURE verifier (CL06.2+). SHAPE/ID/HASH ONLY: nothing here was produced or checked by a verifier. fact_id/content_hash are computed with the reference canonicalizer.",
   "status": "NOT_VERIFIED_BY_ANY_VERIFIER", "facts": [fact01], "content_hashes": {fid: chash}})
rev = chain(f"review:{TID}.{PID}", [
 {"type": "review.recorded", "actor": THER, "scope": sc(), "source": {"type": "therapist"}, "em": "not_applicable", "payload": {"fact_id": fid, "content_hash": chash, "decision": "approve", "note": None}},
 {"type": "evolution.published", "actor": THER, "scope": sc(), "source": {"type": "therapist"}, "em": "not_applicable", "payload": None}])
skey = {"participant_id": PID, "body_segment": "hand", "laterality": "right", "movement_task": "organizar-a-mesa", "method": "cycle_count", "unit": "cycles", "protocol": "none",
        "algorithm_version": "c05-hand-2", "observation_quality_class": "usable", "execution_mode": "camera", "data_origin_class": "synthetic_fixture", "fact_type": "F01",
        "fact_definition_version": "2", "limits_version": "limits-v1"}
evo = {"evolution_id": "evo_fixture-0001", "period_from": "2026-11-23", "period_to": "2026-11-30", "comparability_rules_version": "cmp-v1",
       "series": [{"series_key_hash": R.hash_canonical(skey), "items": [{"fact_id": fid, "content_hash": chash}]}], "assistance_transitions": [], "note_refs": []}
evo["content_hash"] = R.hash_canonical(evo)
rev = chain(f"review:{TID}.{PID}", [rev_spec for rev_spec in [
 {"type": "review.recorded", "actor": THER, "scope": sc(), "source": {"type": "therapist"}, "em": "not_applicable", "payload": {"fact_id": fid, "content_hash": chash, "decision": "approve", "note": None}},
 {"type": "evolution.published", "actor": THER, "scope": sc(), "source": {"type": "therapist"}, "em": "not_applicable", "payload": evo}]])
LEDGER = rxs + cons + sessA + sessB + rev
w("valid/ledger.v3.json", {"description": "CL06.3 synthetic ledger (all data_origin synthetic_fixture). Session A: camera, 4/4 counted cycles + 1 incompatible-handedness cycle preserved as cycle.rejected (PD-04), experimental measurement, report. Session B: report-only. Review stream with an approved fact and a published evolution. Facts are shape-only (no verifier exists).",
   "events": LEDGER, "series_key_example": skey})
w("valid/prescription-limits-boundary.json", {"cases": [
  {"id": "ok-1x100", "target_sets": 1, "target_repetitions": 100, "valid": True}, {"id": "ok-10x10", "target_sets": 10, "target_repetitions": 10, "valid": True},
  {"id": "bad-11x1", "target_sets": 11, "target_repetitions": 1, "valid": False}, {"id": "bad-1x101", "target_sets": 1, "target_repetitions": 101, "valid": False},
  {"id": "bad-product-2x51", "target_sets": 2, "target_repetitions": 51, "valid": False}]})

# ---------- entities ----------
def ent(etype, eid, version, prev, payload, author=THER, org=ORG, pid=PID, origin="synthetic_fixture", created=None, **extra):
    e = {"entity_id": eid, "entity_type": etype, "version": version, "prev_hash": prev, "org_id": org, **({"participant_id": pid} if pid else {}),
         "created_at": created or iso(T0 + 10000 + version), "author": author, "data_origin": origin, "payload": payload}
    e.update(extra); e["hash"] = R.compute_entity_hash(e); return e
items = [{"item_key": "grip_open_close_free", "value_type": "category", "value": "with_difficulty", "unit": None, "source": "therapist_observed", "assistance": "some", "not_assessed": False},
         {"item_key": "wrist_extension", "value_type": "number", "value": None, "unit": "deg", "source": "therapist_instrumental", "assistance": "not_assessed", "not_assessed": True}]
fa1 = ent("functional_assessment", "fa_fixture-0001", 1, None, {"assessment_date": "2026-11-23", "body_segment": "hand", "side": "right",
   "instrument": {"instrument_id": "custom_unvalidated", "instrument_version": "0", "status": "unvalidated_custom"}, "items": items, "therapist_note": None})
fa2 = ent("functional_assessment", "fa_fixture-0001", 2, fa1["hash"], {**fa1["payload"], "therapist_note": "Synthetic revision note."})
gl_payload = {"goal_text": "Synthetic goal: use the hand to open a jar lid.", "body_segment": "hand", "target": {"kind": "descriptive_text", "value": None, "unit": None},
              "status": "active", "confirmed_by": None, "confirmed_at": None}
gl1 = ent("goal", "gl_fixture-0001", 1, None, gl_payload)
gl2 = ent("goal", "gl_fixture-0001", 2, gl1["hash"], {**gl_payload, "status": "achieved_confirmed", "confirmed_by": TID, "confirmed_at": iso(T0 + 20000)})
E_ = {
 "participant": ent("participant", PID, 1, None, {"alias": "Fixture Pessoa", "side": "right"}, pid=PID),
 "therapist": ent("therapist", TID, 1, None, {"display_label": "Terapeuta Fixture"}, pid=None),
 "care_link": ent("care_link", "cl_fixture-0001", 1, None, {"therapist_id": TID, "status": "active", "valid_from": "2026-11-23", "valid_to": None}),
 "functional_assessment": fa1,
 "goal": gl1,
 "encounter": ent("encounter", "en_fixture-0001", 1, None, {"encounter_date": "2026-11-23", "modality": "remote_external", "duration_min": 30,
    "prescription_ref": {"prescription_id": RX, "revision": 1}, "assessment_ref": "fa_fixture-0001", "therapist_note": None}),
 "reassessment": ent("reassessment", "ra_fixture-0001", 1, None, {"baseline_assessment_ref": "fa_fixture-0001", "current_assessment_ref": "fa_fixture-0001",
    "item_comparability": [{"item_key": "grip_open_close_free", "comparable": True, "reason": None}, {"item_key": "wrist_extension", "comparable": False, "reason": "method_differs"}]}),
 "instrumental_measurement": ent("instrumental_measurement", "im_fixture-0001", 1, None, {"measured_at": iso(T0 + 9000), "body_segment": "wrist", "side": "right",
    "movement_key": "wrist_extension", "value": 40, "unit": "deg", "instrument_label": "manual goniometer (synthetic)", "method": "therapist_instrumental_manual", "assistance": "none", "therapist_note": None}),
 "draft": ent("draft", "dr_fixture-0001", 1, None, {"draft_kind": "structured_extraction", "target": "encounter", "status": "draft", "produced_by": "manual_form",
    "retention_class": "until_confirmed", "transcript_text": None, "proposals": [{"field_key": "modality", "proposed_value": "remote_external", "state": "proposed"}],
    "audio_retained": False, "engine_label": None, "microphone_consent_ref": None, "confirmed_entity_ref": None, "confirmed_by": None}),
}
VOICE_DRAFT = ent("draft", "dr_fixture-0002", 1, None, {"draft_kind": "dictation_transcript", "target": "encounter", "status": "draft", "produced_by": "voice_to_text", "retention_class": "until_confirmed",
    "transcript_text": "Synthetic dictation text.", "proposals": [], "audio_retained": False, "engine_label": None, "microphone_consent_ref": "a" * 64, "confirmed_entity_ref": None, "confirmed_by": None})
PART_DRAFT = ent("draft", "dr_fixture-0003", 1, None, {"draft_kind": "session_report_proposal", "target": "session_report", "status": "draft", "produced_by": "assisted_structuring", "retention_class": "session_only",
    "transcript_text": None, "proposals": [{"field_key": "assistance", "proposed_value": "some", "state": "proposed"}], "audio_retained": False, "engine_label": None,
    "microphone_consent_ref": None, "confirmed_entity_ref": None, "confirmed_by": None}, author=PART)
w("valid/entities.v3.json", {"description": "One valid entity per type, plus version chains (assessment v1->v2, goal v1->v2 achieved_confirmed), a voice draft and a participant-authored report proposal.",
   "entities": {**E_, "voice_draft": VOICE_DRAFT, "participant_report_draft": PART_DRAFT, "functional_assessment_v2": fa2, "goal_v2": gl2},
   "chains": {"functional_assessment": [fa1, fa2], "goal": [gl1, gl2]}})

# ---------- invalid: schema/semantic/integrity ----------
inv = {"events": [], "entities": [], "integrity": [], "streams": [], "roles": []}
base_by_type = {}
for e in LEDGER: base_by_type.setdefault(e["type"], e)
def rehash(e):
    e = copy.deepcopy(e); e["hash"] = R.compute_event_hash(e); return e
def mut(e, fn, rehash_it=True):
    e = copy.deepcopy(e); fn(e); return rehash(e) if rehash_it else e
# schema-level (expected first error code, any path)
cyc_ok = base_by_type["cycle.accepted"]; rx_ok = base_by_type["prescription.published"]
SCH = [
 ("schema_version_2", cyc_ok, lambda e: e.update(schema_version=2), "LITERAL"),
 ("missing_execution_mode", cyc_ok, lambda e: e.pop("execution_mode"), "MISSING_FIELD"),
 ("unknown_field_free_text", cyc_ok, lambda e: e["payload"].update(statement="diagnóstico"), "UNKNOWN_FIELD"),
 ("bad_data_origin", cyc_ok, lambda e: e.update(data_origin="real"), "ENUM"),
 ("old_role_caregiver", cyc_ok, lambda e: e["actor"].update(role="caregiver"), "ENUM"),
 ("old_role_supervisor", cyc_ok, lambda e: e["actor"].update(role="supervisor"), "ENUM"),
 ("reporter_role_caregiver", base_by_type["report.submitted"], lambda e: e["payload"].update(reporter_role="caregiver"), "ENUM"),
 ("rx_missing_limits_version", rx_ok, lambda e: e["payload"].pop("limits_version"), "MISSING_FIELD"),
 ("consent_missing_scopes", base_by_type["consent.accepted"], lambda e: e["payload"].pop("scopes"), "MISSING_FIELD"),
 ("consent_bad_scope", base_by_type["consent.accepted"], lambda e: e["payload"].update(scopes=["location"]), "ENUM"),
 ("measurement_not_experimental", base_by_type["measurement.recorded"], lambda e: e["payload"].update(experimental=False), "LITERAL"),
 ("measurement_bad_kind", base_by_type["measurement.recorded"], lambda e: e["payload"].update(measure_kind="recovery_percent"), "ENUM"),
 ("rejected_bad_reason", base_by_type["cycle.rejected"], lambda e: e["payload"].update(reason="bad_side"), "ENUM"),
 ("evolution_unknown_stat", base_by_type["evolution.published"], lambda e: e["payload"].update(trend_p_value=0.01), "UNKNOWN_FIELD"),
 ("evolution_bad_direction", base_by_type["evolution.published"], lambda e: e["payload"].update(assistance_transitions=[{"series_key_hash": "a" * 64, "from_fact_id": "f_" + "a" * 64, "to_fact_id": "f_" + "b" * 64, "from_level": "none", "to_level": "some", "direction": "improved"}]), "ENUM"),
 ("null_not_allowed", base_by_type["session.capture_summary"], lambda e: e["payload"].update(lost_events=None), "NULL_NOT_ALLOWED"),
 ("hash_pattern", cyc_ok, lambda e: e.update(hash="XYZ"), "PATTERN"),
]
for name, base, fn, code in SCH:
    if name == "hash_pattern":
        inv["events"].append({"id": name, "event": mut(base, fn, False), "expect_layer": "schema", "expect": code}); continue
    inv["events"].append({"id": name, "event": mut(base, fn), "expect_layer": "schema", "expect": code})
# semantic (schema-valid, contract rule violated)
SEM = [
 ("actor_not_allowed", cyc_ok, lambda e: e["actor"].update(role="therapist", id=TID), "ACTOR_NOT_ALLOWED"),
 ("source_not_allowed", cyc_ok, lambda e: e["source"].update(type="participant_report"), "SOURCE_NOT_ALLOWED"),
 ("scope_forbidden_key", base_by_type["consent.accepted"], lambda e: e["scope"].update(session_id=SA), "SCOPE_INVALID"),
 ("scope_missing_required", cyc_ok, lambda e: e["scope"].pop("session_id"), "SCOPE_INVALID"),
 ("stream_mismatch", cyc_ok, lambda e: e.update(stream_id="session:s_other-00001"), "STREAM_MISMATCH"),
 ("exec_mode_not_applicable_in_session", cyc_ok, lambda e: e.update(execution_mode="not_applicable"), "EXECUTION_MODE_MISMATCH"),
 ("exec_mode_in_non_session_stream", base_by_type["consent.accepted"], lambda e: e.update(execution_mode="camera"), "EXECUTION_MODE_MISMATCH"),
 ("camera_event_in_simulation_mode", cyc_ok, lambda e: e.update(execution_mode="simulation"), "EXECUTION_MODE_MISMATCH"),
 ("start_mode_vs_source", base_by_type["session.started"], lambda e: e["payload"].update(source_mode="simulation"), "EXECUTION_MODE_MISMATCH"),
 ("origin_ref_required_experimental", cyc_ok, lambda e: e.update(data_origin="experimental_capture"), "ORIGIN_REF_REQUIRED"),
 ("origin_ref_required_imported", cyc_ok, lambda e: e.update(data_origin="imported_v1"), "ORIGIN_REF_REQUIRED"),
 ("live_gate_closed", cyc_ok, lambda e: e.update(data_origin="live"), "REAL_DATA_GATE_CLOSED"),
 ("limits_sets_11", rx_ok, lambda e: e["payload"].update(target_sets=11), "LIMITS_EXCEEDED"),
 ("limits_rep_101", rx_ok, lambda e: e["payload"].update(target_repetitions=101), "LIMITS_EXCEEDED"),
 ("limits_product_101", rx_ok, lambda e: e["payload"].update(target_sets=2, target_repetitions=51), "LIMITS_EXCEEDED"),
 ("limits_version_unknown", rx_ok, lambda e: e["payload"].update(limits_version="limits-v9"), "LIMITS_EXCEEDED"),
]
for name, base, fn, code in SEM:
    inv["events"].append({"id": name, "event": mut(base, fn), "expect_layer": "semantic", "expect": code})
# integrity
def tamper_payload(e): e["payload"]["cycle_index"] = 99
inv["integrity"] = [
 {"id": "payload_tampered_hash_stale", "event": mut(cyc_ok, tamper_payload, False), "expect": "HASH_INVALID"},
 {"id": "event_id_wrong", "event": mut(cyc_ok, lambda e: e.update(event_id="0" * 64)), "expect": "EVENT_ID_INVALID"},
 {"id": "genesis_with_prev_hash", "event": mut(base_by_type["session.started"], lambda e: e.update(prev_hash="a" * 64)), "expect": "GENESIS_INVALID"},
 {"id": "seq_gt1_without_prev", "event": mut(cyc_ok, lambda e: e.update(prev_hash=None)), "expect": "GENESIS_INVALID"},
]
sa = copy.deepcopy(sessA)
sa_broken = copy.deepcopy(sa); sa_broken[5]["prev_hash"] = "b" * 64; sa_broken[5] = rehash(sa_broken[5])
dup = copy.deepcopy(sa) + [rehash({**copy.deepcopy(sa[3]), "payload": {**sa[3]["payload"], "span": 1.2}})]
inv["streams"] = [
 {"id": "chain_broken", "events": sa_broken, "expect": ["CHAIN_BROKEN"]},
 {"id": "conflicting_duplicate_seq", "events": dup, "expect": ["HASH_CONFLICT"]},
]
# handedness stream rule (PD-04)
hand = copy.deepcopy(sessA)
i = next(k for k, e in enumerate(hand) if e["type"] == "cycle.rejected")
hand[i] = rehash({**hand[i], "type": "cycle.accepted", "payload": {k: v for k, v in hand[i]["payload"].items() if k != "reason"}, "event_id": hand[i]["event_id"]})
hand_ok_reason = copy.deepcopy(sessA); j = i
hand_ok_reason[j] = rehash({**hand_ok_reason[j], "payload": {**hand_ok_reason[j]["payload"], "handedness": {"label": "right", "score": 0.9}}})
inv["stream_rules"] = [
 {"id": "incompatible_handedness_accepted", "events": hand, "prescription": rx_payload, "expect": ["HANDEDNESS_INCOMPATIBLE_ACCEPTED"]},
 {"id": "rejected_incompatible_but_label_matches", "events": hand_ok_reason, "prescription": rx_payload, "expect": ["RULE_VIOLATION"]},
 {"id": "mixed_execution_mode", "events": [rehash({**e, "execution_mode": "simulation"}) if e["seq"] == 6 else e for e in sessA], "prescription": rx_payload, "expect": ["EXECUTION_MODE_MISMATCH"]},
]
# entities
def emut(base, fn, rehash_it=True):
    e = copy.deepcopy(base); fn(e)
    if rehash_it: e["hash"] = R.compute_entity_hash(e)
    return e
EI = [
 ("assessment_author_participant", E_["functional_assessment"], lambda e: e["author"].update(role="participant", id=PID), "semantic", "ROLE_NOT_ALLOWED"),
 ("author_role_caregiver", E_["goal"], lambda e: e["author"].update(role="caregiver"), "schema", "ENUM"),
 ("encounter_remote_integrated_p1", E_["encounter"], lambda e: e["payload"].update(modality="remote_integrated"), "schema", "ENUM"),
 ("encounter_unknown_field", E_["encounter"], lambda e: e["payload"].update(video_url="http://x"), "schema", "UNKNOWN_FIELD"),
 ("goal_achieved_without_confirmation", E_["goal"], lambda e: e["payload"].update(status="achieved_confirmed"), "semantic", "GOAL_CONFIRMATION_REQUIRED"),
 ("goal_confirmed_by_participant_author", gl2, lambda e: e["author"].update(role="participant", id=PID), "semantic", "GOAL_CONFIRMATION_REQUIRED"),
 ("goal_active_with_confirmation", E_["goal"], lambda e: e["payload"].update(confirmed_by=TID, confirmed_at=iso(T0)), "semantic", "GOAL_CONFIRMATION_REQUIRED"),
 ("version1_with_prev_hash", E_["care_link"], lambda e: e.update(prev_hash="a" * 64), "semantic", "ENTITY_CHAIN_BROKEN"),
 ("version2_without_prev_hash", fa2, lambda e: e.update(prev_hash=None), "semantic", "ENTITY_CHAIN_BROKEN"),
 ("entity_hash_stale", E_["goal"], lambda e: e["payload"].update(goal_text="altered"), "semantic_nohash", "ENTITY_HASH_INVALID"),
 ("entity_id_wrong_prefix", E_["goal"], lambda e: e.update(entity_id="fa_fixture-0009"), "semantic", "RULE_VIOLATION"),
 ("voice_draft_without_microphone_ref", VOICE_DRAFT, lambda e: e["payload"].update(microphone_consent_ref=None), "schema", "ONEOF"),
 ("draft_audio_retained", E_["draft"], lambda e: e["payload"].update(audio_retained=True), "schema", "ONEOF"),
 ("draft_confirmed_without_confirmer", E_["draft"], lambda e: e["payload"].update(status="confirmed"), "semantic", "DRAFT_NOT_CONFIRMED"),
 ("participant_draft_report_by_therapist", PART_DRAFT, lambda e: e["author"].update(role="therapist", id=TID), "semantic", "ROLE_NOT_ALLOWED"),
 ("experimental_without_origin_ref", E_["goal"], lambda e: e.update(data_origin="experimental_capture"), "semantic", "ORIGIN_REF_REQUIRED"),
 ("assessment_item_unknown_field", fa1, lambda e: e["payload"]["items"][0].update(score_total=9), "schema", "UNKNOWN_FIELD"),
 ("assessment_no_items", fa1, lambda e: e["payload"].update(items=[]), "schema", "LENGTH"),
]
for name, base, fn, layer, code in EI:
    inv["entities"].append({"id": name, "entity": emut(base, fn, layer != "semantic_nohash"), "expect_layer": layer, "expect": code})
inv["entity_chains"] = [
 {"id": "chain_prev_hash_wrong", "versions": [fa1, emut(fa2, lambda e: e.update(prev_hash="c" * 64))], "expect": ["ENTITY_CHAIN_BROKEN"]},
 {"id": "chain_version_gap", "versions": [fa1, emut(fa2, lambda e: e.update(version=3))], "expect": ["ENTITY_VERSION_CONFLICT"]},
]
w("invalid/contract-invalid.v3.json", {"description": "Invalid events, entities, integrity and stream cases with the first expected error code. All derived from the valid fixtures by one mutation each.", **inv})

# ---------- origin register (ajuste 5): evidence-based, no silent inference ----------
def sha(path): return hashlib.sha256(open(path, "rb").read()).hexdigest()
H = "/home/claude/elo-knowledge-claude/04_repos/handoff_2026-11-24/extracted/sources/"
M = "/home/claude/elo-knowledge-claude/04_repos/mvp_CL06_1/extracted/"
TR = "/home/claude/tmp_ref/elo-integrated-demo/evidence/"; NF = "/home/claude/tmp_ref/neofect/evidence/"
REG = [
 ("cl061-ledger", "CL06.1 mvp/shared/fixtures/valid/ledger.json", M + "shared/fixtures/valid/ledger.json", "synthetic_fixture", "reproducible",
  ["every event declares data_origin=synthetic_fixture (checked: single value across 21 events)", "`node shared/fixtures/build-fixtures.mjs --check` reported 'fixtures up to date' (deterministic rebuild), run in this preparation"],
  ["contract_testing", "legacy_read_only_reference"]),
 ("cl061-adversarial-probes", "CL06.1 mvp/shared/fixtures/adversarial/probes.json", M + "shared/fixtures/adversarial/probes.json", "synthetic_fixture", "reproducible",
  ["generated by build-fixtures.mjs from the synthetic ledger (header says so; rebuild check passes)"], ["contract_testing"]),
 ("real-camera-manual-test", "handoff sources/real_camera_manual_test_2026-11-24.json", H + "real_camera_manual_test_2026-11-24.json", "experimental_capture", "self_declared_in_record",
  ["source_type=camera and purpose=experimental_review in the record", "no canvas/injection marker, unlike camera-fixture-export (see 07_REAL_CAMERA_EVIDENCE_AUDIT: real session, no participant identity)",
   "who was captured and under which consent is NOT recorded anywhere found in the package"],
  ["protocol_planning", "contract_testing_reference"]),
 ("camera-fixture-export", "elo-integrated-demo/evidence/camera-fixture-export.json", TR + "camera-fixture-export.json", "synthetic_fixture", "self_declared_in_record",
  ["export.source_type=camera BUT test_environment=canvas_stream_and_injected_landmarks: execution mode camera, data synthetic (PD-03 example: camera != real data)"], ["contract_testing"]),
 ("simulation-export", "elo-integrated-demo/evidence/simulation-export.json", TR + "simulation-export.json", "synthetic_fixture", "self_declared_in_record",
  ["source_type=simulation, purpose=experimental_review"], ["contract_testing"]),
 ("onestep-experiment", "elo-integrated-demo/evidence/onestep.json", TR + "onestep.json", "synthetic_fixture", "self_declared_in_record",
  ["experiment_type=SYNTHETIC_INDEPENDENT_EXPERIMENT; disclaimer: not real patient data"], ["research_reference"]),
 ("neurofenix-archived-run", "elo-integrated-demo/evidence/neurofenix-archived-run.json", TR + "neurofenix-archived-run.json", "synthetic_fixture", "self_declared_in_record",
  ["observations[].source_type=synthetic_rgb_3d_landmarks"], ["research_reference"]),
 ("demo-prescription", "elo-integrated-demo/app/prescription.json", "/home/claude/tmp_ref/elo-integrated-demo/app/prescription.json", "unclassified", "none",
  ["a prescription template; no data about a person; origin not stated"], []),
 ("rea-operation-results", "elo-integrated-demo/evidence/rea-operation-results.json", TR + "rea-operation-results.json", "tool_log_not_patient_data", "inspected",
  ["analysis-tool operation log (error and result envelopes)"], []),
 ("neofect-operation-results", "neofect/evidence/operation-results.json", NF + "operation-results.json", "tool_log_not_patient_data", "inspected",
  ["analysis-tool output about a public product; subject.identity.kind=unknown"], ["research_reference"]),
 ("e2i-benchmark-cases", "elo-evidence-to-impact api/benchmark/cases.json", "/home/claude/tmp_e2i/api/benchmark/cases.json", "synthetic_fixture", "self_declared_in_repo_docs",
  ["README: synthetic pediatric occupational therapy notes; 95 cases. Declared by the repository documentation, not independently verifiable here; pediatric context is out of the MVP (PD-09)"], []),
]
entries = []
for rid, label, path, cls, strength, evid, usable in REG:
    ent_ = {"record_id": rid, "label": label, "sha256": sha(path), "origin_class": cls, "evidence_strength": strength, "evidence": evid, "usable_for": usable,
            "forbidden_for": ["facts", "published_evolution", "clinical_use"] if cls != "synthetic_fixture" else ["clinical_use"]}
    ent_["entry_hash"] = R.hash_canonical({k: v for k, v in ent_.items() if k != "entry_hash"})
    entries.append(ent_)
w("origin-register/legacy-origin-register.json", {"register_version": "1", "rule": "Origin is classified by evidence. `unclassified` records are excluded from facts, published evolution and any clinical use until evidence exists. No inference is made silently. `origin_ref` of an event/entity = entry_hash of its register entry.",
   "classes": {"synthetic_fixture": "artificially generated or injected; not a person's data", "experimental_capture": "real capture from a person during an experimental/manual test; not clinical; identity/consent unrecorded",
               "tool_log_not_patient_data": "log of an analysis tool; not data about a participant", "unclassified": "no evidence found"},
   "entries": entries})

# ---------- adversarial / conformance cases ----------
def case(id_, layer, desc, expect, status, **kw): return {"id": id_, "layer": layer, "description": desc, "expect": expect, "status": status, **kw}
AD = [
 # contract layer: executable now with the reference libraries
 case("P1", "contract", "F01 proposal with free-text field `statement` (diagnosis)", {"code": "UNKNOWN_FIELD", "step": "SHAPE"}, "EXECUTABLE_NOW", kind="proposal_schema", fact="F01", mutate="add_unknown:statement"),
 case("P1b", "contract", "Diagnostic text inside params.algorithm_version", {"code": "PATTERN", "step": "PARAMS"}, "EXECUTABLE_NOW", kind="proposal_schema", fact="F01", mutate="set:params.algorithm_version=diagnostico grave"),
 case("P2", "contract", "type prognosis", {"code": "UNKNOWN_TYPE", "step": "TYPE"}, "EXECUTABLE_NOW", kind="proposal_type", type="prognosis"),
 case("P2b", "contract", "type clinical_improvement", {"code": "UNKNOWN_TYPE", "step": "TYPE"}, "EXECUTABLE_NOW", kind="proposal_type", type="clinical_improvement"),
 case("P3", "contract", "type longitudinal_comparison (no such fact: comparisons live in evolution, not in facts)", {"code": "UNKNOWN_TYPE", "step": "TYPE"}, "EXECUTABLE_NOW", kind="proposal_type", type="longitudinal_comparison"),
 case("P4", "contract", "generated_by_llm flag", {"code": "UNKNOWN_FIELD", "step": "SHAPE"}, "EXECUTABLE_NOW", kind="proposal_schema", fact="F01", mutate="add_unknown:generated_by_llm"),
 case("P7", "contract", "scope without prescription_id", {"code": "MISSING_FIELD", "step": "SHAPE"}, "EXECUTABLE_NOW", kind="proposal_schema", fact="F01", mutate="drop:scope.prescription_id"),
 case("P8", "contract", "tracking_quality float in F06", {"code": "UNKNOWN_FIELD", "step": "PARAMS"}, "EXECUTABLE_NOW", kind="proposal_schema", fact="F06", mutate="add_unknown:params.tracking_quality"),
 case("P10", "contract", "params.incomplete_upload null", {"code": "NULL_NOT_ALLOWED", "step": "PARAMS"}, "EXECUTABLE_NOW", kind="proposal_schema", fact="F01", mutate="set:params.incomplete_upload=null"),
 case("V3-A1", "contract", "F10 params.experimental=false", {"code": "LITERAL"}, "EXECUTABLE_NOW", kind="proposal_schema", fact="F10", mutate="set:params.experimental=false"),
 case("V3-A2", "contract", "F10 params.unit=deg (opening index is dimensionless)", {"code": "LITERAL"}, "EXECUTABLE_NOW", kind="proposal_schema", fact="F10", mutate="set:params.unit=deg"),
 case("V3-A3", "contract", "F01 v2 proposal using catalog_version 1", {"code": "LITERAL"}, "EXECUTABLE_NOW", kind="proposal_schema", fact="F01", mutate="set:catalog_version=1"),
 case("V3-A4", "contract", "F01 v2 proposal missing handedness_unknown_cycles", {"code": "MISSING_FIELD"}, "EXECUTABLE_NOW", kind="proposal_schema", fact="F01", mutate="drop:params.handedness_unknown_cycles"),
 case("V3-A5", "contract", "role caregiver anywhere", {"code": "ENUM"}, "EXECUTABLE_NOW", kind="see_invalid", ref="old_role_caregiver"),
 case("V3-A6", "contract", "incompatible-handedness cycle emitted as cycle.accepted", {"code": "HANDEDNESS_INCOMPATIBLE_ACCEPTED"}, "EXECUTABLE_NOW", kind="see_stream_rule", ref="incompatible_handedness_accepted"),
 case("V3-A7", "contract", "prescription 11 sets / 101 reps / product 101", {"code": "LIMITS_EXCEEDED"}, "EXECUTABLE_NOW", kind="see_invalid", ref="limits_sets_11"),
 case("V3-A8", "contract", "draft with audio_retained=true", {"code": "ONEOF"}, "EXECUTABLE_NOW", kind="see_invalid_entity", ref="draft_audio_retained"),
 # verifier/service layer: need an implementation that does not exist yet
 case("P3-scope", "verifier", "Fact scoped to S2 citing S1 evidence", {"code": "REF_OUT_OF_SCOPE", "step": "REFS_SCOPE"}, "PENDING_IMPLEMENTATION", note="REFS_* need a ledger-backed implementation; in CL06.1 it was checkEvidenceRefs (JS), not ported to the neutral reference libraries."),
 case("P7b", "verifier", "Scope with revision 2 (not published)", {"code": "REF_OUT_OF_SCOPE", "step": "REFS_SCOPE"}, "PENDING_IMPLEMENTATION"),
 case("P3b", "verifier", "F06 with altered usable_fraction", {"code": "RECOMPUTE_MISMATCH", "step": "RECOMPUTE"}, "PENDING_IMPLEMENTATION"),
 case("P5", "verifier", "REGRESSION: F01 omits one accepted-cycle event (count adjusted to match)", {"code": "EVIDENCE_SET_MISMATCH", "step": "EVIDENCE_SET"}, "PENDING_IMPLEMENTATION", regression_of="Python E2I verifier accepted this as supported (VERIFIER_COMPARISON §3)", ledger="valid/ledger.v3.json", fact="F01", session="s_fixture-0001", mutation="drop evidence_ref of cycle seq 9 and set params.accepted=3"),
 case("P5b", "verifier", "F01 accepted inflated with full evidence", {"code": "RECOMPUTE_MISMATCH", "step": "RECOMPUTE"}, "PENDING_IMPLEMENTATION", ledger="valid/ledger.v3.json", fact="F01", mutation="params.accepted=5"),
 case("P6", "verifier", "REGRESSION: F04 cites the superseded report (needs a ledger with two reports in one session)", {"code": "EVIDENCE_SET_MISMATCH", "step": "EVIDENCE_SET"}, "PENDING_IMPLEMENTATION", regression_of="Python E2I verifier accepted this as supported (VERIFIER_COMPARISON §3)", note="The v3 valid ledger has ONE report per session; the conformance harness must append a second report.submitted to session A to build this case (CL06.1 ledger already contains one: S1 seq 14/15)."),
 case("P9", "verifier", "F05 claimed for a report-only session", {"code": "PRECONDITION_FAILED", "step": "PRECONDITIONS"}, "PENDING_IMPLEMENTATION"),
 case("V3-V1", "verifier", "F01 v2 where a handedness_incompatible rejection is omitted from evidence", {"code": "EVIDENCE_SET_MISMATCH"}, "PENDING_IMPLEMENTATION"),
 case("V3-V2", "verifier", "F01 v2 mismatch count computed from accepted cycles (v1 semantics)", {"code": "RECOMPUTE_MISMATCH"}, "PENDING_IMPLEMENTATION"),
 case("V3-V3", "verifier", "F10 for a session without measurement.recorded", {"code": "PRECONDITION_FAILED"}, "PENDING_IMPLEMENTATION"),
 case("V3-S1", "service", "evolution.publish citing a fact not approved", {"code": "UNREVIEWED_FACT_IN_EVOLUTION"}, "PENDING_IMPLEMENTATION"),
 case("V3-S2", "service", "evolution.publish citing an approval with a stale content_hash", {"code": "CONTENT_HASH_STALE"}, "PENDING_IMPLEMENTATION"),
 case("V3-S3", "service", "series mixing F01 definition 1 and 2, or camera and simulation, or experimental_capture and live", {"code": "COMPARABILITY_VIOLATION"}, "PENDING_IMPLEMENTATION"),
 case("V3-S4", "service", "assistance transition across a session whose assistance is unreported", {"code": "NO_TRANSITION_PRODUCED"}, "PENDING_IMPLEMENTATION"),
 case("V3-S5", "service", "voice_to_text draft submitted without active microphone consent", {"code": "MICROPHONE_CONSENT_REQUIRED"}, "PENDING_IMPLEMENTATION"),
 case("V3-S6", "service", "draft published as record without confirmation", {"code": "DRAFT_NOT_CONFIRMED"}, "PENDING_IMPLEMENTATION"),
 case("V3-S7", "service", "participant principal calls a therapist-only route; principal with role caregiver/supervisor", {"code": "FORBIDDEN / ROLE_NOT_ALLOWED"}, "PENDING_IMPLEMENTATION"),
 case("V3-S8", "service", "therapist reads participant without active care_link", {"code": "SCOPE_VIOLATION"}, "PENDING_IMPLEMENTATION"),
 case("V3-S9", "service", "events.batch with data_origin=live while the real-data gate is closed", {"code": "REAL_DATA_GATE_CLOSED"}, "PENDING_IMPLEMENTATION"),
 case("V3-S10", "service", "append v3 event to a legacy schema_version 2 stream", {"code": "LEGACY_STREAM_READ_ONLY"}, "PENDING_IMPLEMENTATION"),
]
w("adversarial/cases.v3.json", {"description": "Adversarial cases. EXECUTABLE_NOW cases are run against the contract layer in Python and JavaScript. PENDING_IMPLEMENTATION cases have no implementation to run against; they are conformance data for CL06.2+ and are reported as PENDING, never as passed.", "cases": AD})

# ---------- valid fact proposals (shape only) ----------
f06p = {"session_id": SA, "session_date_local": "2026-11-24", "usable_fraction": 0.87, "lost_events": 1, "fps_mean": 24.1, "fps_min": 11.2, "low_capture_quality": False}
f06refs = sorted([ev[1]["event_id"], ev[12]["event_id"]])
f10p = {"session_id": SA, "session_date_local": "2026-11-24", "measure_kind": "opening_index", "value": 1.1, "unit": "1", "method": "landmark_ratio_v1",
        "algorithm_version": "c05-hand-2", "protocol_id": None, "measurement_quality": "usable", "experimental": True}
f10refs = sorted([ev[1]["event_id"], ev[13]["event_id"]])
w("valid/fact-proposals.v3.json", {"description": "Shape-valid fact proposals (no verifier has accepted them).", "proposals": {
   "F01": {**f01}, "F06": {"type": "F06", "catalog_version": "2", "params": f06p, "evidence_refs": f06refs, "scope": FS, "data_origin": "synthetic_fixture"},
   "F10": {"type": "F10", "catalog_version": "2", "params": f10p, "evidence_refs": f10refs, "scope": FS, "data_origin": "synthetic_fixture"}}})
