import test from "node:test";
import assert from "node:assert/strict";
import { measure, calibrationStable, c04Protocol, createC04Detector, ReferenceGesture, ALGORITHM_VERSION } from "./c04_engine.mjs";
import { createMotionSession } from "./motion.mjs";

const hand = (open, { edge = 0.5 } = {}) => {
  const w = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  w[9] = { x: 0, y: -0.09, z: 0 };
  [8, 12, 16, 20].forEach((i) => { w[i] = { x: 0, y: -0.09 * (open ? 2 : 0.6), z: 0 }; });
  const img = Array.from({ length: 21 }, () => ({ x: edge, y: 0.5, z: 0 }));
  img[0] = { x: edge, y: 0.8, z: 0 }; img[9] = { x: edge, y: 0.5, z: 0 };
  return { worldLandmarks: [w], landmarks: [img], handedness: [[{ categoryName: "Left", score: 0.9 }]] };
};

test("measure: usable metric separates open from closed; guards reject bad frames", () => {
  const o = measure(hand(true)), c = measure(hand(false));
  assert.equal(o.quality, "usable"); assert.ok(o.metric - c.metric > 0.22);
  assert.equal(measure(hand(true, { edge: 0.99 })).quality, "insufficient");
  assert.equal(measure({}).quality, "missing");
});

test("calibration stability: unstable or too-similar postures are rejected", () => {
  const good = [Array(10).fill(2), Array(10).fill(0.6)];
  assert.equal(calibrationStable(...good), true);
  assert.equal(calibrationStable(Array(10).fill(1.2), Array(10).fill(1.1)), false);
  assert.equal(calibrationStable([2, 0.5, 2, 0.5, 2, 0.5, 2, 0.5], Array(8).fill(0.6)), false);
  assert.equal(calibrationStable(Array(5).fill(2), Array(5).fill(0.6)), false);
});

test("detector adapter: one detected hand -> value, quality and swapped label; absent/insufficient pass through; no frame is kept", () => {
  let preview = "unset";
  const lm = { detectForVideo: () => hand(true) };
  const d = createC04Detector({ landmarker: lm, swapDetectorLabels: true, onPreview: (p) => { preview = p; } });
  const f = d.sample({}, 5);
  assert.equal(f.status, "detected"); assert.equal(f.handedness.label, "right"); assert.equal(f.quality, "usable"); assert.ok(Array.isArray(preview));
  assert.equal(createC04Detector({ landmarker: { detectForVideo: () => ({ landmarks: [] }) }, swapDetectorLabels: false }).sample({}, 1).status, "absent");
  assert.throws(() => createC04Detector({ landmarker: lm }), TypeError);
});

// Repetition definition comparison (reported to the PO; neither contract is changed).
const profile = { open: 2, closed: 0.6 };
const wave = (cycles, { endOpen }) => {
  // open(600ms) -> closed(600ms) -> open ... sampled every 40 ms
  const out = []; let t = 40;
  const seg = (v, ms) => { for (let k = 0; k < ms / 40; k++) { out.push({ t, metric: v }); t += 40; } };
  for (let i = 0; i < cycles; i++) { seg(2, 600); seg(0.6, 600); if (i < cycles - 1 || endOpen) seg(2, 600); }
  return out;
};
const protoScope = { org_id: "o_abcdefgh", participant_id: "p_abcdefgh", session_id: "s_abcdefgh", prescription_id: "rx_abcdefgh", prescription_revision: 1, exercise_id: "organizar-a-mesa" };
function eloCount(frames) {
  const m = createMotionSession({ scope: protoScope, prescription: { targetSets: 1, targetRepetitions: 10, prescribedSide: "left", limitsVersion: "limits-v1" },
    limits: { limits_version: "limits-v1", max_sets: 10, max_repetitions: 100, max_product: 100 }, protocol: c04Protocol,
    calibration: { status: "ready", id: "cal_abcdefgh", open: 2, closed: 0.6, span: 2 - 0.6 }, executionMode: "simulation", dataOrigin: "synthetic_fixture" });
  frames.forEach((f) => m.sample({ timeMs: f.t, status: "detected", value: f.metric, quality: "usable", handedness: { label: "left", score: 0.9 } }));
  return m.snapshot().accepted;
}
function refCount(frames) {
  const g = new ReferenceGesture(profile); let n = 0;
  frames.forEach((f) => { if (g.step({ metric: f.metric, quality: "usable" }, f.t)) n += 1; });
  return n;
}
test("repetition definitions differ: original counts on closing, Elo on return to open (documented incompatibility)", () => {
  const f = wave(3, { endOpen: false }); // open-closed, open-closed, open-closed (ends closed)
  assert.equal(refCount(f), 3);
  assert.equal(eloCount(f), 2);
  const g = wave(3, { endOpen: true }); // ends reopened
  assert.equal(refCount(g), 3);
  assert.equal(eloCount(g), 3);
  assert.equal(ALGORITHM_VERSION, c04Protocol.version);
});
