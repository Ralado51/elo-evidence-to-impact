/**
 * Elo v3 — Pure domain & event-builder model for the participant journey (S1-04).
 *
 * "Organizar a mesa" report-only experience written completely from scratch (PO-F10, PO-F28, PO-F29).
 * Zero DOM dependencies, zero Node-only imports, zero legacy references.
 */

import { hashCanonical } from "./canonical.mjs";
import {
  ASSISTANCE_TRANSITION_LABEL_PTBR,
  formatExecutionMode,
  formatOriginLabel,
  scanForbiddenOutputs,
} from "./therapist_model.mjs";

export {
  ASSISTANCE_TRANSITION_LABEL_PTBR,
  formatExecutionMode,
  formatOriginLabel,
  scanForbiddenOutputs,
};

export const PARTICIPANT_DATA_ORIGIN = "synthetic_fixture";
export const REPORT_ONLY_MODE = "report_only";
export const DEFAULT_EXERCISE_ID = "organizar-a-mesa";

/**
 * Basic report execution choices (Row 5: zero typing; "não sei / prefiro não dizer" -> "unreported").
 */
export const EXECUTION_CHOICES = Object.freeze([
  { value: "complete", label: "Realizei a atividade completa" },
  { value: "partial", label: "Realizei parte da atividade" },
  { value: "none", label: "Não consegui realizar" },
  { value: "unreported", label: "Não sei / prefiro não dizer" },
]);

/**
 * Basic report assistance choices (Row 5: zero typing; "não sei / prefiro não dizer" -> "unreported").
 */
export const ASSISTANCE_CHOICES = Object.freeze([
  { value: "none", label: "Sem ajuda" },
  { value: "some", label: "Com alguma ajuda" },
  { value: "full", label: "Com ajuda total" },
  { value: "unreported", label: "Não sei / prefiro não dizer" },
]);

export const SIDE_LABEL_PTBR = Object.freeze({
  right: "Direito",
  left: "Esquerdo",
});

export const BODY_SEGMENT_LABEL_PTBR = Object.freeze({
  hand: "Mão",
  wrist: "Punho",
});

export const GOAL_STATUS_LABEL_PTBR = Object.freeze({
  active: "Ativa",
  achieved_confirmed: "Confirmada pelo terapeuta",
  discontinued: "Descontinuada",
});

export const GOAL_TARGET_KIND_LABEL_PTBR = Object.freeze({
  descriptive_text: "Objetivo descritivo",
  session_count: "Sessões",
  repetitions: "Repetições",
  measure_value: "Medida",
});

/**
 * Original guided steps for "Organizar a mesa" in report-only mode (PO-F28, PO-F29).
 */
export const ORGANIZAR_A_MESA_GUIDE = Object.freeze([
  "Sente-se de forma confortável diante de uma mesa com itens leves do cotidiano.",
  "Use o lado indicado na sua prescrição para abrir e fechar a mão ao organizar os objetos no seu ritmo.",
  "Esta prática funciona apenas por relato: nenhuma câmera ou microfone será ligado.",
  "Se sentir dor ou cansaço, use o botão único de parada imediata abaixo.",
]);

export const PARTICIPANT_ERROR_MESSAGES_PTBR = Object.freeze({
  UNAUTHENTICATED:
    "Sessão não autenticada. Entre com o código de convite fornecido pelo terapeuta.",
  INVITE_INVALID:
    "Código de convite inválido, expirado ou já utilizado. Solicite um novo convite ao terapeuta.",
  FORBIDDEN:
    "Operação recusada: este perfil de participante não tem permissão para enviar ou acessar este recurso.",
  SCOPE_VIOLATION:
    "Acesso negado: o registro solicitado está fora do escopo do participante autenticado.",
  NOT_FOUND:
    "Registro não encontrado ou indisponível para o participante autenticado.",
  CONSENT_REQUIRED:
    "Operação bloqueada: consentimento de sensor obrigatório não encontrado para este modo de execução.",
  INVALID_TRANSITION:
    "Ação não permitida no estado atual da sessão.",
  PRESCRIPTION_NOT_FOUND:
    "Nenhuma prescrição ativa encontrada para iniciar a sessão.",
  RULE_VIOLATION:
    "Operação recusada pelas regras da API v3.",
  NETWORK_ERROR:
    "Não foi possível comunicar com a API v3 local.",
});

const ALLOWED_CONTROL_ACTIONS = new Set([
  "start",
  "pause",
  "resume",
  "end",
  "pain",
  "fatigue",
]);

const ALLOWED_EXECUTION_VALUES = new Set(EXECUTION_CHOICES.map((c) => c.value));
const ALLOWED_ASSISTANCE_VALUES = new Set(ASSISTANCE_CHOICES.map((c) => c.value));

/**
 * Generate a CL06.3-compliant session_id matching ^s_[A-Za-z0-9-]{8,64}$.
 *
 * @returns {string}
 */
export function generateSessionId() {
  const ts = Date.now().toString(36);
  let rand = "";
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } else {
    rand = Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  }
  return `s_om-${ts}-${rand}`;
}

/**
 * Return an ISO-8601 UTC millisecond timestamp guaranteed >= previousIso + 1ms when provided.
 *
 * @param {string | null | undefined} [previousIso]
 * @returns {string}
 */
export function nextMonotonicIso(previousIso = null) {
  let ms = Date.now();
  if (typeof previousIso === "string" && previousIso) {
    const prevMs = Date.parse(previousIso);
    if (Number.isFinite(prevMs) && ms <= prevMs) {
      ms = prevMs + 1;
    }
  }
  return new Date(ms).toISOString();
}

/**
 * Build and hash one CL06.3 v3 client-authored event on a session stream.
 *
 * @param {{
 *   type: string,
 *   participantId: string,
 *   orgId: string,
 *   sessionId: string,
 *   prescriptionId: string,
 *   prescriptionRevision: number,
 *   exerciseId?: string,
 *   seq: number,
 *   prevHash: string | null,
 *   occurredAt?: string,
 *   payload: Record<string, unknown>,
 * }} params
 */
async function buildSignedReportOnlySessionEvent(params) {
  const streamId = `session:${params.sessionId}`;
  const eventId = await hashCanonical({ seq: params.seq, stream_id: streamId });
  const occurredAt = params.occurredAt || nextMonotonicIso();
  const evNoHash = {
    event_id: eventId,
    schema_version: 3,
    type: params.type,
    stream_id: streamId,
    seq: params.seq,
    prev_hash: params.prevHash,
    occurred_at: occurredAt,
    actor: {
      role: "participant",
      id: params.participantId,
    },
    scope: {
      org_id: params.orgId,
      participant_id: params.participantId,
      session_id: params.sessionId,
      prescription_id: params.prescriptionId,
      prescription_revision: params.prescriptionRevision,
      exercise_id: params.exerciseId || DEFAULT_EXERCISE_ID,
    },
    source: {
      type: "participant_report",
      device_hint: "desktop-chrome",
    },
    execution_mode: REPORT_ONLY_MODE,
    data_origin: PARTICIPANT_DATA_ORIGIN,
    payload: params.payload,
  };
  const hash = await hashCanonical(evNoHash);
  return { ...evNoHash, hash };
}

/**
 * Build a valid report-only ``session.started`` event (seq=1, prev_hash=null).
 */
export async function buildSessionStartedEvent(params) {
  return buildSignedReportOnlySessionEvent({
    ...params,
    type: "session.started",
    seq: 1,
    prevHash: null,
    payload: {
      source_mode: REPORT_ONLY_MODE,
      prescription_id: params.prescriptionId,
      prescription_revision: params.prescriptionRevision,
      capture_context: null,
    },
  });
}

/**
 * Build a valid report-only ``session.control`` event (start, end, pain, fatigue, pause, resume).
 */
export async function buildSessionControlEvent(params) {
  if (!ALLOWED_CONTROL_ACTIONS.has(params.action)) {
    throw new Error(`Unsupported session.control action: ${String(params.action)}`);
  }
  return buildSignedReportOnlySessionEvent({
    ...params,
    type: "session.control",
    payload: {
      action: params.action,
      interrupt_reason: null,
    },
  });
}

/**
 * Build a valid report-only ``report.submitted`` event.
 */
export async function buildReportSubmittedEvent(params) {
  if (!ALLOWED_EXECUTION_VALUES.has(params.execution)) {
    throw new Error(`Invalid report execution choice: ${String(params.execution)}`);
  }
  if (!ALLOWED_ASSISTANCE_VALUES.has(params.assistance)) {
    throw new Error(`Invalid report assistance choice: ${String(params.assistance)}`);
  }
  return buildSignedReportOnlySessionEvent({
    ...params,
    type: "report.submitted",
    payload: {
      execution: params.execution,
      assistance: params.assistance,
      reporter_role: "participant",
    },
  });
}

/**
 * Project a prescription.published event into participant-safe display fields
 * (strips hashes, event_id, created_by, and participant_id per Row 8).
 *
 * @param {any} rxEvent
 */
export function projectPrescriptionForDisplay(rxEvent) {
  const payload = rxEvent?.payload || {};
  const originLabel = formatOriginLabel(rxEvent?.data_origin || PARTICIPANT_DATA_ORIGIN);
  const sideLabel = SIDE_LABEL_PTBR[payload.side] || String(payload.side || "");
  return {
    prescriptionId: String(payload.prescription_id || ""),
    revision: Number(payload.revision || 1),
    exerciseId: String(payload.exercise_id || DEFAULT_EXERCISE_ID),
    exerciseName:
      payload.exercise_id === DEFAULT_EXERCISE_ID
        ? "Organizar a mesa"
        : String(payload.exercise_id || ""),
    movementLabel:
      payload.permitted_movement === "hand_open_close"
        ? "Abrir e fechar a mão"
        : String(payload.permitted_movement || ""),
    sideLabel,
    targetSets: Number(payload.target_sets || 0),
    targetRepetitions: Number(payload.target_repetitions || 0),
    sessionsPerWeek: Number(payload.sessions_per_week || 0),
    validFrom: String(payload.valid_from || ""),
    validTo: payload.valid_to ? String(payload.valid_to) : null,
    instructionsPtBr: String(payload.instructions_ptbr || ""),
    originLabel,
    executionMode: REPORT_ONLY_MODE,
    executionModeLabel: formatExecutionMode(REPORT_ONLY_MODE),
  };
}

/**
 * Extract visible origin label from a participant summary view.
 *
 * @param {any} summaryView
 * @returns {string}
 */
export function resolveSummaryOriginLabel(summaryView) {
  const facts = Array.isArray(summaryView?.rendered_facts) ? summaryView.rendered_facts : [];
  for (const item of facts) {
    const text = String(item?.text_ptbr || "");
    const match = text.match(/^\[(Dados sintéticos|Captura experimental|Importado de versão anterior)\]/);
    if (match) {
      return match[0];
    }
  }
  return formatOriginLabel(PARTICIPANT_DATA_ORIGIN);
}

/**
 * Resolve visible origin label for a participant simplified evolution series.
 *
 * @param {any} series
 * @returns {string}
 */
export function resolveEvolutionSeriesOriginLabel(series) {
  if (typeof series?.origin_prefix === "string" && series.origin_prefix.trim()) {
    return series.origin_prefix.trim();
  }
  return formatOriginLabel(series?.data_origin_class || PARTICIPANT_DATA_ORIGIN);
}

/**
 * Format an API or rejected-batch error into an accessible PT-BR message including [CODE].
 *
 * @param {{ code?: string, status?: number, codes?: string[], message?: string }} err
 * @returns {string}
 */
export function formatParticipantError(err) {
  const code = typeof err?.code === "string" && err.code ? err.code : "UNKNOWN_ERROR";
  const baseMsg = Object.prototype.hasOwnProperty.call(PARTICIPANT_ERROR_MESSAGES_PTBR, code)
    ? PARTICIPANT_ERROR_MESSAGES_PTBR[
        /** @type {keyof typeof PARTICIPANT_ERROR_MESSAGES_PTBR} */ (code)
      ]
    : err?.message || "Erro ao executar operação na API v3.";
  const statusPart = typeof err?.status === "number" && err.status > 0 ? ` (HTTP ${err.status})` : "";
  return `[${code}]${statusPart} ${baseMsg}`;
}

/**
 * Scan rendered text for forbidden participant leaks: 64-hex hashes, note_refs, or actor ids (t_/p_).
 *
 * @param {string} text
 * @returns {Array<{ kind: string, match: string }>}
 */
export function scanParticipantSensitiveLeaks(text) {
  const source = typeof text === "string" ? text : "";
  const findings = [];
  const hexMatch = source.match(/\b[0-9a-f]{64}\b/i);
  if (hexMatch) findings.push({ kind: "sha256_hash", match: hexMatch[0] });
  const actorMatch = source.match(/\b(?:t|p)_[A-Za-z0-9-]{8,64}\b/);
  if (actorMatch) findings.push({ kind: "actor_id", match: actorMatch[0] });
  const noteRefMatch = source.match(/\bnote_refs\b/i);
  if (noteRefMatch) findings.push({ kind: "note_refs", match: noteRefMatch[0] });
  return findings;
}
