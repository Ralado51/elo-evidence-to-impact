// Movement engine `c04-hand-1`, recovered from elo-research-lab/experiments/elo-integrated-demo/app/movement.mjs (measurement, quality guards,
// calibration stability checks, state machine). Nothing here stores or transmits frames: only derived numbers leave the detector.
//
// Integration rule (PO: no double counting, no silent change of the repetition definition):
//  - the measurement, guards and calibration checks below feed the existing Elo motion core through `c04Protocol`;
//  - the ledger counts with the Elo definition (cycle = open -> closed -> open, counted on return to open);
//  - `ReferenceGesture` (the original state machine, counted on closing) is kept for comparison tests ONLY and is never wired to the ledger.
export const ALGORITHM_VERSION = "c04-hand-1";
export const METHOD = "world_tip_distance_over_palm_length_median";
export const MIN_SPAN = 0.22; // same value as the v3 calibration contract
export const OPEN_AT = 0.72;
export const CLOSED_AT = 0.28;
export const MAX_GAP_MS = 240;

const TIPS = [8, 12, 16, 20];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const finite = (p) => p && [p.x, p.y, p.z].every(Number.isFinite);
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

/** One model result -> { metric, quality, completeness } (original `measure`). */
export function measure(result) {
  const points = result?.worldLandmarks?.[0];
  const image = result?.landmarks?.[0];
  if (points?.length !== 21 || image?.length !== 21 || !points.every(finite) || !image.every(finite)) return { metric: null, quality: "missing", completeness: 0 };
  const palm = dist(points[0], points[9]);
  if (palm < 0.015 || palm > 0.2 || image.some((p) => p.x <= 0.025 || p.x >= 0.975 || p.y <= 0.025 || p.y >= 0.975)) return { metric: null, quality: "insufficient", completeness: 1 };
  if (Math.hypot(image[0].x - image[9].x, image[0].y - image[9].y) < 0.055) return { metric: null, quality: "insufficient", completeness: 1 };
  return { metric: median(TIPS.map((i) => dist(points[0], points[i]) / palm)), quality: "usable", completeness: 1 };
}

/** Original calibration stability rule: postures must be different enough and each one stable. Returns true when acceptable. */
export function calibrationStable(open, closed) {
  const ok = (v) => v.filter(Number.isFinite);
  open = ok(open); closed = ok(closed);
  if (Math.min(open.length, closed.length) < 8) return false;
  const hi = median(open), lo = median(closed), span = hi - lo;
  const spread = (v, mid) => median(v.map((x) => Math.abs(x - mid)));
  return !(span < MIN_SPAN || Math.max(spread(open, hi), spread(closed, lo)) > span * 0.16);
}

/** Protocol for the Elo motion core: same measurement thresholds as the original engine, Elo cycle definition. */
export const c04Protocol = Object.freeze({
  version: ALGORITHM_VERSION,
  maxGapMs: MAX_GAP_MS,
  classify: (n) => (n >= OPEN_AT ? "open" : n <= CLOSED_AT ? "closed" : "transition"),
  isUsable: (frame) => frame.quality === "usable",
});

/** Detector adapter (same shape as camera.mjs createHandDetector). `onPreview(landmarks|null)` is for drawing only and keeps nothing. */
export function createC04Detector({ landmarker, swapDetectorLabels, onPreview = () => {} }) {
  if (typeof swapDetectorLabels !== "boolean") throw new TypeError("Declare detector label orientation");
  return {
    sample(video, timeMs) {
      const result = landmarker.detectForVideo(video, timeMs);
      const hands = result.landmarks?.length ?? 0;
      onPreview(hands === 1 ? result.landmarks[0] : null);
      if (!hands) return { timeMs, status: "absent" };
      const m = measure(result);
      if (hands !== 1 || m.quality !== "usable") return { timeMs, status: "insufficient" };
      const { categoryName, score } = result.handedness?.[0]?.[0] ?? {};
      const label = typeof categoryName === "string" ? categoryName.toLowerCase() : null;
      const side = label === "left" || label === "right" ? label : null;
      return {
        timeMs, status: "detected", value: m.metric, quality: m.quality,
        handedness: side && Number.isFinite(score) && score >= 0 && score <= 1 ? { label: swapDetectorLabels ? (side === "left" ? "right" : "left") : side, score } : null,
      };
    },
  };
}

/** Original state machine (counts when the hand CLOSES after being armed open). Comparison only; not used by the ledger. */
export class ReferenceGesture {
  constructor(profile) { this.profile = profile; this.reset(); }
  reset() { this.armedAt = null; this.zone = null; this.since = null; this.samples = 0; this.last = null; }
  step(frame, ms) {
    if (!Number.isFinite(ms) || (this.last !== null && ms <= this.last)) return false;
    if (!Number.isFinite(frame.metric) || frame.quality !== "usable") { this.reset(); this.last = ms; return false; }
    if (this.last !== null && ms - this.last > MAX_GAP_MS) this.reset();
    this.last = ms;
    const n = (frame.metric - this.profile.closed) / (this.profile.open - this.profile.closed);
    const zone = n >= OPEN_AT ? "open" : n <= CLOSED_AT ? "closed" : "between";
    if (zone !== this.zone) { this.zone = zone; this.since = ms; this.samples = 0; }
    this.samples++;
    if (this.samples < 3 || ms - this.since < 125) return false;
    if (zone === "open" && this.armedAt === null) this.armedAt = ms;
    if (zone === "closed" && this.armedAt !== null && ms - this.armedAt >= 180) { this.armedAt = null; return true; }
    return false;
  }
}
