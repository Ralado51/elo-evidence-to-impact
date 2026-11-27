// ARQ-04 / CMP-03 — centralised feedback (success/error banners + live announcement).
// One implementation replaces the three copies in therapist_app / participant_app / painel_app.
//  - exclusive states: showing an error clears the success banner and vice versa (Row 3: never both);
//  - announce dedup: an identical message is not re-announced within the same tick storm (double click, retry);
//  - owner scope: a banner raised for a participant is cleared when the context moves to another participant,
//    so feedback of Alfa never stays on screen for Beta (FIX-37.2). `owner: "global"` survives participant switches
//    (sign-in/out messages) and is cleared only by principal change.
export function createFeedback({ errorBanner, errorBannerText, successBanner, successBannerText, bindText, renderErrorTechnical, announce, now = () => Date.now(), dedupMs = 400 }) {
  let owner = null; // { kind: "participant"|"global" }
  let lastAnnounce = { text: "", at: 0, politeness: "" };
  // FIX-41: lifecycle of result surfaces (assessment, goal, prescription, review, publication result boxes) lives HERE,
  // so every app uses one rule: a new attempt replaces the previous attempt's feedback and results, even when it is stopped by
  // local validation. Only a no-op attempt (same intention already saved / still in flight) gives the previous feedback back.
  const surfaces = new Map(); // kind -> { clear(), restore() }
  let parked = null; // success message hidden by the current attempt
  let lastSuccess = null; // message currently shown in the success banner (a Msg keeps re-translating)

  function say(message, politeness) {
    const text = typeof message === "string" ? message : message?.text ?? "";
    const t0 = now();
    if (text && lastAnnounce.text === text && lastAnnounce.politeness === politeness && t0 - lastAnnounce.at < dedupMs) return false;
    lastAnnounce = { text, at: t0, politeness };
    announce(message, { politeness });
    return true;
  }

  function clearError() {
    errorBanner.hidden = true;
    errorBanner.removeAttribute("role");
    errorBanner.setAttribute("data-error-code", "");
    bindText(errorBannerText, "");
    renderErrorTechnical(errorBanner, "");
  }
  function clearSuccess() {
    if (!successBanner) return;
    successBanner.hidden = true;
    bindText(successBannerText, "");
    lastSuccess = null;
  }
  function showError(code, message, technical = "", { scope = "participant" } = {}) {
    parked = null;
    clearSuccess();
    errorBanner.setAttribute("role", "alert");
    errorBanner.setAttribute("data-error-code", code || "ERROR");
    bindText(errorBannerText, message);
    renderErrorTechnical(errorBanner, technical);
    errorBanner.hidden = false;
    owner = { kind: scope };
    say(message, "assertive");
  }
  function showSuccess(message, { scope = "participant" } = {}) {
    parked = null;
    clearError();
    bindText(successBannerText, message);
    lastSuccess = message;
    successBanner.hidden = false;
    owner = { kind: scope };
    say(message, "polite");
  }
  /** Context moved: drop participant-owned feedback. "principal"/"logout" also drops global feedback. */
  function onContextChange(reason) {
    if (!owner) return;
    if (owner.kind === "participant" || reason === "principal" || reason === "logout") {
      clearError();
      clearSuccess();
      owner = null;
    }
  }
  /** Registers how a result surface is emptied and (for no-op attempts) given back. History/records are never touched. */
  function registerSurface(kind, adapter) { surfaces.set(kind, adapter); }
  /** Every submit attempt starts here, before local validation. */
  function beginAttempt(kind) {
    parked = successBanner && !successBanner.hidden && lastSuccess !== null ? lastSuccess : null;
    clearError();
    clearSuccess();
    surfaces.get(kind)?.clear();
  }
  /** The attempt turned out to be a no-op (same intention settled / already in flight): previous feedback and results come back. */
  function restoreAttempt(kind) {
    const msg = parked;
    parked = null;
    if (msg !== null) showSuccess(msg);
    surfaces.get(kind)?.restore();
  }
  return { showError, showSuccess, clearError, clearSuccess, onContextChange, registerSurface, beginAttempt, restoreAttempt, _owner: () => owner };
}

/** ErrorMapper: normalises an API error to { code, field?, rule?, message key hints } — details object OR code list. */
export function mapErrorDetails(error) {
  const d = error && error.details;
  if (!d) return { code: error?.code || "ERROR", rules: [] };
  if (Array.isArray(d)) return { code: error?.code || "ERROR", rules: d.map((x) => (typeof x === "string" ? { rule: x } : { rule: x.rule, path: x.path })).filter((x) => x.rule) };
  if (typeof d === "object") return { code: error?.code || "ERROR", rules: d.rule ? [{ rule: d.rule, path: d.path }] : [], path: d.path };
  return { code: error?.code || "ERROR", rules: [] };
}
