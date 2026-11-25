# TRACEABILITY_P0 — 101 P0 requirements → CL06.3

Source: `Elo_PRD_Dark_Factory/FUNCTIONAL_REQUIREMENTS.md` (132 IDs: 101 P0 incl. 8 experimental, 31 P1). Reconciled by this script (asserts 132/101). IDs are the PRD's *provisional consolidated IDs* (the PRD itself says to check them against historical IDs before freezing contracts; no separate historical ID list was found in the package, so that check is NOT done).

**Result:** 82 requirements have at least one CL06.3 contract element; 19 are interface/behavior requirements with no contract element (NOT_CONTRACT_SCOPE). All 101 are accounted for; none was dropped or reduced.

`tested_now`: yes = the contract element is exercised by schema/rule/vector tests that run in Python and JavaScript; partial = element specified but its behavior depends on a verifier, server or UI not implemented; no = no contract element.

Counts of tested_now: yes=69, partial=13, no=19.

| ID | Name | Priority | Status | Contract elements | tested_now | Notes / pending |
|---|---|---|---|---|---|---|
| ACC01 | Interface visual | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| ACC02 | Ícones rotulados | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| ACC03 | Controles ampliados | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| ACC04 | Áudio | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| ACC05 | Leitura em voz alta | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| ACC06 | Entrada por voz experimental | P0 experimental | SPECIFIED | consent scope microphone; draft voice_to_text | yes | Experimental. |
| ACC07 | Alternativa à voz | P0 | SPECIFIED | draft produced_by manual_form; report.submitted via UI | yes | Alternative path exists in contract. |
| ACC08 | Teclado | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| ACC09 | Leitor de tela | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| ACC10 | Contraste e ampliação | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| ACC11 | Símbolos | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| ACC12 | Tempo adequado | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| ACC13 | Alternativa à câmera | P0 | SPECIFIED | execution_mode report_only | yes |  |
| ACC14 | Feedback multimodal | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| ACC15 | Redução de animações | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| BTS01 | Atividades prescritas | P0 | SPECIFIED | prescriptions.current; prescription.published | yes |  |
| BTS02 | Orientação visual e sonora | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| BTS03 | Câmera opcional | P0 | SPECIFIED | session.started source_mode {camera, report_only}; execution_mode | yes |  |
| BTS04 | Execução parcial ou integral | P0 | SPECIFIED | report.submitted.execution; F03 | yes | F03 verification pending verifier. |
| BTS05 | Assistência relatada | P0 | SPECIFIED | report.submitted.assistance; F04; cmp-v1 assistance_transition | yes | Verifier pending for F04. |
| BTS06 | Dor e fadiga | P0 | SPECIFIED | session.control pain/fatigue; F08 | yes | Verifier pending for F08. |
| BTS07 | Pausa e interrupção | P0 | SPECIFIED | session.control pause/resume/interrupt; session states | yes |  |
| BTS08 | Histórico | P0 | SPECIFIED | sessions.list; timeline.get | partial | Behavior pending. |
| BTS09 | Acompanhamento profissional | P0 | SPECIFIED | facts.list; reviews.record; evolution.publish | partial | Verifier/service pending. |
| BTS10 | Preservação local e sincronização | P0 | SPECIFIED | events.batch (idempotent); event_id deterministic; hash chain | yes | Idempotency semantics need a server; chain/event_id tested now. |
| BTS11 | Relato sem câmera | P0 | SPECIFIED | execution_mode report_only; session.started.capture_context null | yes |  |
| BTS12 | Voz experimental | P0 experimental | SPECIFIED | draft.schema (session_report_proposal, voice_to_text); consent scope microphone | yes | Experimental; participant confirms and submits report.submitted. Behavior pending. |
| CLI01 | Cadastro de pacientes | P0 | SPECIFIED | participant.schema; care_link.schema; participants.create | yes | Authorization behavior pending service. |
| CLI02 | Vínculo autorizado | P0 | SPECIFIED | care_link.schema; authorization-matrix; care_links.revoke | yes | Enforcement (V3-S8) pending service. |
| CLI03 | Perfil funcional | P0 | SPECIFIED | functional_assessment.schema (generic items, instrument registry extensible) | yes | Specific fields wait for validation with the occupational therapist (Raquel). |
| CLI04 | Avaliação inicial | P0 | SPECIFIED | functional_assessment.schema; instrumental_measurement.schema; assessments.* | yes | Instrument-specific items pending clinical validation. |
| CLI05 | Objetivos | P0 | SPECIFIED | goal.schema; goals.* | yes | Goal confirmation rule tested (GOAL_CONFIRMATION_REQUIRED). |
| CLI06 | Atendimentos | P0 | SPECIFIED | encounter.schema; encounters.* | yes | Modality enum {in_person, remote_external} proposed; confirm with PO/Raquel. |
| CLI07 | Observações profissionais | P0 | SPECIFIED | encounter.therapist_note; review.recorded(annotate); functional_assessment.therapist_note | yes | Free text only in therapist-authored declared fields; never rendered as a fact. |
| CLI08 | Prescrição versionada | P0 | SPECIFIED | prescription.published (limits_version); limits.v1.json; prescriptions.* | yes | Limits rules tested (LIMITS_EXCEEDED). |
| CLI09 | Histórico | P0 | SPECIFIED | entity version chains; entities.versions; timeline.get; prescriptions.history | yes | Chains tested; timeline behavior pending. |
| CLI10 | Reavaliação | P0 | SPECIFIED | reassessment.schema; reassessments.create | yes | Descriptive differences are a projection; behavior pending. |
| CLI11 | Registro visual | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| CLI12 | Ditado experimental | P0 experimental | SPECIFIED | draft.schema (dictation_transcript); consent scope microphone; drafts.* | yes | Experimental. Provider/model not chosen. Behavior pending. |
| EVD01 | Evidência estruturada | P0 | SPECIFIED | event envelope v3; 19 event types | yes |  |
| EVD02 | Origem | P0 | SPECIFIED | source; execution_mode; data_origin; origin_ref; legacy-origin-register | yes | PD-03. |
| EVD03 | Autoria e tempo | P0 | SPECIFIED | actor; occurred_at; t_mono_ms; entity author/created_at | yes |  |
| EVD04 | Verificação determinística | P0 | SPECIFIED | fact-catalog.v2; fact/proposal schemas; adversarial cases | partial | Contract-layer probes tested now; verifier-layer probes PENDING (no implementation). |
| EVD05 | Divergências | P0 | SPECIFIED | F05; DISCREPANCY_RULE | partial | Verifier pending. |
| EVD06 | Limitações e incerteza | P0 | SPECIFIED | limitations.v2.json (L01–L19); fact.limitations | yes |  |
| EVD07 | Rastreabilidade | P0 | SPECIFIED | evidence_refs; facts.evidence; entities.versions | yes |  |
| EVD08 | Revisão individual contextual | P0 | SPECIFIED | review.recorded bound to content_hash | yes |  |
| EVD09 | Aprovação e rejeição | P0 | SPECIFIED | review.recorded approve/reject/annotate | yes |  |
| EVD10 | Correções | P0 | SPECIFIED | review.recorded; summary.published; entity versioning (corrections never overwrite) | yes | Retention of corrections (RN016) pending PX-02. |
| EVD11 | Integridade | P0 | SPECIFIED | canonicalization; hash chain; entity hash; vectors | yes | RN020: integrity is not authenticity. |
| EVD12 | Publicação controlada | P0 | SPECIFIED | summary.published; evolution.published; publication gate rules | partial | Gate enforcement pending service. |
| INT01 | Transcrição experimental | P0 experimental | SPECIFIED | draft.schema (dictation_transcript, voice_to_text); retention_class | yes | Experimental; no provider chosen; audio never retained (audio_retained const false). |
| INT02 | Extração estruturada experimental | P0 experimental | SPECIFIED | draft.schema (structured_extraction, proposals[]) | yes | Experimental. |
| INT03 | Preenchimento assistido | P0 | SPECIFIED | draft.schema; drafts.confirm | yes |  |
| INT04 | Informações ausentes | P0 | SPECIFIED | draft.proposals[].state = missing | yes |  |
| INT05 | Ambiguidades | P0 | SPECIFIED | draft.proposals[].state = ambiguous | yes |  |
| INT06 | Contexto funcional | P0 | SPECIFIED | draft.target; functional_assessment items | partial | Functional context extraction is behavior. |
| INT07 | Confirmação e correção | P0 | SPECIFIED | draft status confirmed requires confirmed_by; DRAFT_NOT_CONFIRMED | yes |  |
| INT08 | Voz do paciente experimental | P0 experimental | SPECIFIED | draft.schema (session_report_proposal, author participant) | yes | Experimental. |
| INT09 | Alternativa sem LLM | P0 | SPECIFIED | draft.produced_by manual_form; templates | yes | Alternative without voice and LLM always possible. |
| MOT01 | Captura local | P0 | SPECIFIED | execution_mode camera; ADR-001 (kept); no frame leaves device | partial | Not a contract-testable property; stated as a constraint. |
| MOT02 | Landmarks da mão | P0 | SPECIFIED | observation.recorded | yes |  |
| MOT03 | Lateralidade | P0 | SPECIFIED | handedness in cycle/observation; cycle.rejected(handedness_incompatible); stream rule; F01 v2 | yes | Semantic change (PD-04): see CONTRACT_EVOLUTION. |
| MOT04 | Calibração | P0 | SPECIFIED | calibration.attempted/applied/failed | yes |  |
| MOT05 | Abertura e fechamento | P0 | SPECIFIED | cycle.accepted / cycle.rejected | yes |  |
| MOT06 | Contagem de ciclos | P0 | SPECIFIED | F01 v2 (definition_version 2) | yes | Derivation recompute pending verifier. |
| MOT07 | Índice adimensional | P0 | SPECIFIED | observation.recorded.metric (unit '1'); measurement.recorded(opening_index, experimental); F10 | yes | F10 summary_eligible=false until protocol validated. |
| MOT08 | Qualidade | P0 | SPECIFIED | quality enum; F06 | yes | Verifier pending for F06. |
| MOT09 | Métricas por sessão | P0 | SPECIFIED | session.capture_summary; F06 | yes |  |
| MOT10 | Comparabilidade | P0 | SPECIFIED | comparability-rules.v1.json (technical criteria) | yes | Rules are data; enforcement (COMPARABILITY_VIOLATION) pending service. |
| MOT11 | Medida instrumental manual | P0 | SPECIFIED | instrumental_measurement.schema (method therapist_instrumental_manual) | yes | Kept separate from automatic measures. |
| MOT12 | Ângulo experimental sem alegação clínica | P0 experimental | SPECIFIED | measurement.recorded(measure_kind angle_auto, experimental const true) | yes | No clinical claim; experimental until protocol (T7). |
| PLY01 | Organizar a mesa | P0 | SPECIFIED | exercise_id organizar-a-mesa in scope | yes | Game itself is product work. |
| PLY02 | Integração Motion | P0 | SPECIFIED | cycle.accepted/rejected; session.completed | yes |  |
| PLY03 | Respeito à prescrição | P0 | SPECIFIED | prescription limits; OVER_TARGET stream rule (CL06.1, carried) | partial | OVER_TARGET not re-implemented in reference libs; carried from CL06.1 legacy rules. |
| PLY04 | Demonstração visual | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| PLY05 | Instrução sonora | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| PLY06 | Feedback visual | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| PLY07 | Feedback sonoro opcional | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| PLY08 | Progresso | P0 | SPECIFIED | ADR-008 carried (progress of the activity only) | partial | Behavioral; no ranking/points fields exist in any schema. |
| PLY09 | Pausa e parada | P0 | SPECIFIED | session.control | yes |  |
| PLY10 | Acessibilidade | P0 | NOT_CONTRACT_SCOPE | — | no | Interface/behavior requirement. No contract element; acceptance by the PRD's CA-* criteria in the product phase. |
| PLY11 | Eventos rastreáveis | P0 | SPECIFIED | event envelope; cycle.*; session.* | yes |  |
| PRG01 | Referência inicial | P0 | SPECIFIED | functional_assessment (baseline) + evolution.series | yes | Behavior pending. |
| PRG02 | Histórico | P0 | SPECIFIED | evolution.series/publish; evolution.published | yes | ADR-015 revises ADR-009. |
| PRG03 | Comparações compatíveis | P0 | SPECIFIED | comparability-rules.v1.json; progress-series.schema | yes | Conflict with ADR-009 resolved by ADR-015 (proposed). |
| PRG04 | Gráficos motores | P0 | SPECIFIED | progress-series.schema; evolution.published (descriptive series only) | yes | Chart rendering is UI. |
| PRG05 | Assistência | P0 | SPECIFIED | F04; cmp-v1 assistance_transition; evolution.published.assistance_transitions | yes | Descriptive indicator; no value words. |
| PRG06 | Objetivos | P0 | SPECIFIED | goal.schema; goals.* | yes |  |
| PRG07 | Participação | P0 | SPECIFIED | F03; F02; session counts in timeline | partial | Adherence over period (F07) intentionally not defined; descriptive timeline only. |
| PRG08 | Dor fadiga interrupções | P0 | SPECIFIED | F02; F08; cmp-v1 contextual dimensions | yes |  |
| PRG09 | Linha do tempo | P0 | SPECIFIED | timeline.get | partial | Read model; behavior pending. |
| PRG10 | Fonte contextual | P0 | SPECIFIED | data_origin and execution_mode on every item; origin_prefix in rendered text | yes |  |
| PRG11 | Visão simplificada do paciente | P0 | SPECIFIED | evolution.get (participant simplified view); authorization-matrix | partial | UI simplicity is product work. |
| PRG12 | Reavaliação | P0 | SPECIFIED | reassessment.schema; reassessments.create | yes |  |
| REM01 | Modalidade identificada | P0 | SPECIFIED | encounter.modality | yes |  |
| REM02 | Registro remoto externo | P0 | SPECIFIED | encounter modality remote_external; encounters.create | yes |  |
| REM03 | Atividades domiciliares | P0 | SPECIFIED | session streams (home sessions) | yes |  |
| REM04 | Histórico unificado | P0 | SPECIFIED | timeline.get; encounter + event refs | partial | Behavior pending. |
| REM05 | Comparações compatíveis | P0 | SPECIFIED | comparability-rules.v1.json | yes | Same rules as MOT10/PRG03. |
| REM06 | Ditado experimental | P0 experimental | SPECIFIED | draft.schema; drafts.* | yes | Experimental. |
