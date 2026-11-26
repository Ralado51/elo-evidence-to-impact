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
import { createCommandController } from "./command_controller.mjs";
import { createParticipantClient, ParticipantApiError } from "./participant_api.mjs";
import { initI18n, t, tm, bindText, label, formatDateTime, formatIsoDate } from "./i18n.mjs";
import { renderErrorTechnical } from "./ui_messages.mjs";
import {
  PARTICIPANT_DATA_ORIGIN,
  describeParticipantError,
  formatAssistanceTransition,
  organizarAMesaGuide,
  buildReportSubmittedEvent,
  buildSessionControlEvent,
  buildSessionStartedEvent,
  formatExecutionMode,
  formatOriginLabel,
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
  // CMP-07 (single owner of intention identity/single-flight). The ledger stays naturally idempotent by event_id.
  const commands = createCommandController({ consumeUntilEdit: true });
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
  function renderGuide() {
    if (!guideList) return;
    guideList.replaceChildren();
    for (const stepText of organizarAMesaGuide()) {
      const li = document.createElement("li");
      li.textContent = stepText;
      guideList.appendChild(li);
    }
  }
  renderGuide();
  document.addEventListener("elo:lang", renderGuide);

  // Result boxes are rebuilt from their builder so a language switch re-translates them.
  const boxBuilders = new Map();
  function renderBox(id, build) {
    boxBuilders.set(id, build);
    runBox(id);
  }
  function runBox(id) {
    const box = el(id);
    const build = boxBuilders.get(id);
    if (!box || !build) return;
    clearElement(box);
    box.hidden = false;
    build(box);
  }

  function clearError() {
    errorBanner.hidden = true;
    errorBanner.removeAttribute("role");
    errorBanner.setAttribute("data-error-code", "");
    bindText(errorBannerText, "");
    renderErrorTechnical(errorBanner, "");
  }

  function clearSuccess() {
    successBanner.hidden = true;
    bindText(successBannerText, "");
  }

  function showError(code, message, technical = "") {
    clearSuccess();
    errorBanner.setAttribute("role", "alert");
    errorBanner.setAttribute("data-error-code", code || "ERROR");
    bindText(errorBannerText, message);
    renderErrorTechnical(errorBanner, technical);
    errorBanner.hidden = false;
    announce(message, { politeness: "assertive" });
  }

  function showSuccess(message) {
    clearError();
    bindText(successBannerText, message);
    successBanner.hidden = false;
    announce(message, { politeness: "polite" });
  }

  function redirectToSignIn(reasonText, technical = "") {
    const msg = reasonText || describeParticipantError({ code: "UNAUTHENTICATED", status: 401 }).msg;
    showError("UNAUTHENTICATED", msg, technical);
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
    const info = describeParticipantError(apiErr);
    if (apiErr.code === "UNAUTHENTICATED") {
      redirectToSignIn(info.msg, info.technical);
      return;
    }
    showError(apiErr.code, info.msg, info.technical);
  }

  function requireAuth() {
    if (!state.session || !state.session.token || !state.session.principal?.id) {
      redirectToSignIn(tm("pa.js.session_required") );
      return false;
    }
    return true;
  }

  function updateStatusBar() {
    if (state.session && state.session.token) {
      sessionStatusEl.textContent = t("pa.js.signed_in");
      btnSignout.hidden = false;
    } else {
      sessionStatusEl.textContent = t("pa.js.session_required");
      btnSignout.hidden = true;
    }

    if (!state.activeSession) {
      phaseStatusEl.textContent = t("pa.js.no_session");
    } else if (state.activeSession.phase === "active") {
      phaseStatusEl.textContent = t("pa.js.session_active");
    } else if (state.activeSession.phase === "ended") {
      const endKey =
        state.activeSession.endAction === "pain"
          ? "pa.js.ended_pain"
          : state.activeSession.endAction === "fatigue"
            ? "pa.js.ended_fatigue"
            : "pa.js.ended_done";
      phaseStatusEl.textContent = t(endKey);
    }
  }

  
  async function loadPublications() {
    const status = el("publication-status");
    const list = el("publication-list");
    if (!status || !list) return;
    clearElement(list);
    if (!state.session?.token) {
      status.textContent = t("pa.js.pub_signin");
      return;
    }
    try {
      const res = await client.listPublications(state.session.principal.id);
      const items = res.data.publications || [];
      status.textContent = items.length
        ? t("pa.js.pub_tap")
        : t("pa.js.pub_none");
      for (const it of items) {
        const li = document.createElement("li");
        li.className = "data-card";
        li.dataset.publicationKind = it.kind;
        li.dataset.publicationId = it.id;
        const period = it.period_from && it.period_to ? ` (${formatIsoDate(it.period_from)} – ${formatIsoDate(it.period_to)})` : "";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-secondary target";
        btn.textContent = t(it.kind === "summary" ? "pa.js.open_summary" : "pa.js.open_evolution") + period;
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
      status.textContent = t("pa.js.pub_fail");
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
      reportGateStatus.textContent = t("pa.js.report_ready");
    } else if (isEnded) {
      reportGateStatus.textContent = t("pa.js.report_choose");
    } else {
      reportGateStatus.textContent = t("pa.js.report_need_session");
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
        t("pa.js.exec_mode", { mode: view.executionModeLabel }),
        "badge-mode",
        "data-execution-mode",
        view.executionMode
      )
    );
    box.appendChild(badges);

    appendParagraph(box, t("pa.js.rx_activity", { name: view.exerciseName, movement: view.movementLabel }));
    appendParagraph(
      box,
      t("pa.js.rx_plan", { side: view.sideLabel, sets: view.targetSets, reps: view.targetRepetitions, per: view.sessionsPerWeek })
    );
    const validText = view.validTo ? t("pa.js.valid_range", { from: formatIsoDate(view.validFrom), to: formatIsoDate(view.validTo) }) : t("pa.js.valid_from", { from: formatIsoDate(view.validFrom) });
    appendParagraph(box, t("pa.js.validity", { text: validText }));
    if (view.instructionsPtBr) {
      appendParagraph(box, t("pa.js.rx_instructions", { text: view.instructionsPtBr }));
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
      appendParagraph(li, t("pa.js.no_goals"));
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
      const statusText = label("goal_status", goal.status);
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
      const seg = label("segment", goal.body_segment);
      const target = goal.target || {};
      const kindLabel = label("goal_kind", target.kind);
      const valPart =
        target.value !== null && target.value !== undefined
          ? `${target.value}${target.unit ? ` ${label("unit", target.unit)}` : ""}`
          : kindLabel;
      appendParagraph(li, t("pa.js.goal_line", { seg, target: valPart }));
      list.appendChild(li);
    }
  }

  function renderSummaryView(summaryData) {
    state.summaryData = summaryData;
    const box = el("summary-view");
    clearElement(box);
    box.hidden = false;

    const originLabel = resolveSummaryOriginLabel(summaryData);
    const card = document.createElement("div");
    card.dataset.participantSummary = String(summaryData.summary_id || "");

    const badges = document.createElement("div");
    badges.className = "meta-badges";
    badges.appendChild(createBadge(t("pa.js.summary_badge"), "badge-confirmed", "", ""));
    badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
    card.appendChild(badges);

    const period = summaryData.period || {};
    appendParagraph(
      card,
      t("pa.js.summary_period", { from: formatIsoDate(period.from), to: formatIsoDate(period.to) })
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

      appendParagraph(li, String(fact.text_ptbr || "")).setAttribute("data-clinical-text", "");
      const lims = Array.isArray(fact.limitations_ptbr) ? fact.limitations_ptbr : [];
      if (lims.length > 0) {
        const limUl = document.createElement("ul");
        limUl.className = "limitations-list";
        limUl.setAttribute("data-clinical-text", "");
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
    state.evolutionData = evoData;
    const box = el("evolution-view");
    clearElement(box);
    box.hidden = false;

    const card = document.createElement("div");
    card.dataset.participantEvolution = String(evoData.evolution_id || "");

    const period = evoData.period || {};
    appendParagraph(
      card,
      t("pa.js.evo_period", { from: formatIsoDate(period.from), to: formatIsoDate(period.to) })
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
        createBadge(t("pa.js.exec_mode", { mode: execModeLabel }), "badge-mode", "data-execution-mode", execMode)
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
          createBadge(t("pa.js.exec_mode", { mode: execModeLabel }), "badge-mode", "data-execution-mode", execMode)
        );
        li.appendChild(ib);

        appendParagraph(li, `${formatIsoDate(item.session_date_local)}: ${item.text_ptbr}`).setAttribute("data-clinical-text", "");
        const ctx = item.context || {};
        appendParagraph(
          li,
          t("pa.js.ctx", { help: label("assistance", ctx.assistance_level), pain: ctx.pain_or_fatigue_signalled ? t("common.yes") : t("common.no"), end: label("end_reason", ctx.session_end_reason) })
        );

        const lims = Array.isArray(item.limitations_ptbr) ? item.limitations_ptbr : [];
        if (lims.length > 0) {
          const limUl = document.createElement("ul");
          limUl.className = "limitations-list";
          limUl.setAttribute("data-clinical-text", "");
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
        const dirText = formatAssistanceTransition(tr.direction);
        appendParagraph(
          sArticle,
          t("pa.js.transition", { from: formatIsoDate(tr.from_date), to: formatIsoDate(tr.to_date), dir: dirText })
        );
      }

      for (const ch of series.context_changes || []) {
        appendParagraph(
          sArticle,
          t("pa.js.ctx_change", { from: formatIsoDate(ch.from_date), to: formatIsoDate(ch.to_date), dim: label("series_key", ch.dimension), a: String(ch.from), b: String(ch.to) })
        );
      }

      card.appendChild(sArticle);
    }

    for (const notice of evoData.notices || []) {
      const nBox = document.createElement("div");
      nBox.className = "banner banner-info";
      appendParagraph(
        nBox,
        t("pa.js.series_split", { what: (notice.differing_keys || []).map((x) => label("series_key", x)).join(", ") })
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
      showSuccess(tm("pa.js.plan_loaded"));
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
        describeParticipantError({ code: "INVALID_TRANSITION", status: 200 }).msg
      );
      return;
    }
    const rxPayload = state.prescription?.payload;
    if (!rxPayload) {
      showError(
        "PRESCRIPTION_NOT_FOUND",
        describeParticipantError({ code: "PRESCRIPTION_NOT_FOUND", status: 404 }).msg
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
      resBox.dataset.sessionPhase = "ended";
      resBox.dataset.endAction = action;
      const msgKey = action === "pain" ? "pa.js.stop_pain" : action === "fatigue" ? "pa.js.stop_fatigue" : "pa.js.stop_done";
      renderBox("session-result", (b) => appendParagraph(b, t(msgKey)));
      showSuccess(tm(msgKey));
    } catch (err) {
      handleApiError(err);
    }
  }

  async function openSummaryById(summaryId) {
    if (!requireAuth()) return;
    const clean = (summaryId || "").trim();
    if (!clean) {
      showError("NOT_FOUND", tm("pa.js.need_sum_id"));
      return;
    }
    try {
      const res = await client.getSummary(clean);
      renderSummaryView(res.data);
      showSuccess(tm("pa.js.sum_loaded", { id: res.data.summary_id }));
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
      showError("NOT_FOUND", tm("pa.js.need_evo_id"));
      return;
    }
    try {
      const res = await client.getEvolution(clean);
      renderEvolutionView(res.data);
      showSuccess(tm("pa.js.evo_loaded"));
    } catch (err) {
      el("evolution-view").hidden = true;
      clearElement(el("evolution-view"));
      handleApiError(err);
    }
  }

  // --- Event bindings ---

  btnSignout.addEventListener("click", () => {
    boxBuilders.clear();
    state.session = null;
    state.prescription = null;
    state.goals = [];
    state.activeSession = null;
    state.summaryData = null;
    state.evolutionData = null;
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
    showSuccess(tm("pa.js.signed_out"));
    window.location.hash = "#sec-signin";
    el("invite-token")?.focus();
  });

  // Step 1: Invite sign-in
  el("form-invite-signin").addEventListener("submit", async (event) => {
    event.preventDefault();
    const tokenVal = el("invite-token").value.trim();
    if (!tokenVal) {
      showError("INVITE_INVALID", describeParticipantError({ code: "INVITE_INVALID", status: 400 }).msg);
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

      renderBox("signin-result", (b) => appendParagraph(b, t("pa.js.access_granted")));
      showSuccess(tm("pa.js.signed_in_ok"));
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
      resBox.dataset.sessionPhase = "active";
      resBox.dataset.sessionId = sessionId;
      renderBox("session-result", (b) => appendParagraph(b, t("pa.js.started_detail")));
      showSuccess(tm("pa.js.started"));
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
    if (!state.activeSession && state.lastReportSlot && commands.stateOf(state.lastReportSlot) === "settled") return;
    if (!state.activeSession || state.activeSession.phase !== "ended") {
      showError(
        "INVALID_TRANSITION",
        describeParticipantError({ code: "INVALID_TRANSITION", status: 200 }).msg
      );
      return;
    }
    if (!state.reportExecution || !state.reportAssistance) {
      showError("RULE_VIOLATION", tm("pa.js.need_both"));
      return;
    }
    const rxPayload = state.prescription?.payload;
    if (!rxPayload) {
      showError(
        "PRESCRIPTION_NOT_FOUND",
        describeParticipantError({ code: "PRESCRIPTION_NOT_FOUND", status: 404 }).msg
      );
      return;
    }
    const slot = `report@${state.activeSession.sessionId}`;
    const execution = state.reportExecution;
    const assistance = state.reportAssistance;
    const out = await commands.run(slot, async () => {
      // The event is built once per intention: a retry after an ambiguous failure resends the SAME event_id/seq/hash.
      if (!state.pendingReport || state.pendingReport.slot !== slot || state.pendingReport.execution !== execution || state.pendingReport.assistance !== assistance) {
        const nextSeq = state.activeSession.seq + 1;
        const occurredAt = nextMonotonicIso(state.activeSession.lastOccurredAt);
        state.pendingReport = {
          slot, execution, assistance, nextSeq, occurredAt,
          ev: await buildReportSubmittedEvent({
            participantId: state.session.principal.id,
            orgId: state.session.principal.org_id,
            sessionId: state.activeSession.sessionId,
            prescriptionId: rxPayload.prescription_id,
            prescriptionRevision: rxPayload.revision,
            exerciseId: rxPayload.exercise_id,
            seq: nextSeq,
            prevHash: state.activeSession.lastHash,
            occurredAt,
            execution,
            assistance,
          }),
        };
      }
      await client.postEventsBatch([state.pendingReport.ev]);
    });
    if (out.status === "ignored" || out.status === "settled") return; // same intention: one single outcome state
    if (out.status === "ambiguous") {
      showError("RESULT_UNCONFIRMED", tm("pa.js.cmd_retry"));
      return;
    }
    if (out.status === "unknown") {
      showError("RESULT_UNKNOWN", tm("pa.js.cmd_unknown"));
      return;
    }
    if (out.status === "error") {
      state.pendingReport = null;
      handleApiError(out.error);
      return;
    }
    try {
      const submittedExec = execution;
      const submittedAssist = assistance;
      const finishedSessionId = state.activeSession.sessionId;
      state.lastReportSlot = slot;
      state.pendingReport = null;
      state.activeSession = null;
      resetReportChoices();
      updateControlsState();

      const resBox = el("report-result");
      resBox.dataset.reportSubmitted = finishedSessionId;
      resBox.dataset.reportExecution = submittedExec;
      resBox.dataset.reportAssistance = submittedAssist;
      renderBox("report-result", (b) => appendParagraph(b, t("pa.js.report_saved")));
      showSuccess(tm("pa.js.report_sent"));
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
      redirectToSignIn(tm("pa.js.session_required") );
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

  initI18n();
  document.addEventListener("elo:lang", () => {
    updateControlsState();
    for (const id of boxBuilders.keys()) runBox(id);
    if (state.session?.token) loadPublications();
    if (state.prescription) renderPrescription(state.prescription);
    if (!el("goals-panel").hidden) renderGoals(state.goals);
    if (state.summaryData) renderSummaryView(state.summaryData);
    if (state.evolutionData) renderEvolutionView(state.evolutionData);
  });
  updateControlsState();
  if (state.session?.token) loadPublications();

  if (!state.session?.token && PROTECTED_HASHES.has(window.location.hash)) {
    redirectToSignIn(tm("pa.js.session_required") );
  }
}

if (typeof document !== "undefined") {
  initParticipantApp();
}
