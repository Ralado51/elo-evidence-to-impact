import { REF_OPEN, REF_CLOSED } from "./protocol.mjs";

/** Deterministic synthetic samples/frames. No camera, no image, no landmark. */
export function simulateCalibrationSamples({ open = REF_OPEN, closed = REF_CLOSED, n = 12 } = {}) {
  const wob = (i) => ((i % 3) - 1) * 0.01;
  return {
    open: Array.from({ length: n }, (_, i) => open + wob(i)),
    closed: Array.from({ length: n }, (_, i) => closed + wob(i)),
  };
}

/** One open -> closed -> open cycle as frames, `step` ms apart, starting after `startMs`. `side` null = indeterminate. */
export function simulateCycleFrames({ startMs, side = "right", score = 0.95, open = REF_OPEN, closed = REF_CLOSED, step = 100 }) {
  const span = open - closed;
  const norm = [1, 1, 0.5, 0, 0, 0.5, 1, 1];
  return norm.map((n, i) => ({
    timeMs: startMs + (i + 1) * step, status: "detected", value: closed + n * span,
    handedness: side ? { label: side, score } : null,
  }));
}
