/**
 * Elo v3 accessibility live-region announcer (browser built-ins only; zero dependencies).
 *
 * Writes announcements exclusively to the single live region (#elo-live-region),
 * supports "polite" and "assertive" politeness levels, and clears text before
 * re-setting it so repeated identical announcements are surfaced by assistive technology.
 */

export const LIVE_REGION_ID = "elo-live-region";

/**
 * Locate the single status live region in the given document.
 * @param {Document | null | undefined} doc
 * @returns {Element}
 */
export function getLiveRegion(doc = globalThis.document) {
  if (!doc) {
    throw new Error("A document or live-region element is required to announce messages.");
  }
  const byId = typeof doc.getElementById === "function" ? doc.getElementById(LIVE_REGION_ID) : null;
  if (byId) {
    return byId;
  }
  const byQuery =
    typeof doc.querySelector === "function"
      ? doc.querySelector('[role="status"], [aria-live]')
      : null;
  if (byQuery) {
    return byQuery;
  }
  throw new Error(`Live region #${LIVE_REGION_ID} not found.`);
}

/**
 * Announce a message through the single live region.
 *
 * @param {string} message - Text to announce.
 * @param {{ politeness?: "polite" | "assertive", doc?: Document, region?: Element | null }} [options]
 * @returns {string} The normalized text written to the live region.
 */
export function announce(message, options = {}) {
  const { politeness = "polite", doc = globalThis.document, region = null } = options;
  if (politeness !== "polite" && politeness !== "assertive") {
    throw new RangeError(`Unsupported politeness level: ${politeness}`);
  }
  const target = region ?? getLiveRegion(doc);
  const text = String(message ?? "").trim();

  if (typeof target.setAttribute === "function") {
    target.setAttribute("aria-live", politeness);
    target.setAttribute("aria-atomic", "true");
  }

  // Clear first, then set so repeated identical messages trigger a fresh announcement.
  target.textContent = "";
  target.textContent = text;
  return text;
}
