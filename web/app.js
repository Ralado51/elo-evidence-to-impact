"use strict";
// Elo Evidence-to-Impact — static app. No framework; every string from the server is set as text, never as HTML.
const API = "/api";
const S = { lang: "pt", meta: null, cases: [], caseId: null, tab: "notes", actor: "", token: "" };
try { S.token = sessionStorage.getItem("elo_token") || ""; S.actor = sessionStorage.getItem("elo_actor") || ""; } catch (e) {}

const T = {
  pt: {
    case: "Caso", newCase: "Novo caso", loadDemo: "Carregar caso de demonstração", noCase: "Crie um caso ou carregue a demonstração para começar.",
    tabs: { notes: "Evoluções", review: "Revisão", goals: "Metas", map: "Mapa de evidências", attendance: "Presença", summary: "Resumo e devolutiva" },
    caseId: "Código (sem espaços)", caseLabel: "Rótulo (use pseudônimo)", save: "Salvar", cancel: "Cancelar", send: "Enviar", reason: "Motivo",
    people: "Pessoas registradas (ficam só neste servidor)", peopleHelp: "O nome real é trocado pelo pseudônimo antes de qualquer texto sair para o modelo. Texto com dado pessoal não registrado é bloqueado.",
    fullName: "Nome completo", pseudo: "Pseudônimo", aliases: "Apelidos (vírgula)", role: "Papel", roles: { patient: "criança", caregiver: "responsável", professional: "profissional", other: "outro" },
    register: "Registrar", noPeople: "Ninguém registrado ainda.",
    noteTitle: "Nova evolução", noteDate: "Data da sessão", observer: "Quem observou", defEnv: "Ambiente padrão", none: "—", text: "Texto da evolução",
    extract: "Extrair evidências", extracting: "Extraindo… (o modelo pode levar cerca de 15 a 30 s)", mode: "Modo usado", found: "Evidências encontradas", rejected: "Não virou evidência",
    forReview: "Só um dos extratores viu — vai para a revisão humana", quote: "Trecho", activity: "Atividade", setting: "Ambiente", assist: "Ajuda", source: "Fonte", date: "Data",
    blocked: "Bloqueado pela proteção de privacidade. Tipos encontrados:", blockedHint: "Registre a pessoa (pseudônimo) ou remova o dado e envie de novo.",
    reviewer: "Seu nome (revisora)", genClaims: "Gerar afirmações a partir das evidências", approve: "Aprovar", edit: "Editar", reject: "Rejeitar",
    needName: "Informe seu nome para revisar.", why: "Por quê", noClaims: "Nenhuma afirmação ainda. Envie evoluções e gere as afirmações.",
    approveOnly: "Só afirmações “sustentadas” podem ser aprovadas. As outras precisam ser editadas até o que a evidência mostra, ou rejeitadas.",
    audit: "Histórico", state: "Estado",
    goalTitle: "Metas do caso", addGoal: "Adicionar meta", measure: "Como saberemos (palavras da terapeuta)", baseline: "Linha de base", start: "Início", review: "Reavaliação",
    check: "Checagem automática (não avalia evolução)", gasTitle: "Pontuação GAS — registrada pela terapeuta", gas: "Pontuação (−2 a +2)", comment: "Comentário", record: "Registrar", noGoals: "Nenhuma meta.",
    gasDone: "Pontuação registrada e auditada.",
    mapTitle: "Onde há observação direta, só relato, ou nada", mapHelp: "Verde: observação direta. Âmbar: só relato. Cinza: sem registro.",
    direct: "direta", report_only: "só relato", noneS: "sem registro", last: "última direta",
    attTitle: "Presença e adesão", attDay: "Dia", attStatus: "Situação", st: { attended: "compareceu", absent: "faltou", absent_justified: "falta justificada", not_held: "não realizada pelo serviço" },
    adhesion: "Adesão", of: "de", sessions: "sessões oferecidas",
    sumTitle: "Resumo para a família (só afirmações aprovadas)", download: "Baixar devolutiva (.docx)", docxHelp: "O rascunho traz evidências e lacunas. Conclusão, pontuação e condutas ficam em branco para a terapeuta.",
    v: { supported: "sustentada", contradicted: "contradita", insufficient_evidence: "evidência insuficiente", needs_review: "precisa de revisão" },
    rs: { pending: "pendente", approved: "aprovada", edited: "aprovada com edição", rejected: "rejeitada" },
    src: { direct_observation: "observação direta", caregiver_report: "relato do responsável", professional_report: "relato de profissional" },
    env: { clinic: "clínica", home: "casa", school: "escola", other: "outro" },
    asst: { independent: "sozinho", verbal_prompt: "instruções verbais", gesture_prompt: "dicas gestuais", physical_partial: "ajuda física parcial", physical_total: "ajuda física total" },
    token: "Código de acesso", error: "Erro", ok: "Feito.", demoLoaded: "Caso de demonstração carregado.", asOf: "Posição em", claimText: "Texto", editClaim: "Editar afirmação",
    loading: "Carregando…", sanitizedShown: "Texto que o modelo recebeu",
  },
  en: {
    case: "Case", newCase: "New case", loadDemo: "Load demo case", noCase: "Create a case or load the demo to start.",
    tabs: { notes: "Session notes", review: "Review", goals: "Goals", map: "Evidence map", attendance: "Attendance", summary: "Summary & report" },
    caseId: "Code (no spaces)", caseLabel: "Label (use a pseudonym)", save: "Save", cancel: "Cancel", send: "Send", reason: "Reason",
    people: "Registered people (kept on this server only)", peopleHelp: "Real names are replaced by the pseudonym before any text leaves for the model. Text with unregistered personal data is blocked.",
    fullName: "Full name", pseudo: "Pseudonym", aliases: "Nicknames (comma)", role: "Role", roles: { patient: "child", caregiver: "caregiver", professional: "professional", other: "other" },
    register: "Register", noPeople: "Nobody registered yet.",
    noteTitle: "New session note", noteDate: "Session date", observer: "Observed by", defEnv: "Default setting", none: "—", text: "Note text",
    extract: "Extract evidence", extracting: "Extracting… (the model may take about 15–30 s)", mode: "Mode used", found: "Evidence found", rejected: "Not turned into evidence",
    forReview: "Only one extractor saw this — goes to human review", quote: "Excerpt", activity: "Activity", setting: "Setting", assist: "Assistance", source: "Source", date: "Date",
    blocked: "Blocked by the privacy gate. Kinds found:", blockedHint: "Register the person (pseudonym) or remove the data, then send again.",
    reviewer: "Your name (reviewer)", genClaims: "Generate claims from the evidence", approve: "Approve", edit: "Edit", reject: "Reject",
    needName: "Enter your name to review.", why: "Why", noClaims: "No claims yet. Send notes and generate claims.",
    approveOnly: "Only “supported” claims can be approved. Others must be edited to what the evidence shows, or rejected.",
    audit: "History", state: "State",
    goalTitle: "Case goals", addGoal: "Add goal", measure: "How we will know (therapist's words)", baseline: "Baseline", start: "Start", review: "Reassessment",
    check: "Automatic check (does not rate progress)", gasTitle: "GAS rating — recorded by the therapist", gas: "Rating (−2 to +2)", comment: "Comment", record: "Record", noGoals: "No goals.",
    gasDone: "Rating recorded and audited.",
    mapTitle: "Where there is direct observation, only a report, or nothing", mapHelp: "Green: direct observation. Amber: report only. Grey: no record.",
    direct: "direct", report_only: "report only", noneS: "no record", last: "last direct",
    attTitle: "Attendance and adherence", attDay: "Day", attStatus: "Status", st: { attended: "attended", absent: "absent", absent_justified: "excused absence", not_held: "not held by the service" },
    adhesion: "Adherence", of: "of", sessions: "sessions offered",
    sumTitle: "Family summary (approved claims only)", download: "Download report (.docx)", docxHelp: "The draft carries evidence and gaps. Conclusion, rating and conduct are left blank for the therapist.",
    v: { supported: "supported", contradicted: "contradicted", insufficient_evidence: "insufficient evidence", needs_review: "needs review" },
    rs: { pending: "pending", approved: "approved", edited: "approved with edit", rejected: "rejected" },
    src: { direct_observation: "direct observation", caregiver_report: "caregiver report", professional_report: "professional report" },
    env: { clinic: "clinic", home: "home", school: "school", other: "other" },
    asst: { independent: "independent", verbal_prompt: "verbal prompt", gesture_prompt: "gesture prompt", physical_partial: "partial physical help", physical_total: "total physical help" },
    token: "Access code", error: "Error", ok: "Done.", demoLoaded: "Demo case loaded.", asOf: "As of", claimText: "Text", editClaim: "Edit claim",
    loading: "Loading…", sanitizedShown: "Text the model received",
  },
};
const t = () => T[S.lang];
const loc = () => (S.lang === "pt" ? "pt-BR" : "en");

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const $ = (id) => document.getElementById(id);
function toast(msg) { const el = $("toast"); el.textContent = msg; el.classList.add("on"); setTimeout(() => el.classList.remove("on"), 2600); }

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (S.token) headers["x-access-token"] = S.token;
  const res = await fetch(API + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) { await askToken(); return api(path, opts); }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error((data && (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail))) || res.statusText); err.status = res.status; err.data = data; throw err; }
  return data;
}
function askToken() {
  return new Promise((resolve) => {
    const f = $("dlgForm"); f.replaceChildren();
    const inp = h("input", { type: "password", autocomplete: "off", "aria-label": t().token });
    f.append(h("label", { class: "field" }, t().token, inp), h("button", { value: "ok" }, "OK"));
    $("dlg").addEventListener("close", () => { S.token = inp.value; try { sessionStorage.setItem("elo_token", S.token); } catch (e) {} resolve(); }, { once: true });
    $("dlg").showModal();
  });
}
function dialog(title, fields, onOk) {
  const f = $("dlgForm"); f.replaceChildren(h("h3", {}, title));
  const inputs = {};
  for (const fd of fields) {
    const input = fd.options ? h("select", {}, fd.options.map(([v, l]) => h("option", { value: v, selected: v === fd.value }, l))) : h(fd.area ? "textarea" : "input", { value: fd.value || "", type: fd.type || "text" });
    if (fd.area) input.value = fd.value || "";
    inputs[fd.key] = input;
    f.append(h("label", { class: "field" }, fd.label, input));
  }
  const err = h("div", { class: "err", hidden: true });
  f.append(err, h("div", { class: "row" },
    h("button", { type: "button", onclick: async () => { try { await onOk(Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]))); $("dlg").close(); } catch (e) { err.hidden = false; err.textContent = e.message; } } }, t().save),
    h("button", { type: "button", class: "ghost", onclick: () => $("dlg").close() }, t().cancel)));
  $("dlg").showModal();
}

const pill = (cls, text) => h("span", { class: "pill p-" + cls }, text);
const actLabel = (a) => (S.meta.activities[a] ? S.meta.activities[a].label[S.lang] : a);
const opt = (obj) => Object.entries(obj);

// ---------------------------------------------------------------- views
const views = {
  async notes(root) {
    const people = await api("/patients");
    root.append(h("h2", {}, t().people), h("p", { class: "muted" }, t().peopleHelp));
    const fn = h("input", { "aria-label": t().fullName, placeholder: t().fullName }), ps = h("input", { "aria-label": t().pseudo, placeholder: "Paciente A" }),
      al = h("input", { "aria-label": t().aliases, placeholder: t().aliases }), role = h("select", { "aria-label": t().role }, opt(t().roles).map(([v, l]) => h("option", { value: v }, l)));
    const perr = h("div", { class: "err", hidden: true });
    root.append(h("div", { class: "card" }, h("div", { class: "row" }, fn, ps, al, role,
      h("button", { class: "ghost", onclick: async () => {
        try { await api("/patients", { method: "POST", body: { role: role.value, full_name: fn.value, pseudonym: ps.value, aliases: al.value.split(",").map((x) => x.trim()).filter(Boolean) } }); render(); }
        catch (e) { perr.hidden = false; perr.textContent = e.message; } } }, t().register)), perr,
      h("p", { class: "muted" }, people.length ? people.map((p) => `${p.pseudonym} (${t().roles[p.role] || p.role})`).join(" · ") : t().noPeople)));

    root.append(h("h2", {}, t().noteTitle));
    const d = h("input", { type: "date", value: new Date().toISOString().slice(0, 10) }), by = h("input", { value: S.actor || "", placeholder: t().observer }),
      env = h("select", {}, h("option", { value: "" }, t().none), S.meta.environments.map((e) => h("option", { value: e }, t().env[e]))),
      ta = h("textarea", { "aria-label": t().text, maxlength: 4000 }), out = h("div");
    const btn = h("button", { class: "y", onclick: async () => {
      btn.disabled = true; out.replaceChildren(h("p", { class: "muted" }, t().extracting));
      try {
        const r = await api(`/cases/${S.caseId}/notes`, { method: "POST", body: { text: ta.value, session_date: d.value, observed_by: by.value || "therapist", default_environment: env.value || null } });
        showExtraction(out, r);
      } catch (e) {
        out.replaceChildren(h("div", { class: "err" }, e.status === 422 && e.data && e.data.kinds ? [t().blocked + " " + e.data.kinds.join(", "), h("br"), t().blockedHint] : `${t().error}: ${e.message}`));
      } finally { btn.disabled = false; }
    } }, t().extract);
    root.append(h("div", { class: "card" }, h("div", { class: "row" }, h("label", { class: "field" }, t().noteDate, d), h("label", { class: "field" }, t().observer, by), h("label", { class: "field" }, t().defEnv, env)), ta, h("p", {}, btn)), out);
  },

  async review(root) {
    const actor = h("input", { value: S.actor, placeholder: t().reviewer, "aria-label": t().reviewer, oninput: (e) => { S.actor = e.target.value; try { sessionStorage.setItem("elo_actor", S.actor); } catch (x) {} } });
    root.append(h("div", { class: "row" }, h("label", { class: "field" }, t().reviewer, actor),
      h("button", { class: "ghost", onclick: async () => { await api(`/cases/${S.caseId}/claims/from-observations`, { method: "POST" }); render(); } }, t().genClaims)),
      h("p", { class: "muted" }, t().approveOnly));
    const claims = await api(`/cases/${S.caseId}/claims`);
    if (!claims.length) root.append(h("p", {}, t().noClaims));
    const need = () => { if (!S.actor.trim()) { toast(t().needName); actor.focus(); return false; } return true; };
    const act = (fn) => async () => { if (!need()) return; try { await fn(); render(); } catch (e) { toast(e.message); } };
    for (const { claim, verdict } of claims) {
      const pending = claim.review_state === "pending";
      const why = (verdict.rationale && (verdict.rationale[S.lang] || verdict.rationale[loc()] || Object.values(verdict.rationale)[0])) || "";
      root.append(h("div", { class: "card" },
        h("div", { class: "row" }, pill(verdict.verdict, t().v[verdict.verdict]), pill(claim.review_state, t().rs[claim.review_state]),
          h("span", { class: "muted" }, `${actLabel(claim.activity)} · ${t().env[claim.environment]} · ${t().asst[claim.assistance]}${claim.as_of ? " · " + claim.as_of : ""}`)),
        h("p", {}, h("q", {}, claim.text)), h("p", { class: "muted" }, `${t().why}: ${why}`),
        pending ? h("div", { class: "row" },
          h("button", { disabled: verdict.verdict !== "supported", onclick: act(() => api(`/claims/${claim.id}/approve`, { method: "POST", body: { actor: S.actor } })) }, t().approve),
          h("button", { class: "ghost", onclick: () => need() && dialog(t().editClaim, [
            { key: "activity", label: t().activity, options: Object.keys(S.meta.activities).map((a) => [a, actLabel(a)]), value: claim.activity },
            { key: "environment", label: t().setting, options: S.meta.environments.map((e) => [e, t().env[e]]), value: claim.environment },
            { key: "assistance", label: t().assist, options: S.meta.assistance_levels.map((a) => [a, t().asst[a]]), value: claim.assistance },
            { key: "text", label: t().claimText, value: claim.text, area: true }, { key: "reason", label: t().reason }],
            async (v) => { await api(`/claims/${claim.id}/edit`, { method: "POST", body: { actor: S.actor, ...v, reason: v.reason || null } }); render(); }) }, t().edit),
          h("button", { class: "bad", onclick: () => need() && dialog(t().reject, [{ key: "reason", label: t().reason, area: true }],
            async (v) => { await api(`/claims/${claim.id}/reject`, { method: "POST", body: { actor: S.actor, reason: v.reason } }); render(); }) }, t().reject)) : null));
    }
  },

  async goals(root) {
    const goals = await api(`/cases/${S.caseId}/goals`);
    root.append(h("h2", {}, t().goalTitle));
    if (!goals.length) root.append(h("p", {}, t().noGoals));
    for (const g of goals) {
      const c = await api(`/goals/${g.id}/check?locale=${loc()}`);
      const gas = h("select", { "aria-label": t().gas }, [-2, -1, 0, 1, 2].map((n) => h("option", { value: n, selected: n === 0 }, (n > 0 ? "+" : "") + n))), cm = h("input", { placeholder: t().comment, "aria-label": t().comment });
      const msg = h("div");
      root.append(h("div", { class: "card" },
        h("div", { class: "row" }, h("b", {}, `${actLabel(g.activity)} · ${t().env[g.environment]} · ${t().asst[g.assistance]}`), pill(c.check.verdict, t().v[c.check.verdict])),
        h("p", { class: "muted" }, g.measure), h("h3", {}, t().check), h("pre", { class: "txt" }, c.text),
        h("div", { class: "row" }, h("label", { class: "field" }, t().gasTitle, gas), h("label", { class: "field" }, t().comment, cm),
          h("button", { class: "ghost", onclick: async () => {
            if (!S.actor.trim()) { toast(t().needName); return; }
            try { await api(`/goals/${g.id}/assessment`, { method: "POST", body: { actor: S.actor, gas_rating: Number(gas.value), comment: cm.value, as_of: new Date().toISOString().slice(0, 10) } }); msg.replaceChildren(h("div", { class: "ok" }, t().gasDone)); }
            catch (e) { msg.replaceChildren(h("div", { class: "err" }, e.message)); } } }, t().record)), msg));
    }
    const a = h("select", {}, Object.keys(S.meta.activities).map((x) => h("option", { value: x }, actLabel(x)))), e = h("select", {}, S.meta.environments.map((x) => h("option", { value: x }, t().env[x]))),
      l = h("select", {}, S.meta.assistance_levels.map((x) => h("option", { value: x }, t().asst[x]))), m = h("input", { placeholder: t().measure, "aria-label": t().measure }),
      s = h("input", { type: "date", value: new Date().toISOString().slice(0, 10), "aria-label": t().start }), r = h("input", { type: "date", "aria-label": t().review });
    const er = h("div");
    root.append(h("h3", {}, t().addGoal), h("div", { class: "card" }, h("div", { class: "row" }, a, e, l, m, h("label", { class: "field" }, t().start, s), h("label", { class: "field" }, t().review, r),
      h("button", { onclick: async () => { try { await api(`/cases/${S.caseId}/goals`, { method: "POST", body: { activity: a.value, environment: e.value, assistance: l.value, measure: m.value, start_date: s.value, review_date: r.value } }); render(); } catch (x) { er.replaceChildren(h("div", { class: "err" }, x.message)); } } }, t().addGoal)), er));
  },

  async map(root) {
    const rows = await api(`/cases/${S.caseId}/gaps`);
    root.append(h("h2", {}, t().mapTitle), h("p", { class: "muted" }, t().mapHelp));
    const acts = [...new Set(rows.map((r) => r.activity))], envs = S.meta.environments.filter((e) => e !== "other");
    const by = Object.fromEntries(rows.map((r) => [r.activity + "|" + r.environment, r]));
    root.append(h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, t().activity), envs.map((e) => h("th", {}, t().env[e])))),
      h("tbody", {}, acts.map((a) => h("tr", {}, h("td", {}, actLabel(a)), envs.map((e) => {
        const r = by[a + "|" + e]; if (!r) return h("td");
        const label = r.status === "direct" ? `${t().direct} (${r.direct_count})` : r.status === "report_only" ? `${t().report_only} (${r.report_count})` : t().noneS;
        return h("td", { class: "cell cell-" + r.status }, label, r.last_direct ? h("div", { class: "muted" }, `${t().last}: ${r.last_direct}`) : null);
      })))))));
  },

  async attendance(root) {
    const data = await api(`/cases/${S.caseId}/attendance`), a = data.adherence;
    root.append(h("h2", {}, t().attTitle));
    const d = h("input", { type: "date", value: new Date().toISOString().slice(0, 10), "aria-label": t().attDay }), st = h("select", { "aria-label": t().attStatus }, opt(t().st).map(([v, l]) => h("option", { value: v }, l)));
    root.append(h("div", { class: "card" }, h("div", { class: "row" }, d, st, h("button", { onclick: async () => {
      if (!S.actor.trim()) { toast(t().needName); return; }
      try { await api(`/cases/${S.caseId}/attendance`, { method: "POST", body: { day: d.value, status: st.value, actor: S.actor } }); render(); } catch (e) { toast(e.message); } } }, t().save))));
    root.append(h("div", { class: "card" }, a.rate == null ? "—" : h("b", {}, `${t().adhesion}: ${a.attended} ${t().of} ${a.offered} ${t().sessions} (${Math.round(a.rate * 100)}%)`), h("p", { class: "muted" }, a.rule)));
    root.append(h("div", { class: "scroll" }, h("table", {}, h("tbody", {}, data.records.map((r) => h("tr", {}, h("td", {}, r.day), h("td", {}, t().st[r.status] || r.status)))))));
  },

  async summary(root) {
    const s = await api(`/cases/${S.caseId}/summary?locale=${loc()}`);
    root.append(h("h2", {}, t().sumTitle), h("pre", { class: "txt" }, s.text));
    const dl = h("button", { class: "y", onclick: async () => {
      const res = await fetch(`${API}/cases/${S.caseId}/devolutiva.docx?locale=${loc()}`, { headers: S.token ? { "x-access-token": S.token } : {} });
      if (!res.ok) { toast(t().error); return; }
      const url = URL.createObjectURL(await res.blob()); const a = h("a", { href: url, download: `devolutiva-${S.caseId}-${S.lang}.docx` }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } }, t().download);
    root.append(h("p", {}, dl), h("p", { class: "muted" }, t().docxHelp));
  },
};

function showExtraction(out, r) {
  const rows = r.observations.map((o) => h("tr", {}, h("td", {}, o.observed_on), h("td", {}, actLabel(o.activity)), h("td", {}, t().env[o.environment]), h("td", {}, t().asst[o.assistance]),
    h("td", {}, pill(o.source_type === "direct_observation" ? "direct" : "report_only", t().src[o.source_type])), h("td", {}, h("q", {}, o.quote))));
  out.replaceChildren(h("div", { class: "card" }, h("p", { class: "muted" }, `${t().mode}: ${r.mode_used}`), h("h3", {}, `${t().found} (${r.observations.length})`),
    rows.length ? h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, [t().date, t().activity, t().setting, t().assist, t().source, t().quote].map((x) => h("th", {}, x)))), h("tbody", {}, rows))) : null,
    r.rejected.length ? [h("h3", {}, t().rejected), h("ul", {}, r.rejected.map((x) => h("li", {}, `${x.reason}${x.quote ? ": " : ""}`, x.quote ? h("q", {}, x.quote) : null)))] : null,
    r.review.length ? [h("h3", {}, t().forReview), h("ul", {}, r.review.map((x) => h("li", {}, `${x.kind}: `, h("q", {}, x.quote))))] : null,
    h("details", {}, h("summary", { class: "muted" }, t().sanitizedShown), h("pre", { class: "txt" }, r.sanitized_text))));
}

// ---------------------------------------------------------------- shell
async function render() {
  const view = $("view"); view.replaceChildren();
  $("banner").textContent = S.meta.notice[loc()] || S.meta.notice["pt-BR"];
  document.documentElement.lang = loc();
  for (const el of document.querySelectorAll("[data-i]")) el.textContent = t()[el.dataset.i];
  const tabs = $("tabs"); tabs.replaceChildren(...Object.entries(t().tabs).map(([k, label]) => h("button", { role: "tab", "aria-selected": String(S.tab === k), onclick: () => { S.tab = k; render(); } }, label)));
  const sel = $("caseSel"); sel.replaceChildren(...S.cases.map((c) => h("option", { value: c.id, selected: c.id === S.caseId }, c.label)));
  document.querySelectorAll(".lang button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === S.lang)));
  if (!S.caseId) { view.append(h("p", {}, t().noCase)); return; }
  view.append(h("p", { class: "muted" }, t().loading));
  const root = h("div");
  try { await views[S.tab](root); view.replaceChildren(root); } catch (e) { view.replaceChildren(h("div", { class: "err" }, `${t().error}: ${e.message}`)); }
}
async function loadCases(select) {
  S.cases = await api("/cases");
  if (select) S.caseId = select; else if (!S.cases.find((c) => c.id === S.caseId)) S.caseId = S.cases.length ? S.cases[0].id : null;
}
async function init() {
  S.meta = await api("/meta");
  try { const sv = localStorage.getItem("elo_lang"); if (sv === "en" || sv === "pt") S.lang = sv; else if ((navigator.language || "").toLowerCase().startsWith("en")) S.lang = "en"; } catch (e) {}
  await loadCases();
  $("caseSel").addEventListener("change", (e) => { S.caseId = e.target.value; render(); });
  document.querySelectorAll(".lang button").forEach((b) => b.addEventListener("click", () => { S.lang = b.dataset.lang; try { localStorage.setItem("elo_lang", S.lang); } catch (e) {} render(); }));
  $("newCase").addEventListener("click", () => dialog(t().newCase, [{ key: "id", label: t().caseId }, { key: "label", label: t().caseLabel }],
    async (v) => { await api("/cases", { method: "POST", body: v }); await loadCases(v.id); render(); }));
  $("demoBtn").addEventListener("click", async () => {
    $("demoBtn").disabled = true;
    try { await api("/demo/seed", { method: "POST" }); await loadCases("demo"); S.tab = "review"; toast(t().demoLoaded); } catch (e) { toast(e.message); await loadCases("demo"); }
    $("demoBtn").disabled = false; render();
  });
  render();
}
init().catch((e) => { $("view").textContent = "Error: " + e.message; });
