"""CL06.3 normative enumerations and registries (single source for the builder)."""
ENUMS = {
 "actor_role": ["participant", "therapist", "system"],
 "source_type": ["camera", "simulation", "participant_report", "therapist", "system"],
 "execution_mode": ["camera", "simulation", "report_only", "not_applicable"],
 # PD-03: origin of the data, independent of execution mode.
 "data_origin": ["live", "synthetic_fixture", "experimental_capture", "imported_v1"],
 "device_hint": ["desktop-chrome", "desktop-edge", "desktop-other", "mobile-chrome", "mobile-safari", "mobile-other"],
 "side": ["left", "right"], "body_segment": ["hand", "wrist"],
 "source_mode": ["camera", "simulation", "report_only"],
 "quality": ["usable", "insufficient", "missing"],
 "quality_reason": ["no_hand", "incomplete_landmarks", "edge", "too_small", "palm_bounds", "low_frame_rate", "frame_gap"],
 "handedness_label": ["left", "right"], "posture": ["open", "closed"],
 "calibration_attempt_reason": ["insufficient_samples", "unstable"],
 "calibration_failure_reason": ["not_separable", "unstable", "below_min_span"],
 "cycle_rejection_reason": ["low_quality", "inactive", "over_target", "calibration_mismatch", "low_frame_rate"],
 "control_action": ["start", "pause", "resume", "end", "pain", "fatigue", "interrupt"],
 "interrupt_reason": ["track_ended", "model_execution", "camera_error", "permission_denied", "camera_unavailable", "page_closed", "consent_revoked"],
 "execution": ["complete", "partial", "none", "unreported"],
 "assistance": ["none", "some", "full", "unreported"],
 "reporter_role": ["participant"],
 "review_decision": ["approve", "reject", "annotate"],
 "end_reason": ["completed", "ended", "symptom", "interrupted"], "symptom": ["pain", "fatigue"],
 "consent_scope": ["camera", "microphone"],
 "measure_kind": ["opening_index", "angle_auto", "amplitude_auto"],
 "measure_unit": ["1", "deg"],
 "encounter_modality": ["in_person", "remote_external"],      # remote_integrated is P1 (reserved, NOT allowed in v3)
 "link_status": ["active", "revoked"],
 "goal_status": ["active", "achieved_confirmed", "discontinued"],
 "goal_target_kind": ["descriptive_text", "session_count", "repetitions", "measure_value"],
 "item_value_type": ["integer", "number", "category", "boolean"],
 "item_source": ["therapist_observed", "therapist_instrumental", "participant_reported"],
 "assistance_level_item": ["none", "some", "full", "not_assessed"],
 "instrument_status": ["unvalidated_custom", "validated_with_therapists"],
 "comparability_reason": ["method_differs", "unit_differs", "protocol_differs", "instrument_version_differs", "side_differs", "segment_differs", "other_not_comparable"],
 "draft_kind": ["dictation_transcript", "structured_extraction", "session_report_proposal"],
 "draft_target": ["encounter", "functional_assessment", "goal", "session_report"],
 "draft_status": ["draft", "confirmed", "discarded"],
 "draft_producer": ["voice_to_text", "assisted_structuring", "manual_form"],
 "retention_class": ["session_only", "until_confirmed", "pending_definition"],
 "entity_type": ["participant", "therapist", "care_link", "functional_assessment", "goal", "encounter", "reassessment", "instrumental_measurement", "draft"],
}
REMOVED_ROLES = ["caregiver", "supervisor"]   # PD-08: must be rejected everywhere
LIMITS_V1 = {"limits_version": "limits-v1", "max_sets": 10, "max_repetitions": 100, "max_product": 100,
             "kind": "technical_processing_and_prescription_limits", "not_a_clinical_recommendation": True}
# event type registry (stream, authored, actors, sources, algorithm, mono, scope) -- v1 table + 2 new types
SESSION_SCOPE = {"required": ["session_id", "prescription_id", "prescription_revision", "exercise_id"], "forbidden": []}
NO_SESSION = {"required": [], "forbidden": ["session_id", "prescription_id", "prescription_revision", "exercise_id"]}
CAP = ["camera", "simulation"]
def cap(mono="required"):
    return {"stream": "session", "authored": "client", "actors": ["participant"], "sources": CAP, "algorithm": "required", "mono": mono, "scope": SESSION_SCOPE}
EVENT_TYPES = {
 "prescription.published": {"stream": "prescription", "authored": "server", "actors": ["therapist"], "sources": ["therapist"], "algorithm": "forbidden", "mono": "forbidden",
    "scope": {"required": ["prescription_id", "prescription_revision", "exercise_id"], "forbidden": ["session_id"]}},
 "consent.accepted": {"stream": "consent", "authored": "client", "actors": ["participant"], "sources": ["participant_report"], "algorithm": "forbidden", "mono": "forbidden", "scope": NO_SESSION},
 "consent.revoked": {"stream": "consent", "authored": "client", "actors": ["participant"], "sources": ["participant_report"], "algorithm": "forbidden", "mono": "forbidden", "scope": NO_SESSION},
 "session.started": {"stream": "session", "authored": "client", "actors": ["participant"], "sources": CAP + ["participant_report"], "algorithm": "capture-only", "mono": "optional", "scope": SESSION_SCOPE},
 "calibration.attempted": cap(), "calibration.applied": cap(), "calibration.failed": cap(),
 "observation.recorded": cap(), "cycle.accepted": cap(), "cycle.rejected": cap(),
 "session.control": {"stream": "session", "authored": "client", "actors": ["participant"], "sources": CAP + ["participant_report"], "algorithm": "capture-only", "mono": "optional", "scope": SESSION_SCOPE},
 "session.completed": cap("optional"), "session.capture_summary": cap("optional"),
 "measurement.recorded": cap("optional"),                                   # NEW (Motion experimental measures)
 "report.submitted": {"stream": "session", "authored": "client", "actors": ["participant"], "sources": ["participant_report"], "algorithm": "forbidden", "mono": "optional", "scope": SESSION_SCOPE},
 "review.recorded": {"stream": "review", "authored": "server", "actors": ["therapist"], "sources": ["therapist"], "algorithm": "forbidden", "mono": "forbidden", "scope": NO_SESSION},
 "summary.published": {"stream": "review", "authored": "server", "actors": ["therapist"], "sources": ["therapist"], "algorithm": "forbidden", "mono": "forbidden", "scope": NO_SESSION},
 "evolution.published": {"stream": "review", "authored": "server", "actors": ["therapist"], "sources": ["therapist"], "algorithm": "forbidden", "mono": "forbidden", "scope": NO_SESSION},  # NEW
 "privacy.erasure": {"stream": "privacy", "authored": "server", "actors": ["system"], "sources": ["system"], "algorithm": "forbidden", "mono": "forbidden", "scope": NO_SESSION},
}
# allowed (execution_mode -> source.type) pairs. PD-03: execution mode is NOT data origin.
EXEC_SOURCE = {"camera": ["camera"], "simulation": ["simulation"], "report_only": ["participant_report"],
               "not_applicable": ["therapist", "system", "participant_report"]}
LIMITATIONS = {
 "L01": "Contagem automática experimental, não validada clinicamente.", "L02": "O ciclo é medido em relação à calibração feita no próprio dia.",
 "L03": "A câmera não identifica quem fez o movimento nem se houve ajuda.", "L04": "Relatos são declarações e não foram verificados.",
 "L05": "Dias sem registro não indicam necessariamente ausência de prática.",
 "L06": "Envio de dados incompleto: parte dos registros desta sessão não chegou ao servidor.",
 "L07": "Em parte dos ciclos, a mão detectada não correspondeu ao lado prescrito.",
 "L08": "O sistema não determina qual fonte está correta.", "L09": "Sinalização da pessoa; requer avaliação do terapeuta.",
 "L10": "Não é medida de amplitude articular; não é comparável entre câmeras ou posições.",
 "L11": "Dados sintéticos de demonstração; não se referem a uma pessoa real.", "L12": "Dados importados de versão anterior, com proveniência reduzida.",
 "L13": "Registro gerado em modo de simulação, sem câmera.", "L14": "Qualidade de captura baixa: menos da metade do tempo com a mão visível o suficiente.",
 "L15": "Assistência não é observável pela câmera.",
 # new in catalog v2
 "L16": "Captura experimental com câmera real, fora de uso clínico; não é registro clínico.",
 "L17": "Ciclos com lateralidade incompatível com a prescrição não são contados como cumprimento.",
 "L18": "Medida experimental: método e valores ainda em validação.",
 "L19": "Ciclos sem leitura de lateralidade foram contados e estão sinalizados.",
}
ORIGIN_PREFIX = {"live": "", "synthetic_fixture": "[Dados sintéticos] ", "experimental_capture": "[Captura experimental] ", "imported_v1": "[Importado de versão anterior] "}
ORIGIN_LIMITATION = {"live": None, "synthetic_fixture": "L11", "experimental_capture": "L16", "imported_v1": "L12"}
