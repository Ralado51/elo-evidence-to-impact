#!/usr/bin/env python3
"""Traceability of the 101 P0 requirements (PRD Elo_PRD_Dark_Factory) to CL06.3 contract elements."""
import csv, json, os, re
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PRD = os.environ.get("PRD_DIR", "/home/claude/px/x/elo-prd")
reqs = {}
for m in re.finditer(r"^\| ([A-Z]{3}\d+) \| ([^|]+) \| ([^|]+) \|", open(os.path.join(PRD, "FUNCTIONAL_REQUIREMENTS.md"), encoding="utf-8").read(), re.M):
    reqs[m.group(1)] = (m.group(3).strip(), m.group(2).strip())     # id -> (name, priority)
P0 = {k: v for k, v in reqs.items() if v[1].startswith("P0")}
assert len(reqs) == 132 and len(P0) == 101, (len(reqs), len(P0))
Y, PT, N = "yes", "partial", "no"
ES = "schemas/entities/"; EV = "schemas/events/"; FC = "catalogs/fact-catalog.v2.json"; CMP = "catalogs/comparability-rules.v1.json"; AZ = "api/authorization-matrix.v3.json"; API = "api/api-contract.v3.json"
NC = ("NOT_CONTRACT_SCOPE", "—", N, "Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase.")
M = {
 "CLI01": ("participant.schema; care_link.schema; participants.create", Y, "Authorization behavior pending service."),
 "CLI02": ("care_link.schema; authorization-matrix; care_links.revoke", Y, "Enforcement (V3-S8) pending service."),
 "CLI03": ("functional_assessment.schema (generic items, instrument registry extensible)", Y, "Specific fields wait for validation with the occupational therapist (Raquel)."),
 "CLI04": ("functional_assessment.schema; instrumental_measurement.schema; assessments.*", Y, "Instrument-specific items pending clinical validation."),
 "CLI05": ("goal.schema; goals.*", Y, "Goal confirmation rule tested (GOAL_CONFIRMATION_REQUIRED)."),
 "CLI06": ("encounter.schema; encounters.*", Y, "Modality enum {in_person, remote_external} proposed; confirm with PO/Raquel."),
 "CLI07": ("encounter.therapist_note; review.recorded(annotate); functional_assessment.therapist_note", Y, "Free text only in therapist-authored declared fields; never rendered as a fact."),
 "CLI08": ("prescription.published (limits_version); limits.v1.json; prescriptions.*", Y, "Limits rules tested (LIMITS_EXCEEDED)."),
 "CLI09": ("entity version chains; entities.versions; timeline.get; prescriptions.history", Y, "Chains tested; timeline behavior pending."),
 "CLI10": ("reassessment.schema; reassessments.create", Y, "Descriptive differences are a projection; behavior pending."),
 "CLI11": NC,
 "CLI12": ("draft.schema (dictation_transcript); consent scope microphone; drafts.*", Y, "Experimental. Provider/model not chosen. Behavior pending."),
 "BTS01": ("prescriptions.current; prescription.published", Y, ""),
 "BTS02": NC,
 "BTS03": ("session.started source_mode {camera, report_only}; execution_mode", Y, ""),
 "BTS04": ("report.submitted.execution; F03", Y, "F03 verification pending verifier."),
 "BTS05": ("report.submitted.assistance; F04; cmp-v1 assistance_transition", Y, "Verifier pending for F04."),
 "BTS06": ("session.control pain/fatigue; F08", Y, "Verifier pending for F08."),
 "BTS07": ("session.control pause/resume/interrupt; session states", Y, ""),
 "BTS08": ("sessions.list; timeline.get", PT, "Behavior pending."),
 "BTS09": ("facts.list; reviews.record; evolution.publish", PT, "Verifier/service pending."),
 "BTS10": ("events.batch (idempotent); event_id deterministic; hash chain", Y, "Idempotency semantics need a server; chain/event_id tested now."),
 "BTS11": ("execution_mode report_only; session.started.capture_context null", Y, ""),
 "BTS12": ("draft.schema (session_report_proposal, voice_to_text); consent scope microphone", Y, "Experimental; participant confirms and submits report.submitted. Behavior pending."),
 "MOT01": ("execution_mode camera; ADR-001 (kept); no frame leaves device", PT, "Not a contract-testable property; stated as a constraint."),
 "MOT02": ("observation.recorded", Y, ""),
 "MOT03": ("handedness in cycle/observation; cycle.rejected(handedness_incompatible); stream rule; F01 v2", Y, "Semantic change (PD-04): see CONTRACT_EVOLUTION."),
 "MOT04": ("calibration.attempted/applied/failed", Y, ""),
 "MOT05": ("cycle.accepted / cycle.rejected", Y, ""),
 "MOT06": ("F01 v2 (definition_version 2)", Y, "Derivation recompute pending verifier."),
 "MOT07": ("observation.recorded.metric (unit '1'); measurement.recorded(opening_index, experimental); F10", Y, "F10 summary_eligible=false until protocol validated."),
 "MOT08": ("quality enum; F06", Y, "Verifier pending for F06."),
 "MOT09": ("session.capture_summary; F06", Y, ""),
 "MOT10": ("comparability-rules.v1.json (technical criteria)", Y, "Rules are data; enforcement (COMPARABILITY_VIOLATION) pending service."),
 "MOT11": ("instrumental_measurement.schema (method therapist_instrumental_manual)", Y, "Kept separate from automatic measures."),
 "MOT12": ("measurement.recorded(measure_kind angle_auto, experimental const true)", Y, "No clinical claim; experimental until protocol (T7)."),
 "PLY01": ("exercise_id organizar-a-mesa in scope", Y, "Game itself is product work."),
 "PLY02": ("cycle.accepted/rejected; session.completed", Y, ""),
 "PLY03": ("prescription limits; OVER_TARGET stream rule (CL06.1, carried)", PT, "OVER_TARGET not re-implemented in reference libs; carried from CL06.1 legacy rules."),
 "PLY04": NC, "PLY05": NC, "PLY06": NC, "PLY07": NC,
 "PLY08": ("ADR-008 carried (progress of the activity only)", PT, "Behavioral; no ranking/points fields exist in any schema."),
 "PLY09": ("session.control", Y, ""),
 "PLY10": NC,
 "PLY11": ("event envelope; cycle.*; session.*", Y, ""),
 "EVD01": ("event envelope v3; 19 event types", Y, ""),
 "EVD02": ("source; execution_mode; data_origin; origin_ref; legacy-origin-register", Y, "PD-03."),
 "EVD03": ("actor; occurred_at; t_mono_ms; entity author/created_at", Y, ""),
 "EVD04": ("fact-catalog.v2; fact/proposal schemas; adversarial cases", PT, "Contract-layer probes tested now; verifier-layer probes PENDING (no implementation)."),
 "EVD05": ("F05; DISCREPANCY_RULE", PT, "Verifier pending."),
 "EVD06": ("limitations.v2.json (L01–L19); fact.limitations", Y, ""),
 "EVD07": ("evidence_refs; facts.evidence; entities.versions", Y, ""),
 "EVD08": ("review.recorded bound to content_hash", Y, ""),
 "EVD09": ("review.recorded approve/reject/annotate", Y, ""),
 "EVD10": ("review.recorded; summary.published; entity versioning (corrections never overwrite)", Y, "Retention of corrections (RN016) pending PX-02."),
 "EVD11": ("canonicalization; hash chain; entity hash; vectors", Y, "RN020: integrity is not authenticity."),
 "EVD12": ("summary.published; evolution.published; publication gate rules", PT, "Gate enforcement pending service."),
 "PRG01": ("functional_assessment (baseline) + evolution.series", Y, "Behavior pending."),
 "PRG02": ("evolution.series/publish; evolution.published", Y, "ADR-015 revises ADR-009."),
 "PRG03": ("comparability-rules.v1.json; progress-series.schema", Y, "Conflict with ADR-009 resolved by ADR-015 (proposed)."),
 "PRG04": ("progress-series.schema; evolution.published (descriptive series only)", Y, "Chart rendering is UI."),
 "PRG05": ("F04; cmp-v1 assistance_transition; evolution.published.assistance_transitions", Y, "Descriptive indicator; no value words."),
 "PRG06": ("goal.schema; goals.*", Y, ""),
 "PRG07": ("F03; F02; session counts in timeline", PT, "Adherence over period (F07) intentionally not defined; descriptive timeline only."),
 "PRG08": ("F02; F08; cmp-v1 contextual dimensions", Y, ""),
 "PRG09": ("timeline.get", PT, "Read model; behavior pending."),
 "PRG10": ("data_origin and execution_mode on every item; origin_prefix in rendered text", Y, ""),
 "PRG11": ("evolution.get (participant simplified view); authorization-matrix", PT, "UI simplicity is product work."),
 "PRG12": ("reassessment.schema; reassessments.create", Y, ""),
 "INT01": ("draft.schema (dictation_transcript, voice_to_text); retention_class", Y, "Experimental; no provider chosen; audio never retained (audio_retained const false)."),
 "INT02": ("draft.schema (structured_extraction, proposals[])", Y, "Experimental."),
 "INT03": ("draft.schema; drafts.confirm", Y, ""),
 "INT04": ("draft.proposals[].state = missing", Y, ""),
 "INT05": ("draft.proposals[].state = ambiguous", Y, ""),
 "INT06": ("draft.target; functional_assessment items", PT, "Functional context extraction is behavior."),
 "INT07": ("draft status confirmed requires confirmed_by; DRAFT_NOT_CONFIRMED", Y, ""),
 "INT08": ("draft.schema (session_report_proposal, author participant)", Y, "Experimental."),
 "INT09": ("draft.produced_by manual_form; templates", Y, "Alternative without voice and LLM always possible."),
 "ACC01": NC, "ACC02": NC, "ACC03": NC, "ACC04": NC, "ACC05": NC,
 "ACC06": ("consent scope microphone; draft voice_to_text", Y, "Experimental."),
 "ACC07": ("draft produced_by manual_form; report.submitted via UI", Y, "Alternative path exists in contract."),
 "ACC08": NC, "ACC09": NC, "ACC10": NC, "ACC11": NC, "ACC12": NC,
 "ACC13": ("execution_mode report_only", Y, ""),
 "ACC14": NC, "ACC15": NC,
 "REM01": ("encounter.modality", Y, ""),
 "REM02": ("encounter modality remote_external; encounters.create", Y, ""),
 "REM03": ("session streams (home sessions)", Y, ""),
 "REM04": ("timeline.get; encounter + event refs", PT, "Behavior pending."),
 "REM05": ("comparability-rules.v1.json", Y, "Same rules as MOT10/PRG03."),
 "REM06": ("draft.schema; drafts.*", Y, "Experimental."),
}
missing = sorted(set(P0) - set(M)); extra = sorted(set(M) - set(P0))
assert not missing and not extra, (missing, extra)
rows = []
for rid in sorted(P0, key=lambda x: (x[:3], int(x[3:]))):
    name, prio = P0[rid]; v = M[rid]
    if v[0] == "NOT_CONTRACT_SCOPE": row = (rid, name, prio, "NOT_CONTRACT_SCOPE", "—", "no", v[3])
    else: row = (rid, name, prio, "SPECIFIED", v[0], v[1], v[2])
    rows.append(row)
os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
with open(os.path.join(ROOT, "docs/TRACEABILITY_P0.csv"), "w", newline="", encoding="utf-8") as f:
    wr = csv.writer(f); wr.writerow(["requirement", "name", "priority", "contract_status", "contract_elements", "tested_now_py_js", "notes_pending"]); wr.writerows(rows)
spec_n = sum(1 for r in rows if r[3] == "SPECIFIED"); nc = len(rows) - spec_n
tested = {k: sum(1 for r in rows if r[5] == k) for k in ("yes", "partial", "no")}
with open(os.path.join(ROOT, "docs/TRACEABILITY_P0.md"), "w", encoding="utf-8") as f:
    f.write("# TRACEABILITY_P0 — 101 P0 requirements → CL06.3\n\n")
    f.write(f"Source: `Elo_PRD_Dark_Factory/FUNCTIONAL_REQUIREMENTS.md` (132 IDs: 101 P0 incl. 8 experimental, 31 P1). Reconciled by this script (asserts 132/101). IDs are the PRD's *provisional consolidated IDs* (the PRD itself says to check them against historical IDs before freezing contracts; no separate historical ID list was found in the package, so that check is NOT done).\n\n")
    f.write(f"**Result:** {spec_n} requirements have at least one CL06.3 contract element; {nc} are interface/behavior requirements with no contract element (NOT_CONTRACT_SCOPE). All 101 are accounted for; none was dropped or reduced.\n\n")
    f.write("`tested_now`: yes = the contract element is exercised by schema/rule/vector tests that run in Python and JavaScript; partial = element specified but its behavior depends on a verifier, server or UI not implemented; no = no contract element.\n\n")
    f.write(f"Counts of tested_now: yes={tested['yes']}, partial={tested['partial']}, no={tested['no']}.\n\n| ID | Name | Priority | Status | Contract elements | tested_now | Notes / pending |\n|---|---|---|---|---|---|---|\n")
    for r in rows: f.write("| " + " | ".join(str(x).replace("|", "/") for x in r) + " |\n")
print("P0", len(rows), "specified", spec_n, "not_contract", nc, tested)
