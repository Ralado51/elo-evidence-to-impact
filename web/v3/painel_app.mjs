/**
 * Elo v3 — therapist dashboard controller ("painel").
 * Reads only /api/v3 (contract client for most calls, plain fetch for the two read/verify
 * routes the typed client does not wrap). Never writes clinical data and never derives a
 * clinical number: every figure on screen comes from an approved fact or the verifier.
 */

import { announce } from "./a11y.mjs";
import { createV3Client } from "./api_client.mjs";
import { TIMELINE_KIND_LABEL_PTBR, formatApiErrorMessage } from "./therapist_model.mjs";
import {
  ASSISTANCE_LEVELS,
  EXECUTION_LABEL_PTBR,
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
  $("error-banner-text").textContent = formatApiErrorMessage(error);
  banner.hidden = false;
  announce(`Erro: ${formatApiErrorMessage(error)}`, { politeness: "assertive" });
}

function clearError() {
  $("error-banner").hidden = true;
  $("error-banner-text").textContent = "";
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

async function rawFetch(method, path, body) {
  const res = await fetch(path, {
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
    const btn = el("button", { type: "button", class: "btn btn-secondary target", text: `${r.alias || "Paciente"} (${r.id})` });
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
    [String(kpis.sessions), "Sessões relatadas"],
    [`${kpis.completed} de ${kpis.executionTotal}`, "Atividades completas"],
    [level(kpis.firstLevel), "Ajuda na 1ª sessão"],
    [level(kpis.latestLevel), "Ajuda na última sessão"],
  ];
  for (const [value, label] of items) {
    ul.append(
      el("li", { class: "kpi" }, [el("span", { class: "kpi-value", text: value }), el("span", { class: "kpi-label", text: label })])
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
    host.append(el("p", { class: "elo-muted", text: "Nenhuma sessão aprovada ainda. Aprove os fatos para ver a evolução." }));
    $("evolution-chart-desc").textContent = "";
    return;
  }
  const g = chartGeometry(chain);
  const root = svg("svg", { viewBox: `0 0 ${g.width} ${g.height}`, "aria-hidden": "true", focusable: "false" });
  for (const lvl of ["full", "some", "none"]) {
    const y = g.yByLevel[lvl];
    root.append(svg("line", { class: "grid-line", x1: g.padLeft, x2: g.width - g.padRight, y1: y, y2: y }));
    const t = svg("text", { class: "axis-label", x: g.padLeft - 12, y: y + 5, "text-anchor": "end" });
    t.textContent = ASSISTANCE_LEVELS[lvl].label;
    root.append(t);
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
    tx.textContent = `Sessão ${p.index}`;
    root.append(tx);
    const ex = svg("text", { class: "tick-label", x: p.x, y: g.height - 10, "text-anchor": "middle" });
    ex.textContent = EXECUTION_LABEL_PTBR[executions[p.index - 1]] ? shorten(EXECUTION_LABEL_PTBR[executions[p.index - 1]]) : "";
    root.append(ex);
  }
  host.append(root);
  const levelsText = chain
    .map((c, i) => `sessão ${i + 1}: ${ASSISTANCE_LEVELS[c.level].label.toLowerCase()}`)
    .join("; ");
  $("evolution-chart-desc").textContent = `Gráfico da ajuda relatada por sessão (${levelsText}). Quanto mais baixo, menos ajuda foi relatada.`;
  host.setAttribute("aria-label", $("evolution-chart-desc").textContent);
}

function shorten(label) {
  return label === "Atividade completa" ? "Completa" : label === "Parte da atividade" ? "Parcial" : label === "Não realizou" ? "Não fez" : "—";
}

function renderTransitions(chain) {
  const ul = $("transition-list");
  ul.replaceChildren();
  for (const t of transitionsFromChain(chain)) {
    const text =
      t.direction === "less_help_reported"
        ? "↓ menos ajuda relatada"
        : t.direction === "more_help_reported"
          ? "↑ mais ajuda relatada"
          : "= sem mudança";
    const cls = t.direction === "less_help_reported" ? "chip chip-good" : t.direction === "more_help_reported" ? "chip chip-warn" : "chip chip-same";
    ul.append(el("li", { class: cls, text: `Sessão ${t.from} → ${t.to}: ${text}` }));
  }
}

function renderSessions(chain, executions) {
  const ol = $("session-list");
  ol.replaceChildren();
  chain.forEach((c, i) => {
    const exec = EXECUTION_LABEL_PTBR[executions[i]] || "Não informado";
    ol.append(
      el("li", { class: "session-row" }, [
        el("span", { class: "session-n", text: `Sessão ${i + 1}` }),
        el("span", { class: "chip", text: exec }),
        el("span", { class: `chip ${c.level === "none" ? "chip-good" : c.level === "full" ? "chip-warn" : "chip-same"}`, text: ASSISTANCE_LEVELS[c.level].label }),
      ])
    );
  });
  if (chain.length === 0) ol.append(el("li", { class: "elo-muted", text: "Nenhuma sessão aprovada ainda." }));
}

function renderApproved(facts, approvedIds) {
  const ul = $("approved-list");
  ul.replaceChildren();
  const rows = facts.filter((f) => approvedIds.has(f.fact_id) && f.rendered?.text_ptbr);
  const preferred = rows.filter((f) => f.type === "F04" || f.type === "F03");
  for (const f of preferred) {
    const lim = (f.rendered.limitations_ptbr || []).map((t) => el("li", { text: t }));
    ul.append(
      el("li", { class: "approved-item", "data-fact-type": f.type }, [
        el("p", { text: f.rendered.text_ptbr }),
        el("ul", {}, lim),
      ])
    );
  }
  if (preferred.length === 0) ul.append(el("li", { class: "elo-muted", text: "Nenhum fato aprovado ainda." }));
}

function renderTimeline(items) {
  const ol = $("timeline-list");
  ol.replaceChildren();
  for (const it of items) {
    const when = new Date(it.occurred_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    ol.append(
      el("li", {}, [
        el("span", { class: "when", text: `${when} ${it.origin_label || ""}` }),
        el("span", { text: TIMELINE_KIND_LABEL_PTBR[it.kind] || it.kind }),
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
    sel.append(el("option", { value: c.factId, text: `Sessão ${i + 1} — ajuda relatada: ${ASSISTANCE_LEVELS[c.level].label.toLowerCase()}` }));
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
  const res = await rawFetch("POST", "/api/v3/facts/verify", proposal);
  const out = $("verify-output");
  out.hidden = false;
  $("verify-claim").textContent = claim;
  const verdict = $("verify-verdict");
  verdict.replaceChildren();
  if (res.status === 200 && res.data?.valid) {
    verdict.dataset.verdict = "accepted";
    verdict.append(el("span", { text: "✔ Aceita pelo verificador" }), el("p", { text: "O valor bate com as evidências registradas e o texto aprovado é o que o catálogo gera." }));
    announce("Afirmação aceita pelo verificador.");
  } else if (res.status === 200) {
    verdict.dataset.verdict = "blocked";
    const code = res.data?.code || "REJEITADA";
    verdict.append(
      el("span", {}, [document.createTextNode("✖ Bloqueada pelo verificador — "), el("span", { class: "code", text: code })]),
      el("p", { text: describeVerifyFailure(code) })
    );
    announce(`Afirmação bloqueada pelo verificador: ${code}.`, { politeness: "assertive" });
  } else {
    showError({ code: res.data?.error?.code || "HTTP_ERROR", status: res.status, message: "Não foi possível consultar o verificador." });
  }
}

/* ---------- data loading ---------- */

async function openPatient(participantId) {
  clearError();
  const id = String(participantId || "").trim();
  if (!/^p_[A-Za-z0-9-]{8,64}$/.test(id)) {
    showError({ code: "INVALID_ID", status: 0, message: "Informe um identificador no formato p_..." });
    return;
  }
  $("participant-id").value = id;
  try {
    const c = state.client;
    const [ent, goals, rx, facts, series, timeline] = await Promise.all([
      rawFetch("GET", `/api/v3/entities/${encodeURIComponent(id)}/versions`),
      c.listGoals(id),
      c.getCurrentPrescription(id).catch(() => ({ data: null })),
      c.listFacts(id),
      c.getEvolutionSeries(id),
      c.getTimeline(id),
    ]);
    if (ent.status !== 200) throw { code: ent.data?.error?.code || "HTTP_ERROR", status: ent.status, message: "Paciente não encontrado." };
    const latest = ent.data[ent.data.length - 1];
    const alias = latest?.payload?.alias || "Paciente";
    const side = latest?.payload?.side === "left" ? "esquerdo" : latest?.payload?.side === "right" ? "direito" : "";
    const factList = facts.data?.facts || [];
    const chain = chainFromSeries(series.data);
    const executions = executionBySession(series.data, factList);
    const approvedIds = new Set((series.data?.series || []).flatMap((s) => (s.items || []).map((it) => it.fact_id)));
    state.patient = { id, facts: factList, chain, executions };

    $("patient-name").textContent = alias;
    $("patient-meta").textContent = `${id} • lado acompanhado: ${side || "—"} • ${latest?.data_origin === "synthetic_fixture" ? "[Dados sintéticos]" : latest?.data_origin || ""}`;
    const goal = (goals.data || [])[goals.data.length - 1]?.payload;
    $("patient-goal").textContent = goal ? `Meta: ${goal.goal_text}` : "Nenhuma meta registrada.";
    const p = rx.data?.payload;
    $("patient-rx").textContent = p
      ? `Prescrição: ${p.target_sets} séries de ${p.target_repetitions} repetições, ${p.sessions_per_week} sessões por semana (modo apenas relato).`
      : "Nenhuma prescrição publicada.";
    renderKpis(computeKpis(factList, chain));
    $("evolution-headline").textContent = headline(chain);
    renderChart(chain, executions);
    renderTransitions(chain);
    renderSessions(chain, executions);
    renderApproved(factList, approvedIds);
    fillVerifySelect(chain, factList);
    renderTimeline(timeline.data?.items || []);
    $("verify-output").hidden = true;
    $("paciente").hidden = false;
    setCaseNav(true);
    rememberPatient(id, alias);
    renderRecents();
    announce(`Paciente ${alias} carregado.`);
  } catch (error) {
    showError(error);
  }
}

async function onSignin(event) {
  event.preventDefault();
  clearError();
  try {
    const res = await state.client.loginTherapist($("signin-username").value.trim(), $("signin-password").value);
    state.session = { token: res.data.token, principal: res.data.principal, expires_at: res.data.expires_at };
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
  announce("Sessão iniciada.");
  const param = new URLSearchParams(window.location.search).get("participant");
  if (param) openPatient(param);
}

function signOut() {
  state.session = null;
  state.patient = null;
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  $("paciente").hidden = true;
  setSignedIn(false);
  announce("Sessão encerrada.");
}

function init() {
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
