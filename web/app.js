"use strict";
// Elo Evidence-to-Impact — static app. No framework; every string from the server is set as text, never as HTML.
const API = "/api";
const S = { lang: "pt", meta: null, cases: [], caseId: null, tab: "notes", actor: "", token: "", hand: null,
  home: { reps: 10, session: "mon", events: [], reports: [], extra: [], result: null, n: 0 } };
try { S.token = sessionStorage.getItem("elo_token") || ""; S.actor = sessionStorage.getItem("elo_actor") || ""; } catch (e) {}

const T = {
  pt: {
    case: "Caso", newCase: "Novo caso", loadDemo: "Carregar caso de demonstração", noCase: "Crie um caso ou carregue a demonstração para começar.",
    tabs: { notes: "Evoluções", review: "Revisão", goals: "Metas", map: "Mapa de evidências", attendance: "Presença", summary: "Resumo e devolutiva", home: "Em casa" },
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
    homeTitle: "Exercício em casa: entre as sessões", homeHelp: "A câmera é lida neste aparelho. Nada de imagem é gravado nem enviado; só o número de repetições. Dados sintéticos: não use dados de paciente real.",
    homePlan: "Plano prescrito (exemplo)", homeReps: "Repetições por sessão", homeSession: "Sessão", sessNames: { mon: "segunda", wed: "quarta", fri: "sexta" },
    h: { canvasLabel: "Esqueleto da mão (sem imagem da câmera)", hint: "Toque em Iniciar. Deixe a mão visível, com boa luz e o celular apoiado.", start: "Iniciar câmera", stop: "Parar", calibrate: "Calibrar (10 s)", reset: "Zerar",
      repsLabel: "repetições", loading: "Carregando o modelo de mãos (uma vez)…", opening: "Abrindo a câmera…", stopped: "Câmera desligada.", failed: "Não foi possível iniciar: ", calFail: "Calibração sem movimento suficiente. Abra e feche a mão bem devagar.",
      openness: "abertura", state: "estado", ignored: "ciclos ignorados", calibrating: "CALIBRANDO: abra e feche a mão devagar", states: { waiting: "aguardando mão aberta", open: "aberta", closed: "fechada" } },
    homeSave: "Salvar contagem desta sessão", homeTyped: "ou digite uma contagem sintética (demonstração, sem câmera)", homeSavedMsg: "Contagem salva (sem imagem):", homeNothing: "Nada contado ainda.",
    homeReport: "Relato do paciente (um toque)", ans: { done: "Fiz", hard: "Fiz, foi difícil", not_finished: "Não terminei" }, homeReportSaved: "Relato salvo.",
    homeWeek: "Semana", observed: "observada", notObserved: "não observada", target: "meta", conflict: "sensor e relato divergem", atypical: "atípicas", noReport: "sem relato",
    homeCheck: "Verificar as afirmações do rascunho", homeTry: "Testar uma afirmação que o verificador deve barrar", homeAdd: "Adicionar",
    tries: { independent: "“Fez sozinho” só com o sensor", not_done: "“Não fez a sessão” sem dado", progress: "“Houve evolução funcional”", wrong_count: "Contagem de repetições errada" },
    homeDraftNote: "Rascunho montado por regras (o rascunho do modelo local vem depois). O verificador é código e não usa modelo.", homeDeliverable: "pode ir para a terapeuta", homeBlocked: "bloqueada",
    homeReportTitle: "O que a terapeuta lê", homeReportNote: "Os fatos vêm direto dos dados e nunca são omitidos; as afirmações verificadas entram depois, sem repetição. Nenhuma frase é do modelo.", homeClaimsTitle: "Verificação das afirmações do rascunho",
    homeNoEvents: "Salve ao menos uma sessão antes de verificar.", homeReason: "Motivo",
    claimReps: "Sessão {s}: {n} repetições contadas pelo sensor.", claimSessions: "{n} de {m} sessões observadas pelo sensor.", claimReport: "Sessão {s}: o paciente relata que fez o exercício (relato, não observação).",
    claimConflict: "Sessão {s}: sensor e relato do paciente divergem.", claimIndep: "O paciente fez o exercício sozinho em casa.", claimNotDone: "O paciente não fez a sessão {s}.", claimProgress: "Houve evolução funcional.", claimWrong: "Sessão {s}: {n} repetições contadas pelo sensor.",
  },
  en: {
    case: "Case", newCase: "New case", loadDemo: "Load demo case", noCase: "Create a case or load the demo to start.",
    tabs: { notes: "Session notes", review: "Review", goals: "Goals", map: "Evidence map", attendance: "Attendance", summary: "Summary & report", home: "At home" },
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
    homeTitle: "Home exercise: between sessions", homeHelp: "The camera is read on this device. No image is recorded or sent; only the repetition count. Synthetic data: do not use real patient data.",
    homePlan: "Prescribed plan (example)", homeReps: "Repetitions per session", homeSession: "Session", sessNames: { mon: "Monday", wed: "Wednesday", fri: "Friday" },
    h: { canvasLabel: "Hand skeleton (no camera image)", hint: "Tap Start camera. Keep your hand visible, with good light and the phone propped up.", start: "Start camera", stop: "Stop", calibrate: "Calibrate (10 s)", reset: "Reset",
      repsLabel: "repetitions", loading: "Loading the hand model (once)…", opening: "Opening the camera…", stopped: "Camera off.", failed: "Could not start: ", calFail: "Calibration had too little movement. Open and close the hand slowly.",
      openness: "openness", state: "state", ignored: "ignored cycles", calibrating: "CALIBRATING: open and close the hand slowly", states: { waiting: "waiting for an open hand", open: "open", closed: "closed" } },
    homeSave: "Save this session's count", homeTyped: "or type a synthetic count (demo, no camera)", homeSavedMsg: "Count saved (no image):", homeNothing: "Nothing counted yet.",
    homeReport: "Patient report (one tap)", ans: { done: "I did it", hard: "I did it, it was hard", not_finished: "I did not finish" }, homeReportSaved: "Report saved.",
    homeWeek: "Week", observed: "observed", notObserved: "not observed", target: "target", conflict: "sensor and report disagree", atypical: "atypical", noReport: "no report",
    homeCheck: "Check the draft claims", homeTry: "Try a claim the verifier should block", homeAdd: "Add",
    tries: { independent: "“Did it independently” from the sensor only", not_done: "“Did not do the session” with no data", progress: "“There was functional progress”", wrong_count: "Wrong repetition count" },
    homeDraftNote: "Draft built by rules (the local model's draft comes later). The verifier is code and uses no model.", homeDeliverable: "can go to the therapist", homeBlocked: "blocked",
    homeReportTitle: "What the therapist reads", homeReportNote: "Facts come straight from the data and are never omitted; verified claims follow, without repeats. No sentence is the model's.", homeClaimsTitle: "Check of the draft claims",
    homeNoEvents: "Save at least one session before checking.", homeReason: "Reason",
    claimReps: "Session {s}: {n} repetitions counted by the sensor.", claimSessions: "{n} of {m} sessions observed by the sensor.", claimReport: "Session {s}: the patient reports doing the exercise (a report, not an observation).",
    claimConflict: "Session {s}: the sensor and the patient's report disagree.", claimIndep: "The patient did the exercise independently at home.", claimNotDone: "The patient did not do session {s}.", claimProgress: "There was functional progress.", claimWrong: "Session {s}: {n} repetitions counted by the sensor.",
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

  async home(root) {
    const H = S.home, tx = t(), sessions = ["mon", "wed", "fri"], day = new Date().toISOString().slice(0, 10);
    const plan = () => ({ exercise: "open_close_hand", reps_per_session: H.reps, sessions });
    const fill = (str, o) => str.replace(/\{(\w+)\}/g, (_, k) => o[k]);
    root.append(h("h2", {}, tx.homeTitle), h("p", { class: "muted" }, tx.homeHelp));

    const reps = h("input", { type: "number", min: 1, max: 100, value: H.reps, "aria-label": tx.homeReps, oninput: (e) => { H.reps = Math.max(1, Number(e.target.value) || 1); } });
    const sess = h("select", { "aria-label": tx.homeSession, onchange: (e) => { H.session = e.target.value; } }, sessions.map((x) => h("option", { value: x, selected: x === H.session }, tx.sessNames[x])));
    root.append(h("div", { class: "card" }, h("b", {}, tx.homePlan), h("div", { class: "row" }, h("label", { class: "field" }, tx.homeReps, reps), h("label", { class: "field" }, tx.homeSession, sess))));

    const camBox = h("div", { class: "hand" });
    root.append(h("div", { class: "card" }, camBox));
    S.hand = window.EloHand.mount(camBox, tx.h);

    const out = h("div"), typed = h("input", { type: "number", min: 0, max: 200, "aria-label": tx.homeTyped, placeholder: "0" });
    const evId = () => "e" + (++H.n), rpId = () => "r" + (++H.n);
    const saveEvent = (n, atyp, source) => {
      H.events = H.events.filter((e) => e.session !== H.session);  // one count per session: the latest replaces the earlier one
      H.events.push({ id: evId(), session: H.session, source, day, reps: n, atypical: atyp }); H.result = null;
      out.replaceChildren(h("div", { class: "ok" }, `${tx.homeSavedMsg} ${tx.sessNames[H.session]}, ${n} ${tx.h.repsLabel}${atyp ? ` (${atyp} ${tx.atypical})` : ""}.`)); drawWeek();
    };
    root.append(h("div", { class: "card" },
      h("div", { class: "row" }, h("button", { class: "y", onclick: () => { const r = S.hand.result(); if (!r.reps) { toast(tx.homeNothing); return; } saveEvent(r.reps, r.atypical, "camera"); S.hand.clear(); } }, tx.homeSave),
        h("label", { class: "field" }, tx.homeTyped, typed), h("button", { class: "ghost", onclick: () => { if (typed.value === "") return; saveEvent(Math.max(0, Math.round(Number(typed.value))), 0, "phone"); } }, tx.save)),
      h("h3", {}, tx.homeReport),
      h("div", { class: "row" }, ["done", "hard", "not_finished"].map((a) => h("button", { class: "ghost", onclick: () => {
        H.reports = H.reports.filter((r) => r.session !== H.session); H.reports.push({ id: rpId(), session: H.session, day, answer: a }); H.result = null;
        out.replaceChildren(h("div", { class: "ok" }, `${tx.homeReportSaved} ${tx.sessNames[H.session]}: ${tx.ans[a]}.`)); drawWeek(); } }, tx.ans[a])))), out);

    const weekBox = h("div"), resBox = h("div");
    const conflictOf = (s) => { const e = H.events.find((x) => x.session === s), r = H.reports.find((x) => x.session === s); return !!(e && r && ((e.reps >= H.reps) !== (r.answer !== "not_finished"))); };
    function drawWeek() {
      const rows = sessions.map((s) => { const e = H.events.find((x) => x.session === s), r = H.reports.find((x) => x.session === s);
        return h("tr", {}, h("td", {}, tx.sessNames[s]), h("td", {}, e ? pill("direct", `${tx.observed}: ${e.reps}/${H.reps}${e.atypical ? ` · ${e.atypical} ${tx.atypical}` : ""}`) : pill("none", tx.notObserved)),
          h("td", {}, r ? tx.ans[r.answer] : h("span", { class: "muted" }, tx.noReport)), h("td", {}, conflictOf(s) ? pill("needs_review", tx.conflict) : "")); });
      weekBox.replaceChildren(h("h3", {}, tx.homeWeek), h("div", { class: "scroll" }, h("table", {}, h("tbody", {}, rows))));
    }
    drawWeek();

    const draft = () => {
      const cl = [], ev = H.events, doneSessions = new Set(ev.map((e) => e.session));
      for (const e of ev) {
        cl.push({ id: "c-reps-" + e.session, text: fill(tx.claimReps, { s: tx.sessNames[e.session], n: e.reps }), kind: "reps", level: 2, value: e.reps, session: e.session, evidence: [e.id], flags_conflict: conflictOf(e.session) });
        const r = H.reports.find((x) => x.session === e.session);
        if (r && r.answer !== "not_finished") cl.push({ id: "c-rep-" + e.session, text: fill(tx.claimReport, { s: tx.sessNames[e.session] }), kind: "independent", level: 3, session: e.session, evidence: [r.id] });
        if (conflictOf(e.session)) cl.push({ id: "c-conf-" + e.session, text: fill(tx.claimConflict, { s: tx.sessNames[e.session] }), kind: "conflict", level: 3, session: e.session, evidence: r ? [e.id, r.id] : [e.id], flags_conflict: true });
      }
      cl.push({ id: "c-sessions", text: fill(tx.claimSessions, { n: doneSessions.size, m: sessions.length }), kind: "sessions_done", level: 2, value: doneSessions.size, evidence: ev.map((e) => e.id), flags_conflict: sessions.some(conflictOf) });
      return cl.concat(H.extra);
    };
    const tryKind = h("select", { "aria-label": tx.homeTry }, Object.entries(tx.tries).map(([k, l]) => h("option", { value: k }, l)));
    const addTry = () => {
      const k = tryKind.value, e = H.events.find((x) => x.session === H.session), n = ++H.n, s = tx.sessNames[H.session];
      const ids = H.events.map((x) => x.id);
      const x = { independent: { kind: "independent", level: 3, text: tx.claimIndep, evidence: e ? [e.id] : ids },
        not_done: { kind: "not_done", level: 2, text: fill(tx.claimNotDone, { s }), session: H.session, evidence: [] },
        progress: { kind: "progress", level: 4, text: tx.claimProgress, evidence: ids },
        wrong_count: { kind: "reps", level: 2, text: fill(tx.claimWrong, { s, n: (e ? e.reps : 0) + 3 }), value: (e ? e.reps : 0) + 3, session: H.session, evidence: e ? [e.id] : [] } }[k];
      H.extra.push({ id: "x" + n, ...x }); check();
    };
    async function check() {
      if (!H.events.length) { resBox.replaceChildren(h("div", { class: "warn" }, tx.homeNoEvents)); return; }
      try {
        const r = await api("/home/verify", { method: "POST", body: { plan: plan(), events: H.events, reports: H.reports, claims: draft() } });
        H.result = r; showResult();
      } catch (e) { resBox.replaceChildren(h("div", { class: "err" }, `${tx.error}: ${e.message}`)); }
    }
    function showResult() {
      const claims = draft(), by = Object.fromEntries(claims.map((c) => [c.id, c]));
      resBox.replaceChildren(h("h3", {}, tx.homeReportTitle), h("div", { class: "card" }, h("ul", {}, H.result.report.map((l) => h("li", {}, l[S.lang])))), h("p", { class: "muted" }, tx.homeReportNote), h("h3", {}, tx.homeClaimsTitle), h("p", { class: "muted" }, tx.homeDraftNote), ...H.result.results.map((r) => h("div", { class: "card" },
        h("div", { class: "row" }, pill(r.verdict, tx.v[r.verdict]), pill(r.deliverable ? "supported" : "rejected", r.deliverable ? tx.homeDeliverable : tx.homeBlocked)),
        h("p", {}, h("q", {}, r.deliverable && r.deliverable_text ? r.deliverable_text[S.lang] : (by[r.claim_id] ? by[r.claim_id].text : r.claim_id))),
        r.reasons.length ? h("p", { class: "muted" }, `${tx.homeReason}: ${r.reasons.map((x) => x[S.lang]).join(" ")}`) : null)));
    }
    root.append(weekBox, h("div", { class: "row" }, h("button", { onclick: check }, tx.homeCheck)),
      h("div", { class: "row" }, h("label", { class: "field" }, tx.homeTry, tryKind), h("button", { class: "ghost", onclick: addTry }, tx.homeAdd)), resBox);
    if (H.result) showResult();
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
  if (S.hand) { S.hand.stop(); S.hand = null; }
  const view = $("view"); view.replaceChildren();
  $("banner").textContent = S.meta.notice[loc()] || S.meta.notice["pt-BR"];
  document.documentElement.lang = loc();
  for (const el of document.querySelectorAll("[data-i]")) el.textContent = t()[el.dataset.i];
  const tabs = $("tabs"); tabs.replaceChildren(...Object.entries(t().tabs).map(([k, label]) => h("button", { role: "tab", "aria-selected": String(S.tab === k), onclick: () => { S.tab = k; render(); } }, label)));
  const sel = $("caseSel"); sel.replaceChildren(...S.cases.map((c) => h("option", { value: c.id, selected: c.id === S.caseId }, c.label)));
  document.querySelectorAll(".lang button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === S.lang)));
  if (!S.caseId && S.tab !== "home") { view.append(h("p", {}, t().noCase)); return; }
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
