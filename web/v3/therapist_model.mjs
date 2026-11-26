/**
 * Elo v3 — Pure domain/view-model helpers for the therapist journey (S1-03).
 *
 * Zero DOM dependencies so all review-gate, origin-label, execution-mode,
 * error-formatting, and forbidden-output rules are directly unit-testable.
 */
import { t, label } from "./i18n.mjs";

/**
 * Origin labels mirrored directly from contracts/CL06_3-r1/contracts/catalogs/limitations.v2.json.
 */
export const ORIGIN_PREFIX = Object.freeze({
  live: "",
  synthetic_fixture: "[Dados sintéticos] ",
  experimental_capture: "[Captura experimental] ",
  imported_v1: "[Importado de versão anterior] ",
});

/** Canonical contract values that have a localized label (labels live in the i18n catalogs). */
export const EXECUTION_MODES = Object.freeze(["report_only", "camera", "simulation", "not_applicable"]);
export const TIMELINE_KINDS = Object.freeze([
  "functional_assessment", "goal", "encounter", "reassessment", "instrumental_measurement",
  "prescription.published", "summary.published", "evolution.published",
]);
export const ASSISTANCE_TRANSITIONS = Object.freeze(["less_help_reported", "more_help_reported", "unchanged"]);

/** Localized label of a timeline kind (no internal code shown). */
export function formatTimelineKind(kind) {
  return label("timeline", kind);
}

/** Localized label of an assistance transition direction. */
export function formatAssistanceTransition(direction) {
  return label("transition", direction);
}

/** Server message patterns that map to a specific, understandable rule (RULE_VIOLATION). */
const RULE_PATTERNS = Object.freeze([
  [/valid_to must not be earlier|period_to must not be earlier/i, "err.rule.date_order"],
  [/not a valid calendar date/i, "err.rule.calendar_date"],
  [/Contradictory|differs from/i, "err.rule.contradiction"],
  [/two attempt_refs|cycle_index|duplicate session/i, "err.rule.session_stream"],
]);

/**
 * Friendly, localized description of an API error.
 * `message` is for people; `technical` (code + HTTP status) is for the audit/diagnostic area only.
 *
 * @param {{ code?: string, status?: number, message?: string }} error
 * @returns {{ message: string, code: string, technical: string }}
 */
export function describeApiError(error) {
  const code = typeof error?.code === "string" && error.code ? error.code : "UNKNOWN_ERROR";
  let message;
  if (code === "RULE_VIOLATION") {
    const hit = RULE_PATTERNS.find(([re]) => re.test(String(error?.message || "")));
    message = t(hit ? hit[1] : "err.RULE_VIOLATION");
  } else {
    message = t(`err.${code}`);
    if (message === `err.${code}`) message = t("err.generic");
  }
  return { message, code, technical: formatApiErrorMessage(error) };
}

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
  if (!dataOrigin || typeof dataOrigin !== "string") return label("origin", "unknown");
  const out = label("origin", dataOrigin);
  return out === t("enum.unknown") ? label("origin", "unknown") : out;
}

/**
 * Return the localized execution-mode label (the canonical token is not shown to people).
 *
 * @param {string | null | undefined} executionMode
 * @returns {string}
 */
export function formatExecutionMode(executionMode) {
  if (!executionMode || typeof executionMode !== "string") return t("enum.unknown");
  return label("exec_mode", executionMode);
}

/**
 * Technical (audit/diagnostic) form of an API error: always includes the code and HTTP status.
 * People-facing text comes from describeApiError().
 *
 * @param {{ code?: string, status?: number, message?: string }} error
 * @returns {string}
 */
export function formatApiErrorMessage(error) {
  const code = typeof error?.code === "string" && error.code ? error.code : "UNKNOWN_ERROR";
  const known = t(`err.${code}`);
  const mapped = known !== `err.${code}` ? known : error?.message || "API v3 error.";
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
      labelPtBr: t("gate.not_eligible"),
      publishable: false,
    };
  }
  const rev = entry?.effectiveReview;
  if (!rev) {
    return {
      status: "unreviewed",
      labelPtBr: t("gate.unreviewed"),
      publishable: false,
    };
  }
  if (rev.decision === "reject") {
    return {
      status: "rejected",
      labelPtBr: t("gate.rejected"),
      publishable: false,
    };
  }
  if (rev.decision === "approve") {
    if (rev.content_hash !== entry.contentHash) {
      return {
        status: "stale",
        labelPtBr: t("gate.stale"),
        publishable: false,
      };
    }
    return {
      status: "approved",
      labelPtBr: t("gate.approved"),
      publishable: true,
    };
  }
  return {
    status: "unreviewed",
    labelPtBr: t("gate.unreviewed"),
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
 * Filter a list of comparable evolution series to only those whose items are ALL
 * currently publishable (effectively approved, current content_hash, summary-eligible).
 *
 * @param {Array<{ series_key_hash: string, items: Array<{ fact_id: string, content_hash: string }> }>} seriesList
 * @param {Array<{ fact: any, contentHash: string, effectiveReview?: any }>} factEntries
 * @returns {Array<{ series_key_hash: string, items: Array<{ fact_id: string, content_hash: string }> }>}
 */
export function getPublishableEvolutionSeries(seriesList, factEntries) {
  if (!Array.isArray(seriesList) || seriesList.length === 0) {
    return [];
  }
  const approvedById = new Map();
  for (const entry of factEntries || []) {
    const gate = evaluateFactGate(entry);
    if (gate.publishable) {
      approvedById.set(String(entry.fact.fact_id), String(entry.contentHash));
    }
  }
  if (approvedById.size === 0) {
    return [];
  }
  return seriesList.filter(
    (s) =>
      Array.isArray(s.items) &&
      s.items.length > 0 &&
      s.items.every((it) => approvedById.get(String(it.fact_id)) === String(it.content_hash))
  );
}

/**
 * Determine whether the Publish Evolution control may be enabled.
 * Requires at least one comparable series returned by GET /evolution/series
 * AND every item in EVERY cached series to be verified as currently approved
 * (zero stale, obsolete, rejected, or unreviewed items in the offered selection).
 *
 * @param {Array<{ series_key_hash: string, items: Array<{ fact_id: string, content_hash: string }> }>} seriesList
 * @param {Array<{ fact: any, contentHash: string, effectiveReview?: any }>} factEntries
 * @returns {boolean}
 */
export function canPublishEvolution(seriesList, factEntries) {
  if (!Array.isArray(seriesList) || seriesList.length === 0) {
    return false;
  }
  const publishable = getPublishableEvolutionSeries(seriesList, factEntries);
  return publishable.length === seriesList.length;
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
