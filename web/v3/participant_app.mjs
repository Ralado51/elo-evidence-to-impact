/**
 * Elo v3 — Participant journey browser controller (S1-04).
 *
 * Report-only "Organizar a mesa" experience written from scratch (PO-F10, PO-F28, PO-F29):
 * - Zero camera or microphone capture APIs invoked.
 * - Sends no consent.accepted in report-only mode (D-S1-04-1).
 * - Uses only participant-allowed /api/v3 routes via participant_api.mjs.
 * - Zero hashes, note_refs, or actor ids rendered in participant views (Row 8).
 * - Single live region via a11y.mjs.
 */

import { announce } from "./a11y.mjs";
import { createParticipantClient, ParticipantApiError } from "./participant_api.mjs";
import {
  ASSISTANCE_TRANSITION_LABEL_PTBR,
  BODY_SEGMENT_LABEL_PTBR,
  GOAL_STATUS_LABEL_PTBR,
  GOAL_TARGET_KIND_LABEL_PTBR,
  ORGANIZAR_A_MESA_GUIDE,
  PARTICIPANT_DATA_ORIGIN,
  buildReportSubmittedEvent,
  buildSessionControlEvent,
  buildSessionStartedEvent,
  formatExecutionMode,
  formatOriginLabel,
  formatParticipantError,
  generateSessionId,
  nextMonotonicIso,
  projectPrescriptionForDisplay,
  resolveEvolutionSeriesOriginLabel,
  resolveSummaryOriginLabel,
} from "./participant_model.mjs";

const SESSION_STORAGE_KEY = "elo_v3_participant_session";

const PROTECTED_HASHES = new Set([
  "#sec-plan",
  "#sec-session",
  "#sec-report",
  "#sec-views",
]);

function readStoredSession() {
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === "string" && parsed.token.length > 0) {
      return parsed;
    }
  } catch {
    // Ignore storage read errors.
  }
  return null;
}

function writeStoredSession(session) {
  try {
    if (session) {
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } else {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage write errors.
  }
}

function el(id) {
  return document.getElementById(id);
}

function clearElement(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function createBadge(text, extraClass, dataAttrName, dataAttrVal) {
  const span = document.createElement("span");
  span.className = `badge ${extraClass || ""}`.trim();
  span.textContent = text;
  if (dataAttrName) {
    span.setAttribute(dataAttrName, String(dataAttrVal ?? ""));
  }
  return span;
}

function appendParagraph(parent, text) {
  const p = document.createElement("p");
  p.textContent = text;
  parent.appendChild(p);
  return p;
}

export function initParticipantApp() {
  const state = {
    session: readStoredSession(),
    prescription: null,
    goals: [],
    activeSession: null, // { sessionId, seq, lastHash, lastOccurredAt, phase: "active"|"ended", endAction }
    reportExecution: null,
    reportAssistance: null,
  };

  const client = createParticipantClient({
    getToken: () => state.session?.token || null,
  });

  const errorBanner = el("error-banner");
  const errorBannerText = el("error-banner-text");
  const successBanner = el("success-banner");
  const successBannerText = el("success-banner-text");
  const sessionStatusEl = el("participant-session-status");
  const phaseStatusEl = el("practice-phase-status");
  const btnSignout = el("btn-participant-signout");
  const btnSessionStart = el("btn-session-start");
  const btnSessionEnd = el("btn-session-end");
  const btnStopPain = el("btn-stop-pain");
  const btnStopFatigue = el("btn-stop-fatigue");
  const btnSubmitReport = el("btn-submit-report");
  const reportGateStatus = el("report-gate-status");

  // Populate guided report-only steps for "Organizar a mesa".
  const guideList = el("activity-guide");
  if (guideList && guideList.children.length === 0) {
    for (const stepText of ORGANIZAR_A_MESA_GUIDE) {
      const li = document.createElement("li");
      li.textContent = stepText;
      guideList.appendChild(li);
    }
  }

  function clearError() {
    errorBanner.hidden = true;
    errorBanner.removeAttribute("role");
    errorBanner.setAttribute("data-error-code", "");
    errorBannerText.textContent = "";
  }

  function clearSuccess() {
    successBanner.hidden = true;
    successBannerText.textContent = "";
  }

  function showError(code, message) {
    clearSuccess();
    errorBanner.setAttribute("role", "alert");
    errorBanner.setAttribute("data-error-code", code || "ERROR");
    errorBannerText.textContent = message;
    errorBanner.hidden = false;
    announce(message, { politeness: "assertive" });
  }

  function showSuccess(message) {
    clearError();
    successBannerText.textContent = message;
    successBanner.hidden = false;
    announce(message, { politeness: "polite" });
  }

  function redirectToSignIn(reasonText) {
    const msg = reasonText || formatParticipantError({ code: "UNAUTHENTICATED", status: 401 });
    showError("UNAUTHENTICATED", msg);
    if (window.location.hash !== "#sec-signin") {
      window.location.hash = "#sec-signin";
    }
    el("invite-token")?.focus();
  }

  function handleApiError(err) {
    const apiErr =
      err instanceof ParticipantApiError
        ? err
        : new ParticipantApiError({
            code: err?.code || "UNKNOWN_ERROR",
            status: err?.status || 0,
            message: err instanceof Error ? err.message : String(err),
          });
    const formatted = formatParticipantError(apiErr);
    if (apiErr.code === "UNAUTHENTICATED") {
      redirectToSignIn(formatted);
      return;
    }
    showError(apiErr.code, formatted);
  }

  function requireAuth() {
    if (!state.session || !state.session.token || !state.session.principal?.id) {
      redirectToSignIn(
        "[UNAUTHENTICATED] Sessão não autenticada. Redirecionado para a etapa 1 (Entrar com convite)."
      );
      return false;
    }
    return true;
  }

  function updateStatusBar() {
    if (state.session && state.session.token) {
      sessionStatusEl.textContent = "Sessão autenticada como participante (modo apenas relato).";
      btnSignout.hidden = false;
    } else {
      sessionStatusEl.textContent =
        "Sessão não autenticada. Entre com seu convite na etapa 1.";
      btnSignout.hidden = true;
    }

    if (!state.activeSession) {
      phaseStatusEl.textContent = "Nenhuma sessão de prática iniciada.";
    } else if (state.activeSession.phase === "active") {
      phaseStatusEl.textContent = "Sessão em andamento (Organizar a mesa — apenas relato).";
    } else if (state.activeSession.phase === "ended") {
      const endLabel =
        state.activeSession.endAction === "pain"
          ? "encerrada por dor"
          : state.activeSession.endAction === "fatigue"
            ? "encerrada por cansaço"
            : "concluída";
      phaseStatusEl.textContent = `Sessão ${endLabel}. Pronto para enviar o relato na etapa 4.`;
    }
  }

  const PUB_LABEL_PTBR = { summary: "Resumo", evolution: "Evolução" };

  async function loadPublications() {
    const status = el("publication-status");
    const list = el("publication-list");
    if (!status || !list) return;
    clearElement(list);
    if (!state.session?.token) {
      status.textContent = "Entre para ver o que seu terapeuta liberou.";
      return;
    }
    try {
      const res = await client.listPublications(state.session.principal.id);
      const items = res.data.publications || [];
      status.textContent = items.length
        ? "Toque para abrir o que seu terapeuta liberou."
        : "Seu terapeuta ainda não liberou nenhum resumo ou evolução.";
      for (const it of items) {
        const li = document.createElement("li");
        li.className = "data-card";
        li.dataset.publicationKind = it.kind;
        li.dataset.publicationId = it.id;
        const period = it.period_from && it.period_to ? ` (${it.period_from} a ${it.period_to})` : "";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-secondary target";
        btn.textContent = `Abrir ${PUB_LABEL_PTBR[it.kind] || it.kind}${period}`;
        btn.addEventListener("click", () => {
          if (it.kind === "summary") {
            el("summary-id-input").value = it.id;
            openSummaryById(it.id);
          } else {
            el("evolution-id-input").value = it.id;
            openEvolutionById(it.id);
          }
        });
        li.appendChild(btn);
        list.appendChild(li);
      }
    } catch {
      status.textContent = "Não consegui carregar a lista agora. Você ainda pode abrir pelos códigos abaixo.";
    }
  }

  function updateControlsState() {
    const isActive = state.activeSession?.phase === "active";
    const isEnded = state.activeSession?.phase === "ended";

    btnSessionStart.disabled = isActive;
    btnSessionEnd.disabled = !isActive;
    btnStopPain.disabled = !isActive;
    btnStopFatigue.disabled = !isActive;

    const reportReady =
      isEnded && Boolean(state.reportExecution) && Boolean(state.reportAssistance);
    btnSubmitReport.disabled = !reportReady;
    if (reportReady) {
      reportGateStatus.textContent = "Relato pronto para envio (sem digitação).";
    } else if (isEnded) {
      reportGateStatus.textContent = "Escolha uma opção em cada pergunta para enviar o relato.";
    } else {
      reportGateStatus.textContent =
        "Inicie e encerre uma sessão na etapa 3 e escolha as duas opções para enviar o relato.";
    }
    updateStatusBar();
  }

  function resetReportChoices() {
    state.reportExecution = null;
    state.reportAssistance = null;
    for (const btn of document.querySelectorAll("button[data-choice-group]")) {
      btn.setAttribute("aria-pressed", "false");
    }
  }

  function renderPrescription(rxEvent) {
    const view = projectPrescriptionForDisplay(rxEvent);
    const box = el("prescription-view");
    clearElement(box);
    box.hidden = false;
    box.dataset.prescriptionLoaded = "true";

    const badges = document.createElement("div");
    badges.className = "meta-badges";
    badges.appendChild(createBadge(view.originLabel, "badge-origin", "data-origin-label", view.originLabel));
    badges.appendChild(
      createBadge(
        `Modo de execução: ${view.executionModeLabel}`,
        "badge-mode",
        "data-execution-mode",
        view.executionMode
      )
    );
    box.appendChild(badges);

    appendParagraph(box, `Atividade prescrita: ${view.exerciseName} — ${view.movementLabel}`);
    appendParagraph(
      box,
      `Lado: ${view.sideLabel} • Plano: ${view.targetSets} séries de ${view.targetRepetitions} repetições (${view.sessionsPerWeek} sessões por semana)`
    );
    const validText = view.validTo ? `${view.validFrom} até ${view.validTo}` : `a partir de ${view.validFrom}`;
    appendParagraph(box, `Vigência: ${validText}`);
    if (view.instructionsPtBr) {
      appendParagraph(box, `Orientações: ${view.instructionsPtBr}`);
    }
  }

  function renderGoals(goals) {
    const panel = el("goals-panel");
    const list = el("goals-list");
    clearElement(list);
    panel.hidden = false;

    const originLabel = formatOriginLabel(PARTICIPANT_DATA_ORIGIN);
    if (!Array.isArray(goals) || goals.length === 0) {
      const li = document.createElement("li");
      li.className = "data-card";
      appendParagraph(li, "Nenhuma meta cadastrada até o momento.");
      list.appendChild(li);
      return;
    }

    for (const goal of goals) {
      const li = document.createElement("li");
      li.className = "data-card";
      li.dataset.goalItem = "true";

      const badges = document.createElement("div");
      badges.className = "meta-badges";
      badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      const statusText = GOAL_STATUS_LABEL_PTBR[goal.status] || String(goal.status || "");
      badges.appendChild(
        createBadge(
          statusText,
          goal.status === "achieved_confirmed" ? "badge-confirmed" : "",
          "data-goal-status",
          goal.status
        )
      );
      li.appendChild(badges);

      appendParagraph(li, String(goal.goal_text || ""));
      const seg = BODY_SEGMENT_LABEL_PTBR[goal.body_segment] || String(goal.body_segment || "");
      const target = goal.target || {};
      const kindLabel = GOAL_TARGET_KIND_LABEL_PTBR[target.kind] || String(target.kind || "");
      const valPart =
        target.value !== null && target.value !== undefined
          ? `${target.value}${target.unit ? ` ${target.unit}` : ""}`
          : kindLabel;
      appendParagraph(li, `Segmento: ${seg} • Alvo: ${valPart}`);
      list.appendChild(li);
    }
  }

  function renderSummaryView(summaryData) {
    const box = el("summary-view");
    clearElement(box);
    box.hidden = false;

    const originLabel = resolveSummaryOriginLabel(summaryData);
    const card = document.createElement("div");
    card.dataset.participantSummary = String(summaryData.summary_id || "");

    const badges = document.createElement("div");
    badges.className = "meta-badges";
    badges.appendChild(createBadge("Resumo publicado", "badge-confirmed", "", ""));
    badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
    card.appendChild(badges);

    const period = summaryData.period || {};
    appendParagraph(
      card,
      `Resumo ${summaryData.summary_id} • Período: ${period.from || ""} a ${period.to || ""}`
    );

    const ul = document.createElement("ul");
    ul.className = "card-list";
    for (const fact of summaryData.rendered_facts || []) {
      const li = document.createElement("li");
      li.className = "data-card";
      li.dataset.summaryRenderedFact = "true";

      const fb = document.createElement("div");
      fb.className = "meta-badges";
      fb.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      li.appendChild(fb);

      appendParagraph(li, String(fact.text_ptbr || ""));
      const lims = Array.isArray(fact.limitations_ptbr) ? fact.limitations_ptbr : [];
      if (lims.length > 0) {
        const limUl = document.createElement("ul");
        limUl.className = "limitations-list";
        for (const text of lims) {
          const limLi = document.createElement("li");
          limLi.textContent = text;
          limUl.appendChild(limLi);
        }
        li.appendChild(limUl);
      }
      ul.appendChild(li);
    }
    card.appendChild(ul);
    box.appendChild(card);
  }

  function renderEvolutionView(evoData) {
    const box = el("evolution-view");
    clearElement(box);
    box.hidden = false;

    const card = document.createElement("div");
    card.dataset.participantEvolution = String(evoData.evolution_id || "");

    const period = evoData.period || {};
    appendParagraph(
      card,
      `Evolução ${evoData.evolution_id} • Período: ${period.from || ""} a ${period.to || ""}`
    );

    const seriesList = Array.isArray(evoData.series) ? evoData.series : [];
    for (const series of seriesList) {
      const originLabel = resolveEvolutionSeriesOriginLabel(series);
      const execMode = String(series.execution_mode || "report_only");
      const execModeLabel = formatExecutionMode(execMode);

      const sArticle = document.createElement("article");
      sArticle.className = "data-card";
      sArticle.dataset.participantEvolutionSeries = "true";

      const badges = document.createElement("div");
      badges.className = "meta-badges";
      badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      badges.appendChild(
        createBadge(`Modo de execução: ${execModeLabel}`, "badge-mode", "data-execution-mode", execMode)
      );
      sArticle.appendChild(badges);

      const itemsUl = document.createElement("ul");
      itemsUl.className = "card-list";
      for (const item of series.items || []) {
        const li = document.createElement("li");
        li.className = "result-box";
        li.dataset.participantEvolutionItem = "true";

        const ib = document.createElement("div");
        ib.className = "meta-badges";
        ib.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
        ib.appendChild(
          createBadge(`Modo de execução: ${execModeLabel}`, "badge-mode", "data-execution-mode", execMode)
        );
        li.appendChild(ib);

        appendParagraph(li, `${item.session_date_local}: ${item.text_ptbr}`);
        const ctx = item.context || {};
        appendParagraph(
          li,
          `Contexto — ajuda: ${ctx.assistance_level ?? "?"} • dor/fadiga sinalizada: ${String(ctx.pain_or_fatigue_signalled)} • término: ${ctx.session_end_reason ?? "?"}`
        );

        const lims = Array.isArray(item.limitations_ptbr) ? item.limitations_ptbr : [];
        if (lims.length > 0) {
          const limUl = document.createElement("ul");
          limUl.className = "limitations-list";
          for (const text of lims) {
            const limLi = document.createElement("li");
            limLi.textContent = text;
            limUl.appendChild(limLi);
          }
          li.appendChild(limUl);
        }
        itemsUl.appendChild(li);
      }
      sArticle.appendChild(itemsUl);

      for (const tr of series.assistance_transitions || []) {
        const dirText =
          ASSISTANCE_TRANSITION_LABEL_PTBR[tr.direction] || String(tr.direction || "");
        appendParagraph(
          sArticle,
          `Mudança descritiva na ajuda relatada (${tr.from_date} a ${tr.to_date}): ${dirText}.`
        );
      }

      for (const ch of series.context_changes || []) {
        appendParagraph(
          sArticle,
          `Mudança de contexto (${ch.from_date} a ${ch.to_date}): ${ch.dimension} (${String(ch.from)} → ${String(ch.to)}).`
        );
      }

      card.appendChild(sArticle);
    }

    for (const notice of evoData.notices || []) {
      const nBox = document.createElement("div");
      nBox.className = "banner banner-info";
      appendParagraph(
        nBox,
        `Aviso de separação de séries (${notice.kind}): critérios diferentes: ${(notice.differing_keys || []).join(", ")}.`
      );
      card.appendChild(nBox);
    }

    box.appendChild(card);
  }

  async function loadPlan() {
    if (!requireAuth()) return false;
    const pid = state.session.principal.id;
    try {
      const [rxRes, goalsRes] = await Promise.all([
        client.getCurrentPrescription(pid),
        client.listGoals(pid),
      ]);
      state.prescription = rxRes.data;
      state.goals = Array.isArray(goalsRes.data) ? goalsRes.data : [];
      renderPrescription(state.prescription);
      renderGoals(state.goals);
      showSuccess("Prescrição atual e metas carregadas.");
      return true;
    } catch (err) {
      handleApiError(err);
      return false;
    }
  }

  async function endActiveSession(action) {
    if (!requireAuth()) return;
    if (!state.activeSession || state.activeSession.phase !== "active") {
      showError(
        "INVALID_TRANSITION",
        formatParticipantError({ code: "INVALID_TRANSITION", status: 200 })
      );
      return;
    }
    const rxPayload = state.prescription?.payload;
    if (!rxPayload) {
      showError(
        "PRESCRIPTION_NOT_FOUND",
        formatParticipantError({ code: "PRESCRIPTION_NOT_FOUND", status: 404 })
      );
      return;
    }
    const nextSeq = state.activeSession.seq + 1;
    const occurredAt = nextMonotonicIso(state.activeSession.lastOccurredAt);
    try {
      const ev = await buildSessionControlEvent({
        participantId: state.session.principal.id,
        orgId: state.session.principal.org_id,
        sessionId: state.activeSession.sessionId,
        prescriptionId: rxPayload.prescription_id,
        prescriptionRevision: rxPayload.revision,
        exerciseId: rxPayload.exercise_id,
        seq: nextSeq,
        prevHash: state.activeSession.lastHash,
        occurredAt,
        action,
      });
      await client.postEventsBatch([ev]);

      state.activeSession = {
        ...state.activeSession,
        seq: nextSeq,
        lastHash: ev.hash,
        lastOccurredAt: occurredAt,
        phase: "ended",
        endAction: action,
      };
      resetReportChoices();
      updateControlsState();

      const resBox = el("session-result");
      clearElement(resBox);
      resBox.hidden = false;
      resBox.dataset.sessionPhase = "ended";
      resBox.dataset.endAction = action;
      const msg =
        action === "pain"
          ? "Sessão encerrada imediatamente por sinalização de dor. Registre seu relato na etapa 4."
          : action === "fatigue"
            ? "Sessão encerrada imediatamente por sinalização de cansaço. Registre seu relato na etapa 4."
            : "Sessão concluída em modo apenas relato. Registre seu relato na etapa 4.";
      appendParagraph(resBox, msg);
      showSuccess(msg);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function openSummaryById(summaryId) {
    if (!requireAuth()) return;
    const clean = (summaryId || "").trim();
    if (!clean) {
      showError("NOT_FOUND", "[NOT_FOUND] Informe o identificador do resumo para abrir.");
      return;
    }
    try {
      const res = await client.getSummary(clean);
      renderSummaryView(res.data);
      showSuccess(`Resumo ${res.data.summary_id} carregado.`);
    } catch (err) {
      el("summary-view").hidden = true;
      clearElement(el("summary-view"));
      handleApiError(err);
    }
  }

  async function openEvolutionById(evolutionId) {
    if (!requireAuth()) return;
    const clean = (evolutionId || "").trim();
    if (!clean) {
      showError("NOT_FOUND", "[NOT_FOUND] Informe o identificador da evolução para abrir.");
      return;
    }
    try {
      const res = await client.getEvolution(clean);
      renderEvolutionView(res.data);
      showSuccess(`Evolução ${res.data.evolution_id} carregada.`);
    } catch (err) {
      el("evolution-view").hidden = true;
      clearElement(el("evolution-view"));
      handleApiError(err);
    }
  }

  // --- Event bindings ---

  btnSignout.addEventListener("click", () => {
    state.session = null;
    state.prescription = null;
    state.goals = [];
    state.activeSession = null;
    resetReportChoices();
    writeStoredSession(null);
    updateControlsState();
    loadPublications();
    for (const id of ["summary-view", "evolution-view"]) {
      el(id).hidden = true;
      clearElement(el(id));
    }
    el("summary-id-input").value = "";
    el("evolution-id-input").value = "";
    showSuccess("Sessão encerrada.");
    window.location.hash = "#sec-signin";
    el("invite-token")?.focus();
  });

  // Step 1: Invite sign-in
  el("form-invite-signin").addEventListener("submit", async (event) => {
    event.preventDefault();
    const tokenVal = el("invite-token").value.trim();
    if (!tokenVal) {
      showError("INVITE_INVALID", formatParticipantError({ code: "INVITE_INVALID", status: 400 }));
      return;
    }
    try {
      const res = await client.redeemInvite(tokenVal);
      state.session = {
        token: res.data.token,
        expires_at: res.data.expires_at,
        principal: res.data.principal,
      };
      writeStoredSession(state.session);
      updateControlsState();
      loadPublications();

      const box = el("signin-result");
      clearElement(box);
      box.hidden = false;
      appendParagraph(box, "Acesso liberado como participante em modo apenas relato.");
      showSuccess("Entrada realizada com sucesso.");
    } catch (err) {
      handleApiError(err);
    }
  });

  // Step 2: Load prescription & goals
  el("btn-load-plan").addEventListener("click", () => {
    loadPlan();
  });

  // Step 3: Start report-only "Organizar a mesa" session
  btnSessionStart.addEventListener("click", async () => {
    if (!requireAuth()) return;
    if (!state.prescription) {
      const loaded = await loadPlan();
      if (!loaded || !state.prescription) return;
    }
    const rxPayload = state.prescription.payload;
    const sessionId = generateSessionId();
    const t1 = nextMonotonicIso();
    const t2 = nextMonotonicIso(t1);
    try {
      const ev1 = await buildSessionStartedEvent({
        participantId: state.session.principal.id,
        orgId: state.session.principal.org_id,
        sessionId,
        prescriptionId: rxPayload.prescription_id,
        prescriptionRevision: rxPayload.revision,
        exerciseId: rxPayload.exercise_id,
        occurredAt: t1,
      });
      const ev2 = await buildSessionControlEvent({
        participantId: state.session.principal.id,
        orgId: state.session.principal.org_id,
        sessionId,
        prescriptionId: rxPayload.prescription_id,
        prescriptionRevision: rxPayload.revision,
        exerciseId: rxPayload.exercise_id,
        seq: 2,
        prevHash: ev1.hash,
        occurredAt: t2,
        action: "start",
      });
      await client.postEventsBatch([ev1, ev2]);

      state.activeSession = {
        sessionId,
        seq: 2,
        lastHash: ev2.hash,
        lastOccurredAt: t2,
        phase: "active",
        endAction: null,
      };
      resetReportChoices();
      updateControlsState();

      const resBox = el("session-result");
      clearElement(resBox);
      resBox.hidden = false;
      resBox.dataset.sessionPhase = "active";
      resBox.dataset.sessionId = sessionId;
      appendParagraph(
        resBox,
        "Sessão de Organizar a mesa iniciada em modo apenas relato (sem câmera)."
      );
      showSuccess("Sessão iniciada em modo apenas relato.");
    } catch (err) {
      handleApiError(err);
    }
  });

  btnSessionEnd.addEventListener("click", () => endActiveSession("end"));
  btnStopPain.addEventListener("click", () => endActiveSession("pain"));
  btnStopFatigue.addEventListener("click", () => endActiveSession("fatigue"));

  // Step 4: Choice button selection (zero typing)
  for (const btn of document.querySelectorAll("button[data-choice-group]")) {
    btn.addEventListener("click", () => {
      const group = btn.getAttribute("data-choice-group");
      const val = btn.getAttribute("data-choice-value");
      for (const peer of document.querySelectorAll(`button[data-choice-group="${group}"]`)) {
        peer.setAttribute("aria-pressed", peer === btn ? "true" : "false");
      }
      if (group === "execution") state.reportExecution = val;
      if (group === "assistance") state.reportAssistance = val;
      updateControlsState();
    });
  }

  // Step 4: Submit basic report (report.submitted)
  el("form-report").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireAuth()) return;
    if (!state.activeSession || state.activeSession.phase !== "ended") {
      showError(
        "INVALID_TRANSITION",
        formatParticipantError({ code: "INVALID_TRANSITION", status: 200 })
      );
      return;
    }
    if (!state.reportExecution || !state.reportAssistance) {
      showError(
        "RULE_VIOLATION",
        "[RULE_VIOLATION] Selecione uma opção para execução e uma opção para ajuda."
      );
      return;
    }
    const rxPayload = state.prescription?.payload;
    if (!rxPayload) {
      showError(
        "PRESCRIPTION_NOT_FOUND",
        formatParticipantError({ code: "PRESCRIPTION_NOT_FOUND", status: 404 })
      );
      return;
    }
    const nextSeq = state.activeSession.seq + 1;
    const occurredAt = nextMonotonicIso(state.activeSession.lastOccurredAt);
    try {
      const ev = await buildReportSubmittedEvent({
        participantId: state.session.principal.id,
        orgId: state.session.principal.org_id,
        sessionId: state.activeSession.sessionId,
        prescriptionId: rxPayload.prescription_id,
        prescriptionRevision: rxPayload.revision,
        exerciseId: rxPayload.exercise_id,
        seq: nextSeq,
        prevHash: state.activeSession.lastHash,
        occurredAt,
        execution: state.reportExecution,
        assistance: state.reportAssistance,
      });
      await client.postEventsBatch([ev]);

      const submittedExec = state.reportExecution;
      const submittedAssist = state.reportAssistance;
      const finishedSessionId = state.activeSession.sessionId;
      state.activeSession = null;
      resetReportChoices();
      updateControlsState();

      const resBox = el("report-result");
      clearElement(resBox);
      resBox.hidden = false;
      resBox.dataset.reportSubmitted = finishedSessionId;
      resBox.dataset.reportExecution = submittedExec;
      resBox.dataset.reportAssistance = submittedAssist;
      appendParagraph(resBox, "Relato registrado com sucesso.");
      showSuccess("Relato da sessão enviado com sucesso.");
    } catch (err) {
      handleApiError(err);
    }
  });

  // Step 5: Open summary and evolution by ID (and optional URL query params)
  el("form-open-summary").addEventListener("submit", (event) => {
    event.preventDefault();
    openSummaryById(el("summary-id-input").value);
  });

  el("form-open-evolution").addEventListener("submit", (event) => {
    event.preventDefault();
    openEvolutionById(el("evolution-id-input").value);
  });

  // Row 9: Unauthenticated navigation to protected section redirects to sign-in.
  window.addEventListener("hashchange", () => {
    if (!state.session?.token && PROTECTED_HASHES.has(window.location.hash)) {
      redirectToSignIn(
        "[UNAUTHENTICATED] Sessão não autenticada. Redirecionado para a etapa 1 (Entrar com convite)."
      );
    }
  });

  // Optional query params (?summary_id=...&evolution_id=...) per D-S1-04-1(c)
  const params = new URLSearchParams(window.location.search);
  const qSummary = params.get("summary_id");
  const qEvolution = params.get("evolution_id");
  if (qSummary && el("summary-id-input")) el("summary-id-input").value = qSummary;
  if (qEvolution && el("evolution-id-input")) el("evolution-id-input").value = qEvolution;

  // Invite link from the therapist: #invite=<token>. Fill the field and remove it from the address bar.
  const inviteMatch = /^#invite=([A-Za-z0-9_\-%.]+)$/.exec(window.location.hash || "");
  if (inviteMatch && el("invite-token") && !state.session?.token) {
    try {
      el("invite-token").value = decodeURIComponent(inviteMatch[1]);
    } catch {
      // Malformed fragment: leave the field empty.
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  updateControlsState();
  if (state.session?.token) loadPublications();

  if (!state.session?.token && PROTECTED_HASHES.has(window.location.hash)) {
    redirectToSignIn(
      "[UNAUTHENTICATED] Sessão não autenticada. Redirecionado para a etapa 1 (Entrar com convite)."
    );
  }
}

if (typeof document !== "undefined") {
  initParticipantApp();
}
