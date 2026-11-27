import { PROTOCOL_VERSION } from "./capture_events.mjs";

// contador-exp-1: EXPERIMENTAL. Every value below comes from the existing web/s2/counter.js (thresholdsFrom / createCounter defaults).
// No clinical validity is attributed to these parameters (PO B2). Differences with counter.js: the core normalizes with the calibration
// median open/closed values (not P10-P90) and does not apply the EMA smoothing, minCycleMs/maxCycleMs or minAmp of createCounter.
export const CLOSE_FRACTION = 0.3; // counter.js: closeBelow = lo + 0.3 * (hi - lo)
export const OPEN_FRACTION = 0.7; // counter.js: openAbove  = lo + 0.7 * (hi - lo)
export const LOST_MS = 600; // counter.js: lostMs default
export const MIN_SPAN = 0.3; // counter.js: thresholdsFrom rejects hi - lo < 0.3
export const REF_OPEN = 1.7; // counter.js comment: open about 1.6-1.7
export const REF_CLOSED = 0.6; // counter.js comment: closed about 0.6

export const contadorExp1 = Object.freeze({
  version: PROTOCOL_VERSION,
  maxGapMs: LOST_MS,
  classify: (n) => (n >= OPEN_FRACTION ? "open" : n <= CLOSE_FRACTION ? "closed" : "transition"),
  isUsable: () => true,
});
