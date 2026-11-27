/**
 * Elo v3 — pure model for the therapist dashboard ("painel").
 * No DOM, no network. Everything here is derived from data the /api/v3 already returned,
 * so the dashboard never invents a clinical number.
 */

import { t, label } from "./i18n.mjs";
import { hashCanonical } from "./canonical.mjs";

const mkLevel = (rank, value) =>
  Object.freeze({
    rank,
    get label() { return label("assistance", value); },
    get short() { return label("assistance_short", value); },
  });

export const ASSISTANCE_LEVELS = Object.freeze({
  full: mkLevel(3, "full"),
  some: mkLevel(2, "some"),
  none: mkLevel(1, "none"),
});

/** Localized execution label per session (F03 values). */
export function executionLabel(value) {
  return label("execution_short", value);
}

const VERIFY_CODES = Object.freeze(["RECOMPUTE_MISMATCH", "MISSING_FIELD", "UNSUPPORTED"]);

export function describeVerifyFailure(code) {
  return VERIFY_CODES.includes(code) ? t(`pn.verify.${code}`) : t("pn.verify.default");
}

/**
 * Project each approved F04 series separately. Execution is optional and must
 * be approved for the same session and content version.
 */
export async function assistanceSeries(seriesResponse, facts) {
  const all = (seriesResponse?.series ?? []).filter(({ series_key }) =>
    series_key.fact_type === "F03" || series_key.fact_type === "F04"
  );
  const factsById = new Map(facts.map((fact) => [fact.fact_id, fact]));
  const approved = new Map();
  await Promise.all(all.flatMap((series) => series.items.map(async (item) => {
    const fact = factsById.get(item.fact_id);
    if (fact?.type === series.series_key.fact_type &&
        fact.scope?.participant_id === series.series_key.participant_id &&
        fact.scope.session_id && await hashCanonical(fact) === item.content_hash) {
      approved.set(item.fact_id, fact);
    }
  })));

  const executions = new Map();
  for (const series of all.filter(({ series_key }) => series_key.fact_type === "F03")) {
    for (const item of series.items) {
      const fact = approved.get(item.fact_id);
      if (!fact) continue;
      const key = sessionKey(fact);
      executions.set(key, executions.has(key) ? "unreported" : fact.params?.execution ?? "unreported");
    }
  }

  const series = all.filter(({ series_key }) => series_key.fact_type === "F04").map((series) => {
    const chain = series.items
      .map((item) => {
        const fact = approved.get(item.fact_id);
        return {
          factId: item.fact_id,
          level: item.context.assistance_level,
          date: item.session_date_local,
          execution: fact ? executions.get(sessionKey(fact)) ?? "unreported" : "unreported",
        };
      })
      .filter(({ level }) => Object.hasOwn(ASSISTANCE_LEVELS, level));
    const positions = new Map(chain.map((item, index) => [item.factId, index + 1]));
    const transitions = [];
    for (const change of seriesResponse.context_changes?.[series.series_key_hash] ?? []) {
      const from = positions.get(change.from_fact_id);
      const to = positions.get(change.to_fact_id);
      if (change.dimension !== "assistance_level" || from === undefined || to !== from + 1) continue;
      const previous = ASSISTANCE_LEVELS[chain[from - 1].level].rank;
      const current = ASSISTANCE_LEVELS[chain[to - 1].level].rank;
      if (previous === current) continue;
      transitions.push({ from, to, direction: current < previous ? "less_help_reported" : "more_help_reported" });
    }
    const splitKeys = (seriesResponse.notices ?? [])
      .filter((notice) => notice.kind === "series_split" && notice.series_key_hashes.includes(series.series_key_hash))
      .flatMap((notice) => notice.differing_keys);
    return { chain, transitions, splitKeys: [...new Set(splitKeys)] };
  });
  return { series, approvedIds: new Set(approved.keys()) };
}

function sessionKey(fact) {
  const { org_id, participant_id, session_id, prescription_id, prescription_revision } = fact.scope;
  return JSON.stringify([org_id, participant_id, session_id, prescription_id, prescription_revision]);
}

/** Counts and latest values for the KPI cards, from the facts list. */
export function computeKpis(facts, chain) {
  const list = Array.isArray(facts) ? facts : [];
  const byType = (t) => list.filter((f) => f.type === t);
  const sessions = byType("F02").length;
  const exec = byType("F03");
  const completed = exec.filter((f) => f.params?.execution === "complete").length;
  const latest = chain.length ? chain[chain.length - 1] : null;
  const first = chain.length ? chain[0] : null;
  return {
    sessions,
    completed,
    executionTotal: exec.length,
    latestLevel: latest ? latest.level : null,
    firstLevel: first ? first.level : null,
    factsTotal: list.length,
  };
}

/** Summarize only changes reported by the authorized server projection. */
export function headline(series) {
  const changes = series.flatMap((entry) => entry.transitions);
  const more = changes.filter((change) => change.direction === "more_help_reported").length;
  const less = changes.length - more;
  return changes.length
    ? t("pn.headline.changes", { more, less })
    : t("pn.headline.no_confirmed_changes");
}

/**
 * Geometry for the step chart. Higher "help" is higher on the chart; the goal is to go down.
 * @returns {{ width:number, height:number, points: Array<{x:number,y:number,level:string,index:number}>, yByLevel: Record<string,number> }}
 */
export function chartGeometry(chain, { width = 640, height = 260, padLeft = 120, padRight = 56, padTop = 28, padBottom = 54 } = {}) {
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;
  const yByLevel = {
    full: padTop,
    some: padTop + innerH / 2,
    none: padTop + innerH,
  };
  const n = chain.length;
  const points = chain.map((c, i) => ({
    x: n === 1 ? padLeft + innerW / 2 : padLeft + (innerW * i) / (n - 1),
    y: yByLevel[c.level] ?? yByLevel.some,
    level: c.level,
    index: i + 1,
  }));
  return { width, height, points, yByLevel, padLeft, padRight, padTop, padBottom };
}

/** A sentence that claims MORE independence than the record supports (used to demonstrate blocking). */
export function exaggeratedLevel(realLevel) {
  return realLevel === "none" ? "some" : "none";
}

export function exaggeratedSentence(sessionNumber, level) {
  const lvl = (ASSISTANCE_LEVELS[level] ?? ASSISTANCE_LEVELS.some).label.toLowerCase();
  return t("pn.exaggerated", { n: sessionNumber, level: lvl });
}

/** Build a verify-proposal from a stored fact, optionally overriding the assistance param. */
export function proposalFromFact(fact, assistanceOverride) {
  const proposal = {
    type: fact.type,
    catalog_version: fact.catalog_version,
    params: { ...fact.params },
    evidence_refs: [...fact.evidence_refs],
    scope: { ...fact.scope },
    data_origin: fact.data_origin,
  };
  if (assistanceOverride) proposal.params.assistance = assistanceOverride;
  return proposal;
}
