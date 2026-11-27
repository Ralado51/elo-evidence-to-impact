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
  }
  function showError(code, message, technical = "", { scope = "participant" } = {}) {
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
    clearError();
    bindText(successBannerText, message);
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
  return { showError, showSuccess, clearError, clearSuccess, onContextChange, _owner: () => owner };
}

/** ErrorMapper: normalises an API error to { code, field?, rule?, message key hints } — details object OR code list. */
export function mapErrorDetails(error) {
  const d = error && error.details;
  if (!d) return { code: error?.code || "ERROR", rules: [] };
  if (Array.isArray(d)) return { code: error?.code || "ERROR", rules: d.map((x) => (typeof x === "string" ? { rule: x } : { rule: x.rule, path: x.path })).filter((x) => x.rule) };
  if (typeof d === "object") return { code: error?.code || "ERROR", rules: d.rule ? [{ rule: d.rule, path: d.path }] : [], path: d.path };
  return { code: error?.code || "ERROR", rules: [] };
}
