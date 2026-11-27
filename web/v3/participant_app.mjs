import { mountInstructionAudio } from "./assistance/instruction_audio_ui.mjs";
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

import { createContextStore } from "./context_store.mjs";
import { createFeedback } from "./feedback.mjs";
import { loadCatalogs, legacyFindings } from "./domain_fields.mjs";
import { announce } from "./a11y.mjs";
import { createCommandController } from "./command_controller.mjs";
import { createParticipantClient, ParticipantApiError } from "./participant_api.mjs";
import { initI18n, t, tm, bindText, label, unitLabel, formatDateTime, formatIsoDate } from "./i18n.mjs";
import { renderErrorTechnical } from "./ui_messages.mjs";
import {
  PARTICIPANT_DATA_ORIGIN,
  describeParticipantError,
  formatAssistanceTransition,
  organizarAMesaGuide,
  formatExecutionMode,
  formatOriginLabel,
  projectPrescriptionForDisplay,
  resolveEvolutionSeriesOriginLabel,
  resolveSummaryOriginLabel,
} from "./participant_model.mjs";

import { StorageAdapter } from "./arq05/storage_adapter.mjs";
import { RecoveryStore } from "./arq05/recovery_store.mjs";
import { EventOutbox } from "./arq05/event_outbox.mjs";
import { EventDispatcher, dispatchSessionWithConsent } from "./arq05/event_dispatcher.mjs";
import { SessionController } from "./arq05/session_controller.mjs";
import { CaptureController } from "./arq05/capture_controller.mjs";
import { ConsentOutbox } from "./arq05/consent_outbox.mjs";
import { createActivityRunner } from "../s2/arq08/activity_runner.mjs";
import { simulateCalibrationSamples, simulateCycleFrames } from "../s2/arq08/simulation_source.mjs";
import { retentionState } from "./arq05/retention.mjs";

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
    rec: null, // projection of the local recovery stream (ARQ-05)
    dismissArmed: false,
  };
  let recovery = null; // { outbox, controller, dispatcher, tk, needsReauth }
  let retryTimer = null;

  // ARQ-04 / CMP-10: logout and sign-in are context boundaries; reads in flight never repaint another principal.
  const ctxStore = createContextStore();
  ctxStore.switchTo({ principalId: state.session?.principal?.id ?? null, role: "participant", participantId: null });

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
  const audioPreview = new URLSearchParams(location.search).get("s4") === "1"
    ? mountInstructionAudio(el("instruction-audio"), organizarAMesaGuide) : null;

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

  // ARQ-04 / CMP-03: single feedback implementation (exclusive states, announce dedup, owner scope).
  const feedback = createFeedback({ errorBanner, errorBannerText, successBanner, successBannerText, bindText, renderErrorTechnical, announce });
  ctxStore.onReset((reason) => feedback.onContextChange(reason));
  const clearError = () => feedback.clearError();
  const clearSuccess = () => feedback.clearSuccess();
  const showError = (code, message, technical = "") => feedback.showError(code, message, technical, { scope: code === "UNAUTHENTICATED" ? "global" : "participant" });
  const showSuccess = (message) => feedback.showSuccess(message);

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
    } else if (state.activeSession.phase === "created" || state.activeSession.phase === "calibrated") {
      phaseStatusEl.textContent = t(state.activeSession.phase === "created" ? "pa.act.status_created" : "pa.act.status_calibrated");
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
    const op = ctxStore.begin("publications", { level: "principal" });
    try {
      const res = await client.listPublications(state.session.principal.id, { signal: op.signal });
      if (!op.isCurrent()) return;
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
    } catch (err) {
      op.fail(err, () => { status.textContent = t("pa.js.pub_fail"); });
    } finally {
      op.done();
    }
  }

  function updateControlsState() {
    const ph = state.activeSession?.phase;
    const isActive = ph === "active" || ph === "created" || ph === "calibrated"; // an open session of either mode
    const isEnded = ph === "ended";

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
    renderActivity();
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

  // ARQ-04 / CMP-02: legacy marker needs the versioned goal rules; without them (load failure) nothing is marked (never guessed).
  let goalRules = null;
  loadCatalogs().then((c) => { goalRules = c.goalRules; if (state.goals) renderGoals(state.goals); }).catch(() => {});

  function renderGoals(goals) {
    state.goals = goals;
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
      if (legacyFindings(goalRules, goal.target).length) {
        const lb = createBadge(t("shared.legacy_badge"), "badge-legacy", "data-legacy", "true");
        lb.title = t("shared.legacy_hint");
        badges.appendChild(lb);
        li.dataset.legacy = "true";
      }
      li.appendChild(badges);

      appendParagraph(li, String(goal.goal_text || ""));
      const seg = label("segment", goal.body_segment);
      const target = goal.target || {};
      const kindLabel = label("goal_kind", target.kind);
      const valPart =
        target.value !== null && target.value !== undefined
          ? `${target.value}${target.unit ? ` ${unitLabel(target.unit)}` : ""}`
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
    const op = ctxStore.begin("plan", { level: "principal" });
    try {
      const [rxRes, goalsRes] = await Promise.all([
        client.getCurrentPrescription(pid, { signal: op.signal }),
        client.listGoals(pid, { signal: op.signal }),
      ]);
      if (!op.isCurrent()) return false;
      state.prescription = rxRes.data;
      state.goals = Array.isArray(goalsRes.data) ? goalsRes.data : [];
      renderPrescription(state.prescription);
      renderGoals(state.goals);
      renderActivity();
      showSuccess(tm("pa.js.plan_loaded"));
      return true;
    } catch (err) {
      op.fail(err, handleApiError);
      return false;
    } finally {
      op.done();
    }
  }

  // ---- ARQ-05: local-first recovery wiring (synthetic MVP; sessionStorage of this tab only) ----
  function discardRecovery() {
    clearTimeout(retryTimer);
    if (recovery) {
      recovery.cameraStart = null;
      recovery.cam?.unwatch();
      recovery.cam?.stop();
    }
    const video = el("act-cam");
    video?.srcObject?.getTracks().forEach((track) => track.stop());
    if (video) { video.srcObject = null; video.hidden = true; }
    if (el("act-camera-consent")) el("act-camera-consent").checked = false;
    if (el("act-camera-status")) el("act-camera-status").textContent = "";
    recovery = null;
  }

  function openRecovery() {
    discardRecovery();
    state.rec = null;
    const p = state.session?.principal;
    if (!state.session?.token || !p?.id || !p?.org_id) return;
    try {
      const store = new RecoveryStore({ orgId: p.org_id, participantId: p.id }, new StorageAdapter());
      const outbox = new EventOutbox(store);
      let owner;
      const transport = async (evs) => {
        if (recovery !== owner || !owner.tk.isCurrent() || !state.session?.token) throw new Error("STALE_CONTEXT");
        try {
          const res = await client.postEventsBatch(evs);
          if (recovery === owner && owner.tk.isCurrent()) owner.lastError = null;
          return res;
        } catch (err) {
          if (recovery === owner && owner.tk.isCurrent()) owner.lastError = err;
          throw err;
        }
      };
      // Camera consent chain: own local key (it outlives a session record), same transport/dispatcher. Unavailable storage only disables the camera.
      let consent = null;
      try { const consentStore = new ConsentOutbox(new RecoveryStore({ orgId: p.org_id, participantId: p.id }, new StorageAdapter(globalThis.localStorage), { keyPrefix: "elo:s2:consent:v1:" })); consent = consentStore; } catch { consent = null; }
      // A revocation is only sent after the capture events recorded under that consent are stored (the ledger judges consent at ingestion).
      const consentTransport = async (evs) => {
        const cur = await outbox.read().catch(() => null);
        const hold = cur && cur.acknowledged < cur.events.length && cur.mode === "camera";
        const cut = hold ? evs.findIndex((e) => e.type === "consent.revoked") : -1;
        const part = cut >= 0 ? evs.slice(0, cut) : evs;
        if (!part.length) return { data: { results: [] } };
        return transport(part);
      };
      recovery = owner = {
        consent, consentDispatcher: consent ? new EventDispatcher(consent, consentTransport) : null, cam: null, camCal: null,
        outbox,
        controller: new SessionController(outbox),
        capture: new CaptureController(outbox),
        runner: null,
        lastError: null,
        dispatcher: new EventDispatcher(outbox, transport),
        tk: ctxStore.capture({ level: "principal" }),
        needsReauth: true, // recovered events need an explicit user action before being transmitted
      };
    } catch {
      state.rec = { error: true };
    }
  }

  async function refreshRecovery() {
    const rec = recovery;
    if (!rec) { renderSync(); updateControlsState(); return; }
    let r, record;
    try {
      record = await rec.outbox.read();
      r = await rec.capture.restore(); // same outbox for every mode; adds mode and capture stats
    } catch {
      if (recovery === rec && rec.tk.isCurrent()) { state.rec = { error: true }; renderSync(); updateControlsState(); }
      return;
    }
    if (recovery !== rec || !rec.tk.isCurrent()) return;
    const consentActive = Boolean(rec.consent && (await rec.consent.read().catch(() => ({ active: false }))).active);
    if (recovery !== rec || !rec.tk.isCurrent()) return;
    const ret = retentionState(record, Date.now());
    state.activeSession = ["created", "calibrated", "active", "ended"].includes(r.phase)
      ? { sessionId: r.sessionId, phase: r.phase, endAction: r.endAction, mode: r.mode }
      : null;
    if (r.pending === 0) rec.needsReauth = false;
    state.rec = {
      phase: r.phase, mode: r.mode, accepted: r.accepted, candidates: r.candidates, pending: r.pending, conflict: r.conflict,
      expired: ret.expired, fullyConfirmed: ret.fullyConfirmed, needsReauth: rec.needsReauth,
      consentActive,
    };
    if (r.phase !== "ended") state.dismissArmed = false;
    renderSync();
    updateControlsState();
    renderActivity();
  }

  function renderSync() {
    const panel = el("sync-panel");
    if (!panel) return;
    const r = state.rec;
    if (!state.session?.token || !r) { panel.hidden = true; return; }
    panel.hidden = false;
    const status = el("sync-status");
    const notice = el("sync-notice");
    if (r.error) {
      panel.dataset.syncStatus = "error";
      status.textContent = t("pa.js.storage_unavailable");
      notice.textContent = "";
      el("btn-sync-now").hidden = true;
      el("btn-dismiss-report").hidden = true;
      return;
    }
    panel.dataset.syncStatus = r.conflict ? "conflict" : r.pending ? "pending" : "synced";
    panel.dataset.syncPending = String(r.pending);
    status.textContent = r.conflict ? t("pa.js.sync_conflict")
      : r.pending ? t("pa.js.sync_pending", { n: r.pending }) : t("pa.js.sync_synced");
    const msgs = [];
    const kinds = [];
    if (r.pending && r.needsReauth) { msgs.push(t("pa.js.sync_recovered")); kinds.push("recovered"); }
    if (r.pending && r.expired) { msgs.push(t("pa.js.sync_expired")); kinds.push("expired"); }
    if (r.phase === "active" && state.recoveredOrphan) { msgs.push(t("pa.js.sync_orphan")); kinds.push("orphan"); }
    notice.textContent = msgs.join(" ");
    notice.dataset.noticeKind = kinds.join(" ");
    el("btn-sync-now").hidden = !r.pending || Boolean(r.conflict);
    el("btn-dismiss-report").hidden = r.phase !== "ended" || state.dismissArmed;
  }

  // Single transmission attempt. Automatic mode makes at most one delayed retry; conflicts suspend sending entirely.
  async function dispatchNow({ manual = false, retry = false } = {}) {
    const rec = recovery;
    if (!rec || !rec.tk.isCurrent() || !state.session?.token) return null;
    if (!manual && rec.needsReauth) return null;
    clearTimeout(retryTimer);
    let res = null;
    try {
      res = await dispatchSessionWithConsent(rec, () => recovery === rec && rec.tk.isCurrent());
    } catch { res = null; }
    if (recovery !== rec || !rec.tk.isCurrent()) return null;
    await refreshRecovery();
    if (recovery !== rec || !rec.tk.isCurrent()) return null;
    if (res?.status !== "synced" && rec.lastError) {
      const e = rec.lastError;
      rec.lastError = null;
      res = { ...res, errorShown: true };
      handleApiError(e); // a server refusal or transport failure is shown; the local records stay saved
    }
    if (res?.status !== "synced" && !manual && !retry && res?.status !== "conflict") {
      retryTimer = setTimeout(() => { dispatchNow({ retry: true }); }, 3000);
    }
    return res;
  }

  // One gate for a new session of either mode: no open session, no pending report (unless explicitly dismissed), nothing unconfirmed.
  function startGate(r) {
    const autoDismiss = r.phase === "ended" && r.expired && r.fullyConfirmed;
    const dismissReport = r.phase === "ended" && (state.dismissArmed || autoDismiss);
    if (["active", "created", "calibrated"].includes(r.phase)) { showError("SESSION_BLOCKED", tm("pa.js.sync_blocked_active")); return null; }
    if (r.phase === "ended" && !dismissReport) { showError("SESSION_BLOCKED", tm("pa.js.sync_blocked_report")); return null; }
    if (r.conflict || (r.pending && r.phase !== "idle")) { showError("SESSION_BLOCKED", tm("pa.js.sync_blocked_unresolved")); return null; }
    return { dismissReport };
  }

  // ---- S2 experimental activity: simulation (synthetic) and local camera (experimental_capture) on the same runner/outbox. ----
  let simClock = 0;
  let limitsCatalog = null;
  async function loadLimits() {
    if (!limitsCatalog) limitsCatalog = await (await fetch(new URL("./catalogs/limits.v1.json", import.meta.url))).json();
    return limitsCatalog;
  }
  async function finishCapture(rec, action) {
    if (rec.runner) { await rec.runner.finish({ action }); return; }
    // Orphan session after a reload: stop it and close the capture with an empty summary (nothing to count).
    const st = await rec.capture.restore();
    if (["created", "calibrated", "active"].includes(st.phase)) await rec.capture.stop(action);
    await rec.capture.captureSummary({ frames_total: 0, fps_mean: null, fps_min: null, usable_fraction: null, lost_events: 0 });
  }
  function renderActivity() {
    const panel = el("activity-panel");
    if (!panel) return;
    const signed = Boolean(state.session?.token) && state.rec && !state.rec.error;
    panel.hidden = !signed;
    if (!signed) return;
    const ph = state.activeSession?.phase ?? "idle";
    const sim = state.activeSession?.mode === "simulation";
    const cam = state.activeSession?.mode === "camera";
    const camLive = Boolean(recovery?.cam?.active);
    const rx = state.prescription?.payload;
    el("act-dose").textContent = rx ? t("pa.act.dose", { sets: rx.target_sets, reps: rx.target_repetitions, side: label("side", rx.side) }) : t("pa.act.dose_unknown");
    const target = (rx?.target_sets ?? 0) * (rx?.target_repetitions ?? 0);
    const accepted = sim || cam ? state.rec.accepted : 0;
    const prog = el("act-progress");
    prog.max = Math.max(target, 1);
    prog.value = Math.min(accepted, prog.max);
    const mesa = el("act-mesa");
    if (mesa) {
      const slots = Math.min(Math.max(target, 0), 40);
      if (mesa.childElementCount !== slots) mesa.replaceChildren(...Array.from({ length: slots }, () => document.createElement("li")));
      Array.from(mesa.children).forEach((c, i) => c.classList.toggle("placed", i < accepted));
    }
    el("act-progress-text").textContent = t("pa.act.progress", { a: accepted, t: target, c: sim || cam ? state.rec.candidates : 0 });
    el("btn-act-begin").disabled = ["created", "calibrated", "active"].includes(ph);
    const open = ["created", "calibrated", "active"].includes(ph);
    el("btn-act-camera").disabled = open || !recovery?.consent;
    el("btn-act-cal-open").disabled = !(cam && camLive && (ph === "created" || ph === "calibrated") && recovery?.runner);
    el("btn-act-cal-closed").disabled = el("btn-act-cal-open").disabled;
    el("btn-act-revoke").disabled = !camLive && !state.rec?.consentActive;
    el("btn-act-calibrate").disabled = !(sim && (ph === "created" || ph === "calibrated") && recovery?.runner);
    el("btn-act-start").disabled = !((sim || (cam && camLive)) && ph === "calibrated" && recovery?.runner);
    el("btn-act-cycle").disabled = !(sim && ph === "active" && recovery?.runner);
    el("act-sim-side").disabled = el("btn-act-cycle").disabled;
  }
  function actMessage(key, extra) {
    el("act-status").textContent = t(key, extra);
    showSuccess(tm(key, extra));
  }
  async function beginActivity({ mode = "simulation", frame = { width: 640, height: 480 }, deviceHint, beforeBegin, stillCurrent = () => true } = {}) {
    if (!requireAuth()) return false;
    const rec = recovery;
    if (!rec) { showError("RECOVERY_UNAVAILABLE", tm("pa.js.storage_unavailable")); return false; }
    const tk = ctxStore.capture({ level: "principal" });
    const isCurrent = () => tk.isCurrent() && recovery === rec && stillCurrent();
    await refreshRecovery();
    if (!isCurrent()) return false;
    const r = state.rec;
    if (!r || r.error) { showError("RECOVERY_UNAVAILABLE", tm("pa.js.storage_unavailable")); return false; }
    const gate = startGate(r);
    if (!gate) return false;
    if (!state.prescription) {
      const loaded = await loadPlan();
      if (!isCurrent() || !loaded || !state.prescription) return false;
    }
    try {
      const limits = await loadLimits();
      if (!isCurrent()) return false;
      const p = state.session.principal;
      // Opt-in engine (?engine=c04): original c04-hand-1 measurement/guards/calibration checks over the same runner, ledger and Elo repetition definition.
      const c04 = mode === "camera" && ENGINE_C04 ? await import("../s2/arq08/c04_engine.mjs") : null;
      if (!isCurrent()) return false;
      rec.runner = createActivityRunner({
        controller: rec.capture, scope: { org_id: p.org_id, participant_id: p.id },
        prescription: state.prescription.payload, limits, mode,
        ...(c04 ? { protocol: c04.c04Protocol, minSpan: c04.MIN_SPAN, validateCalibration: ({ open, closed }) => c04.calibrationStable(open, closed) } : {}),
      });
      if (beforeBegin) await beforeBegin();
      if (!isCurrent()) return false;
      await rec.runner.begin(frame, { dismissReport: gate.dismissReport }, deviceHint);
    } catch (err) {
      rec.runner = null;
      if (isCurrent()) showError("SESSION_BLOCKED", tm(err?.message === "RECOVERY_STREAM_UNRESOLVED" ? "pa.js.sync_blocked_unresolved" : "pa.act.err_begin"));
      return false;
    }
    if (!isCurrent()) return false;
    state.dismissArmed = false;
    state.recoveredOrphan = false;
    simClock = 0;
    resetReportChoices();
    await refreshRecovery();
    if (!isCurrent()) return false;
    const resBox = el("session-result");
    resBox.dataset.sessionPhase = "created";
    resBox.dataset.sessionMode = mode;
    resBox.dataset.sessionId = state.activeSession?.sessionId || "";
    renderBox("session-result", (b) => appendParagraph(b, t("pa.act.begun")));
    actMessage(mode === "camera" ? "pa.act.cam_ready" : "pa.act.begun");
    dispatchNow();
    return true;
  }
  async function activityStep(fn, okKey) {
    const rec = recovery;
    if (!requireAuth() || !rec?.runner) return;
    const tk = ctxStore.capture({ level: "principal" });
    let out;
    try { out = await fn(rec.runner); } catch { if (tk.isCurrent()) showError("INVALID_TRANSITION", describeParticipantError({ code: "INVALID_TRANSITION", status: 200 }).msg); return; }
    if (!tk.isCurrent() || recovery !== rec) return;
    await refreshRecovery();
    if (okKey) actMessage(okKey);
    dispatchNow();
    return out;
  }
  async function calibrateActivity() {
    const rec = recovery;
    if (!rec?.runner) return;
    const tk = ctxStore.capture({ level: "principal" });
    let out;
    try { out = await rec.runner.calibrate(simulateCalibrationSamples()); } catch { if (tk.isCurrent()) showError("INVALID_TRANSITION", describeParticipantError({ code: "INVALID_TRANSITION", status: 200 }).msg); return; }
    if (!tk.isCurrent() || recovery !== rec) return;
    await refreshRecovery();
    el("btn-act-calibrate").dataset.calibration = out.status;
    if (out.status === "ready") actMessage("pa.act.calibrated");
    else showError("CALIBRATION_FAILED", tm(out.status === "invalid_span" ? "pa.act.cal_span" : "pa.act.cal_insufficient"));
    dispatchNow();
  }
  async function simulateCycle() {
    const rec = recovery;
    if (!rec?.runner) return;
    const tk = ctxStore.capture({ level: "principal" });
    const raw = el("act-sim-side").value;
    const side = raw === "unknown" ? null : raw;
    const frames = simulateCycleFrames({ startMs: (simClock += 2000), side });
    simClock = frames.at(-1).timeMs;
    let last;
    for (const fr of frames) last = rec.runner.feed(fr);
    await rec.runner.flush();
    if (!tk.isCurrent() || recovery !== rec) return;
    await refreshRecovery();
    const phase = state.activeSession?.phase;
    const key = state.rec.phase === "ended" ? "pa.act.dose_reached" : side === null ? "pa.act.cycle_unknown"
      : side !== state.prescription?.payload?.side ? "pa.act.cycle_rejected" : "pa.act.cycle_ok";
    if (state.rec.phase === "ended" && phase === "ended") {
      try { await rec.runner.finish({ action: "end" }); } catch { /* summary appended once; a failed append stays visible as pending */ }
      await refreshRecovery();
      resetReportChoices();
      updateControlsState();
    }
    el("act-status").dataset.lastCycle = last?.status ?? "";
    actMessage(key);
    dispatchNow();
  }
  el("btn-act-begin")?.addEventListener("click", () => beginActivity());
  el("btn-act-calibrate")?.addEventListener("click", calibrateActivity);
  el("btn-act-start")?.addEventListener("click", () => (state.activeSession?.mode === "camera" ? startCameraCounting() : activityStep((r) => r.start(), "pa.act.counting")));
  el("btn-act-cycle")?.addEventListener("click", simulateCycle);

  // ---- S2 local camera (MediaPipe from ./vendor, same origin). Consent first; images and raw landmarks never leave the detector. ----
  const camHint = () => {
    const ua = globalThis.navigator?.userAgent ?? "";
    const mobile = /Android|iPhone|iPad|Mobile/i.test(ua);
    if (/Edg\//.test(ua)) return mobile ? "mobile-other" : "desktop-edge";
    if (/Chrome\//.test(ua)) return mobile ? "mobile-chrome" : "desktop-chrome";
    if (/Safari\//.test(ua) && mobile) return "mobile-safari";
    return mobile ? "mobile-other" : "desktop-other";
  };
  const camStatus = (key, extra) => { el("act-camera-status").textContent = t(key, extra); announce(t(key, extra)); };
  async function refreshAfterCamera(rec) {
    if (recovery !== rec) return;
    await refreshRecovery();
    if (recovery !== rec || !rec.tk.isCurrent()) return;
    updateControlsState();
    renderActivity();
  }
  async function closeCameraActivity(rec, { action, interruptReason = null, messageKey, doseReached = false }) {
    rec.cameraStart = null;
    rec.cam?.unwatch();
    rec.cam?.stop();
    rec.camCal = null;
    if (rec.runner && ["created", "calibrated", "active"].includes(state.activeSession?.phase ?? "")) {
      try { await rec.runner.finish({ action, interruptReason }); } catch { /* the summary is appended once; a failed append stays visible as pending */ }
    } else if (doseReached && rec.runner && state.rec?.phase === "ended" && state.activeSession?.phase === "ended") {
      try { await rec.runner.finish({ action: "end" }); } catch { /* dose already reached */ }
    }
    if (recovery !== rec) return;
    resetReportChoices();
    await refreshAfterCamera(rec);
    if (recovery !== rec || !rec.tk.isCurrent()) return;
    if (messageKey) actMessage(messageKey);
    dispatchNow();
  }
  const ENGINE_C04 = new URLSearchParams(globalThis.location?.search ?? "").get("engine") === "c04";
  // Local preview of the hand (21 points + connections), drawn automatically while a hand is detected. Drawing only: nothing is stored, encoded or sent.
  const HAND_LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
  function drawPreview(lm) {
    const cvs = el("act-landmarks"), vid = el("act-cam");
    if (!cvs) return;
    const g = cvs.getContext("2d");
    if (!lm || lm.length !== 21 || !vid.videoWidth) { g.clearRect(0, 0, cvs.width, cvs.height); cvs.hidden = true; return; }
    if (cvs.width !== vid.videoWidth || cvs.height !== vid.videoHeight) { cvs.width = vid.videoWidth; cvs.height = vid.videoHeight; }
    cvs.hidden = false;
    g.clearRect(0, 0, cvs.width, cvs.height);
    const at = (p) => [p.x * cvs.width, p.y * cvs.height];
    g.lineCap = "round";
    for (const [w, c] of [[7, "#262626"], [3, "#fff56b"]]) {
      g.lineWidth = w; g.strokeStyle = c; g.beginPath();
      for (const [i, j] of HAND_LINKS) { g.moveTo(...at(lm[i])); g.lineTo(...at(lm[j])); }
      g.stroke();
    }
    g.fillStyle = "#ffffff"; g.strokeStyle = "#262626"; g.lineWidth = 2;
    for (const p of lm) { g.beginPath(); g.arc(...at(p), 5, 0, 6.2832); g.fill(); g.stroke(); }
  }
  async function fillDevices() {
    const sel = el("act-device");
    if (!sel || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput" && d.deviceId);
      const keep = sel.value;
      sel.replaceChildren(new Option(t("pa.act.device_default"), ""), ...cams.map((d, i) => new Option(d.label || `${t("pa.act.device")} ${i + 1}`, d.deviceId)));
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    } catch { /* device list is optional */ }
  }
  void fillDevices();
  async function startCameraActivity() {
    if (!requireAuth()) return;
    const rec = recovery;
    if (!rec?.consent) { showError("CAMERA_UNAVAILABLE", tm("pa.act.cam_fallback")); return; }
    if (!el("act-camera-consent").checked) { showError("CONSENT_REQUIRED", tm("pa.act.cam_consent_needed")); return; }
    if (rec.cameraStart || rec.cam?.active) return;
    const tk = ctxStore.capture({ level: "principal" });
    rec.cameraStart = tk;
    const isCurrent = () => tk.isCurrent() && recovery === rec && rec.cameraStart === tk;
    let cam;
    try {
      await refreshRecovery();
      if (!isCurrent() || !(state.rec && !state.rec.error && startGate(state.rec))) return;
      camStatus("pa.act.cam_loading");
      await rec.consent.record("consent.accepted");
      if (!isCurrent()) return;
      await dispatchNow({ manual: true });
      if (!isCurrent()) return;
      const cs = await rec.consent.read();
      if (!isCurrent()) return;
      if (cs.acknowledged !== cs.events.length || cs.conflict || !cs.active) {
        camStatus("pa.act.cam_consent_unsent");
        showError("CONSENT_UNCONFIRMED", tm("pa.act.cam_consent_unsent"));
        return;
      }
      const { createCameraSession } = await import("../s2/arq08/camera_session.mjs");
      if (!isCurrent()) return;
      const session = createCameraSession({ video: el("act-cam"), engine: ENGINE_C04 ? "c04" : null, onPreview: drawPreview, onInterrupted: (reason) => {
        if (recovery === rec && rec.tk.isCurrent() && rec.cam === session)
          void closeCameraActivity(rec, { action: "interrupt", interruptReason: reason, messageKey: "pa.act.cam_interrupted" });
      } });
      rec.cam = cam = session;
      const out = await cam.start({ consent: true, deviceId: el("act-device")?.value || null });
      if (!isCurrent()) return;
      if (out.status !== "ready") throw new Error("CAMERA_UNAVAILABLE");
      const ok = await beginActivity({ mode: "camera", frame: out.frame, deviceHint: camHint(), stillCurrent: isCurrent });
      if (!isCurrent() || !ok) return;
      camStatus("pa.act.cam_ready");
      void fillDevices();
      renderActivity();
      cam = null; // leave the current session open
    } catch {
      if (isCurrent()) {
        camStatus("pa.act.cam_fallback");
        showError("CAMERA_UNAVAILABLE", tm("pa.act.cam_fallback"));
      }
    } finally {
      if (cam) {
        cam.unwatch();
        cam.stop();
        if (rec.cam === cam) rec.cam = null;
      }
      if (rec.cameraStart === tk) rec.cameraStart = null;
    }
  }
  async function calibrateCamera(posture) {
    const rec = recovery;
    if (!rec?.cam?.active || !rec.runner) return;
    if (posture === "closed" && !rec.camCal?.open) { showError("CALIBRATION_FAILED", tm("pa.act.cam_closed_first")); return; }
    const tk = ctxStore.capture({ level: "principal" });
    el("btn-act-cal-open").disabled = el("btn-act-cal-closed").disabled = true;
    camStatus(posture === "open" ? "pa.act.cam_collect_open" : "pa.act.cam_collect_closed");
    const values = await rec.cam.collect(3000);
    if (!tk.isCurrent() || recovery !== rec || !rec.cam?.active) return;
    rec.camCal = { ...(rec.camCal ?? {}), [posture]: values };
    if (posture === "open") { camStatus("pa.act.cam_open_done"); renderActivity(); return; }
    const samples = { open: rec.camCal.open, closed: rec.camCal.closed };
    rec.camCal = null;
    let out;
    try { out = await rec.runner.calibrate(samples); } catch { if (!tk.isCurrent() || recovery !== rec) return; showError("INVALID_TRANSITION", describeParticipantError({ code: "INVALID_TRANSITION", status: 200 }).msg); renderActivity(); return; }
    await refreshAfterCamera(rec);
    if (!tk.isCurrent() || recovery !== rec || !rec.cam?.active) return;
    el("btn-act-cal-open").dataset.calibration = out.status;
    if (out.status === "ready") { camStatus("pa.act.calibrated"); showSuccess(tm("pa.act.calibrated")); }
    else showError("CALIBRATION_FAILED", tm(out.status === "invalid_span" ? "pa.act.cal_span" : "pa.act.cal_insufficient"));
    dispatchNow();
  }
  async function startCameraCounting() {
    const rec = recovery;
    if (!rec?.cam?.active || !rec.runner) return;
    await activityStep((r) => r.start(), null);
    if (recovery !== rec || !rec.tk.isCurrent() || !rec.cam?.active) return;
    const { phase } = await rec.capture.restore();
    if (recovery !== rec || !rec.tk.isCurrent() || !rec.cam?.active || phase !== "active") return;
    camStatus("pa.act.cam_counting_hint");
    let busy = false;
    rec.cam.watch((frame) => {
      const r = rec.runner.feed(frame);
      if ((r.status === "accepted" || r.status === "rejected") && !busy) {
        busy = true;
        rec.runner.flush().then(async () => {
          await refreshAfterCamera(rec);
          if (recovery !== rec || !rec.tk.isCurrent() || !rec.cam?.active) return;
          if (state.rec?.phase === "ended") await closeCameraActivity(rec, { action: "end", messageKey: "pa.act.dose_reached", doseReached: true });
          else dispatchNow();
        }).finally(() => { busy = false; });
      }
    });
  }
  async function revokeCamera() {
    const rec = recovery;
    if (!rec) return;
    const open = ["created", "calibrated", "active"].includes(state.activeSession?.phase ?? "");
    // The camera is switched off first; the session (if any) is closed as interrupted; the revocation is chained after it.
    await closeCameraActivity(rec, { action: "interrupt", interruptReason: open ? "consent_revoked" : null });
    if (recovery !== rec || !rec.tk.isCurrent()) return;
    try { await rec.consent?.record("consent.revoked"); } catch { /* chain unresolved: shown through the sync panel */ }
    if (recovery !== rec || !rec.tk.isCurrent()) return;
    rec.cam = null;
    el("act-camera-consent").checked = false;
    await refreshAfterCamera(rec);
    if (recovery !== rec || !rec.tk.isCurrent()) return;
    camStatus("pa.act.cam_revoked");
    dispatchNow({ manual: true });
  }
  el("btn-act-camera")?.addEventListener("click", startCameraActivity);
  el("btn-act-cal-open")?.addEventListener("click", () => calibrateCamera("open"));
  el("btn-act-cal-closed")?.addEventListener("click", () => calibrateCamera("closed"));
  el("btn-act-revoke")?.addEventListener("click", revokeCamera);

  async function endActiveSession(action) {
    audioPreview?.stop();
    if (!requireAuth()) return;
    const rec = recovery;
    if (!rec || !["active", "created", "calibrated"].includes(state.activeSession?.phase)) {
      showError(
        "INVALID_TRANSITION",
        describeParticipantError({ code: "INVALID_TRANSITION", status: 200 }).msg
      );
      return;
    }
    const tk = ctxStore.capture({ level: "principal" }); // BEFORE the await: the write is never aborted, only its rendering is guarded
    try {
      if (state.activeSession.mode === "simulation" || state.activeSession.mode === "camera") { rec.cam?.stop(); await finishCapture(rec, action); }
      else await rec.controller.stop(action);
    } catch {
      if (tk.isCurrent()) showError("INVALID_TRANSITION", describeParticipantError({ code: "INVALID_TRANSITION", status: 200 }).msg);
      return;
    }
    if (!tk.isCurrent() || recovery !== rec) return; // signed out meanwhile: the event stays in the local stream; nothing is rendered
    state.recoveredOrphan = false;
    resetReportChoices();
    await refreshRecovery();

    const resBox = el("session-result");
    resBox.dataset.sessionPhase = "ended";
    resBox.dataset.endAction = action;
    const msgKey = action === "pain" ? "pa.js.stop_pain" : action === "fatigue" ? "pa.js.stop_fatigue" : "pa.js.stop_done";
    renderBox("session-result", (b) => appendParagraph(b, t(msgKey)));
    showSuccess(tm(msgKey));
    dispatchNow();
  }

  async function openSummaryById(summaryId) {
    if (!requireAuth()) return;
    const clean = (summaryId || "").trim();
    if (!clean) {
      showError("NOT_FOUND", tm("pa.js.need_sum_id"));
      return;
    }
    const op = ctxStore.begin("summary", { level: "principal" });
    try {
      const res = await client.getSummary(clean, { signal: op.signal });
      if (!op.isCurrent()) return;
      renderSummaryView(res.data);
      showSuccess(tm("pa.js.sum_loaded", { id: res.data.summary_id }));
    } catch (err) {
      op.fail(err, (e) => {
        el("summary-view").hidden = true;
        clearElement(el("summary-view"));
        handleApiError(e);
      });
    } finally {
      op.done();
    }
  }

  async function openEvolutionById(evolutionId) {
    if (!requireAuth()) return;
    const clean = (evolutionId || "").trim();
    if (!clean) {
      showError("NOT_FOUND", tm("pa.js.need_evo_id"));
      return;
    }
    const op = ctxStore.begin("evolution", { level: "principal" });
    try {
      const res = await client.getEvolution(clean, { signal: op.signal });
      if (!op.isCurrent()) return;
      renderEvolutionView(res.data);
      showSuccess(tm("pa.js.evo_loaded"));
    } catch (err) {
      op.fail(err, (e) => {
        el("evolution-view").hidden = true;
        clearElement(el("evolution-view"));
        handleApiError(e);
      });
    } finally {
      op.done();
    }
  }

  // FIX-43: logout / principal change empties EVERY visible surface and in-memory participant data at once
  // (goals, prescription, publications, summary, evolution, identification, session/report results, feedback).
  // Pending-session recovery data (pendingReport / command slots) is NOT touched here: that policy belongs to ARQ-05.
  function clearParticipantSurfaces() {
    audioPreview?.stop();
    boxBuilders.clear();
    state.prescription = null;
    state.goals = [];
    state.activeSession = null;
    discardRecovery(); // the stored local stream is NOT erased
    state.rec = null;
    state.dismissArmed = false;
    state.recoveredOrphan = false;
    renderSync();
    renderActivity();
    el("act-status") && (el("act-status").textContent = "");
    state.summaryData = null;
    state.evolutionData = null;
    resetReportChoices();
    for (const id of ["prescription-view", "session-result", "report-result", "signin-result", "summary-view", "evolution-view"]) {
      const box = el(id);
      if (!box) continue;
      clearElement(box);
      box.hidden = true;
      for (const k of Object.keys(box.dataset)) delete box.dataset[k];
    }
    const goalsList = el("goals-list");
    if (goalsList) clearElement(goalsList);
    const goalsPanel = el("goals-panel");
    if (goalsPanel) goalsPanel.hidden = true;
    const pubList = el("publication-list");
    if (pubList) clearElement(pubList);
    for (const id of ["summary-id-input", "evolution-id-input"]) { const i = el(id); if (i) i.value = ""; }
    clearError();
    clearSuccess();
    updateControlsState();
  }

  // --- Event bindings ---

  btnSignout.addEventListener("click", () => {
    ctxStore.reset("logout"); // aborts reads, invalidates write tickets: nothing in flight may repaint afterwards
    state.session = null;
    writeStoredSession(null);
    clearParticipantSurfaces();
    loadPublications();
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
    const authOp = ctxStore.begin("auth", { level: "principal" }); // PA-01: obsolete sign-in responses never install a session
    try {
      const res = await client.redeemInvite(tokenVal);
      if (!authOp.isCurrent()) return;
      authOp.done();
      state.session = {
        token: res.data.token,
        expires_at: res.data.expires_at,
        principal: res.data.principal,
      };
      writeStoredSession(state.session);
      ctxStore.switchTo({ principalId: res.data.principal.id, role: "participant", participantId: null });
      clearParticipantSurfaces();
      openRecovery();
      state.recoveredOrphan = true;
      refreshRecovery();
      loadPublications();

      renderBox("signin-result", (b) => appendParagraph(b, t("pa.js.access_granted")));
      showSuccess(tm("pa.js.signed_in_ok"));
    } catch (err) {
      authOp.fail(err, handleApiError);
    } finally {
      authOp.done();
    }
  });

  // Step 2: Load prescription & goals
  el("btn-load-plan").addEventListener("click", () => {
    loadPlan();
  });

  // Step 3: Start report-only "Organizar a mesa" session
  btnSessionStart.addEventListener("click", async () => {
    if (!requireAuth()) return;
    const rec = recovery;
    if (!rec) { showError("RECOVERY_UNAVAILABLE", tm("pa.js.storage_unavailable")); return; }
    await refreshRecovery();
    const r = state.rec;
    if (!r || r.error) { showError("RECOVERY_UNAVAILABLE", tm("pa.js.storage_unavailable")); return; }
    const gate = startGate(r);
    if (!gate) return;
    const { dismissReport } = gate;
    if (!state.prescription) {
      const loaded = await loadPlan();
      if (!loaded || !state.prescription) return;
    }
    const rxPayload = state.prescription.payload;
    const tk = ctxStore.capture({ level: "principal" });
    try {
      await rec.controller.start({
        prescriptionId: rxPayload.prescription_id,
        prescriptionRevision: rxPayload.revision,
        exerciseId: rxPayload.exercise_id,
      }, { dismissReport });
    } catch (err) {
      if (!tk.isCurrent()) return;
      const code = err?.message === "RECOVERY_STREAM_UNRESOLVED" ? "pa.js.sync_blocked_unresolved" : null;
      if (code) showError("SESSION_BLOCKED", tm(code));
      else handleApiError(err);
      return;
    }
    if (!tk.isCurrent() || recovery !== rec) return;
    state.dismissArmed = false;
    state.recoveredOrphan = false;
    resetReportChoices();
    await refreshRecovery();
    const resBox = el("session-result");
    resBox.dataset.sessionPhase = "active";
    resBox.dataset.sessionId = state.activeSession?.sessionId || "";
    renderBox("session-result", (b) => appendParagraph(b, t("pa.js.started_detail")));
    showSuccess(tm("pa.js.started"));
    dispatchNow();
  });

  el("btn-sync-now")?.addEventListener("click", async () => {
    if (!requireAuth() || !recovery) return;
    const rec = recovery;
    rec.needsReauth = false; // explicit user action = reauthorization to transmit recovered events
    const res = await dispatchNow({ manual: true });
    if (recovery !== rec) return;
    if (res?.status === "synced") showSuccess(tm("pa.js.sync_sent"));
    else if (res?.status === "conflict") showError("SYNC_CONFLICT", tm("pa.js.sync_conflict"));
    else if (!res?.errorShown) showError("SYNC_FAILED", tm("pa.js.sync_failed"));
  });

  el("btn-dismiss-report")?.addEventListener("click", async () => {
    if (!requireAuth()) return;
    await refreshRecovery();
    const r = state.rec;
    if (!r || r.phase !== "ended") return;
    if (r.pending || r.conflict) { showError("DISMISS_REFUSED", tm("pa.js.sync_dismiss_refused")); return; }
    state.dismissArmed = true;
    resetReportChoices();
    renderSync();
    updateControlsState();
    showSuccess(tm("pa.js.sync_dismiss_info"));
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
    const rec = recovery;
    if (!rec || state.dismissArmed) {
      showError("INVALID_TRANSITION", describeParticipantError({ code: "INVALID_TRANSITION", status: 200 }).msg);
      return;
    }
    const tk = ctxStore.capture({ level: "principal" });
    const slot = `report@${state.activeSession.sessionId}`;
    const execution = state.reportExecution;
    const assistance = state.reportAssistance;
    // The report is appended ONCE to the local chain (one event_id/seq/hash per intention); transmission is separate.
    const out = await commands.run(slot, async () => {
      await (state.activeSession?.mode === "simulation" || state.activeSession?.mode === "camera" ? rec.capture : rec.controller).submitReport({ execution, assistance });
    });
    if (!tk.isCurrent()) return; // signed out while in flight: nothing shown; the command slot keeps its state for recovery (ARQ-05)
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
      showError("INVALID_TRANSITION", describeParticipantError({ code: "INVALID_TRANSITION", status: 200 }).msg);
      return;
    }
    try {
      const submittedExec = execution;
      const submittedAssist = assistance;
      const finishedSessionId = state.activeSession.sessionId;
      state.lastReportSlot = slot;
      resetReportChoices();
      await refreshRecovery();
      if (recovery !== rec || !tk.isCurrent()) return;

      const resBox = el("report-result");
      resBox.dataset.reportSubmitted = finishedSessionId;
      resBox.dataset.reportExecution = submittedExec;
      resBox.dataset.reportAssistance = submittedAssist;
      renderBox("report-result", (b) => appendParagraph(b, t("pa.js.report_saved")));
      const sent = await dispatchNow();
      if (recovery !== rec || !tk.isCurrent()) return;
      if (sent?.status === "synced") showSuccess(tm("pa.js.report_sent"));
      else showSuccess(tm("pa.js.report_saved"));
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
    renderSync();
    renderActivity();
    for (const id of boxBuilders.keys()) runBox(id);
    if (state.session?.token) loadPublications();
    if (state.prescription) renderPrescription(state.prescription);
    if (!el("goals-panel").hidden) renderGoals(state.goals);
    if (state.summaryData) renderSummaryView(state.summaryData);
    if (state.evolutionData) renderEvolutionView(state.evolutionData);
  });
  openRecovery();
  state.recoveredOrphan = true;
  refreshRecovery();
  updateControlsState();
  if (state.session?.token) loadPublications();

  if (!state.session?.token && PROTECTED_HASHES.has(window.location.hash)) {
    redirectToSignIn(tm("pa.js.session_required") );
  }
}

if (typeof document !== "undefined") {
  initParticipantApp();
}
