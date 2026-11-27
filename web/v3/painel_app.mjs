/**
 * Elo v3 — therapist dashboard controller ("painel").
 * Reads only /api/v3 (contract client for most calls, plain fetch for the two read/verify
 * routes the typed client does not wrap). Never writes clinical data and never derives a
 * clinical number: every figure on screen comes from an approved fact or the verifier.
 */

import { announce } from "./a11y.mjs";
import { createV3Client } from "./api_client.mjs";
import { createContextStore } from "./context_store.mjs";
import { describeApiError } from "./therapist_model.mjs";
import { initI18n, t, tm, bindText, label as enumLabel, formatDateTime } from "./i18n.mjs";
import { renderErrorTechnical } from "./ui_messages.mjs";
import {
  ASSISTANCE_LEVELS,
  executionLabel,
  chainFromSeries,
  chartGeometry,
  computeKpis,
  describeVerifyFailure,
  exaggeratedLevel,
  exaggeratedSentence,
  executionBySession,
  headline,
  proposalFromFact,
  transitionsFromChain,
} from "./painel_model.mjs";

const SESSION_KEY = "elo_v3_therapist_session";
const RECENTS_KEY = "elo_v3_painel_recents";
const SVG_NS = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);
const state = { session: null, client: null, patient: null };

function readSession() {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(s) {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* storage is a convenience only */
  }
}

function readRecents() {
  try {
    const list = JSON.parse(window.localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(list) ? list.filter((r) => r && typeof r.id === "string") : [];
  } catch {
    return [];
  }
}

function rememberPatient(id, alias) {
  try {
    const next = [{ id, alias }, ...readRecents().filter((r) => r.id !== id)].slice(0, 5);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function showError(error) {
  const banner = $("error-banner");
  const info = describeApiError(error);
  bindText($("error-banner-text"), info.msg);
  renderErrorTechnical(banner, info.technical);
  banner.hidden = false;
  announce(info.msg, { politeness: "assertive" });
}

function clearError() {
  $("error-banner").hidden = true;
  bindText($("error-banner-text"), "");
  renderErrorTechnical($("error-banner"), "");
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") node.textContent = v;
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

// ARQ-04 / CMP-10: one store per page; the dashboard had no guard against late responses.
const ctxStore = createContextStore();

async function rawFetch(method, path, body, signal) {
  const res = await fetch(path, {
    ...(signal ? { signal } : {}),
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${state.session.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function setSignedIn(signedIn) {
  $("sec-entrar").hidden = signedIn;
  $("painel-conteudo").hidden = !signedIn;
  $("nav-entrar").hidden = signedIn;
  setCaseNav(signedIn && !$("paciente").hidden);
  $("btn-signout").hidden = !signedIn;
}

function setCaseNav(visible) {
  for (const a of document.querySelectorAll(".nav-case")) a.hidden = !visible;
}

function renderRecents() {
  const list = readRecents();
  $("recents").hidden = list.length === 0;
  const ul = $("recents-list");
  ul.replaceChildren();
  for (const r of list) {
    const btn = el("button", { type: "button", class: "btn btn-secondary target", text: r.alias || t("pn.js.participant") });
    btn.addEventListener("click", () => openPatient(r.id));
    ul.append(el("li", {}, [btn]));
  }
}

/* ---------- rendering ---------- */

function renderKpis(kpis) {
  const ul = $("kpi-list");
  ul.replaceChildren();
  const level = (l) => (l ? ASSISTANCE_LEVELS[l].label : "—");
  const items = [
    [String(kpis.sessions), t("pn.js.kpi_sessions")],
    [t("pn.js.of", { a: kpis.completed, b: kpis.executionTotal }), t("pn.js.kpi_complete")],
    [level(kpis.firstLevel), t("pn.js.kpi_first")],
    [level(kpis.latestLevel), t("pn.js.kpi_last")],
  ];
  for (const [value, text] of items) {
    ul.append(
      el("li", { class: "kpi" }, [el("span", { class: "kpi-value", text: value }), el("span", { class: "kpi-label", text })])
    );
  }
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function renderChart(chain, executions) {
  const host = $("evolution-chart");
  host.replaceChildren();
  if (chain.length === 0) {
    host.append(el("p", { class: "elo-muted", text: t("pn.js.no_chart") }));
    $("evolution-chart-desc").textContent = "";
    return;
  }
  const g = chartGeometry(chain);
  const root = svg("svg", { viewBox: `0 0 ${g.width} ${g.height}`, "aria-hidden": "true", focusable: "false" });
  for (const lvl of ["full", "some", "none"]) {
    const y = g.yByLevel[lvl];
    root.append(svg("line", { class: "grid-line", x1: g.padLeft, x2: g.width - g.padRight, y1: y, y2: y }));
    const ax = svg("text", { class: "axis-label", x: g.padLeft - 12, y: y + 5, "text-anchor": "end" });
    ax.textContent = ASSISTANCE_LEVELS[lvl].label;
    root.append(ax);
  }
  root.append(
    svg("polyline", {
      class: "series-line",
      points: g.points.map((p) => `${p.x},${p.y}`).join(" "),
    })
  );
  for (const p of g.points) {
    const shape = p.level === "none" ? "rect" : "circle";
    const common = { class: `pt pt-${p.level}` };
    const node =
      shape === "rect"
        ? svg("rect", { ...common, x: p.x - 9, y: p.y - 9, width: 18, height: 18, rx: 3 })
        : svg("circle", { ...common, cx: p.x, cy: p.y, r: p.level === "full" ? 10 : 9 });
    root.append(node);
    const tx = svg("text", { class: "tick-label", x: p.x, y: g.height - 28, "text-anchor": "middle" });
    tx.textContent = t("pn.js.session_n", { n: p.index });
    root.append(tx);
    const ex = svg("text", { class: "tick-label", x: p.x, y: g.height - 10, "text-anchor": "middle" });
    ex.textContent = executions[p.index - 1] ? executionLabel(executions[p.index - 1]) : "";
    root.append(ex);
  }
  host.append(root);
  const levelsText = chain
    .map((c, i) => t("pn.js.chart_item", { n: i + 1, level: ASSISTANCE_LEVELS[c.level].label.toLowerCase() }))
    .join("; ");
  $("evolution-chart-desc").textContent = t("pn.js.chart_desc", { items: levelsText });
  host.setAttribute("aria-label", $("evolution-chart-desc").textContent);
}

function renderTransitions(chain) {
  const ul = $("transition-list");
  ul.replaceChildren();
  for (const tr of transitionsFromChain(chain)) {
    const arrow = tr.direction === "less_help_reported" ? "↓ " : tr.direction === "more_help_reported" ? "↑ " : "= ";
    const text = arrow + enumLabel("transition", tr.direction).toLowerCase();
    const cls = tr.direction === "less_help_reported" ? "chip chip-good" : tr.direction === "more_help_reported" ? "chip chip-warn" : "chip chip-same";
    ul.append(el("li", { class: cls, text: t("pn.js.transition", { from: tr.from, to: tr.to, text }) }));
  }
}

function renderSessions(chain, executions) {
  const ol = $("session-list");
  ol.replaceChildren();
  chain.forEach((c, i) => {
    const exec = executionLabel(executions[i] || "unreported");
    ol.append(
      el("li", { class: "session-row" }, [
        el("span", { class: "session-n", text: t("pn.js.session_n", { n: i + 1 }) }),
        el("span", { class: "chip", text: exec }),
        el("span", { class: `chip ${c.level === "none" ? "chip-good" : c.level === "full" ? "chip-warn" : "chip-same"}`, text: ASSISTANCE_LEVELS[c.level].label }),
      ])
    );
  });
  if (chain.length === 0) ol.append(el("li", { class: "elo-muted", text: t("pn.js.no_sessions") }));
}

function renderApproved(facts, approvedIds) {
  const ul = $("approved-list");
  ul.replaceChildren();
  const rows = facts.filter((f) => approvedIds.has(f.fact_id) && f.rendered?.text_ptbr);
  const preferred = rows.filter((f) => f.type === "F04" || f.type === "F03");
  for (const f of preferred) {
    const lim = (f.rendered.limitations_ptbr || []).map((txt) => el("li", { text: txt }));
    ul.append(
      el("li", { class: "approved-item", "data-fact-type": f.type }, [
        el("p", { text: f.rendered.text_ptbr, "data-clinical-text": "" }),
        el("ul", { "data-clinical-text": "" }, lim),
      ])
    );
  }
  if (preferred.length === 0) ul.append(el("li", { class: "elo-muted", text: t("pn.js.no_evidence") }));
}

function renderTimeline(items) {
  const ol = $("timeline-list");
  ol.replaceChildren();
  for (const it of items) {
    const when = formatDateTime(it.occurred_at);
    ol.append(
      el("li", {}, [
        el("span", { class: "when", text: when }),
        el("span", { text: enumLabel("timeline", it.kind) }),
      ])
    );
  }
}

function fillVerifySelect(chain, facts) {
  const sel = $("verify-session");
  sel.replaceChildren();
  chain.forEach((c, i) => {
    const fact = facts.find((f) => f.fact_id === c.factId);
    if (!fact) return;
    sel.append(el("option", { value: c.factId, text: t("pn.js.verify_option", { n: i + 1, level: ASSISTANCE_LEVELS[c.level].label.toLowerCase() }) }));
  });
  const has = sel.options.length > 0;
  $("btn-verify-true").disabled = !has;
  $("btn-verify-false").disabled = !has;
}

async function runVerify(kind) {
  const factId = $("verify-session").value;
  const idx = state.patient.chain.findIndex((c) => c.factId === factId);
  const fact = state.patient.facts.find((f) => f.fact_id === factId);
  if (!fact || idx < 0) return;
  const exaggerated = kind === "exaggerated";
  const realLevel = state.patient.chain[idx].level;
  const level = exaggerated ? exaggeratedLevel(realLevel) : null;
  const proposal = proposalFromFact(fact, level);
  const claim = exaggerated ? exaggeratedSentence(idx + 1, level) : fact.rendered.text_ptbr;
  const ticket = ctxStore.capture();
  const res = await rawFetch("POST", "/api/v3/facts/verify", proposal);
  if (!ticket.isCurrent()) return; // verification result of a previous patient must not be shown on the current one
  const out = $("verify-output");
  out.hidden = false;
  $("verify-claim").textContent = claim;
  if (exaggerated) $("verify-claim").removeAttribute("data-clinical-text");
  else $("verify-claim").setAttribute("data-clinical-text", "");
  const verdict = $("verify-verdict");
  verdict.replaceChildren();
  if (res.status === 200 && res.data?.valid) {
    verdict.dataset.verdict = "accepted";
    verdict.append(el("span", { text: t("pn.js.accepted") }), el("p", { text: t("pn.js.accepted_why") }));
    announce(tm("pn.js.accepted_ann"));
  } else if (res.status === 200) {
    verdict.dataset.verdict = "blocked";
    const code = res.data?.code || "REJECTED";
    verdict.append(
      el("span", {}, [document.createTextNode(t("pn.js.blocked") + " — "), el("span", { class: "code", title: t("err.tech_summary"), text: code })]),
      el("p", { text: describeVerifyFailure(code) })
    );
    announce(tm("pn.js.blocked_ann"), { politeness: "assertive" });
  } else {
    showError({ code: res.data?.error?.code || "HTTP_ERROR", status: res.status });
  }
}

function renderPatientView() {
  const pt = state.patient;
  if (!pt) return;
  $("patient-name").textContent = pt.alias;
  const originText = pt.origin ? enumLabel("origin", pt.origin) : "";
  $("patient-meta").textContent = t("pn.js.meta", { side: pt.side ? enumLabel("side", pt.side) : "—", origin: originText });
  $("patient-goal").textContent = pt.goal ? t("pn.js.goal", { text: pt.goal.goal_text }) : t("pn.js.no_goal");
  const p = pt.rx;
  $("patient-rx").textContent = p
    ? t("pn.js.rx", { sets: p.target_sets, reps: p.target_repetitions, per: p.sessions_per_week, mode: enumLabel("exec_mode", "report_only").toLowerCase() })
    : t("pn.js.no_rx");
  renderKpis(computeKpis(pt.facts, pt.chain));
  $("evolution-headline").textContent = headline(pt.chain);
  renderChart(pt.chain, pt.executions);
  renderTransitions(pt.chain);
  renderSessions(pt.chain, pt.executions);
  renderApproved(pt.facts, pt.approvedIds);
  fillVerifySelect(pt.chain, pt.facts);
  renderTimeline(pt.timeline);
}

/* ---------- data loading ---------- */

async function openPatient(participantId) {
  clearError();
  const id = String(participantId || "").trim();
  if (!/^p_[A-Za-z0-9-]{8,64}$/.test(id)) {
    showError({ code: "INVALID_ID", status: 0 });
    return;
  }
  $("participant-id").value = id;
  ctxStore.switchTo({ principalId: state.session?.principal?.id ?? null, role: "therapist", participantId: id });
  const op = ctxStore.begin("open");
  try {
    const c = state.client;
    const [ent, goals, rx, facts, series, timeline] = await Promise.all([
      rawFetch("GET", `/api/v3/entities/${encodeURIComponent(id)}/versions`, undefined, op.signal),
      c.listGoals(id, { signal: op.signal }),
      c.getCurrentPrescription(id, { signal: op.signal }).catch((e) => { if (e && e.code === "ABORTED") throw e; return { data: null }; }),
      c.listFacts(id, {}, { signal: op.signal }),
      c.getEvolutionSeries(id, {}, { signal: op.signal }),
      c.getTimeline(id, { signal: op.signal }),
    ]);
    if (!op.isCurrent()) return; // the last requested patient wins; a late response never repaints
    if (ent.status !== 200) throw { code: ent.data?.error?.code || "HTTP_ERROR", status: ent.status };
    const latest = ent.data[ent.data.length - 1];
    const alias = latest?.payload?.alias || t("pn.js.participant");
    const factList = facts.data?.facts || [];
    const chain = chainFromSeries(series.data);
    const executions = executionBySession(series.data, factList);
    const approvedIds = new Set((series.data?.series || []).flatMap((s) => (s.items || []).map((it) => it.fact_id)));

    const goal = (goals.data || [])[goals.data.length - 1]?.payload;
    state.patient = { id, alias, side: latest?.payload?.side || "", origin: latest?.data_origin || "", goal: goal || null, rx: rx.data?.payload || null, timeline: timeline.data?.items || [], facts: factList, chain, executions, approvedIds };
    renderPatientView();
    $("verify-output").hidden = true;
    $("paciente").hidden = false;
    setCaseNav(true);
    rememberPatient(id, alias);
    renderRecents();
    announce(tm("pn.js.loaded", { alias }));
  } catch (error) {
    op.fail(error, showError);
  } finally {
    op.done();
  }
}

async function onSignin(event) {
  event.preventDefault();
  clearError();
  try {
    const res = await state.client.loginTherapist($("signin-username").value.trim(), $("signin-password").value);
    state.session = { token: res.data.token, principal: res.data.principal, expires_at: res.data.expires_at };
    ctxStore.switchTo({ principalId: res.data.principal.id, role: "therapist", participantId: null });
    saveSession(state.session);
    $("signin-password").value = "";
    afterSignin();
  } catch (error) {
    showError(error);
  }
}

function afterSignin() {
  setSignedIn(true);
  renderRecents();
  announce(tm("pn.js.signed_in"));
  const param = new URLSearchParams(window.location.search).get("participant");
  if (param) openPatient(param);
}

function signOut() {
  ctxStore.reset("logout"); // logout is a context boundary
  state.session = null;
  state.patient = null;
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  $("paciente").hidden = true;
  setSignedIn(false);
  announce(tm("pn.js.signed_out"));
}

function init() {
  initI18n();
  document.addEventListener("elo:lang", () => {
    renderRecents();
    renderPatientView();
    if (state.patient && !$("verify-output").hidden) $("verify-output").hidden = true;
  });
  state.client = createV3Client({ getToken: () => state.session?.token || null });
  $("form-signin").addEventListener("submit", onSignin);
  $("form-open").addEventListener("submit", (e) => {
    e.preventDefault();
    openPatient($("participant-id").value);
  });
  $("btn-signout").addEventListener("click", signOut);
  $("btn-verify-true").addEventListener("click", () => runVerify("faithful"));
  $("btn-verify-false").addEventListener("click", () => runVerify("exaggerated"));
  const stored = readSession();
  if (stored?.token) {
    state.session = stored;
    afterSignin();
  } else {
    setSignedIn(false);
  }
}

init();
