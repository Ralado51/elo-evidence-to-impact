/**
 * Elo v3 accessibility live-region announcer (browser built-ins only; zero dependencies).
 *
 * Writes announcements exclusively to the single shell live region (#elo-live-region),
 * supports "polite" and "assertive" politeness levels, and clears text before
 * re-setting it so repeated identical announcements are surfaced by assistive technology.
 */

export const LIVE_REGION_ID = "elo-live-region";

/**
 * Locate the single status live region by its fixed id within the given document/root.
 * @param {Document | Element | null | undefined} doc
 * @returns {Element}
 */
export function getLiveRegion(doc = globalThis.document) {
  if (!doc) {
    throw new Error("A document is required to locate the live region.");
  }
  const byId =
    typeof doc.getElementById === "function" ? doc.getElementById(LIVE_REGION_ID) : null;
  if (byId) {
    return byId;
  }
  const bySelector =
    typeof doc.querySelector === "function" ? doc.querySelector(`#${LIVE_REGION_ID}`) : null;
  if (bySelector) {
    return bySelector;
  }
  throw new Error(`Live region #${LIVE_REGION_ID} not found.`);
}

/**
 * Announce a message exclusively through the single shell live region (#elo-live-region).
 *
 * Arbitrary target element overrides are intentionally not supported (D-S0-05-2).
 *
 * @param {string} message - Text to announce.
 * @param {{ politeness?: "polite" | "assertive", doc?: Document | Element }} [options]
 * @returns {string} The normalized text written to the live region.
 */
export function announce(message, options = {}) {
  const { politeness = "polite", doc = globalThis.document } = options ?? {};
  if (politeness !== "polite" && politeness !== "assertive") {
    throw new RangeError(`Unsupported politeness level: ${politeness}`);
  }
  const target = getLiveRegion(doc);
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
