/**
 * Elo v3 — Therapist journey browser controller (S1-03).
 *
 * Strictly uses /api/v3 endpoints via api_client.mjs, RFC 8785 hashing via canonical.mjs,
 * pure review-gate & formatting rules via therapist_model.mjs, and the sole live region
 * announcer via a11y.mjs. Zero legacy imports.
 */

import { announce } from "./a11y.mjs";
import { createV3Client, V3ApiError } from "./api_client.mjs";
import { hashCanonical } from "./canonical.mjs";
import {
  ASSISTANCE_TRANSITION_LABEL_PTBR,
  TIMELINE_KIND_LABEL_PTBR,
  canPublishEvolution,
  canPublishSummary,
  evaluateFactGate,
  formatApiErrorMessage,
  formatExecutionMode,
  formatOriginLabel,
  getPublishableSummaryItems,
} from "./therapist_model.mjs";

const SESSION_STORAGE_KEY = "elo_v3_therapist_session";

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
    evolutionSeries: [],
    evolutionNotices: [],
    evolutionContextChanges: {},
    publishedSummary: null,
    publishedEvolution: null,
    timelineItems: [],
  };

  const client = createV3Client({
    getToken: () => state.session?.token || null,
  });

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
    errorBannerText.textContent = "";
  }

  function clearSuccess() {
    successBanner.hidden = true;
    successBannerText.textContent = "";
  }

  function showError(code, message) {
    // Row 3: Never show success when an error occurs.
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
    const msg =
      reasonText ||
      formatApiErrorMessage({ code: "UNAUTHENTICATED", status: 401 });
    showError("UNAUTHENTICATED", msg);
    if (window.location.hash !== "#sec-signin") {
      window.location.hash = "#sec-signin";
    }
    const userInput = el("signin-username");
    if (userInput) {
      userInput.focus();
    }
  }

  function handleApiError(err) {
    const apiErr =
      err instanceof V3ApiError
        ? err
        : new V3ApiError({
            code: err?.code || "UNKNOWN_ERROR",
            status: err?.status || 0,
            message: err instanceof Error ? err.message : String(err),
          });
    const formatted = formatApiErrorMessage(apiErr);
    if (apiErr.code === "UNAUTHENTICATED") {
      redirectToSignIn(formatted);
      return;
    }
    showError(apiErr.code, formatted);
  }

  function requireAuth() {
    if (!state.session || !state.session.token) {
      redirectToSignIn(
        "[UNAUTHENTICATED] Sessão não autenticada. Redirecionado para a etapa 1 (Entrar como terapeuta)."
      );
      return false;
    }
    return true;
  }

  function requireParticipant() {
    if (!requireAuth()) return false;
    const pid = state.participantId.trim();
    if (!pid) {
      showError(
        "PARTICIPANT_REQUIRED",
        "[PARTICIPANT_REQUIRED] Cadastre ou selecione um participante na etapa 2 antes de continuar."
      );
      el("participant-alias")?.focus();
      return false;
    }
    return true;
  }

  function updateSessionBar() {
    if (state.session && state.session.token) {
      const p = state.session.principal || {};
      const role = p.role || "unknown";
      const id = p.id || "desconhecido";
      const org = p.org_id || "desconhecida";
      sessionSummary.textContent = `Autenticado: ${id} (perfil: ${role}, organização: ${org}).`;
      btnSignout.hidden = false;
    } else {
      sessionSummary.textContent =
        "Sessão não autenticada. Entre como terapeuta na etapa 1 para continuar.";
      btnSignout.hidden = true;
    }

    if (state.participantId) {
      const aliasPart = state.participantAlias ? ` (${state.participantAlias})` : "";
      const linkPart = state.careLinkId ? ` • vínculo: ${state.careLinkId}` : "";
      participantSummary.textContent = `Participante ativo: ${state.participantId}${aliasPart}${linkPart}.`;
    } else {
      participantSummary.textContent = "Nenhum participante selecionado.";
    }
  }

  function setActiveParticipant(participantId, alias = "", careLinkId = "", side = "") {
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
    state.evolutionSeries = [];
    state.evolutionNotices = [];
    state.evolutionContextChanges = {};
    renderFactsList();
    renderEvolutionSeries();
    updatePublishGates();
    updateSessionBar();
  }

  function updatePublishGates() {
    const approvedItems = getPublishableSummaryItems(state.factEntries);
    const summaryAllowed = canPublishSummary(state.factEntries);
    btnPublishSummary.disabled = !summaryAllowed;
    if (summaryAllowed) {
      summaryGateStatus.textContent = `Pronto para publicação: ${approvedItems.length} fato(s) elegível(is) aprovado(s) pelo terapeuta.`;
    } else {
      summaryGateStatus.textContent =
        "Publicação bloqueada: nenhum fato elegível está efetivamente aprovado com content_hash atual.";
    }

    const evolutionAllowed = canPublishEvolution(state.evolutionSeries, state.factEntries);
    btnPublishEvolution.disabled = !evolutionAllowed;
    if (evolutionAllowed) {
      evolutionGateStatus.textContent = `Pronto para publicação: ${state.evolutionSeries.length} série(s) comparável(is) cmp-v1 com fatos aprovados.`;
    } else {
      evolutionGateStatus.textContent =
        "Publicação bloqueada: aprove os fatos elegíveis e carregue as séries comparáveis cmp-v1.";
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
      badges.appendChild(createBadge(`Fato ${fact.type}`, "", "data-fact-type-badge", fact.type));
      badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      badges.appendChild(
        createBadge(`Modo de execução: ${execModeLabel}`, "badge-mode", "data-execution-mode", executionMode)
      );
      const statusClass =
        gate.status === "approved"
          ? "badge-approved"
          : gate.status === "rejected"
            ? "badge-rejected"
            : "";
      badges.appendChild(createBadge(gate.labelPtBr, statusClass, "data-review-status", gate.status));
      li.appendChild(badges);

      appendParagraph(li, fact.rendered?.text_ptbr || "", "");
      appendParagraph(li, `Identificador: ${fact.fact_id}`, "mono");
      appendParagraph(li, `content_hash: ${contentHash}`, "mono");

      const lims = Array.isArray(fact.rendered?.limitations_ptbr) ? fact.rendered.limitations_ptbr : [];
      if (lims.length > 0) {
        const ul = document.createElement("ul");
        ul.className = "limitations-list";
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
      noteLabel.textContent = `Nota de revisão para ${fact.type} (${fact.fact_id})`;
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
        { key: "approve", label: "Aprovar fato", cls: "btn btn-primary target" },
        { key: "reject", label: "Rejeitar fato", cls: "btn btn-secondary target" },
        { key: "annotate", label: "Anotar fato", cls: "btn btn-secondary target" },
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
    try {
      const res = await client.recordReview({
        participant_id: state.participantId,
        fact_id: entry.fact.fact_id,
        content_hash: entry.contentHash,
        decision,
        note,
      });
      if (decision === "approve" || decision === "reject") {
        entry.effectiveReview = {
          decision,
          content_hash: entry.contentHash,
          event_id: res.data.event_id,
          note,
        };
        state.effectiveReviews[entry.fact.fact_id] = entry.effectiveReview;
      }
      // Changing effective review invalidates previously loaded evolution series snapshot.
      if (decision === "reject") {
        state.evolutionSeries = [];
        renderEvolutionSeries();
      }
      renderFactsList();
      updatePublishGates();
      showSuccess(
        `Revisão registrada (${decision}) para ${entry.fact.type} (${entry.fact.fact_id}). Evento: ${res.data.event_id}.`
      );
    } catch (err) {
      handleApiError(err);
    }
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
      badges.appendChild(createBadge(`Série ${sk.fact_type || "?"} (${sk.movement_task || ""})`, "", "", ""));
      badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      badges.appendChild(
        createBadge(`Modo de execução: ${execModeLabel}`, "badge-mode", "data-execution-mode", execMode)
      );
      card.appendChild(badges);

      appendParagraph(
        card,
        `Regras: cmp-v1 • Lado: ${sk.laterality || "?"} • Método: ${sk.method || "?"} • Hash da série: ${series.series_key_hash}`,
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
          createBadge(`Modo de execução: ${execModeLabel}`, "badge-mode", "data-execution-mode", execMode)
        );
        itemLi.appendChild(itemBadges);

        appendParagraph(itemLi, `${item.session_date_local}: ${item.text_ptbr}`);
        const ctx = item.context || {};
        appendParagraph(
          itemLi,
          `Contexto — ajuda: ${ctx.assistance_level ?? "?"} • dor/fadiga sinalizada: ${String(ctx.pain_or_fatigue_signalled)} • dose prescrita: ${ctx.dose_prescribed ?? "?"} • término: ${ctx.session_end_reason ?? "?"}`
        );
        itemsUl.appendChild(itemLi);
      }
      card.appendChild(itemsUl);

      const transitions = Array.isArray(series.assistance_transitions)
        ? series.assistance_transitions
        : [];
      for (const tr of transitions) {
        const dirLabel =
          ASSISTANCE_TRANSITION_LABEL_PTBR[tr.direction] || String(tr.direction);
        appendParagraph(
          card,
          `Transição descritiva de ajuda relatada: ${tr.from_level} → ${tr.to_level} (${dirLabel}).`
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
          `Aviso de separação de série (${n.kind}): chaves diferentes: ${(n.differing_keys || []).join(", ")}.`
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
    badges.appendChild(createBadge("Resumo publicado", "badge-approved", "", ""));
    badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
    badges.appendChild(
      createBadge(`Modo de execução: ${execModeLabel}`, "badge-mode", "data-execution-mode", execMode)
    );
    card.appendChild(badges);

    appendParagraph(
      card,
      `Resumo ${payload.summary_id} publicado para o período ${payload.period_from} a ${payload.period_to}.`
    );
    appendParagraph(card, `Evento: ${summaryEvent.event_id} • Itens: ${(payload.items || []).length}`, "mono");

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
          `Modo de execução: ${formatExecutionMode(itemMode)}`,
          "badge-mode",
          "data-execution-mode",
          itemMode
        )
      );
      li.appendChild(itemBadges);
      appendParagraph(li, entry?.fact?.rendered?.text_ptbr || `Fato incluído: ${item.fact_id}`);
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
    badges.appendChild(createBadge("Evolução publicada (cmp-v1)", "badge-approved", "", ""));
    badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
    badges.appendChild(
      createBadge(`Modo de execução: ${execModeLabel}`, "badge-mode", "data-execution-mode", execMode)
    );
    card.appendChild(badges);

    appendParagraph(
      card,
      `Evolução ${payload.evolution_id} publicada (${payload.period_from} a ${payload.period_to}) sob regras ${payload.comparability_rules_version}.`
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
        ib.appendChild(createBadge(`Fato ${sk.fact_type || "?"}`, "", "", ""));
        ib.appendChild(createBadge(sOrigin, "badge-origin", "data-origin-label", sOrigin));
        ib.appendChild(
          createBadge(`Modo de execução: ${formatExecutionMode(sMode)}`, "badge-mode", "data-execution-mode", sMode)
        );
        li.appendChild(ib);
        appendParagraph(li, `Série ${sk.movement_task || "organizar-a-mesa"} • Fato ${it.fact_id}`, "mono");
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

      const originLabel =
        item.origin_label && item.origin_label.trim()
          ? item.origin_label.trim()
          : formatOriginLabel(item.data_origin);
      const execMode = item.execution_mode || "not_applicable";
      const execModeLabel = formatExecutionMode(execMode);
      const kindPt = TIMELINE_KIND_LABEL_PTBR[item.kind] || item.kind;

      const badges = document.createElement("div");
      badges.className = "meta-badges";
      badges.appendChild(createBadge(`${kindPt} (${item.kind})`, "", "", ""));
      badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      badges.appendChild(
        createBadge(`Modo de execução: ${execModeLabel}`, "badge-mode", "data-execution-mode", execMode)
      );
      li.appendChild(badges);

      appendParagraph(li, `Referência: ${item.ref} • Registrado em: ${item.occurred_at}`, "mono");
      list.appendChild(li);
    }
  }

  // --- Event bindings ---

  btnSignout.addEventListener("click", () => {
    state.session = null;
    writeStoredSession(null);
    updateSessionBar();
    updatePublishGates();
    showSuccess("Sessão encerrada.");
    window.location.hash = "#sec-signin";
    el("signin-username")?.focus();
  });

  // Step 1: Therapist sign-in
  el("form-signin").addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = el("signin-username").value.trim();
    const password = el("signin-password").value;
    if (!username || !password) {
      showError("UNAUTHENTICATED", "[UNAUTHENTICATED] Informe usuário e senha do terapeuta.");
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

      const box = el("signin-result");
      clearElement(box);
      box.hidden = false;
      appendParagraph(
        box,
        `Terapeuta autenticado: ${res.data.principal.id} (organização: ${res.data.principal.org_id}).`
      );
      showSuccess(`Sessão iniciada para ${res.data.principal.id}.`);
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
      showError("MISSING_FIELD", "[MISSING_FIELD] Informe o apelido sintético do participante.");
      return;
    }
    try {
      const res = await client.createParticipant(alias, side);
      const ent = res.data;
      const careLinkId = res.headers.get("x-elo-care-link-id") || "";
      setActiveParticipant(ent.entity_id, ent.payload.alias, careLinkId, ent.payload.side);

      const box = el("participant-result");
      clearElement(box);
      box.hidden = false;
      const originLabel = formatOriginLabel(ent.data_origin);
      const badges = document.createElement("div");
      badges.className = "meta-badges";
      badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      badges.appendChild(
        createBadge(
          `Modo de execução: ${formatExecutionMode("not_applicable")}`,
          "badge-mode",
          "data-execution-mode",
          "not_applicable"
        )
      );
      box.appendChild(badges);
      appendParagraph(
        box,
        `Participante cadastrado e vinculado: ${ent.entity_id} (versão ${ent.version}, lado ${ent.payload.side}).`
      );
      appendParagraph(box, `Vínculo de cuidado (care_link): ${careLinkId}`, "mono");

      showSuccess(`Participante ${ent.entity_id} cadastrado e vinculado (${careLinkId}).`);
    } catch (err) {
      handleApiError(err);
    }
  });

  // Step 2b: Select existing participant by ID (useful for resuming or authorization checks)
  el("form-select-participant").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!requireAuth()) return;
    const pid = el("active-participant-id").value.trim();
    if (!pid) {
      showError("MISSING_FIELD", "[MISSING_FIELD] Informe um identificador de participante válido.");
      return;
    }
    setActiveParticipant(pid);
    showSuccess(`Participante ativo definido para ${pid}.`);
  });

  // Step 3: Record functional assessment
  el("form-assessment").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireParticipant()) return;
    const noteText = el("assessment-note").value.trim();
    const payload = {
      assessment_date: el("assessment-date").value.trim(),
      body_segment: el("assessment-segment").value,
      side: el("assessment-side").value,
      instrument: {
        instrument_id: el("assessment-instrument-id").value.trim(),
        instrument_version: el("assessment-instrument-version").value.trim(),
        status: el("assessment-instrument-status").value,
      },
      items: [
        {
          item_key: el("assessment-item-key").value.trim(),
          value_type: "category",
          value: el("assessment-item-value").value.trim(),
          unit: null,
          source: "therapist_observed",
          assistance: el("assessment-item-assistance").value,
          not_assessed: false,
        },
      ],
      therapist_note: noteText.length > 0 ? noteText : null,
    };
    try {
      const res = await client.createAssessment(state.participantId, payload);
      const ent = res.data;
      const box = el("assessment-result");
      clearElement(box);
      box.hidden = false;
      const originLabel = formatOriginLabel(ent.data_origin);
      const badges = document.createElement("div");
      badges.className = "meta-badges";
      badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      badges.appendChild(
        createBadge(
          `Modo de execução: ${formatExecutionMode("not_applicable")}`,
          "badge-mode",
          "data-execution-mode",
          "not_applicable"
        )
      );
      box.appendChild(badges);
      appendParagraph(
        box,
        `Avaliação funcional registrada: ${ent.entity_id} (versão ${ent.version}) em ${ent.payload.assessment_date}.`
      );
      showSuccess(`Avaliação funcional ${ent.entity_id} registrada.`);
    } catch (err) {
      handleApiError(err);
    }
  });

  // Step 4: Create functional goal
  el("form-goal").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireParticipant()) return;
    const kind = el("goal-target-kind").value;
    const rawVal = el("goal-target-value").value.trim();
    const rawUnit = el("goal-target-unit").value.trim();
    const payload = {
      goal_text: el("goal-text").value.trim(),
      body_segment: el("goal-segment").value,
      target: {
        kind,
        value: kind === "descriptive_text" || rawVal === "" ? null : Number(rawVal),
        unit: kind === "descriptive_text" || rawUnit === "" ? null : rawUnit,
      },
      status: el("goal-status").value,
      confirmed_by: null,
      confirmed_at: null,
    };
    try {
      const res = await client.createGoal(state.participantId, payload);
      const ent = res.data;
      const box = el("goal-result");
      clearElement(box);
      box.hidden = false;
      const originLabel = formatOriginLabel(ent.data_origin);
      const badges = document.createElement("div");
      badges.className = "meta-badges";
      badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      badges.appendChild(
        createBadge(
          `Modo de execução: ${formatExecutionMode("not_applicable")}`,
          "badge-mode",
          "data-execution-mode",
          "not_applicable"
        )
      );
      box.appendChild(badges);
      appendParagraph(
        box,
        `Meta registrada: ${ent.entity_id} (versão ${ent.version}, estado ${ent.payload.status}).`
      );
      showSuccess(`Meta funcional ${ent.entity_id} salva.`);
    } catch (err) {
      handleApiError(err);
    }
  });

  // Step 5: Publish prescription (organizar-a-mesa, report-only)
  el("form-prescription").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireParticipant()) return;
    const validToRaw = el("rx-valid-to").value.trim();
    const draft = {
      participant_id: state.participantId,
      exercise_id: el("rx-exercise").value,
      permitted_movement: el("rx-movement").value,
      side: el("rx-side").value,
      target_sets: Number.parseInt(el("rx-sets").value, 10),
      target_repetitions: Number.parseInt(el("rx-reps").value, 10),
      sessions_per_week: Number.parseInt(el("rx-sessions-week").value, 10),
      valid_from: el("rx-valid-from").value.trim(),
      valid_to: validToRaw.length > 0 ? validToRaw : null,
      timezone: el("rx-timezone").value,
      min_calibration_span: null,
      instructions_ptbr: el("rx-instructions").value.trim(),
    };
    try {
      const res = await client.publishPrescription(draft);
      const rxData = res.data;
      const curRes = await client.getCurrentPrescription(state.participantId);
      const rxEvent = curRes.data;
      const originLabel = formatOriginLabel(rxEvent.data_origin);
      const execMode = rxEvent.execution_mode || "not_applicable";

      const box = el("prescription-result");
      clearElement(box);
      box.hidden = false;
      const badges = document.createElement("div");
      badges.className = "meta-badges";
      badges.appendChild(createBadge(originLabel, "badge-origin", "data-origin-label", originLabel));
      badges.appendChild(
        createBadge(
          `Modo de execução: ${formatExecutionMode(execMode)}`,
          "badge-mode",
          "data-execution-mode",
          execMode
        )
      );
      box.appendChild(badges);
      appendParagraph(
        box,
        `Prescrição publicada: ${rxData.prescription_id} (revisão ${rxData.revision}) — Organizar a mesa (modo de relato apenas).`
      );
      appendParagraph(box, `Evento: ${rxData.event_id}`, "mono");
      showSuccess(`Prescrição ${rxData.prescription_id} (revisão ${rxData.revision}) publicada.`);
    } catch (err) {
      handleApiError(err);
    }
  });

  // Step 6: Load verified facts & resolve execution_mode from evidence
  el("btn-load-facts").addEventListener("click", async () => {
    if (!requireParticipant()) return;
    try {
      const res = await client.listFacts(state.participantId);
      const facts = Array.isArray(res.data?.facts) ? res.data.facts : [];

      // Fetch execution_mode once per unique session_id via GET /api/v3/facts/{fact_id}/evidence.
      const sessionModeCache = new Map();
      const entries = [];
      for (const fact of facts) {
        const sid = fact.scope?.session_id || "";
        let executionMode = sessionModeCache.get(sid);
        if (!executionMode) {
          const evRes = await client.getFactEvidence(fact.fact_id);
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
          effectiveReview: state.effectiveReviews[fact.fact_id] || null,
          draftNote: "",
        });
      }

      state.factEntries = entries;
      renderFactsList();
      updatePublishGates();

      const summaryBox = el("facts-summary");
      clearElement(summaryBox);
      summaryBox.hidden = false;
      appendParagraph(
        summaryBox,
        `${entries.length} fato(s) verificado(s) carregado(s) (catálogo v${res.data?.catalog_version || "2"}).`
      );
      showSuccess(`${entries.length} fato(s) verificado(s) carregado(s) para revisão.`);
    } catch (err) {
      handleApiError(err);
    }
  });

  // Step 7a: Publish summary
  el("form-summary").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireParticipant()) return;
    const items = getPublishableSummaryItems(state.factEntries);
    if (items.length === 0) {
      showError(
        "FACT_NOT_APPROVED",
        formatApiErrorMessage({ code: "FACT_NOT_APPROVED", status: 422 })
      );
      return;
    }
    const periodFrom = el("summary-period-from").value.trim();
    const periodTo = el("summary-period-to").value.trim();
    try {
      const pubRes = await client.publishSummary({
        participant_id: state.participantId,
        items,
        period: { from: periodFrom, to: periodTo },
        note_refs: [],
      });
      const getRes = await client.getSummary(pubRes.data.summary_id);
      state.publishedSummary = getRes.data;
      renderPublishedSummary(getRes.data);
      showSuccess(`Resumo ${pubRes.data.summary_id} publicado e verificado.`);
    } catch (err) {
      handleApiError(err);
    }
  });

  // Step 7b: Load comparable evolution series (cmp-v1)
  el("btn-load-evolution-series").addEventListener("click", async () => {
    if (!requireParticipant()) return;
    try {
      const res = await client.getEvolutionSeries(state.participantId);
      state.evolutionSeries = Array.isArray(res.data?.series) ? res.data.series : [];
      state.evolutionNotices = Array.isArray(res.data?.notices) ? res.data.notices : [];
      state.evolutionContextChanges = res.data?.context_changes || {};
      renderEvolutionSeries();
      updatePublishGates();
      showSuccess(
        `${state.evolutionSeries.length} série(s) comparável(is) carregada(s) sob regras ${res.data?.rules_version || "cmp-v1"}.`
      );
    } catch (err) {
      handleApiError(err);
    }
  });

  // Step 7b: Publish evolution
  el("form-evolution").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireParticipant()) return;
    if (!canPublishEvolution(state.evolutionSeries, state.factEntries)) {
      showError(
        "UNREVIEWED_FACT_IN_EVOLUTION",
        formatApiErrorMessage({ code: "UNREVIEWED_FACT_IN_EVOLUTION", status: 409 })
      );
      return;
    }
    const periodFrom = el("evolution-period-from").value.trim();
    const periodTo = el("evolution-period-to").value.trim();
    const seriesKeys = state.evolutionSeries.map((s) => s.series_key_hash);
    try {
      const pubRes = await client.publishEvolution({
        participant_id: state.participantId,
        period: { from: periodFrom, to: periodTo },
        series_keys: seriesKeys,
      });
      const getRes = await client.getEvolution(pubRes.data.evolution_id);
      state.publishedEvolution = getRes.data;
      renderPublishedEvolution(getRes.data);
      showSuccess(`Evolução ${pubRes.data.evolution_id} publicada e verificada.`);
    } catch (err) {
      handleApiError(err);
    }
  });

  // Step 8: Load participant timeline
  el("btn-load-timeline").addEventListener("click", async () => {
    if (!requireParticipant()) return;
    try {
      const res = await client.getTimeline(state.participantId);
      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      state.timelineItems = items;
      renderTimeline(items);

      const box = el("timeline-summary");
      clearElement(box);
      box.hidden = false;
      appendParagraph(box, `Linha do tempo carregada com ${items.length} registro(s) ordenado(s).`);
      showSuccess(`Linha do tempo carregada com ${items.length} item(ns).`);
    } catch (err) {
      handleApiError(err);
    }
  });

  // Row 9: Unauthenticated navigation to any protected section redirects to sign-in.
  window.addEventListener("hashchange", () => {
    if (!state.session?.token && PROTECTED_HASHES.has(window.location.hash)) {
      redirectToSignIn(
        "[UNAUTHENTICATED] Sessão não autenticada. Redirecionado para a etapa 1 (Entrar como terapeuta)."
      );
    }
  });

  updateSessionBar();
  updatePublishGates();

  if (!state.session?.token && PROTECTED_HASHES.has(window.location.hash)) {
    redirectToSignIn(
      "[UNAUTHENTICATED] Sessão não autenticada. Redirecionado para a etapa 1 (Entrar como terapeuta)."
    );
  }
}

if (typeof document !== "undefined") {
  initTherapistApp();
}
