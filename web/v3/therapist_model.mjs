/**
 * Elo v3 — Pure domain/view-model helpers for the therapist journey (S1-03).
 *
 * Zero DOM dependencies so all review-gate, origin-label, execution-mode,
 * error-formatting, and forbidden-output rules are directly unit-testable.
 */

/**
 * Origin labels mirrored directly from contracts/CL06_3-r1/contracts/catalogs/limitations.v2.json.
 */
export const ORIGIN_PREFIX = Object.freeze({
  live: "",
  synthetic_fixture: "[Dados sintéticos] ",
  experimental_capture: "[Captura experimental] ",
  imported_v1: "[Importado de versão anterior] ",
});

export const ORIGIN_LABEL = Object.freeze({
  live: "Sem prefixo (live)",
  synthetic_fixture: "[Dados sintéticos]",
  experimental_capture: "[Captura experimental]",
  imported_v1: "[Importado de versão anterior]",
});

export const EXECUTION_MODE_LABEL_PTBR = Object.freeze({
  report_only: "Apenas relato (report_only)",
  camera: "Câmera (camera)",
  simulation: "Simulação (simulation)",
  not_applicable: "Não aplicável (not_applicable)",
});

export const TIMELINE_KIND_LABEL_PTBR = Object.freeze({
  functional_assessment: "Avaliação funcional",
  goal: "Meta funcional",
  encounter: "Atendimento",
  reassessment: "Reavaliação",
  instrumental_measurement: "Medida instrumental",
  "prescription.published": "Prescrição publicada",
  "summary.published": "Resumo publicado",
  "evolution.published": "Evolução publicada",
});

export const ASSISTANCE_TRANSITION_LABEL_PTBR = Object.freeze({
  less_help_reported: "Menos ajuda relatada",
  more_help_reported: "Mais ajuda relatada",
  unchanged: "Sem mudança na ajuda relatada",
});

export const ERROR_MESSAGE_PTBR = Object.freeze({
  UNAUTHENTICATED:
    "Autenticação necessária. Entre com suas credenciais de terapeuta para continuar.",
  FORBIDDEN:
    "Acesso negado: o perfil atual não tem permissão para esta operação clínica.",
  SCOPE_VIOLATION:
    "Acesso negado: o terapeuta autenticado não possui vínculo ativo com este participante.",
  NOT_FOUND:
    "Registro não encontrado ou sem permissão de acesso no escopo atual.",
  UNREVIEWED_FACT_IN_EVOLUTION:
    "Publicação bloqueada: todos os fatos incluídos na evolução precisam estar aprovados pelo terapeuta.",
  FACT_NOT_APPROVED:
    "Publicação bloqueada: apenas fatos efetivamente aprovados pelo terapeuta podem ser publicados.",
  FACT_NOT_SUMMARY_ELIGIBLE:
    "Publicação bloqueada: o fato selecionado não é elegível para resumo ou evolução.",
  CONTENT_HASH_STALE:
    "Publicação ou revisão bloqueada: o conteúdo do fato mudou (content_hash obsoleto). Recarregue os fatos antes de revisar novamente.",
  COMPARABILITY_VIOLATION:
    "Publicação bloqueada: os fatos selecionados não são comparáveis segundo as regras cmp-v1.",
  RULE_VIOLATION:
    "Operação recusada pelas regras clínicas ou contratuais da API v3.",
  LIMITS_EXCEEDED:
    "Prescrição recusada: séries ou repetições excedem os limites técnicos permitidos.",
  CONFLICT_IMMUTABLE:
    "Conflito de imutabilidade: o registro publicado não pode ser sobrescrito com conteúdo diferente.",
  ROLE_NOT_ALLOWED:
    "Perfil não permitido pela política de autorização da API v3.",
  REAL_DATA_GATE_CLOSED:
    "Origem de dados real bloqueada enquanto a etapa estiver restrita a dados sintéticos.",
  NETWORK_ERROR:
    "Não foi possível comunicar com a API v3 local. Verifique se o servidor está ativo.",
});

/**
 * Forbidden clinical output & value-judgement patterns per comparability-rules.v1.json (cmp-v1)
 * and ACCEPTANCE Row 5. Checked case-insensitively on normalized text.
 */
export const FORBIDDEN_OUTPUT_PATTERNS = Object.freeze([
  { id: "trend_slope_pt", regex: /\btend[eê]ncia\b|\binclina[cç][aã]o\b|\bsignific[aâ]ncia\s+estat[ií]stica\b/i },
  { id: "trend_slope_en", regex: /\btrend\b|\bslope\b|\bstatistical\s+significance\b/i },
  { id: "recovery_prediction_pt", regex: /\bprevis[aã]o\s+de\s+recupera[cç][aã]o\b|\bprogn[oó]stico\b/i },
  { id: "recovery_prediction_en", regex: /\brecovery\s+prediction\b/i },
  { id: "worsening_alert_pt", regex: /\balerta\s+de\s+piora\b|\bpiora\s+cl[ií]nica\b/i },
  { id: "worsening_alert_en", regex: /\bworsening\s+alert\b/i },
  { id: "recovery_score_pt", regex: /\bescore\s+(global|de\s+recupera[cç][aã]o)\b|\bpontua[cç][aã]o\s+global\b/i },
  { id: "recovery_score_en", regex: /\bglobal\s+recovery\s+score\b|\brecovery\s+score\b/i },
  { id: "recovery_pct_pt", regex: /\bporcentagem\s+de\s+recupera[cç][aã]o\b|\bpercentual\s+de\s+recupera[cç][aã]o\b/i },
  { id: "recovery_pct_en", regex: /\bpercentage\s+of\s+recovery\b/i },
  {
    id: "value_words_pt_en",
    regex: /\b(melhorou|piorou|progresso\s+excelente|evolu[cç][aã]o\s+positiva|evolu[cç][aã]o\s+negativa|improved|worsened)\b/i,
  },
]);

/**
 * Return visible origin label for a ``data_origin`` value.
 *
 * @param {string | null | undefined} dataOrigin
 * @returns {string}
 */
export function formatOriginLabel(dataOrigin) {
  if (!dataOrigin || typeof dataOrigin !== "string") {
    return "[Origem desconhecida]";
  }
  if (Object.prototype.hasOwnProperty.call(ORIGIN_LABEL, dataOrigin)) {
    return ORIGIN_LABEL[/** @type {keyof typeof ORIGIN_LABEL} */ (dataOrigin)];
  }
  return `[${dataOrigin}]`;
}

/**
 * Return visible execution mode text containing both PT-BR description and canonical token.
 *
 * @param {string | null | undefined} executionMode
 * @returns {string}
 */
export function formatExecutionMode(executionMode) {
  if (!executionMode || typeof executionMode !== "string") {
    return "Modo desconhecido (unknown)";
  }
  if (Object.prototype.hasOwnProperty.call(EXECUTION_MODE_LABEL_PTBR, executionMode)) {
    return EXECUTION_MODE_LABEL_PTBR[/** @type {keyof typeof EXECUTION_MODE_LABEL_PTBR} */ (executionMode)];
  }
  return executionMode;
}

/**
 * Format an API v3 error into an accessible PT-BR message always including the error code.
 *
 * @param {{ code?: string, status?: number, message?: string }} error
 * @returns {string}
 */
export function formatApiErrorMessage(error) {
  const code = typeof error?.code === "string" && error.code ? error.code : "UNKNOWN_ERROR";
  const mapped = Object.prototype.hasOwnProperty.call(ERROR_MESSAGE_PTBR, code)
    ? ERROR_MESSAGE_PTBR[/** @type {keyof typeof ERROR_MESSAGE_PTBR} */ (code)]
    : error?.message || "Erro ao executar operação na API v3.";
  const statusPart = typeof error?.status === "number" && error.status > 0 ? ` (HTTP ${error.status})` : "";
  return `[${code}]${statusPart} ${mapped}`;
}

/**
 * Evaluate the review-gate state of a single fact entry.
 *
 * Rules (ADR-012, D-S1b-03-2, ACCEPTANCE Row 3):
 * - ``annotate`` never changes effective approval status.
 * - Non-summary-eligible facts (F09/F10) can never enter summaries or evolution.
 * - Only facts effectively approved under their CURRENT ``content_hash`` are publishable.
 *
 * @param {{
 *   fact: { fact_id: string, type: string, flags?: { summary_eligible?: boolean } },
 *   contentHash: string,
 *   effectiveReview?: { decision: string, content_hash: string } | null
 * }} entry
 */
export function evaluateFactGate(entry) {
  const eligible = Boolean(entry?.fact?.flags?.summary_eligible);
  if (!eligible) {
    return {
      status: "not_eligible",
      labelPtBr: "Não elegível para resumo",
      publishable: false,
    };
  }
  const rev = entry?.effectiveReview;
  if (!rev) {
    return {
      status: "unreviewed",
      labelPtBr: "Pendente de revisão",
      publishable: false,
    };
  }
  if (rev.decision === "reject") {
    return {
      status: "rejected",
      labelPtBr: "Rejeitado",
      publishable: false,
    };
  }
  if (rev.decision === "approve") {
    if (rev.content_hash !== entry.contentHash) {
      return {
        status: "stale",
        labelPtBr: "Aprovação obsoleta (content_hash alterado)",
        publishable: false,
      };
    }
    return {
      status: "approved",
      labelPtBr: "Aprovado",
      publishable: true,
    };
  }
  return {
    status: "unreviewed",
    labelPtBr: "Pendente de revisão",
    publishable: false,
  };
}

/**
 * Fold an array of ``review.recorded`` events into effective review map by ``fact_id``.
 * Only ``approve`` and ``reject`` alter effective status; ``annotate`` never does.
 *
 * @param {Array<{ payload?: { fact_id?: string, decision?: string, content_hash?: string, note?: string | null }, event_id?: string }>} reviews
 * @returns {Record<string, { decision: string, content_hash: string, event_id: string | null, note: string | null }>}
 */
export function foldEffectiveReviews(reviews) {
  /** @type {Record<string, { decision: string, content_hash: string, event_id: string | null, note: string | null }>} */
  const effective = {};
  for (const ev of reviews || []) {
    const payload = ev?.payload;
    if (!payload || typeof payload.fact_id !== "string") continue;
    if (payload.decision === "approve" || payload.decision === "reject") {
      effective[payload.fact_id] = {
        decision: payload.decision,
        content_hash: String(payload.content_hash || ""),
        event_id: typeof ev.event_id === "string" ? ev.event_id : null,
        note: payload.note ?? null,
      };
    }
  }
  return effective;
}

/**
 * Return the publishable (effectively approved, current-hash, summary-eligible) items for summary publication.
 *
 * @param {Array<{ fact: any, contentHash: string, effectiveReview?: any }>} factEntries
 * @returns {Array<{ fact_id: string, content_hash: string }>}
 */
export function getPublishableSummaryItems(factEntries) {
  const items = [];
  for (const entry of factEntries || []) {
    const gate = evaluateFactGate(entry);
    if (gate.publishable) {
      items.push({
        fact_id: String(entry.fact.fact_id),
        content_hash: String(entry.contentHash),
      });
    }
  }
  return items;
}

/**
 * Determine whether the Publish Summary control may be enabled.
 *
 * @param {Array<{ fact: any, contentHash: string, effectiveReview?: any }>} factEntries
 * @returns {boolean}
 */
export function canPublishSummary(factEntries) {
  return getPublishableSummaryItems(factEntries).length > 0;
}

/**
 * Determine whether the Publish Evolution control may be enabled.
 * Requires at least one comparable series returned by GET /evolution/series
 * AND every item in the selected series to be verified as approved in the current state.
 *
 * @param {Array<{ series_key_hash: string, items: Array<{ fact_id: string, content_hash: string }> }>} seriesList
 * @param {Array<{ fact: any, contentHash: string, effectiveReview?: any }>} factEntries
 * @returns {boolean}
 */
export function canPublishEvolution(seriesList, factEntries) {
  if (!Array.isArray(seriesList) || seriesList.length === 0) {
    return false;
  }
  const approvedById = new Map();
  for (const entry of factEntries || []) {
    const gate = evaluateFactGate(entry);
    if (gate.publishable) {
      approvedById.set(String(entry.fact.fact_id), String(entry.contentHash));
    }
  }
  if (approvedById.size === 0) {
    return false;
  }
  return seriesList.some(
    (s) =>
      Array.isArray(s.items) &&
      s.items.length > 0 &&
      s.items.every((it) => approvedById.get(String(it.fact_id)) === String(it.content_hash))
  );
}

/**
 * Scan visible text for any cmp-v1 forbidden clinical outputs or value-judgement words.
 *
 * @param {string} text
 * @returns {Array<{ id: string, match: string }>}
 */
export function scanForbiddenOutputs(text) {
  const source = typeof text === "string" ? text : "";
  const findings = [];
  for (const rule of FORBIDDEN_OUTPUT_PATTERNS) {
    const m = source.match(rule.regex);
    if (m) {
      findings.push({ id: rule.id, match: m[0] });
    }
  }
  return findings;
}
