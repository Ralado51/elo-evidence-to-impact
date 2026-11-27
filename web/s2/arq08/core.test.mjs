import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createCameraPort, createHandDetector } from "./camera.mjs";
import { evaluateCalibration, createMotionSession } from "./motion.mjs";
import { sealSyntheticCycle } from "./evidence.mjs";
import { hashCanonical } from "../../v3/canonical.mjs";

const limits = JSON.parse(readFileSync(new URL("../../../contracts/CL06_3-r1/contracts/catalogs/limits.v1.json", import.meta.url)));
const calibrationInput = { id: "cal_fixture01", open: Array(8).fill(2), closed: Array(8).fill(1),
  method: "synthetic-median", version: "test-v1", minSpan: 0.22 };
const options = {
  executionMode: "simulation", dataOrigin: "synthetic_fixture",
  scope: { org_id: "o_fixture01", participant_id: "p_fixture01", session_id: "s_fixture01",
    prescription_id: "rx_fixture01", prescription_revision: 2, exercise_id: "organizar-a-mesa" },
  prescription: { targetSets: 1, targetRepetitions: 2, prescribedSide: "right", limitsVersion: "limits-v1" },
  limits, calibration: evaluateCalibration(calibrationInput),
  protocol: { version: "test-v1", maxGapMs: 50, isUsable: (frame) => frame.usable !== false,
    classify: (n) => n === 1 ? "open" : n === 0 ? "closed" : "transition" },
};
const frame = (timeMs, value, label = "right") => ({ timeMs, value, status: "detected",
  handedness: label ? { label, score: 1 } : null });
const cycle = (session, t = 1, side = "right") => [2, 1, 2].map((v, i) => session.sample(frame(t+i, v, side))).at(-1);

test("consent, failure fallback, stop and revoke during acquisition", async () => {
  let resolve;
  let calls = 0;
  let stopped = 0;
  const track = { readyState: "live", stop: () => stopped++ };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const camera = createCameraPort({ getUserMedia(input) {
    calls++;
    assert.deepEqual(input, { video: true, audio: false });
    return new Promise((done) => { resolve = done; });
  } });
  assert.equal((await camera.start()).status, "consent_required");
  assert.equal(calls, 0);
  const pending = camera.start({ consent: true });
  assert.equal((await camera.start({ consent: true })).status, "busy");
  camera.revoke();
  resolve(stream);
  assert.equal((await pending).status, "cancelled");
  assert.equal(stopped, 1);
  const next = camera.start({ consent: true });
  resolve(stream);
  assert.equal((await next).status, "ready");
  camera.stop();
  assert.equal(stopped, 2);
  const denied = createCameraPort({ getUserMedia: async () => { throw new Error("denied"); } });
  assert.equal((await denied.start({ consent: true })).status, "report_only");
});

test("adapts local landmarks, mirror convention, absence and ambiguous hands", () => {
  const points = Array.from({ length: 21 }, () => ({ x: 1, y: 2 }));
  let result = { landmarks: [points], handedness: [[{ categoryName: "Left", score: 0.9 }]] };
  const video = { videoWidth: 640, videoHeight: 480 };
  const landmarker = { detectForVideo: () => result };
  const detector = createHandDetector({ landmarker, openness: (_, ratio) => ratio, swapDetectorLabels: true });
  assert.deepEqual(detector.sample(video, 1), {
    timeMs: 1, status: "detected", value: 4 / 3, handedness: { label: "right", score: 0.9 },
  });
  result = { landmarks: [points, points] };
  assert.deepEqual(detector.sample(video, 2), { timeMs: 2, status: "insufficient" });
  result = { landmarks: [] };
  assert.deepEqual(detector.sample(video, 3), { timeMs: 3, status: "absent" });
});

test("calibration enforces sample availability, contract span and version", () => {
  assert.equal(evaluateCalibration({ ...calibrationInput, open: [2] }).status, "insufficient");
  assert.equal(evaluateCalibration({ ...calibrationInput, open: Array(8).fill(1) }).status, "invalid_span");
  assert.equal(options.calibration.version, "test-v1");
  assert.equal(createMotionSession({ ...options, calibration: null }).sample(frame(1, 2)).status, "uncalibrated");
});

test("accepts full cycles once, rejects incompatible side and caps at prescribed dose", () => {
  const session = createMotionSession(options);
  const rejected = cycle(session, 1, "left");
  assert.equal(rejected.candidate.payload.reason, "handedness_incompatible");
  assert.equal(rejected.candidate.payload.cycle_index, 1);
  assert.equal(session.snapshot().accepted, 0);
  assert.equal(cycle(session, 4).candidate.payload.cycle_index, 2);
  assert.equal(session.sample(frame(6, 2)).status, "ignored_frame");
  assert.equal(cycle(session, 7).status, "accepted");
  assert.equal(session.sample(frame(10, 1)).status, "limit_reached");
  assert.deepEqual(session.snapshot(), { accepted: 2, target: 2, candidates: 3 });
  assert.throws(() => createMotionSession({ ...options,
    prescription: { ...options.prescription, targetSets: 10, targetRepetitions: 11 } }));
});

test("loss, quality, unknown side and time gap break an in-flight cycle", () => {
  for (const interrupted of [
    { timeMs: 3, status: "absent" }, { ...frame(3, 1), usable: false }, frame(3, 1, null), frame(100, 2),
  ]) {
    const session = createMotionSession(options);
    session.sample(frame(1, 2)); session.sample(frame(2, 1));
    assert.equal(session.sample(interrupted).candidate, undefined);
    assert.equal(session.sample(frame(interrupted.timeMs + 1, 2)).candidate, undefined);
    assert.equal(session.snapshot().accepted, 0);
  }
});

test("structured evidence uses deterministic v3 identity, scope and origin", async () => {
  const { candidate } = cycle(createMotionSession(options));
  const input = { seq: 4, prevHash: "a".repeat(64), occurredAt: "2026-11-27T12:00:00.000Z" };
  const first = await sealSyntheticCycle(candidate, input);
  assert.deepEqual(await sealSyntheticCycle(candidate, input), first);
  const { hash, ...body } = first;
  assert.equal(await hashCanonical(body), hash);
  assert.equal(first.event_id, await hashCanonical({ stream_id: first.stream_id, seq: 4 }));
  assert.equal(first.scope.prescription_revision, 2);
  assert.equal(first.execution_mode, "simulation");
  assert.equal(first.data_origin, "synthetic_fixture");
  for (const rejected of [false, true]) {
    const type = rejected ? "cycle.rejected" : "cycle.accepted";
    const { properties } = JSON.parse(readFileSync(new URL(
      "../../../contracts/CL06_3-r1/contracts/schemas/events/" + type + ".schema.json", import.meta.url)));
    const result = cycle(createMotionSession(options), 1, rejected ? "left" : "right");
    const event = await sealSyntheticCycle(result.candidate, input);
    assert.deepEqual(Object.keys(event.payload).sort(), [...properties.payload.required].sort());
    for (const [key, value] of Object.entries(event.payload)) {
      const schema = properties.payload.properties[key];
      if (schema.minimum !== undefined) assert.ok(value >= schema.minimum && value <= schema.maximum);
      if (schema.enum) assert.ok(schema.enum.includes(value));
    }
  }
});
