/**
 * Elo v3 — Therapist journey browser controller (S1-03).
 *
 * Strictly uses /api/v3 endpoints via api_client.mjs, RFC 8785 hashing via canonical.mjs,
 * pure review-gate & formatting rules via therapist_model.mjs, and the sole live region
 * announcer via a11y.mjs. Zero legacy imports.
 */

import { announce } from "./a11y.mjs";
import { createV3Client, V3ApiError } from "./api_client.mjs";
import { createCommandController } from "./command_controller.mjs";
import { hashCanonical } from "./canonical.mjs";
import { renderErrorTechnical } from "./ui_messages.mjs";
import { validateDateFields } from "./date_field.mjs";
import { setFieldError } from "./field_error.mjs";
import { violationFromApiError } from "./validation_registry.mjs";
import { loadCatalogs, instrumentEntries, instrumentFromSelection, instrumentViolations, doseViolations, buildItem, itemViolations, goalTargetSpec, buildGoalTarget, goalTargetViolations, FIELD_FOR_PATH } from "./domain_fields.mjs";
import { applyI18n, initI18n, t, tm, lref, bindText, label, formatDate, formatDateTime, formatIsoDate } from "./i18n.mjs";
import {
  canPublishEvolution,
  canPublishSummary,
  evaluateFactGate,
  describeApiError,
  formatAssistanceTransition,
  formatExecutionMode,
  formatOriginLabel,
  getPublishableEvolutionSeries,
  getPublishableSummaryItems,
} from "./therapist_model.mjs";

const SESSION_STORAGE_KEY = "elo_v3_therapist_session";

const CONTEXT_STORAGE_KEY = "elo_v3_therapist_ctx";

function readStoredContext() {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(CONTEXT_STORAGE_KEY) || "null");
    if (parsed && typeof parsed.participantId === "string" && parsed.participantId) return parsed;
  } catch {
    // Ignore storage read errors.
  }
  return null;
}

function writeStoredContext(ctx) {
  try {
    if (ctx) window.sessionStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(ctx));
    else window.sessionStorage.removeItem(CONTEXT_STORAGE_KEY);
  } catch {
    // Ignore storage write errors.
  }
}

const PROTECTED_HASHES = new Set([
  "#sec-participant",
  "#sec-assessment",
  "#sec-goal",
  "#sec-prescription",
  "#sec-facts",
  "#sec-publications",
  "#sec-timeline",
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

function createBadge(text, extraClass, dataAttrName, dataAttrVal) {
  const span = document.createElement("span");
  span.className = `badge ${extraClass || ""}`.trim();
  span.textContent = text;
  if (dataAttrName) {
    span.setAttribute(dataAttrName, String(dataAttrVal ?? ""));
  }
  return span;
}

function appendParagraph(parent, text, className = "") {
  const p = document.createElement("p");
  if (className) p.className = className;
  p.textContent = text;
  parent.appendChild(p);
  return p;
}

function clearElement(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

export function initTherapistApp() {
  const state = {
    session: readStoredSession(),
    participantId: "",
    participantAlias: "",
    careLinkId: "",
    side: "right",
    factEntries: [],
    effectiveReviews: {},
    ctxSeq: 0, // bumps on every participant change: late responses of a previous context are discarded
    reviewEpoch: 0, // bumps on every recorded review: a fact load that raced with it is repeated
    factsLoadSeq: 0,
    evolutionSeries: [],
    evolutionNotices: [],
    evolutionContextChanges: {},
    publishedSummary: null,
    publishedEvolution: null,
    timelineItems: [],
    listView: null,
  };

  const client = createV3Client({
    getToken: () => state.session?.token || null,
  });

  // CMP-07: one Idempotency-Key per business intention, single-flight, bounded retry window (ARQ-02).
  const commands = createCommandController({ consumeUntilEdit: true });
  async function syncRetention() {
    try {
      const res = await client.health();
      commands.setRetentionDays(res.headers.get("idempotency-retention-days"));
    } catch {
      /* keep the contract minimum (1 day) */
    }
  }
  const errorBanner = el("error-banner");
  const errorBannerText = el("error-banner-text");
  const successBanner = el("success-banner");
  const successBannerText = el("success-banner-text");
  const sessionSummary = el("session-summary");
  const participantSummary = el("active-participant-summary");
  const btnSignout = el("btn-signout");
  const btnPublishSummary = el("btn-publish-summary");
  const btnPublishEvolution = el("btn-publish-evolution");
  const summaryGateStatus = el("summary-gate-status");
  const evolutionGateStatus = el("evolution-gate-status");

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
    // Row 3: Never show success when an error occurs.
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
    const msg = reasonText || describeApiError({ code: "UNAUTHENTICATED", status: 401 }).msg;
    showError("UNAUTHENTICATED", msg, technical);
    if (window.location.hash !== "#sec-signin") {
      window.location.hash = "#sec-signin";
    }
    const userInput = el("signin-username");
    if (userInput) {
      userInput.focus();
    }
  }

  // Runs one keyed command. Success and error are mutually exclusive; ambiguous results keep the same key.
  // An intention belongs to a form AND to the active participant: switching participant never reuses a key/state.
  const slotOf = (id) => (id === "participant" ? id : `${id}@${state.participantId || ""}`);
  const COMMAND_FORMS = { participant: "form-participant", assessment: "form-assessment", goal: "form-goal", prescription: "form-prescription", summary: "form-summary", evolution: "form-evolution" };
  // A user edit (typing, selecting, reset) is what starts a NEW intention; never elapsed time or content comparison.
  for (const [id, formId] of Object.entries(COMMAND_FORMS)) {
    const form = document.getElementById(formId);
    if (!form) continue;
    // Only genuine user edits count: programmatic value changes, i18n re-translation and language switches fire no trusted event.
    const edited = (ev) => { if (ev.isTrusted) { commands.release(slotOf(id)); document.getElementById("btn-cmd-another")?.remove(); } };
    form.addEventListener("input", edited);
    form.addEventListener("change", edited);
  }
  // Explicit "new intention" transition after a success: the user can register another operation with identical
  // content without editing a field. Starts a NEW intention (new Idempotency-Key) only on this deliberate action.
  function offerAnotherIntention(formId) {
    document.getElementById("btn-cmd-another")?.remove();
    if (commands.stateOf(formId) !== "settled" || successBanner.hidden) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "btn-cmd-another";
    btn.className = "btn btn-secondary target";
    bindText(btn, tm("th.js.cmd_another"));
    btn.addEventListener("click", () => {
      commands.startNewIntention(formId);
      btn.remove();
      announce(tm("th.js.cmd_another_done"), { politeness: "polite" });
    });
    successBanner.appendChild(btn);
  }
  async function cmd(rawFormId, send, onOk, signature) {
    const formId = slotOf(rawFormId);
    errorBanner.querySelector("#btn-cmd-new-intention")?.remove();
    const out = await commands.run(formId, send, { signature });
    if (out.status === "ignored") return;
    if (out.status === "settled") {
      announce(tm("th.js.cmd_settled"), { politeness: "polite" }); // same intention already fulfilled: no new record
      return;
    }
    if (out.status === "ok") {
      try {
        const r = await onOk(out.result);
        if (r !== "stale") offerAnotherIntention(formId);
      } catch (err) {
        handleApiError(err);
      }
      return;
    }
    if (out.status === "ambiguous") {
      showError("RESULT_UNCONFIRMED", tm("th.js.cmd_retry"));
      return;
    }
    if (out.status === "unknown") {
      showError("RESULT_UNKNOWN", tm("th.js.cmd_unknown"));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = "btn-cmd-new-intention";
      btn.className = "btn btn-secondary target";
      bindText(btn, tm("th.js.cmd_new_intention"));
      btn.addEventListener("click", () => {
        commands.startNewIntention(formId);
        btn.remove();
        clearError();
        announce(tm("th.js.cmd_new_intention_done"));
      });
      errorBanner.appendChild(btn);
      return;
    }
    handleApiError(out.error);
  }
  const domainCatalogs = { goalRules: null, instruments: null, units: null, limits: null };

  function handleApiError(err) {
    const apiErr =
      err instanceof V3ApiError
        ? err
        : new V3ApiError({
            code: err?.code || "UNKNOWN_ERROR",
            status: err?.status || 0,
            message: err instanceof Error ? err.message : String(err),
          });
    const info = describeApiError(apiErr);
    const viol = violationFromApiError(apiErr);
    const fieldId = viol && FIELD_FOR_PATH[viol.path];
    if (fieldId && document.getElementById(fieldId)) setFieldError(document.getElementById(fieldId), tm(`rule.${viol.rule}`));
    if (apiErr.code === "UNAUTHENTICATED") {
      redirectToSignIn(info.msg, info.technical);
      return;
    }
    showError(apiErr.code, info.msg, info.technical);
  }

  function requireAuth() {
    if (!state.session || !state.session.token) {
      redirectToSignIn(tm("th.js.session_required"));
      return false;
    }
    return true;
  }

  function requireParticipant() {
    if (!requireAuth()) return false;
    const pid = state.participantId.trim();
    if (!pid) {
      showError("PARTICIPANT_REQUIRED", tm("th.js.need_participant"));
      el("participant-alias")?.focus();
      return false;
    }
    return true;
  }

  function updateSessionBar() {
    if (state.session && state.session.token) {
      const p = state.session.principal || {};
      const role = p.role ? label("role", p.role) : t("enum.unknown");
      const id = p.id || t("enum.unknown");
      const org = p.org_id || t("enum.unknown");
      sessionSummary.textContent = t("th.js.session_bar", { id, role, org });
      btnSignout.hidden = false;
    } else {
      sessionSummary.textContent = t("th.js.session_required");
      btnSignout.hidden = true;
    }

    if (state.participantId) {
      const aliasPart = state.participantAlias ? ` (${state.participantAlias})` : "";
      participantSummary.textContent = t("th.js.active_participant", { name: state.participantAlias || state.participantId }) + (aliasPart ? "" : "");
    } else {
      participantSummary.textContent = t("th.js.no_participant");
    }
  }

  function clearEvolutionSeriesCache() {
    state.evolutionSeries = [];
    state.evolutionNotices = [];
    state.evolutionContextChanges = {};
    renderEvolutionSeries();
  }

  const PARTICIPANT_RESULT_BOXES = [
    "participant-result",
    "assessment-result",
    "goal-result",
    "prescription-result",
    "summary-result",
    "evolution-result",
    "invite-result",
  ];

  // Result boxes are rebuilt from their builder so a language switch re-translates them (E-correction 3/4/5).
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

  function setActiveParticipant(participantId, alias = "", careLinkId = "", side = "") {
    const changed = state.participantId !== participantId;
    if (changed) {
      state.ctxSeq += 1;
      // Isolation between participants: nothing from the previous one may stay on screen or in memory.
      state.participantAlias = "";
      state.careLinkId = "";
      state.publishedSummary = null;
      state.publishedEvolution = null;
      state.timelineItems = [];
      for (const id of boxBuilders.keys()) if (id !== "signin-result") boxBuilders.delete(id);
      for (const id of PARTICIPANT_RESULT_BOXES) {
        const box = el(id);
        if (box) {
          clearElement(box);
          box.hidden = true;
        }
      }
      const tl = el("timeline-list");
      if (tl) clearElement(tl);
      // Typed drafts of the previous participant must not be recorded on the next one.
      for (const fid of ["form-assessment", "form-goal", "form-prescription", "form-summary", "form-evolution"]) {
        el(fid)?.reset();
      }
      applyI18n(); // reset restores the markup defaults: translate them again
      const link = el("invite-link");
      if (link) link.value = "";
    }
    state.participantId = participantId;
    if (alias) state.participantAlias = alias;
    if (careLinkId) state.careLinkId = careLinkId;
    if (side === "left" || side === "right") {
      state.side = side;
      const assessSide = el("assessment-side");
      const rxSide = el("rx-side");
      if (assessSide) assessSide.value = side;
      if (rxSide) rxSide.value = side;
    }
    const pidInput = el("active-participant-id");
    if (pidInput) pidInput.value = participantId;
    state.factEntries = [];
    state.effectiveReviews = {};
    renderFactsList();
    clearEvolutionSeriesCache();
    updatePublishGates();
    updateSessionBar();
    const inviteBtn = el("btn-create-invite");
    if (inviteBtn) inviteBtn.disabled = !participantId;
    writeStoredContext(
      participantId
        ? { participantId, alias: state.participantAlias, careLinkId: state.careLinkId, side: state.side, therapistId: state.session?.principal?.id || "" }
        : null
    );
    highlightSelectedParticipant();
  }

  // --- Participant list (read-only index view) ---

  function highlightSelectedParticipant() {
    for (const li of document.querySelectorAll("#participant-list [data-participant-id]")) {
      const on = li.dataset.participantId === state.participantId;
      li.dataset.selected = String(on);
      const b = li.querySelector("button");
      if (b) b.setAttribute("aria-pressed", String(on));
    }
  }

  function renderParticipantList(items) {
    const list = el("participant-list");
    clearElement(list);
    for (const it of items) {
      const li = document.createElement("li");
      li.className = "data-card";
      li.dataset.participantId = it.participant_id;
      appendParagraph(li, t("th.js.alias_side", { alias: it.alias, side: label("side", it.side) }));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-secondary target";
      btn.textContent = t("th.js.select");
      btn.setAttribute("aria-label", t("th.js.select_aria", { alias: it.alias }));
      btn.dataset.action = "select-participant";
      btn.addEventListener("click", () => {
        setActiveParticipant(it.participant_id, it.alias, it.care_link_id, it.side);
        showSuccess(tm("th.js.active_participant", { name: it.alias }));
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
    highlightSelectedParticipant();
  }

  function paintParticipantStatus() {
    const status = el("participant-list-status");
    const v = state.listView;
    if (!state.session?.token || !v) {
      status.textContent = t("th.js.list_signin");
      return;
    }
    status.textContent = v.items.length
      ? t(v.q ? "th.js.found" : "th.js.linked", { n: v.total })
      : v.q
        ? t("th.js.none_found")
        : t("th.js.none_yet");
  }

  async function refreshParticipantList(q = "") {
    if (!state.session?.token) {
      state.listView = null;
      paintParticipantStatus();
      renderParticipantList([]);
      return [];
    }
    try {
      const res = await client.listParticipants(q);
      const items = res.data.participants || [];
      state.listView = { items, q, total: res.data.total };
      renderParticipantList(items);
      paintParticipantStatus();
      return items;
    } catch (err) {
      handleApiError(err);
      return [];
    }
  }

  async function restoreContext() {
    const items = await refreshParticipantList("");
    const ctx = readStoredContext();
    if (!ctx || ctx.therapistId !== (state.session?.principal?.id || "")) {
      writeStoredContext(null);
      return;
    }
    const hit = items.find((it) => it.participant_id === ctx.participantId);
    if (!hit) {
      writeStoredContext(null);
      return;
    }
    setActiveParticipant(hit.participant_id, hit.alias, hit.care_link_id, hit.side);
  }

  function updatePublishGates() {
    const approvedItems = getPublishableSummaryItems(state.factEntries);
    const summaryAllowed = canPublishSummary(state.factEntries);
    btnPublishSummary.disabled = !summaryAllowed;
    if (summaryAllowed) {
      summaryGateStatus.textContent = t("th.js.summary_ready", { n: approvedItems.length });
    } else {
      summaryGateStatus.textContent = t("th.js.summary_blocked");
    }

    const evolutionAllowed = canPublishEvolution(state.evolutionSeries, state.factEntries);
    btnPublishEvolution.disabled = !evolutionAllowed;
    if (evolutionAllowed) {
      evolutionGateStatus.textContent = t("th.js.evo_ready", { n: state.evolutionSeries.length });
    } else {
      evolutionGateStatus.textContent = t("th.js.evo_blocked");
    }
  }

  function renderFactsList() {
    const list = el("facts-list");
    clearElement(list);

    for (const entry of state.factEntries) {
      const { fact, contentHash, executionMode } = entry;
      const gate = evaluateFactGate(entry);
      const originLabel = formatOriginLabel(fact.data_origin);
      const execModeLabel = formatExecutionMode(executionMode);

      const li = document.createElement("li");
      li.className = "data-card";
      li.dataset.factItem = fact.fact_id;
      li.dataset.factType = fact.type;

      const badges = document.createElement("div");
      badges.className = "meta-badges";
      badges.appendChild(createBadge(label("fact", fact.type), "", "data-fact-type-badge", fact.type));
      badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      badges.appendChild(
        createBadge(t("th.js.exec_mode", { mode: execModeLabel }), "badge-mode", "data-execution-mode", executionMode)
      );
      const statusClass =
        gate.status === "approved"
          ? "badge-approved"
          : gate.status === "rejected"
            ? "badge-rejected"
            : "";
      badges.appendChild(createBadge(gate.labelPtBr, statusClass, "data-review-status", gate.status));
      li.appendChild(badges);

      appendParagraph(li, fact.rendered?.text_ptbr || "", "").setAttribute("data-clinical-text", "");
      // Technical identifiers live only in a collapsed audit block (FIX-24/25); harness hooks keep the raw labels there.
      const audit = document.createElement("details");
      audit.className = "audit-details";
      const auditSummary = document.createElement("summary");
      auditSummary.textContent = t("th.js.audit_summary");
      audit.appendChild(auditSummary);
      appendParagraph(audit, `fact_id: ${fact.fact_id}`, "mono");
      appendParagraph(audit, `content_hash: ${contentHash}`, "mono");
      li.appendChild(audit);

      const lims = Array.isArray(fact.rendered?.limitations_ptbr) ? fact.rendered.limitations_ptbr : [];
      if (lims.length > 0) {
        const ul = document.createElement("ul");
        ul.className = "limitations-list";
        ul.setAttribute("data-clinical-text", "");
        for (const text of lims) {
          const limLi = document.createElement("li");
          limLi.textContent = text;
          ul.appendChild(limLi);
        }
        li.appendChild(ul);
      }

      const noteWrap = document.createElement("div");
      noteWrap.className = "field";
      const noteId = `review-note-${fact.fact_id}`;
      const noteLabel = document.createElement("label");
      noteLabel.setAttribute("for", noteId);
      noteLabel.textContent = t("th.js.note_label", { name: label("fact", fact.type) });
      const noteInput = document.createElement("input");
      noteInput.id = noteId;
      noteInput.type = "text";
      noteInput.maxLength = 1000;
      noteInput.value = entry.draftNote || "";
      noteInput.addEventListener("input", () => {
        entry.draftNote = noteInput.value;
      });
      noteWrap.appendChild(noteLabel);
      noteWrap.appendChild(noteInput);
      li.appendChild(noteWrap);

      const actions = document.createElement("div");
      actions.className = "actions-row";

      const decisions = [
        { key: "approve", label: t("th.js.act_approve"), cls: "btn btn-primary target" },
        { key: "reject", label: t("th.js.act_reject"), cls: "btn btn-secondary target" },
        { key: "annotate", label: t("th.js.act_annotate"), cls: "btn btn-secondary target" },
      ];
      for (const dec of decisions) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = dec.cls;
        btn.dataset.reviewDecision = dec.key;
        btn.dataset.factId = fact.fact_id;
        btn.textContent = dec.label;
        btn.addEventListener("click", () => handleReviewAction(entry, dec.key));
        actions.appendChild(btn);
      }
      li.appendChild(actions);

      list.appendChild(li);
    }
  }

  async function handleReviewAction(entry, decision) {
    if (!requireParticipant()) return;
    const rawNote = (entry.draftNote || "").trim();
    const note = rawNote.length > 0 ? rawNote : null;
    const cur = entry.effectiveReview;
    const alreadyEffective =
      (decision === "approve" || decision === "reject") &&
      cur && cur.decision === decision && cur.content_hash === entry.contentHash;
    if (alreadyEffective) {
      // Same decision already effective for this exact content: no new review, no contradictory message.
      announce(tm("th.js.review_already"), { politeness: "polite" });
      return;
    }
    // A legitimate change of the effective state is a new intention (a consumed slot must not block it).
    commands.startNewIntention(slotOf(`review:${entry.fact.fact_id}:${decision}`));
    const reviewBody = {
      participant_id: state.participantId,
      fact_id: entry.fact.fact_id,
      content_hash: entry.contentHash,
      decision,
      note,
    };
    const seq = state.ctxSeq;
    await cmd(`review:${entry.fact.fact_id}:${decision}`, (key) => client.recordReview(reviewBody, { idempotencyKey: key }), async (res) => {
      state.reviewEpoch += 1; // the ledger changed: any fact load still in flight must be repeated
      if (seq !== state.ctxSeq) return "stale"; // recorded for its own participant; never touches the current context
      if (decision === "approve" || decision === "reject") {
        const live = state.factEntries.find((e) => e.fact.fact_id === entry.fact.fact_id) || entry;
        entry.effectiveReview = {
          decision,
          content_hash: entry.contentHash,
          event_id: res.data.event_id,
          note,
        };
        live.effectiveReview = entry.effectiveReview;
        state.effectiveReviews[entry.fact.fact_id] = entry.effectiveReview;
      }
      // Changing effective review invalidates previously loaded evolution series snapshot.
      if (decision === "approve" || decision === "reject") {
        clearEvolutionSeriesCache();
      }
      renderFactsList();
      updatePublishGates();
      showSuccess(tm("th.js.review_saved", { decision: lref("decision", decision), name: lref("fact", entry.fact.type) }));
    }, reviewBody);
  }

  function renderEvolutionSeries() {
    const container = el("evolution-series-container");
    clearElement(container);

    for (const series of state.evolutionSeries) {
      const sk = series.series_key || {};
      const originLabel = formatOriginLabel(sk.data_origin_class);
      const execMode = sk.execution_mode || "unknown";
      const execModeLabel = formatExecutionMode(execMode);

      const card = document.createElement("article");
      card.className = "data-card";
      card.dataset.evolutionSeries = series.series_key_hash;

      const badges = document.createElement("div");
      badges.className = "meta-badges";
      badges.appendChild(createBadge(t("th.js.series", { name: label("fact", sk.fact_type), movement: label("exercise", sk.movement_task || "organizar-a-mesa") }), "", "", ""));
      badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      badges.appendChild(
        createBadge(t("th.js.exec_mode", { mode: execModeLabel }), "badge-mode", "data-execution-mode", execMode)
      );
      card.appendChild(badges);

      appendParagraph(
        card,
        t("th.js.series_meta", { side: label("side", sk.laterality), method: label("method", sk.method), hash: series.series_key_hash }),
        "mono"
      );

      const itemsUl = document.createElement("ul");
      itemsUl.className = "card-list";
      for (const item of series.items || []) {
        const itemLi = document.createElement("li");
        itemLi.className = "result-box";
        itemLi.dataset.evolutionItem = item.fact_id;

        const itemBadges = document.createElement("div");
        itemBadges.className = "meta-badges";
        itemBadges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
        itemBadges.appendChild(
          createBadge(t("th.js.exec_mode", { mode: execModeLabel }), "badge-mode", "data-execution-mode", execMode)
        );
        itemLi.appendChild(itemBadges);

        appendParagraph(itemLi, `${formatIsoDate(item.session_date_local)}: ${item.text_ptbr}`).setAttribute("data-clinical-text", "");
        const ctx = item.context || {};
        appendParagraph(
          itemLi,
          t("th.js.ctx", { help: label("assistance", ctx.assistance_level), pain: ctx.pain_or_fatigue_signalled ? t("common.yes") : t("common.no"), dose: ctx.dose_prescribed ?? t("enum.unknown"), end: label("end_reason", ctx.session_end_reason) })
        );
        itemsUl.appendChild(itemLi);
      }
      card.appendChild(itemsUl);

      const transitions = Array.isArray(series.assistance_transitions)
        ? series.assistance_transitions
        : [];
      for (const tr of transitions) {
        const dirLabel = formatAssistanceTransition(tr.direction);
        appendParagraph(
          card,
          t("th.js.transition", { from: label("assistance", tr.from_level), to: label("assistance", tr.to_level), dir: dirLabel })
        );
      }

      container.appendChild(card);
    }

    if (state.evolutionNotices.length > 0) {
      const noticeBox = document.createElement("div");
      noticeBox.className = "banner banner-info";
      for (const n of state.evolutionNotices) {
        appendParagraph(
          noticeBox,
          t("th.js.series_split", { what: (n.differing_keys || []).map((x) => label("series_key", x)).join(", ") })
        );
      }
      container.appendChild(noticeBox);
    }
  }

  function renderPublishedSummary(summaryEvent) {
    const box = el("summary-result");
    clearElement(box);
    box.hidden = false;

    const originLabel = formatOriginLabel(summaryEvent.data_origin);
    const execMode = summaryEvent.execution_mode || "not_applicable";
    const execModeLabel = formatExecutionMode(execMode);
    const payload = summaryEvent.payload || {};

    const card = document.createElement("div");
    card.dataset.publishedSummary = payload.summary_id || "";

    const badges = document.createElement("div");
    badges.className = "meta-badges";
    badges.appendChild(createBadge(t("th.js.summary_badge"), "badge-approved", "", ""));
    badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
    badges.appendChild(
      createBadge(t("th.js.exec_mode", { mode: execModeLabel }), "badge-mode", "data-execution-mode", execMode)
    );
    card.appendChild(badges);

    appendParagraph(
      card,
      t("th.js.summary_published", { from: formatIsoDate(payload.period_from), to: formatIsoDate(payload.period_to) })
    );
    appendParagraph(card, t("th.js.audit_event", { id: summaryEvent.event_id, n: (payload.items || []).length }), "mono");

    const byId = new Map(state.factEntries.map((e) => [e.fact.fact_id, e]));
    const ul = document.createElement("ul");
    ul.className = "card-list";
    for (const item of payload.items || []) {
      const li = document.createElement("li");
      li.className = "data-card";
      li.dataset.summaryFactItem = item.fact_id;
      const entry = byId.get(item.fact_id);
      const itemOrigin = entry ? formatOriginLabel(entry.fact.data_origin) : originLabel;
      const itemMode = entry ? entry.executionMode : execMode;

      const itemBadges = document.createElement("div");
      itemBadges.className = "meta-badges";
      itemBadges.appendChild(createBadge(itemOrigin, "badge-origin", "data-origin-label", itemOrigin));
      itemBadges.appendChild(
        createBadge(
          t("th.js.exec_mode", { mode: formatExecutionMode(itemMode) }),
          "badge-mode",
          "data-execution-mode",
          itemMode
        )
      );
      li.appendChild(itemBadges);
      appendParagraph(li, entry?.fact?.rendered?.text_ptbr || t("th.js.fact_included", { id: item.fact_id })).setAttribute("data-clinical-text", "");
      appendParagraph(li, `fact_id: ${item.fact_id}`, "mono");
      ul.appendChild(li);
    }
    card.appendChild(ul);
    box.appendChild(card);
  }

  function renderPublishedEvolution(evoData) {
    const box = el("evolution-result");
    clearElement(box);
    box.hidden = false;

    const ev = evoData.event || {};
    const payload = ev.payload || {};
    const seriesKeys = evoData.series_keys || {};
    const originLabel = formatOriginLabel(ev.data_origin);
    const execMode = ev.execution_mode || "not_applicable";
    const execModeLabel = formatExecutionMode(execMode);

    const card = document.createElement("div");
    card.dataset.publishedEvolution = payload.evolution_id || "";

    const badges = document.createElement("div");
    badges.className = "meta-badges";
    badges.appendChild(createBadge(t("th.js.evo_badge"), "badge-approved", "", ""));
    badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
    badges.appendChild(
      createBadge(t("th.js.exec_mode", { mode: execModeLabel }), "badge-mode", "data-execution-mode", execMode)
    );
    card.appendChild(badges);

    appendParagraph(
      card,
      t("th.js.evo_published", { from: formatIsoDate(payload.period_from), to: formatIsoDate(payload.period_to) })
    );
    appendParagraph(card, `Evento: ${ev.event_id}`, "mono");

    const ul = document.createElement("ul");
    ul.className = "card-list";
    for (const s of payload.series || []) {
      const sk = seriesKeys[s.series_key_hash] || {};
      const sOrigin = formatOriginLabel(sk.data_origin_class || ev.data_origin);
      const sMode = sk.execution_mode || execMode;
      for (const it of s.items || []) {
        const li = document.createElement("li");
        li.className = "data-card";
        li.dataset.publishedEvolutionItem = it.fact_id;

        const ib = document.createElement("div");
        ib.className = "meta-badges";
        ib.appendChild(createBadge(label("fact", sk.fact_type), "", "", ""));
        ib.appendChild(createBadge(sOrigin, "badge-origin", "data-origin-label", sOrigin));
        ib.appendChild(
          createBadge(t("th.js.exec_mode", { mode: formatExecutionMode(sMode) }), "badge-mode", "data-execution-mode", sMode)
        );
        li.appendChild(ib);
        appendParagraph(li, t("th.js.series_item", { movement: label("exercise", sk.movement_task || "organizar-a-mesa"), fact: it.fact_id }), "mono");
        ul.appendChild(li);
      }
    }
    card.appendChild(ul);
    box.appendChild(card);
  }

  function renderTimeline(items) {
    const list = el("timeline-list");
    clearElement(list);

    for (const item of items) {
      const li = document.createElement("li");
      li.className = "data-card";
      li.dataset.timelineItem = item.ref;
      li.dataset.timelineKind = item.kind;

      // Localized label derived from the canonical data_origin (the server label is pt-BR only).
      const originLabel = formatOriginLabel(item.data_origin);
      const execMode = item.execution_mode || "not_applicable";
      const execModeLabel = formatExecutionMode(execMode);
      const kindPt = label("timeline", item.kind);

      const badges = document.createElement("div");
      badges.className = "meta-badges";
      badges.appendChild(createBadge(kindPt, "", "", ""));
      badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      badges.appendChild(
        createBadge(t("th.js.exec_mode", { mode: execModeLabel }), "badge-mode", "data-execution-mode", execMode)
      );
      li.appendChild(badges);

      appendParagraph(li, t("th.js.timeline_row", { when: formatDateTime(item.occurred_at), ref: item.ref }), "mono");
      list.appendChild(li);
    }
  }

  // --- Event bindings ---

  btnSignout.addEventListener("click", () => {
    state.session = null;
    writeStoredSession(null);
    writeStoredContext(null);
    setActiveParticipant("");
    renderParticipantList([]);
    state.listView = null;
    paintParticipantStatus();
    updateSessionBar();
    updatePublishGates();
    showSuccess(tm("th.js.signed_out"));
    window.location.hash = "#sec-signin";
    el("signin-username")?.focus();
  });

  // Step 1: Therapist sign-in
  el("form-signin").addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = el("signin-username").value.trim();
    const password = el("signin-password").value;
    if (!username || !password) {
      showError("UNAUTHENTICATED", tm("th.js.need_credentials"));
      return;
    }
    try {
      const res = await client.loginTherapist(username, password);
      state.session = {
        token: res.data.token,
        expires_at: res.data.expires_at,
        principal: res.data.principal,
      };
      writeStoredSession(state.session);
      updateSessionBar();

      renderBox("signin-result", (box) => {
        appendParagraph(
          box,
          t("th.js.session_bar", { id: res.data.principal.id, role: label("role", res.data.principal.role), org: res.data.principal.org_id })
        );
      });
      syncRetention();
      showSuccess(tm("th.js.signed_in", { id: res.data.principal.id }));
      restoreContext();
    } catch (err) {
      handleApiError(err);
    }
  });

  // Step 2: Register and link participant
  el("form-participant").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireAuth()) return;
    const alias = el("participant-alias").value.trim();
    const side = el("participant-side").value;
    if (!alias) {
      showError("MISSING_FIELD", tm("th.js.need_alias"));
      return;
    }
    await cmd("participant", (key) => client.createParticipant(alias, side, { idempotencyKey: key }), async (res) => {
      const ent = res.data;
      const careLinkId = res.headers.get("x-elo-care-link-id") || "";
      setActiveParticipant(ent.entity_id, ent.payload.alias, careLinkId, ent.payload.side);

      renderBox("participant-result", (box) => {
        const originLabel = formatOriginLabel(ent.data_origin);
        const badges = document.createElement("div");
        badges.className = "meta-badges";
        badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
        badges.appendChild(
          createBadge(
            t("th.js.exec_mode", { mode: formatExecutionMode("not_applicable") }),
            "badge-mode",
            "data-execution-mode",
            "not_applicable"
          )
        );
        box.appendChild(badges);
        appendParagraph(
          box,
          t("th.js.registered_detail", { alias: ent.payload.alias, side: label("side", ent.payload.side) })
        );
        appendParagraph(box, t("th.js.audit_link", { id: careLinkId }), "mono");
      });

      showSuccess(tm("th.js.registered", { alias: ent.payload.alias }));
      refreshParticipantList("");
    }, [alias, side]);
  });

  // Step 2b (support/advanced): select by identifier. The identifier must belong to the authorized list
  // of this therapist; otherwise nothing changes and the last valid context is kept (D05 / FIX-04).
  let selectBusy = false;
  el("form-select-participant").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireAuth() || selectBusy) return;
    const pid = el("active-participant-id").value.trim();
    const previous = state.participantId;
    const restoreField = () => {
      const f = el("active-participant-id");
      if (f) f.value = previous;
    };
    if (!pid) {
      showError("MISSING_FIELD", tm("th.js.need_pid"));
      restoreField();
      return;
    }
    selectBusy = true;
    try {
      const res = await client.listParticipants("");
      const hit = (res.data.participants || []).find((it) => it.participant_id === pid);
      if (!hit) {
        showError("NOT_FOUND", tm("err.NOT_FOUND"), "[NOT_FOUND] participant not in the authorized list");
        restoreField();
        return;
      }
      setActiveParticipant(hit.participant_id, hit.alias, hit.care_link_id, hit.side);
      showSuccess(tm("th.js.active_participant", { name: hit.alias }));
    } catch (err) {
      restoreField();
      handleApiError(err);
    } finally {
      selectBusy = false;
    }
  });

  el("form-participant-search").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!requireAuth()) return;
    refreshParticipantList(el("participant-search").value.trim());
  });

  // Invite generation: one click, link ready to share (the code travels in the URL fragment, never in a query string).
  let inviteBusy = false;
  el("btn-create-invite").addEventListener("click", async () => {
    if (!requireAuth() || inviteBusy) return;
    if (!state.participantId) {
      showError("MISSING_FIELD", tm("th.js.invite_need_participant"));
      return;
    }
    inviteBusy = true;
    el("btn-create-invite").disabled = true;
    try {
      const ttl = Number(el("invite-ttl").value) || 3600;
      const inv = await commands.singleFlightOnly("invite", () => client.createInvite(state.participantId, ttl));
      if (inv.status === "ignored") return;
      if (inv.status === "error") throw inv.error;
      const res = inv.result;
      const link = new URL("participant.html", window.location.href);
      link.hash = `invite=${encodeURIComponent(res.data.invite_token)}`;
      renderBox("invite-result", (box) => {
        box.dataset.inviteFor = state.participantId;
        const when = new Date(res.data.expires_at);
        appendParagraph(box, t("th.js.invite_made", { name: state.participantAlias || t("th.js.the_participant"), when: formatDateTime(when) }));
        const input = document.createElement("input");
        input.type = "text";
        input.readOnly = true;
        input.id = "invite-link";
        input.value = link.toString();
        input.setAttribute("aria-label", t("th.js.invite_link_aria"));
        box.appendChild(input);
        const copy = document.createElement("button");
        copy.type = "button";
        copy.id = "btn-copy-invite";
        copy.className = "btn btn-secondary target";
        copy.textContent = t("th.js.copy_link");
        copy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(input.value);
            announce(tm("th.js.copied"));
            showSuccess(tm("th.js.copied"));
          } catch {
            input.select();
            showError("CLIPBOARD", tm("th.js.copy_fail"));
          }
        });
        box.appendChild(copy);
      });
      announce(tm("th.js.invite_done"));
    } catch (err) {
      handleApiError(err);
    } finally {
      inviteBusy = false;
      el("btn-create-invite").disabled = !state.participantId;
    }
  });

  // Step 3: Record functional assessment
  el("form-assessment").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireParticipant()) return;
    if (!validateDateFields([{ input: el("assessment-date"), required: true }])) return;
    if (!domainCatalogs.instruments) Object.assign(domainCatalogs, await loadCatalogs());
    const instrument = instrumentFromSelection(domainCatalogs.instruments, el("assessment-instrument-id").value);
    if (!instrument || instrumentViolations(domainCatalogs.instruments, instrument).length) {
      setFieldError(el("assessment-instrument-id"), tm("rule.instrument.registry_mismatch"));
      el("assessment-instrument-id").focus();
      return;
    }
    const items = [buildItem({
      key: el("assessment-item-key").value.trim(),
      valueType: el("assessment-item-value-type").value,
      rawValue: el("assessment-item-value").value,
      unit: el("assessment-item-unit").value,
      notAssessed: el("assessment-item-not-assessed").checked,
      assistance: el("assessment-item-assistance").value,
    })];
    const itemProblems = itemViolations(items);
    if (itemProblems.length) {
      const first = itemProblems[0];
      const input = el(FIELD_FOR_PATH[first.path.replace(/items\[\d+\]/, "items[0]")] || "assessment-item-value");
      setFieldError(input, tm(`rule.${first.rule}`));
      input.focus();
      announce(tm(`rule.${first.rule}`), { politeness: "assertive" });
      return;
    }
    const noteText = el("assessment-note").value.trim();
    const payload = {
      assessment_date: el("assessment-date").value,
      body_segment: el("assessment-segment").value,
      side: el("assessment-side").value,
      instrument,
      items,
      therapist_note: noteText.length > 0 ? noteText : null,
    };
    await cmd("assessment", (key) => client.createAssessment(state.participantId, payload, { idempotencyKey: key }), async (res) => {
      const ent = res.data;
      renderBox("assessment-result", (box) => {
        const originLabel = formatOriginLabel(ent.data_origin);
        const badges = document.createElement("div");
        badges.className = "meta-badges";
        badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
        badges.appendChild(
          createBadge(
            t("th.js.exec_mode", { mode: formatExecutionMode("not_applicable") }),
            "badge-mode",
            "data-execution-mode",
            "not_applicable"
          )
        );
        box.appendChild(badges);
        appendParagraph(
          box,
          t("th.js.assess_saved_detail", { date: formatIsoDate(ent.payload.assessment_date) })
        );
      });
      showSuccess(tm("th.js.assess_saved"));
    }, payload);
  });

  // Step 4: Create functional goal
  el("form-goal").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireParticipant()) return;
    if (!validateDateFields([{ input: el("goal-deadline"), required: false }])) return;
    if (!domainCatalogs.goalRules) Object.assign(domainCatalogs, await loadCatalogs());
    const kind = el("goal-target-kind").value;
    const target = buildGoalTarget(domainCatalogs.goalRules, kind, el("goal-target-value").value);
    const problems = goalTargetViolations(domainCatalogs.goalRules, target);
    if (problems.length) {
      const first = problems[0];
      const input = el(FIELD_FOR_PATH[first.path]);
      setFieldError(input, tm(`rule.${first.rule}`));
      input.focus();
      announce(tm(`rule.${first.rule}`), { politeness: "assertive" });
      return;
    }
    const payload = {
      goal_text: el("goal-text").value.trim(),
      body_segment: el("goal-segment").value,
      target,
      status: el("goal-status").value,
      confirmed_by: null,
      confirmed_at: null,
      ...(el("goal-deadline").value ? { deadline: el("goal-deadline").value } : {}),
    };
    await cmd("goal", (key) => client.createGoal(state.participantId, payload, { idempotencyKey: key }), async (res) => {
      const ent = res.data;
      renderBox("goal-result", (box) => {
        const originLabel = formatOriginLabel(ent.data_origin);
        const badges = document.createElement("div");
        badges.className = "meta-badges";
        badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
        badges.appendChild(
          createBadge(
            t("th.js.exec_mode", { mode: formatExecutionMode("not_applicable") }),
            "badge-mode",
            "data-execution-mode",
            "not_applicable"
          )
        );
        box.appendChild(badges);
        appendParagraph(
          box,
          t("th.js.goal_saved_detail", { status: label("goal_status", ent.payload.status) })
        );
      });
      showSuccess(tm("th.js.goal_saved"));
    }, payload);
  });

  // Step 5: Publish prescription (organizar-a-mesa, report-only)
  el("form-prescription").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireParticipant()) return;
    if (!validateDateFields([{ input: el("rx-valid-from"), required: true }, { input: el("rx-valid-to"), notBefore: el("rx-valid-from") }])) return;
    if (!domainCatalogs.limits) Object.assign(domainCatalogs, await loadCatalogs());
    const doseProblems = doseViolations(domainCatalogs.limits, {
      sets: Number(el("rx-sets").value),
      reps: Number(el("rx-reps").value),
      perWeek: Number(el("rx-sessions-week").value),
    });
    if (doseProblems.length) {
      const first = doseProblems[0];
      const input = el(first.field);
      setFieldError(input, tm(`rule.${first.rule}`));
      input.focus();
      announce(tm(`rule.${first.rule}`), { politeness: "assertive" });
      return;
    }
    const validToRaw = el("rx-valid-to").value;
    const draft = {
      participant_id: state.participantId,
      exercise_id: el("rx-exercise").value,
      permitted_movement: el("rx-movement").value,
      side: el("rx-side").value,
      target_sets: Number.parseInt(el("rx-sets").value, 10),
      target_repetitions: Number.parseInt(el("rx-reps").value, 10),
      sessions_per_week: Number.parseInt(el("rx-sessions-week").value, 10),
      valid_from: el("rx-valid-from").value,
      valid_to: validToRaw.length > 0 ? validToRaw : null,
      timezone: el("rx-timezone").value,
      min_calibration_span: null,
      instructions_ptbr: el("rx-instructions").value.trim(),
    };
    await cmd("prescription", (key) => client.publishPrescription(draft, { idempotencyKey: key }), async (res) => {
      const rxData = res.data;
      const curRes = await client.getCurrentPrescription(state.participantId);
      const rxEvent = curRes.data;
      const execMode = rxEvent.execution_mode || "not_applicable";

      renderBox("prescription-result", (box) => {
        const originLabel = formatOriginLabel(rxEvent.data_origin);
        const badges = document.createElement("div");
        badges.className = "meta-badges";
        badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
        badges.appendChild(
          createBadge(
            t("th.js.exec_mode", { mode: formatExecutionMode(execMode) }),
            "badge-mode",
            "data-execution-mode",
            execMode
          )
        );
        box.appendChild(badges);
        appendParagraph(
          box,
          t("th.js.rx_saved_detail", { rev: rxData.revision, movement: label("exercise", "organizar-a-mesa"), mode: formatExecutionMode("report_only") })
        );
        appendParagraph(box, t("th.js.audit_event_only", { id: rxData.event_id }), "mono");
      });
      showSuccess(tm("th.js.rx_saved", { rev: rxData.revision }));
    }, draft);
  });

  // Step 6: Load verified facts & resolve execution_mode from evidence
  el("btn-load-facts").addEventListener("click", async () => {
    if (!requireParticipant()) return;
    const seq = state.ctxSeq;
    const loadId = ++state.factsLoadSeq;
    const pid = state.participantId;
    try {
      let facts = [];
      let projected = null;
      let entries = [];
      // Repeat while a review was recorded during the load (projection could predate it).
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const epoch = state.reviewEpoch;
        const res = await client.listFacts(pid, { includeReviews: true });
        if (seq !== state.ctxSeq || loadId !== state.factsLoadSeq) return; // late response: discard
        facts = Array.isArray(res.data?.facts) ? res.data.facts : [];
        // Eligibility is rebuilt from the server ledger projection on every load (no client-only truth).
        projected = res.data?.effective_reviews;
        const reviews = projected && typeof projected === "object" ? { ...projected } : {};

        // Fetch execution_mode once per unique session_id via GET /api/v3/facts/{fact_id}/evidence.
        const sessionModeCache = new Map();
        entries = [];
        for (const fact of facts) {
          const sid = fact.scope?.session_id || "";
          let executionMode = sessionModeCache.get(sid);
          if (!executionMode) {
            const evRes = await client.getFactEvidence(fact.fact_id);
            if (seq !== state.ctxSeq || loadId !== state.factsLoadSeq) return;
            const evList = Array.isArray(evRes.data?.events) ? evRes.data.events : [];
            const startEv = evList.find((e) => e.type === "session.started") || evList[0];
            executionMode = startEv?.execution_mode || "report_only";
            if (sid) sessionModeCache.set(sid, executionMode);
          }
          const contentHash = await hashCanonical(fact);
          entries.push({
            fact,
            contentHash,
            executionMode,
            effectiveReview: reviews[fact.fact_id] || null,
            draftNote: "",
          });
        }
        if (seq !== state.ctxSeq || loadId !== state.factsLoadSeq) return;
        state.effectiveReviews = reviews;
        if (epoch === state.reviewEpoch) break;
      }

      state.factEntries = entries;
      // Row 3 / F1: Refreshing verified facts invalidates any cached evolution series snapshot
      // so obsolete/unreviewed/stale series can never remain displayed or offered for publication.
      clearEvolutionSeriesCache();
      renderFactsList();
      updatePublishGates();

      const summaryBox = el("facts-summary");
      clearElement(summaryBox);
      summaryBox.hidden = false;
      appendParagraph(
        summaryBox,
        t("th.js.facts_loaded_detail", { n: entries.length })
      );
      showSuccess(tm("th.js.facts_loaded_detail", { n: entries.length }));
    } catch (err) {
      if (seq === state.ctxSeq) handleApiError(err); // errors of a previous context are not shown in the current one
    }
  });

  // Step 7a: Publish summary
  el("form-summary").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireParticipant()) return;
    if (!validateDateFields([{ input: el("summary-period-from"), required: true }, { input: el("summary-period-to"), required: true, notBefore: el("summary-period-from") }])) return;
    const items = getPublishableSummaryItems(state.factEntries);
    if (items.length === 0) {
      showError(
        "FACT_NOT_APPROVED",
        describeApiError({ code: "FACT_NOT_APPROVED", status: 422 }).msg
      );
      return;
    }
    const periodFrom = el("summary-period-from").value;
    const periodTo = el("summary-period-to").value;
    const summaryBody = {
      participant_id: state.participantId,
      items,
      period: { from: periodFrom, to: periodTo },
      note_refs: [],
    };
    const seq = state.ctxSeq;
    await cmd("summary", (key) => client.publishSummary(summaryBody, { idempotencyKey: key }), async (pubRes) => {
      if (seq !== state.ctxSeq) return "stale";
      const getRes = await client.getSummary(pubRes.data.summary_id);
      if (seq !== state.ctxSeq) return "stale";
      state.publishedSummary = getRes.data;
      renderPublishedSummary(getRes.data);
      showSuccess(tm("th.js.summary_ok"));
    }, summaryBody);
  });

  // Step 7b: Load comparable evolution series (cmp-v1)
  el("btn-load-evolution-series").addEventListener("click", async () => {
    if (!requireParticipant()) return;
    try {
      const seq = state.ctxSeq;
      const res = await client.getEvolutionSeries(state.participantId);
      if (seq !== state.ctxSeq) return;
      state.evolutionSeries = Array.isArray(res.data?.series) ? res.data.series : [];
      state.evolutionNotices = Array.isArray(res.data?.notices) ? res.data.notices : [];
      state.evolutionContextChanges = res.data?.context_changes || {};
      renderEvolutionSeries();
      updatePublishGates();
      showSuccess(tm("th.js.series_loaded", { n: state.evolutionSeries.length })
      );
    } catch (err) {
      handleApiError(err);
    }
  });

  // Step 7b: Publish evolution
  el("form-evolution").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireParticipant()) return;
    if (!validateDateFields([{ input: el("evolution-period-from"), required: true }, { input: el("evolution-period-to"), required: true, notBefore: el("evolution-period-from") }])) return;
    const publishableSeries = getPublishableEvolutionSeries(state.evolutionSeries, state.factEntries);
    if (
      !canPublishEvolution(state.evolutionSeries, state.factEntries) ||
      publishableSeries.length !== state.evolutionSeries.length ||
      publishableSeries.length === 0
    ) {
      showError(
        "UNREVIEWED_FACT_IN_EVOLUTION",
        describeApiError({ code: "UNREVIEWED_FACT_IN_EVOLUTION", status: 409 }).msg
      );
      return;
    }
    const periodFrom = el("evolution-period-from").value;
    const periodTo = el("evolution-period-to").value;
    const seriesKeys = publishableSeries.map((s) => s.series_key_hash);
    const evolutionBody = {
      participant_id: state.participantId,
      period: { from: periodFrom, to: periodTo },
      series_keys: seriesKeys,
    };
    const seq = state.ctxSeq;
    await cmd("evolution", (key) => client.publishEvolution(evolutionBody, { idempotencyKey: key }), async (pubRes) => {
      if (seq !== state.ctxSeq) return "stale";
      const getRes = await client.getEvolution(pubRes.data.evolution_id);
      if (seq !== state.ctxSeq) return "stale";
      state.publishedEvolution = getRes.data;
      renderPublishedEvolution(getRes.data);
      showSuccess(tm("th.js.evo_ok"));
    }, evolutionBody);
  });

  // Step 8: Load participant timeline
  el("btn-load-timeline").addEventListener("click", async () => {
    if (!requireParticipant()) return;
    try {
      const seq = state.ctxSeq;
      const res = await client.getTimeline(state.participantId);
      if (seq !== state.ctxSeq) return;
      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      state.timelineItems = items;
      renderTimeline(items);

      renderBox("timeline-summary", (box) => {
        appendParagraph(box, t("th.js.timeline_loaded", { n: items.length }));
      });
      showSuccess(tm("th.js.timeline_loaded", { n: items.length }));
    } catch (err) {
      handleApiError(err);
    }
  });

  // Row 9: Unauthenticated navigation to any protected section redirects to sign-in.
  window.addEventListener("hashchange", () => {
    if (!state.session?.token && PROTECTED_HASHES.has(window.location.hash)) {
      redirectToSignIn(tm("th.js.session_required")
      );
    }
  });

  initI18n();
  // GoalTargetField: kind drives value/unit availability; the unit is derived and read-only (A2-02).
  function applyMeasurement() {
    const numeric = ["integer", "number"].includes(el("assessment-item-value-type").value);
    const unit = el("assessment-item-unit");
    unit.disabled = !numeric;
    if (!numeric) unit.value = "";
    const na = el("assessment-item-not-assessed").checked;
    const v = el("assessment-item-value");
    v.disabled = na;
    if (na) v.value = "";
  }
  function applyUnits() {
    const sel = el("assessment-item-unit");
    for (const u of domainCatalogs.units.units) {
      if ([...sel.options].some((o) => o.value === u.unit)) continue;
      const o = document.createElement("option");
      o.value = u.unit;
      o.textContent = label("unit", u.unit);
      sel.appendChild(o);
    }
  }
  function applyInstrument() {
    const sel = el("assessment-instrument-id");
    sel.replaceChildren(...instrumentEntries(domainCatalogs.instruments).map((e) => {
      const o = document.createElement("option");
      o.value = e.id;
      o.setAttribute("data-i18n", `th.opt.assessment-instrument-id.${e.id}`);
      o.textContent = e.id;
      return o;
    }));
    applyI18n(sel);
    syncInstrument();
  }
  function syncInstrument() {
    const inst = instrumentFromSelection(domainCatalogs.instruments, el("assessment-instrument-id").value);
    if (!inst) return;
    el("assessment-instrument-version").value = inst.instrument_version;
    el("assessment-instrument-status").value = inst.status;
  }
  function applyGoalKind() {
    const spec = goalTargetSpec(domainCatalogs.goalRules, el("goal-target-kind").value);
    if (!spec) return;
    const v = el("goal-target-value"), u = el("goal-target-unit");
    v.disabled = !spec.numeric;
    u.value = spec.unit || "";
    if (!spec.numeric) v.value = "";
    else if (v.value === "") v.value = "3";
    v.min = String(spec.min ?? 0);
  }
  loadCatalogs().then((c) => { Object.assign(domainCatalogs, c); applyGoalKind(); applyInstrument(); applyUnits(); applyMeasurement(); }).catch(() => {});
  el("goal-target-kind").addEventListener("change", applyGoalKind);
  el("assessment-item-value-type").addEventListener("change", applyMeasurement);
  el("assessment-item-not-assessed").addEventListener("change", applyMeasurement);
  el("assessment-instrument-id").addEventListener("change", syncInstrument);
  document.addEventListener("elo:lang", () => {
    // Re-render dynamic content in the new language without touching what the user typed.
    updateSessionBar();
    updatePublishGates();
    renderFactsList();
    renderEvolutionSeries();
    renderTimeline(state.timelineItems || []);
    for (const id of boxBuilders.keys()) runBox(id);
    if (state.publishedSummary) renderPublishedSummary(state.publishedSummary);
    if (state.publishedEvolution) renderPublishedEvolution(state.publishedEvolution);
    if (state.listView) renderParticipantList(state.listView.items);
    paintParticipantStatus();
  });
  updateSessionBar();
  updatePublishGates();
  if (state.session?.token) {
    syncRetention();
    restoreContext();
  }

  if (!state.session?.token && PROTECTED_HASHES.has(window.location.hash)) {
    redirectToSignIn(tm("th.js.session_required")
    );
  }
}

if (typeof document !== "undefined") {
  initTherapistApp();
}
