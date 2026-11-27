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
import { EventDispatcher } from "./arq05/event_dispatcher.mjs";
import { SessionController } from "./arq05/session_controller.mjs";
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
  function openRecovery() {
    clearTimeout(retryTimer);
    recovery = null;
    state.rec = null;
    const p = state.session?.principal;
    if (!state.session?.token || !p?.id || !p?.org_id) return;
    try {
      const store = new RecoveryStore({ orgId: p.org_id, participantId: p.id }, new StorageAdapter());
      const outbox = new EventOutbox(store);
      recovery = {
        outbox,
        controller: new SessionController(outbox),
        lastError: null,
        dispatcher: new EventDispatcher(outbox, async (evs) => {
          try {
            const res = await client.postEventsBatch(evs);
            if (recovery) recovery.lastError = null;
            return res;
          } catch (err) {
            if (recovery) recovery.lastError = err;
            throw err;
          }
        }),
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
      r = await rec.controller.restore();
    } catch {
      if (recovery === rec && rec.tk.isCurrent()) { state.rec = { error: true }; renderSync(); updateControlsState(); }
      return;
    }
    if (recovery !== rec || !rec.tk.isCurrent()) return;
    const ret = retentionState(record, Date.now());
    state.activeSession = r.phase === "active" || r.phase === "ended"
      ? { sessionId: r.sessionId, phase: r.phase, endAction: r.endAction }
      : null;
    if (r.pending === 0) rec.needsReauth = false;
    state.rec = {
      phase: r.phase, pending: r.pending, conflict: r.conflict,
      expired: ret.expired, fullyConfirmed: ret.fullyConfirmed, needsReauth: rec.needsReauth,
    };
    if (r.phase !== "ended") state.dismissArmed = false;
    renderSync();
    updateControlsState();
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
    try { res = await rec.dispatcher.dispatch(); } catch { res = null; }
    if (recovery !== rec || !rec.tk.isCurrent()) return null;
    await refreshRecovery();
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

  async function endActiveSession(action) {
    if (!requireAuth()) return;
    const rec = recovery;
    if (!rec || state.activeSession?.phase !== "active") {
      showError(
        "INVALID_TRANSITION",
        describeParticipantError({ code: "INVALID_TRANSITION", status: 200 }).msg
      );
      return;
    }
    const tk = ctxStore.capture({ level: "principal" }); // BEFORE the await: the write is never aborted, only its rendering is guarded
    try {
      await rec.controller.stop(action);
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
    boxBuilders.clear();
    state.prescription = null;
    state.goals = [];
    state.activeSession = null;
    clearTimeout(retryTimer);
    recovery = null; // the stored local stream is NOT erased: it stays isolated by organization and principal
    state.rec = null;
    state.dismissArmed = false;
    state.recoveredOrphan = false;
    renderSync();
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
    const autoDismiss = r.phase === "ended" && r.expired && r.fullyConfirmed;
    const dismissReport = r.phase === "ended" && (state.dismissArmed || autoDismiss);
    if (r.phase === "active") { showError("SESSION_BLOCKED", tm("pa.js.sync_blocked_active")); return; }
    if (r.phase === "ended" && !dismissReport) { showError("SESSION_BLOCKED", tm("pa.js.sync_blocked_report")); return; }
    if (r.conflict || (r.pending && r.phase !== "idle")) { showError("SESSION_BLOCKED", tm("pa.js.sync_blocked_unresolved")); return; }
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
      await rec.controller.submitReport({ execution, assistance });
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
