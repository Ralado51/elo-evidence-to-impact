import { mountAssistedDraft } from "./assistance/assisted_draft.mjs";
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
import { createContextStore } from "./context_store.mjs";
import { createFeedback } from "./feedback.mjs";
import { loadCatalogs, instrumentEntries, instrumentFromSelection, instrumentViolations, doseViolations, buildItem, createDomainRegistry, goalTargetSpec, buildGoalTarget, goalTargetViolations, FIELD_FOR_PATH } from "./domain_fields.mjs";
import { applyI18n, initI18n, t, tm, lref, bindText, label, unitLabel, formatDate, formatDateTime, formatIsoDate } from "./i18n.mjs";
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
    reviewEpoch: 0, // bumps on every recorded review: a fact load that raced with it is repeated
    evolutionSeries: [],
    evolutionNotices: [],
    evolutionContextChanges: {},
    publishedSummary: null,
    publishedEvolution: null,
    timelineItems: [],
    listView: null,
  };
  // ARQ-04 / CMP-10: one ContextStore replaces ctxSeq/factsLoadSeq. Reads are aborted/dropped, writes are never aborted.
  const ctxStore = createContextStore();
  ctxStore.switchTo({ principalId: state.session?.principal?.id ?? null, role: "therapist", participantId: null });

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

  // ARQ-04 / CMP-03: single feedback implementation (exclusive states, announce dedup, owner scope).
  const feedback = createFeedback({ errorBanner, errorBannerText, successBanner, successBannerText, bindText, renderErrorTechnical, announce });
  ctxStore.onReset((reason) => feedback.onContextChange(reason));
  const clearError = () => feedback.clearError();
  const clearSuccess = () => feedback.clearSuccess();
  const showError = (code, message, technical = "") => feedback.showError(code, message, technical, { scope: code === "UNAUTHENTICATED" ? "global" : "participant" });
  const showSuccess = (message) => feedback.showSuccess(message);

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
  async function cmd(rawFormId, send, onOk, signature, { onOrphan } = {}) {
    const formId = slotOf(rawFormId);
    errorBanner.querySelector("#btn-cmd-new-intention")?.remove();
    const ticket = ctxStore.capture(); // BEFORE the await: the write itself is never aborted (FIX-37.1)
    const out = await commands.run(formId, send, { signature });
    if (out.status === "ignored") { restoreSurfaces(rawFormId); offerAnotherIntention(formId); return; }
    if (out.status === "settled") {
      restoreSurfaces(rawFormId);
      offerAnotherIntention(formId);
      if (ticket.isCurrent()) announce(tm("th.js.cmd_settled"), { politeness: "polite" }); // same intention already fulfilled: no new record
      return;
    }
    if (!ticket.isCurrent()) {
      // Logout / principal change while the write was in flight (TH-03 et al.): the write is persisted server-side and the next
      // authorised list shows it; nothing is rendered, no request is issued without a session, no notice crosses principals.
      if (ctxStore.current().principalGen !== ticket.scope.principalGen) return;
      // The context moved on while the write was in flight: never render here; reconcile for the participant it belongs to.
      if (out.status === "error" && (out.error?.status === 401 || out.error?.code === "UNAUTHENTICATED")) { handleApiError(out.error); return; }
      if (out.status === "ok") {
        if (onOrphan) onOrphan(out.result, ticket.scope);
        else ctxStore.addNotice(ticket.participantId, { kind: rawFormId });
      } else ctxStore.addNotice(ticket.participantId, { kind: rawFormId, failed: true });
      return;
    }
    if (out.status === "ok") {
      try {
        const r = await onOk(out.result, ticket);
        if (r !== "stale") offerAnotherIntention(formId);
      } catch (err) {
        if (ticket.isCurrent()) handleApiError(err);
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
  // FIX-42: a secondary read that follows a persisted write is bound to the ORIGIN participant (ticket), is abortable,
  // and is re-validated after the await. If the context moved on, nothing is shown; the write is reconciled on return.
  const STALE = "stale";
  async function readAfterWrite(ticket, kind, read) {
    const orphaned = () => { ctxStore.addNotice(ticket.participantId, { kind }); return STALE; };
    if (!ticket.isCurrent()) return orphaned();
    const op = ctxStore.begin(`${kind}.after-write`);
    try {
      const res = await read(op.signal, ticket.participantId);
      if (!ticket.isCurrent() || !op.isCurrent()) return orphaned();
      return res;
    } catch (err) {
      if (!ticket.isCurrent() || !op.isCurrent()) return orphaned();
      throw err;
    } finally {
      op.done();
    }
  }
  // FIX-41: the lifecycle of result surfaces is owned by the shared feedback component; this app only says WHICH surfaces exist.
  const RESULT_SURFACES = { assessment: ["assessment-result"], goal: ["goal-result"], prescription: ["prescription-result"], summary: ["summary-result"], evolution: ["evolution-result"] };
  const parkedBuilders = new Map(); // builders of the hidden surfaces, restored only for a no-op attempt
  for (const [kind, ids] of Object.entries(RESULT_SURFACES)) {
    feedback.registerSurface(kind, {
      clear() {
        document.getElementById("btn-cmd-another")?.remove();
        for (const id of ids) {
          parkedBuilders.delete(id);
          if (boxBuilders.has(id)) parkedBuilders.set(id, boxBuilders.get(id));
          boxBuilders.delete(id);
          const box = el(id);
          if (box) { clearElement(box); box.hidden = true; }
        }
      },
      restore() {
        for (const id of ids) { const b = parkedBuilders.get(id); if (b && !boxBuilders.has(id)) renderBox(id, b); }
      },
    });
  }
  const beginAttempt = (kind) => feedback.beginAttempt(kind);
  const restoreSurfaces = (kind) => feedback.restoreAttempt(kind);
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

  const draftPreview = new URLSearchParams(location.search).get("s4") === "1"
    ? mountAssistedDraft(el("assisted-draft")) : null;

  function setActiveParticipant(participantId, alias = "", careLinkId = "", side = "") {
    draftPreview?.setContext(state.session?.token ? participantId : "");
    const changed = state.participantId !== participantId;
    if (changed) {
      ctxStore.switchTo({ principalId: state.session?.principal?.id ?? null, role: "therapist", participantId });
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
      for (const fid of ["form-assessment", "form-goal", "form-prescription", "form-summary", "form-evolution", "form-read-evolution"]) {
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
    if (changed && participantId) deliverNotices(participantId);
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
    const op = ctxStore.begin("list", { level: "principal" });
    try {
      const res = await client.listParticipants(q, { signal: op.signal });
      if (!op.isCurrent()) return [];
      const items = res.data.participants || [];
      state.listView = { items, q, total: res.data.total };
      renderParticipantList(items);
      paintParticipantStatus();
      return items;
    } catch (err) {
      op.fail(err, handleApiError);
      return [];
    } finally {
      op.done();
    }
  }

  async function restoreContext() {
    const rop = ctxStore.begin("restore"); // TH-07: any manual selection / logout / new login while the list loads cancels the restore
    const items = await refreshParticipantList("");
    if (!rop.isCurrent()) { rop.done(); return; }
    rop.done();
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

  // Reconciliation of writes that completed while another participant was active (FIX-37.1, D-ARQ4-02).
  function deliverNotices(pid) {
    const notes = ctxStore.takeNotices(pid);
    if (!notes.length) return;
    const failed = notes.filter((n) => n.failed).length;
    const done = notes.filter((n) => !n.failed && n.kind !== "invite");
    for (const n of notes) if (n.kind === "invite" && !n.failed) renderInviteBox(pid, n.alias, n.link, n.expiresAt);
    if (done.length) {
      // Reload the origin's readable data (read-only) FIRST, then say what happened, so the notice is not overwritten by the reload's own banner.
      const tk = ctxStore.capture();
      void loadTimeline().then(() => { if (tk.isCurrent()) showSuccess(tm("th.js.late_notice", { n: done.length })); });
    } else if (failed) {
      showError("RESULT_UNCONFIRMED", tm("th.js.late_notice_failed", { n: failed }));
    }
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
    await cmd(`review:${entry.fact.fact_id}:${decision}`, (key) => client.recordReview(reviewBody, { idempotencyKey: key }), async (res) => {
      state.reviewEpoch += 1; // the ledger changed: any fact load still in flight must be repeated
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

  function appendPublishedExplanation(card, explanation) {
    const heading = document.createElement("h4");
    heading.textContent = t("th.explanation.heading");
    card.appendChild(heading);

    const contextValue = (dimension, value) => {
      if (value == null) return t("enum.unknown");
      if (dimension === "assistance_level") return label("assistance", value);
      if (dimension === "session_end_reason") return label("end_reason", value);
      if (typeof value === "boolean") return t(value ? "common.yes" : "common.no");
      return String(value);
    };
    const series = explanation.series;
    const positions = new Map(series.map((entry, index) => [entry.series_key_hash, index + 1]));
    if (!series.length) appendParagraph(card, t("th.explanation.insufficient_items"));
    for (const notice of explanation.separations) {
      appendParagraph(card, t("th.explanation.split", {
        series: notice.series_key_hashes.map((hash) => positions.get(hash)).join(", "),
        reasons: notice.differing_keys.map((key) => label("series_key", key)).join(", "),
      }));
    }

    const list = document.createElement("ul");
    list.className = "card-list";
    for (const [index, entry] of series.entries()) {
      const item = document.createElement("li");
      item.className = "data-card";
      appendParagraph(item, t("th.explanation.series", { n: index + 1, fact: label("fact", entry.technical_key.fact_type) }));
      if (entry.status !== "published_descriptions_available") {
        appendParagraph(item, t(`th.explanation.${entry.status}`));
      }
      const describe = (change, text) => {
        appendParagraph(item, text);
        for (const fact of [change.from_fact, change.to_fact]) {
          appendParagraph(item, t("th.explanation.fact", { id: fact.fact_id, hash: fact.content_hash }), "mono");
        }
      };
      for (const change of entry.context_changes) {
        describe(change, t("th.explanation.change", {
          dimension: label("series_key", change.dimension),
          from: contextValue(change.dimension, change.from),
          to: contextValue(change.dimension, change.to),
        }));
      }
      for (const change of entry.reported_assistance) {
        describe(change, label("transition", change.direction));
      }
      list.appendChild(item);
    }
    card.appendChild(list);
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
    if (evoData.explanation) appendPublishedExplanation(card, evoData.explanation);
    box.appendChild(card);
  }

  el("form-read-evolution").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireParticipant()) return;
    const participantId = state.participantId;
    const op = ctxStore.begin("read-published-evolution");
    try {
      const id = el("read-evolution-id").value.trim();
      const res = await client.getEvolution(id, { signal: op.signal });
      if (!op.isCurrent()) return;
      if (res.data?.event?.scope?.participant_id !== participantId) {
        showError("NOT_FOUND", tm("th.explanation.not_found"));
        return;
      }
      state.publishedEvolution = res.data;
      renderPublishedEvolution(res.data);
      showSuccess(tm("th.explanation.loaded"));
    } catch (err) {
      op.fail(err, handleApiError);
    } finally {
      op.done();
    }
  });

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

  // FIX-43: logout empties every visible surface and every participant-bound in-memory datum, even with no active participant.
  function clearTherapistSurfaces() {
    state.factEntries = [];
    state.effectiveReviews = {};
    state.publishedSummary = null;
    state.publishedEvolution = null;
    state.timelineItems = [];
    state.participantAlias = "";
    state.careLinkId = "";
    boxBuilders.clear();
    for (const id of [...PARTICIPANT_RESULT_BOXES, "signin-result", "timeline-summary"]) {
      const box = el(id);
      if (box) { clearElement(box); box.hidden = true; for (const k of Object.keys(box.dataset)) delete box.dataset[k]; }
    }
    for (const fid of ["form-assessment", "form-goal", "form-prescription", "form-summary", "form-evolution", "form-read-evolution"]) el(fid)?.reset();
    clearEvolutionSeriesCache();
    renderFactsList();
    renderTimeline([]);
    const link = el("invite-link");
    if (link) link.value = "";
    clearError();
    clearSuccess();
    applyI18n();
  }

  // --- Event bindings ---

  btnSignout.addEventListener("click", () => {
    ctxStore.reset("logout"); // logout is a context boundary: reads in flight are aborted, tickets invalidated, secrets destroyed
    state.session = null;
    writeStoredSession(null);
    writeStoredContext(null);
    setActiveParticipant("");
    clearTherapistSurfaces();
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
    const authOp = ctxStore.begin("auth", { level: "principal" }); // TH-01: a late/obsolete sign-in response (after logout or a newer attempt) is discarded
    try {
      const res = await client.loginTherapist(username, password);
      if (!authOp.isCurrent()) return;
      authOp.done();
      state.session = {
        token: res.data.token,
        expires_at: res.data.expires_at,
        principal: res.data.principal,
      };
      writeStoredSession(state.session);
      ctxStore.switchTo({ principalId: res.data.principal.id, role: "therapist", participantId: null });
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
      authOp.fail(err, handleApiError);
    } finally {
      authOp.done();
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
    }, [alias, side], {
      onOrphan: (res) => { // created while another participant became active: do not switch; the list shows it
        showSuccess(tm("th.js.registered", { alias: res.data.payload.alias }));
        refreshParticipantList("");
      },
    });
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
    const op = ctxStore.begin("select", { level: "principal" });
    try {
      const res = await client.listParticipants("", { signal: op.signal });
      if (!op.isCurrent()) return;
      const hit = (res.data.participants || []).find((it) => it.participant_id === pid);
      if (!hit) {
        showError("NOT_FOUND", tm("err.NOT_FOUND"), "[NOT_FOUND] participant not in the authorized list");
        restoreField();
        return;
      }
      setActiveParticipant(hit.participant_id, hit.alias, hit.care_link_id, hit.side);
      showSuccess(tm("th.js.active_participant", { name: hit.alias }));
    } catch (err) {
      op.fail(err, (e) => { restoreField(); handleApiError(e); });
    } finally {
      op.done();
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
  function renderInviteBox(pid, alias, link, expiresAt) {
      renderBox("invite-result", (box) => {
        box.dataset.inviteFor = pid;
        const when = new Date(expiresAt);
        appendParagraph(box, t("th.js.invite_made", { name: alias || t("th.js.the_participant"), when: formatDateTime(when) }));
        const input = document.createElement("input");
        input.type = "text";
        input.readOnly = true;
        input.id = "invite-link";
        input.value = link;
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
  }

  el("btn-create-invite").addEventListener("click", async () => {
    if (!requireAuth() || inviteBusy) return;
    if (!state.participantId) {
      showError("MISSING_FIELD", tm("th.js.invite_need_participant"));
      return;
    }
    const pid = state.participantId; // captured BEFORE the await (FIX-37.1: the invite belongs to this participant)
    const alias = state.participantAlias;
    const ticket = ctxStore.capture();
    inviteBusy = true;
    el("btn-create-invite").disabled = true;
    try {
      const ttl = Number(el("invite-ttl").value) || 3600;
      const inv = await commands.singleFlightOnly("invite", () => client.createInvite(pid, ttl));
      if (inv.status === "ignored") return;
      if (inv.status === "error") throw inv.error;
      const res = inv.result;
      const link = new URL("participant.html", window.location.href);
      link.hash = `invite=${encodeURIComponent(res.data.invite_token)}`;
      if (!ticket.isCurrent()) {
        // Single-use secret: never shown in the new context, never lost. Kept in memory for its own participant only (D-ARQ4-02).
        ctxStore.addNotice(pid, { kind: "invite", link: link.toString(), expiresAt: res.data.expires_at, alias });
        return;
      }
      renderInviteBox(pid, alias, link.toString(), res.data.expires_at);
    } catch (err) {
      if (ticket.isCurrent()) handleApiError(err);
    } finally {
      inviteBusy = false;
      el("btn-create-invite").disabled = !state.participantId;
    }
  });

  // Step 3: Record functional assessment
  el("form-assessment").addEventListener("submit", async (event) => {
    event.preventDefault();
    beginAttempt("assessment");
    if (!requireParticipant()) return;
    if (!validateDateFields([{ input: el("assessment-date"), required: true }])) return;
    if (!domainCatalogs.instruments) Object.assign(domainCatalogs, await loadCatalogs());
    const instrument = instrumentFromSelection(domainCatalogs.instruments, el("assessment-instrument-id").value);
    if (!instrument || instrumentViolations(domainCatalogs.instruments, instrument).length) {
      setFieldError(el("assessment-instrument-id"), tm("rule.instrument.registry_mismatch"));
      el("assessment-instrument-id").focus();
      return;
    }
    const itemState = el("assessment-item-state").value;
    const items = [buildItem({
      key: el("assessment-item-key").value.trim(),
      valueType: el("assessment-item-value-type").value,
      rawValue: el("assessment-item-value").value,
      unit: el("assessment-item-unit").value,
      state: itemState,
      assistance: el("assessment-item-assistance").value,
    })];
    const itemProblems = domainRegistry().evaluate("assessment_item", { state: itemState, rawValue: el("assessment-item-value").value, item: items[0] });
    if (itemProblems.length) {
      const first = itemProblems[0];
      const input = el(FIELD_FOR_PATH[first.path.replace(/items\[\d+\]/, "items[0]")] || "assessment-item-value");
      const msg = tm(`rule.${first.rule}`, first.params);
      setFieldError(input, msg);
      input.focus();
      announce(msg, { politeness: "assertive" });
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
    beginAttempt("goal");
    if (!requireParticipant()) return;
    if (!validateDateFields([{ input: el("goal-deadline"), required: false }])) return;
    if (!domainCatalogs.goalRules) Object.assign(domainCatalogs, await loadCatalogs());
    const kind = el("goal-target-kind").value;
    const target = buildGoalTarget(domainCatalogs.goalRules, kind, el("goal-target-value").value);
    const problems = domainRegistry().evaluate("goal", { goal_text: el("goal-text").value, target });
    if (problems.length) {
      const first = problems[0];
      const input = el(FIELD_FOR_PATH[first.path]);
      const msg = tm(`rule.${first.rule}`, first.params);
      setFieldError(input, msg);
      input.focus();
      announce(msg, { politeness: "assertive" });
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
    beginAttempt("prescription");
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
    await cmd("prescription", (key) => client.publishPrescription(draft, { idempotencyKey: key }), async (res, ticket) => {
      const rxData = res.data;
      const curRes = await readAfterWrite(ticket, "prescription", (signal, pid) => client.getCurrentPrescription(pid, { signal }));
      if (curRes === STALE) return STALE;
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
    const pid = state.participantId;
    const op = ctxStore.begin("facts");
    try {
      let facts = [];
      let projected = null;
      let entries = [];
      let settled = false;
      // Repeat while a review was recorded during the load (projection could predate it).
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const epoch = state.reviewEpoch;
        const res = await client.listFacts(pid, { includeReviews: true }, { signal: op.signal });
        if (!op.isCurrent()) return; // late response: discard
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
            const evRes = await client.getFactEvidence(fact.fact_id, { signal: op.signal });
            if (!op.isCurrent()) return;
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
        if (!op.isCurrent()) return;
        state.effectiveReviews = reviews;
        settled = epoch === state.reviewEpoch;
        if (settled) break;
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
      // FIX-37.4: when the attempts are exhausted the projection may predate a review: say so, never present it as current.
      if (settled) showSuccess(tm("th.js.facts_loaded_detail", { n: entries.length }));
      else showError("STALE_DATA", tm("th.js.facts_stale", { n: entries.length }));
    } catch (err) {
      op.fail(err, handleApiError); // errors of a previous context are not shown in the current one
    } finally {
      op.done();
    }
  });

  // Step 7a: Publish summary
  el("form-summary").addEventListener("submit", async (event) => {
    event.preventDefault();
    beginAttempt("summary");
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
    await cmd("summary", (key) => client.publishSummary(summaryBody, { idempotencyKey: key }), async (pubRes, ticket) => {
      const getRes = await readAfterWrite(ticket, "summary", (signal) => client.getSummary(pubRes.data.summary_id, { signal }));
      if (getRes === STALE) return STALE;
      state.publishedSummary = getRes.data;
      renderPublishedSummary(getRes.data);
      showSuccess(tm("th.js.summary_ok"));
    }, summaryBody);
  });

  // Step 7b: Load comparable evolution series (cmp-v1)
  el("btn-load-evolution-series").addEventListener("click", async () => {
    if (!requireParticipant()) return;
    const op = ctxStore.begin("series");
    try {
      const res = await client.getEvolutionSeries(state.participantId, {}, { signal: op.signal });
      if (!op.isCurrent()) return;
      state.evolutionSeries = Array.isArray(res.data?.series) ? res.data.series : [];
      state.evolutionNotices = Array.isArray(res.data?.notices) ? res.data.notices : [];
      state.evolutionContextChanges = res.data?.context_changes || {};
      renderEvolutionSeries();
      updatePublishGates();
      showSuccess(tm("th.js.series_loaded", { n: state.evolutionSeries.length })
      );
    } catch (err) {
      op.fail(err, handleApiError);
    } finally {
      op.done();
    }
  });

  // Step 7b: Publish evolution
  el("form-evolution").addEventListener("submit", async (event) => {
    event.preventDefault();
    beginAttempt("evolution");
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
    await cmd("evolution", (key) => client.publishEvolution(evolutionBody, { idempotencyKey: key }), async (pubRes, ticket) => {
      const getRes = await readAfterWrite(ticket, "evolution", (signal) => client.getEvolution(pubRes.data.evolution_id, { signal }));
      if (getRes === STALE) return STALE;
      state.publishedEvolution = getRes.data;
      renderPublishedEvolution(getRes.data);
      showSuccess(tm("th.js.evo_ok"));
    }, evolutionBody);
  });

  // Step 8: Load participant timeline
  async function loadTimeline() {
    if (!requireParticipant()) return false;
    const op = ctxStore.begin("timeline");
    try {
      const res = await client.getTimeline(state.participantId, { signal: op.signal });
      if (!op.isCurrent()) return;
      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      state.timelineItems = items;
      renderTimeline(items);

      renderBox("timeline-summary", (box) => {
        appendParagraph(box, t("th.js.timeline_loaded", { n: items.length }));
      });
      showSuccess(tm("th.js.timeline_loaded", { n: items.length }));
      return true;
    } catch (err) {
      op.fail(err, handleApiError);
      return false;
    } finally {
      op.done();
    }
  }
  el("btn-load-timeline").addEventListener("click", () => { void loadTimeline(); });

  // Row 9: Unauthenticated navigation to any protected section redirects to sign-in.
  window.addEventListener("hashchange", () => {
    if (!state.session?.token && PROTECTED_HASHES.has(window.location.hash)) {
      redirectToSignIn(tm("th.js.session_required")
      );
    }
  });

  initI18n();
  // GoalTargetField: kind drives value/unit availability; the unit is derived and read-only (A2-02).
  let domainReg = null;
  function domainRegistry() { return domainReg || (domainReg = createDomainRegistry(domainCatalogs)); }
  function applyMeasurement() {
    const numeric = ["integer", "number"].includes(el("assessment-item-value-type").value);
    const unit = el("assessment-item-unit");
    unit.disabled = !numeric;
    if (!numeric) unit.value = "";
    const absent = el("assessment-item-state").value !== "observed";
    const v = el("assessment-item-value");
    v.disabled = absent;
    if (absent) v.value = "";
  }
  function applyUnits() {
    const sel = el("assessment-item-unit");
    for (const u of domainCatalogs.units.units) {
      if ([...sel.options].some((o) => o.value === u.unit)) continue;
      const o = document.createElement("option");
      o.value = u.unit;
      o.textContent = unitLabel(u.unit);
      sel.appendChild(o);
    }
    relabelUnits();
  }
  // I-01: unit options are built at runtime, so the language switch must relabel them (the value never changes).
  function relabelUnits() {
    const gu = el("goal-target-unit");
    if (gu) gu.value = unitLabel(gu.dataset.unit || "");
    const sel = el("assessment-item-unit");
    for (const o of sel.options) if (o.value) o.textContent = unitLabel(o.value);
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
    u.dataset.unit = spec.unit || ""; // canonical value (payload/state); the visible text is translated (I-01)
    u.value = unitLabel(spec.unit);
    if (!spec.numeric) v.value = "";
    else if (v.value === "") v.value = "3";
    v.min = String(spec.min ?? 0);
    if (spec.max != null) v.max = String(spec.max); else v.removeAttribute("max");
  }
  loadCatalogs().then((c) => { Object.assign(domainCatalogs, c); applyGoalKind(); applyInstrument(); applyUnits(); applyMeasurement(); }).catch(() => {});
  el("goal-target-kind").addEventListener("change", applyGoalKind);
  el("assessment-item-value-type").addEventListener("change", applyMeasurement);
  el("assessment-item-state").addEventListener("change", applyMeasurement);
  for (const fid of ["form-assessment", "form-goal"]) el(fid)?.addEventListener("reset", () => setTimeout(() => { applyMeasurement(); if (domainCatalogs.goalRules) applyGoalKind(); }, 0));
  el("assessment-instrument-id").addEventListener("change", syncInstrument);
  document.addEventListener("elo:lang", () => {
    // Re-render dynamic content in the new language without touching what the user typed.
    relabelUnits();
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
