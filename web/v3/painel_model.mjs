/**
 * Elo v3 — pure model for the therapist dashboard ("painel").
 * No DOM, no network. Everything here is derived from data the /api/v3 already returned,
 * so the dashboard never invents a clinical number.
 */

import { t, label } from "./i18n.mjs";

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

/** Ordered chain (one entry per session) taken from the approved comparable F04 series. */
export function chainFromSeries(seriesResponse) {
  const all = Array.isArray(seriesResponse?.series) ? seriesResponse.series : [];
  const f4 = all.find((s) => s?.series_key?.fact_type === "F04");
  if (!f4 || !Array.isArray(f4.items)) return [];
  return f4.items
    .map((it) => ({ factId: it.fact_id, level: it?.context?.assistance_level, date: it.session_date_local }))
    .filter((c) => Object.prototype.hasOwnProperty.call(ASSISTANCE_LEVELS, c.level));
}

/** Direction between consecutive sessions, derived only from the chain. */
export function transitionsFromChain(chain) {
  const out = [];
  for (let i = 1; i < chain.length; i += 1) {
    const a = ASSISTANCE_LEVELS[chain[i - 1].level].rank;
    const b = ASSISTANCE_LEVELS[chain[i].level].rank;
    out.push({
      from: i,
      to: i + 1,
      direction: b < a ? "less_help_reported" : b > a ? "more_help_reported" : "unchanged",
    });
  }
  return out;
}

/** Execution category (F03) per session, aligned to the chain order via the F03 series. */
export function executionBySession(seriesResponse, facts) {
  const all = Array.isArray(seriesResponse?.series) ? seriesResponse.series : [];
  const f3 = all.find((s) => s?.series_key?.fact_type === "F03");
  if (!f3 || !Array.isArray(f3.items)) return [];
  const byId = new Map((Array.isArray(facts) ? facts : []).map((f) => [f.fact_id, f]));
  return f3.items.map((it) => byId.get(it.fact_id)?.params?.execution ?? "unreported");
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

/** Plain-language headline that only states what the published chain supports. */
export function headline(chain) {
  if (chain.length < 2) {
    return t("pn.headline.few");
  }
  const a = ASSISTANCE_LEVELS[chain[0].level];
  const b = ASSISTANCE_LEVELS[chain[chain.length - 1].level];
  if (!a || !b) return t("pn.headline.published");
  if (a.rank === b.rank) {
    return t("pn.headline.same", { level: b.label.toLowerCase(), n: chain.length });
  }
  return t(b.rank < a.rank ? "pn.headline.down" : "pn.headline.up", { from: a.label.toLowerCase(), to: b.label.toLowerCase(), n: chain.length });
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
