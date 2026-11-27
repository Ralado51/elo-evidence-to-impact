import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { StorageAdapter } from "../../v3/arq05/storage_adapter.mjs";
import { RecoveryStore } from "../../v3/arq05/recovery_store.mjs";
import { EventOutbox } from "../../v3/arq05/event_outbox.mjs";
import { EventDispatcher } from "../../v3/arq05/event_dispatcher.mjs";
import { CaptureController } from "../../v3/arq05/capture_controller.mjs";
import { ConsentOutbox } from "../../v3/arq05/consent_outbox.mjs";
import { createActivityRunner } from "./activity_runner.mjs";
import { simulateCalibrationSamples, simulateCycleFrames } from "./simulation_source.mjs";
import { createCameraSession } from "./camera_session.mjs";
import { hashCanonical } from "../../v3/canonical.mjs";

globalThis.crypto ??= webcrypto;
const limits = JSON.parse(readFileSync(new URL("../../v3/catalogs/limits.v1.json", import.meta.url)));
const ids = { orgId: "o_fixture01", participantId: "p_fixture01" };
const scope = { org_id: ids.orgId, participant_id: ids.participantId };
const rx = { prescription_id: "rx_fixture01", revision: 1, exercise_id: "organizar-a-mesa", target_sets: 1, target_repetitions: 2, side: "right", limits_version: "limits-v1", min_calibration_span: null };
const memory = () => { const d = new Map(); return { getItem: (k) => d.get(k) ?? null, setItem: (k, v) => d.set(k, v) }; };
const camSetup = (consentStorage = memory()) => {
  const outbox = new EventOutbox(new RecoveryStore(ids, new StorageAdapter(memory())));
  const consent = new ConsentOutbox(new RecoveryStore(ids, new StorageAdapter(consentStorage), { keyPrefix: "elo:s2:consent:v1:" }));
  const runner = createActivityRunner({ controller: new CaptureController(outbox), scope, prescription: rx, limits, mode: "camera" });
  return { outbox, consent, runner, consentStorage };
};
let t = 0;
const cycle = (runner, side = "right") => { for (const f of simulateCycleFrames({ startMs: (t += 2000), side })) runner.feed(f); t += 1000; };

test("vendored MediaPipe assets match the verified package manifest and version", () => {
  const dir = new URL("../vendor/", import.meta.url);
  const lines = readFileSync(new URL("SHA256SUMS", dir), "utf8").trim().split("\n");
  assert.equal(lines.length, 8);
  for (const line of lines) {
    const [hash, file] = line.split(/\s+/);
    assert.equal(createHash("sha256").update(readFileSync(new URL(file, dir))).digest("hex"), hash, file);
  }
  const expected = { "vision_bundle.mjs": "40f4123dfcd75cfa58add046919cc6f52fde66f009ff582997c09ba54c6ba27c",
    "hand_landmarker.task": "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
    "wasm/vision_wasm_internal.wasm": "f00ec4731faa23b3e714d00e88d4d10e2df5c0a427d3a2b4ae6e3526fdd14ef7",
    "wasm/vision_wasm_nosimd_internal.wasm": "3821ea9b1f7fb8c549ef2a064ef5c85750bf375c545a49fd6eea0df44a95f1f4" };
  for (const [file, hash] of Object.entries(expected)) assert.ok(lines.includes(`${hash}  ${file}`), file);
  assert.equal(JSON.parse(readFileSync(new URL("package.json", dir))).version, "0.10.21");
  assert.match(readFileSync(new URL("LICENSE", dir), "utf8"), /Apache License/);
  assert.deepEqual(readdirSync(new URL("wasm", dir)).sort(), ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"]);
});

test("camera activity: experimental_capture, origin_ref, camera source, same dose rules, never labelled simulation", async () => {
  t = 0;
  const { outbox, runner } = camSetup();
  await runner.begin({ width: 640, height: 480 }, {}, "desktop-chrome");
  assert.equal((await runner.calibrate(simulateCalibrationSamples())).status, "ready");
  await runner.start();
  cycle(runner); cycle(runner, "left"); cycle(runner, null); cycle(runner); cycle(runner);
  await runner.flush();
  await runner.finish({ report: { execution: "complete", assistance: "none" } });
  const rec = await outbox.read();
  assert.equal(rec.mode, "camera");
  assert.equal(rec.phase, "reported");
  const first = rec.events[0];
  assert.deepEqual(first.payload.capture_context, { device_hint: "desktop-chrome", frame_width: 640, frame_height: 480 });
  assert.ok(rec.events.every((e) => e.execution_mode === "camera" && e.data_origin === "experimental_capture" && /^[0-9a-f]{64}$/.test(e.origin_ref)));
  assert.ok(rec.events.every((e) => e.source.type === (e.type === "report.submitted" ? "participant_report" : "camera")));
  assert.equal(rec.events.filter((e) => e.type === "cycle.accepted").length, 2); // prescribed dose reached by the right hand only
  const rejected = rec.events.filter((e) => e.type === "cycle.rejected");
  assert.deepEqual(rejected.map((e) => e.payload.reason), ["handedness_incompatible"]);
  const summary = rec.events.find((e) => e.type === "session.capture_summary").payload;
  assert.ok(summary.lost_events >= 1 && summary.fps_mean > 0 && summary.fps_min >= 0);
  // no image, frame or raw landmark in any persisted event
  const dump = JSON.stringify(rec);
  assert.doesNotMatch(dump, /landmark|data:image|blob:|"x":|"y":/i);
});

test("camera stream cannot be read back with a synthetic origin, a simulation source or a missing origin_ref", async () => {
  const tamper = async (mutate) => {
    t = 0;
    const store = memory();
    const outbox = new EventOutbox(new RecoveryStore(ids, new StorageAdapter(store)));
    const runner = createActivityRunner({ controller: new CaptureController(outbox), scope, prescription: rx, limits, mode: "camera" });
    await runner.begin({ width: 640, height: 480 });
    const key = [...Array(1)].map(() => "elo:arq05:v1:" + JSON.stringify([ids.orgId, ids.participantId]))[0];
    const rec = JSON.parse(store.getItem(key));
    mutate(rec.events[0]);
    const { hash: _old, ...body } = rec.events[0];
    rec.events[0].hash = await hashCanonical(body); // keep the hash valid: only the origin/source rule can reject it
    store.setItem(key, JSON.stringify(rec));
    return outbox.read();
  };
  await assert.rejects(tamper((e) => { e.data_origin = "synthetic_fixture"; }), /RECOVERY_RECORD_INVALID/);
  await assert.rejects(tamper((e) => { delete e.origin_ref; }), /RECOVERY_RECORD_INVALID/);
  await assert.rejects(tamper((e) => { e.source.type = "simulation"; }), /RECOVERY_RECORD_INVALID/);
});

test("consent chain: accept, revoke, idempotence, tamper rejection, ordered reconcile and held revocation", async () => {
  const storage = memory();
  const { consent } = camSetup(storage);
  assert.equal((await consent.read()).active, false);
  await consent.record("consent.accepted");
  await consent.record("consent.accepted"); // idempotent while active
  let rec = await consent.read();
  assert.equal(rec.events.length, 1);
  assert.equal(rec.active, true);
  assert.equal(rec.events[0].stream_id, "consent:p_fixture01");
  assert.deepEqual(rec.events[0].payload.scopes, ["camera"]);
  assert.equal(rec.events[0].execution_mode, "not_applicable");
  await consent.record("consent.revoked");
  rec = await consent.read();
  assert.deepEqual(rec.events.map((e) => [e.seq, e.type]), [[1, "consent.accepted"], [2, "consent.revoked"]]);
  assert.equal(rec.events[1].prev_hash, rec.events[0].hash);
  assert.equal(rec.active, false);
  // a reopened store (same storage) continues the same chain
  const again = camSetup(storage).consent;
  await again.record("consent.accepted");
  assert.deepEqual((await again.read()).events.map((e) => e.seq), [1, 2, 3]);
  // dispatch through the same dispatcher; receipts advance only the confirmed prefix
  const sent = [];
  const dispatcher = new EventDispatcher(again, async (evs) => { sent.push(evs.map((e) => e.seq)); return { data: { results: evs.map((e) => ({ event_id: e.event_id, status: e.seq < 3 ? "stored" : "rejected", codes: e.seq < 3 ? [] : ["INTERNAL"] })) } }; });
  assert.equal((await dispatcher.dispatch()).status, "pending");
  assert.equal((await again.read()).acknowledged, 2);
  // tampering is rejected on read
  const mutated = JSON.parse(storage.getItem("elo:s2:consent:v1:" + JSON.stringify([ids.orgId, ids.participantId])));
  mutated.events[1].payload.scopes = ["camera", "microphone"];
  storage.setItem("elo:s2:consent:v1:" + JSON.stringify([ids.orgId, ids.participantId]), JSON.stringify(mutated));
  await assert.rejects(again.read(), /RECOVERY_RECORD_INVALID/);
});

test("camera session: no capture without consent, local detector only, tracks released on stop/track end, absent frames flow", async () => {
  let stopped = 0;
  const listeners = {};
  const track = { readyState: "live", stop: () => stopped++, addEventListener: (n, f) => { listeners[n] = f; }, getSettings: () => ({ width: 640, height: 480 }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let requested = 0;
  const video = { hidden: true, readyState: 4, videoWidth: 640, videoHeight: 480, srcObject: null, play: async () => {}, pause() {}, requestVideoFrameCallback: (fn) => { setTimeout(fn, 1); return 1; }, cancelVideoFrameCallback() {} };
  const results = [{ landmarks: [], handedness: [] }];
  const fakeLandmarker = { detectForVideo: () => results[0] };
  globalThis.EloCounter = { openness: () => 1 };
  const interrupted = [];
  const session = createCameraSession({ video, doc: {}, mediaDevices: { getUserMedia: async (c) => { requested++; assert.deepEqual(c, { video: true, audio: false }); return stream; } },
    loadDetector: async () => fakeLandmarker, onInterrupted: (r) => interrupted.push(r) });
  assert.equal((await session.start()).status, "consent_required");
  assert.equal(requested, 0);
  const out = await session.start({ consent: true });
  assert.equal(out.status, "ready");
  assert.deepEqual(out.frame, { width: 640, height: 480 });
  const frames = [];
  session.watch((f) => frames.push(f));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(frames.length >= 2 && frames.every((f) => f.status === "absent" && Number.isInteger(f.timeMs)));
  assert.ok(frames.every((f, i) => i === 0 || f.timeMs >= frames[i - 1].timeMs));
  listeners.ended();
  assert.deepEqual(interrupted, ["track_ended"]);
  assert.equal(stopped, 1);
  assert.equal(video.srcObject, null);
  assert.equal(session.active, false);
  // a detector failure ends capture with model_execution
  const bad = createCameraSession({ video: { ...video, srcObject: null }, doc: {}, mediaDevices: { getUserMedia: async () => stream },
    loadDetector: async () => ({ detectForVideo: () => { throw new Error("boom"); } }), onInterrupted: (r) => interrupted.push(r) });
  assert.equal((await bad.start({ consent: true })).status, "model_unavailable"); // fails on the first frame: reported by start()
  assert.equal(stopped, 2);
  // a failure after start is an interruption
  let calls = 0;
  const late = createCameraSession({ video: { ...video, srcObject: null }, doc: {}, mediaDevices: { getUserMedia: async () => stream },
    loadDetector: async () => ({ detectForVideo: () => { if (++calls > 2) throw new Error("late"); return results[0]; } }), onInterrupted: (r) => interrupted.push(r) });
  assert.equal((await late.start({ consent: true })).status, "ready");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(interrupted.at(-1), "model_execution");
  assert.equal(late.active, false);
  // permission denied falls back, nothing captured
  const denied = createCameraSession({ video: { ...video }, doc: {}, mediaDevices: { getUserMedia: async () => { throw new Error("denied"); } }, loadDetector: async () => fakeLandmarker });
  assert.equal((await denied.start({ consent: true })).status, "report_only");
  // model unavailable falls back
  const nomodel = createCameraSession({ video: { ...video }, doc: {}, mediaDevices: { getUserMedia: async () => stream }, loadDetector: async () => { throw new Error("missing"); } });
  assert.equal((await nomodel.start({ consent: true })).status, "model_unavailable");
});
