import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { StorageAdapter } from "../../v3/arq05/storage_adapter.mjs";
import { RecoveryStore } from "../../v3/arq05/recovery_store.mjs";
import { EventOutbox } from "../../v3/arq05/event_outbox.mjs";
import { EventDispatcher } from "../../v3/arq05/event_dispatcher.mjs";
import { CaptureController } from "../../v3/arq05/capture_controller.mjs";
import { createActivityRunner } from "./activity_runner.mjs";
import { simulateCalibrationSamples, simulateCycleFrames } from "./simulation_source.mjs";

globalThis.crypto ??= webcrypto;
const limits = JSON.parse(readFileSync(new URL("../../v3/catalogs/limits.v1.json", import.meta.url)));
const ids = { orgId: "o_fixture01", participantId: "p_fixture01" };
const scope = { org_id: ids.orgId, participant_id: ids.participantId };
const rx = (o = {}) => ({ prescription_id: "rx_fixture01", revision: 1, exercise_id: "organizar-a-mesa", target_sets: 1, target_repetitions: 3,
  side: "right", limits_version: "limits-v1", min_calibration_span: null, ...o });
let clockNow = 0;
function fixture(prescription = rx()) {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const open = () => {
    const outbox = new EventOutbox(new RecoveryStore(ids, new StorageAdapter(storage)));
    const controller = new CaptureController(outbox);
    const runner = createActivityRunner({ controller, scope, prescription, limits, clock: () => clockNow });
    return { outbox, controller, runner };
  };
  return { open, storage, data };
}
const types = async (outbox) => (await outbox.read()).events.map((e) => e.type);
async function ready(f, prescription) {
  const a = f.open();
  await a.runner.begin({ width: 640, height: 480 });
  const cal = await a.runner.calibrate(simulateCalibrationSamples());
  assert.equal(cal.status, "ready");
  await a.runner.start();
  return a;
}
let t = 0;
const cycle = (runner, side = "right") => { for (const f of simulateCycleFrames({ startMs: (t += 2000), side })) runner.feed(f); t += 1000; };
const reset = () => { t = 0; clockNow = 0; };

test("full simulated activity reaches the prescribed dose, completes, summarizes and reports on the same outbox", async () => {
  reset();
  const f = fixture(); const { runner, outbox } = await ready(f);
  for (let i = 0; i < 3; i++) cycle(runner);
  await runner.flush();
  assert.deepEqual(runner.progress(), { accepted: 3, candidates: 3, target: 3 });
  assert.equal((await outbox.read()).phase, "ended"); // session.completed reached
  await runner.finish({ report: { execution: "complete", assistance: "some" } });
  const rec = await outbox.read();
  assert.deepEqual(rec.events.map((e) => e.type), ["session.started", "calibration.attempted", "calibration.attempted", "calibration.applied",
    "session.control", "cycle.accepted", "cycle.accepted", "cycle.accepted", "session.completed", "session.capture_summary", "report.submitted"]);
  assert.equal(rec.phase, "reported");
  assert.ok(rec.events.every((e) => e.execution_mode === "simulation" && e.data_origin === "synthetic_fixture"));
  assert.ok(rec.events.filter((e) => e.type !== "report.submitted").every((e) => e.source.algorithm_version === "contador-exp-1"));
  const done = rec.events.find((e) => e.type === "session.completed");
  assert.deepEqual(done.payload, { accepted: 3, target: 3 });
  const monos = rec.events.filter((e) => e.t_mono_ms !== undefined).map((e) => e.t_mono_ms);
  assert.deepEqual(monos, [...monos].sort((a, b) => a - b));
});

test("B3: indeterminate laterality never counts toward the dose; incompatible side is a rejected candidate", async () => {
  reset();
  const f = fixture(rx({ target_repetitions: 2 })); const { runner, outbox } = await ready(f);
  cycle(runner, null); // indeterminate: no candidate, no dose, sequence lost
  cycle(runner, "left"); // prescribed right: rejected, not counted
  cycle(runner, "right");
  await runner.flush();
  const ev = (await outbox.read()).events.filter((e) => e.type.startsWith("cycle."));
  assert.deepEqual(ev.map((e) => e.type), ["cycle.rejected", "cycle.accepted"]);
  assert.equal(ev[0].payload.reason, "handedness_incompatible");
  assert.deepEqual(ev.map((e) => e.payload.cycle_index), [1, 2]);
  assert.deepEqual(runner.progress(), { accepted: 1, candidates: 2, target: 2 });
  await runner.finish({ action: "end", report: { execution: "partial", assistance: "none" } });
  const summary = (await outbox.read()).events.find((e) => e.type === "session.capture_summary");
  assert.ok(summary.payload.lost_events >= 1, "indeterminate cycle is preserved as aggregate evidence (lost_events)");
});

test("no cycles without a valid calibration; insufficient samples and narrow span are recorded, not counted", async () => {
  reset();
  const f = fixture(); const a = f.open();
  await a.runner.begin({ width: 640, height: 480 });
  assert.equal(a.runner.feed({ timeMs: 100, status: "detected", value: 1, handedness: { label: "right", score: 1 } }).status, "uncalibrated");
  assert.equal((await a.runner.calibrate({ open: [1.7, 1.7], closed: [0.6] })).status, "insufficient");
  const narrow = simulateCalibrationSamples({ open: 0.7, closed: 0.6 });
  assert.equal((await a.runner.calibrate(narrow)).status, "invalid_span");
  assert.equal((await a.outbox.read()).events.at(-1).type, "calibration.failed");
  await assert.rejects(a.controller.start(), /INVALID_SESSION_TRANSITION/);
  assert.equal((await a.controller.restore()).phase, "created");
});

test("reload restores a capture stream; an orphan active session can only be stopped, then summarized", async () => {
  reset();
  const f = fixture(); const first = await ready(f);
  cycle(first.runner); await first.runner.flush();
  const after = f.open(); // fresh components over the same storage
  const state = await after.controller.restore();
  assert.equal(state.phase, "active"); assert.equal(state.accepted, 1); assert.equal(state.mode, "simulation");
  assert.equal(after.runner.feed({ timeMs: 99999, status: "detected", value: 1, handedness: null }).status, "uncalibrated", "no automatic resume");
  await after.runner.finish({ action: "interrupt" });
  assert.equal((await after.outbox.read()).phase, "ended");
  assert.deepEqual((await types(after.outbox)).slice(-2), ["session.control", "session.capture_summary"]);
});

test("outbox rejects capture streams that break ledger order, tamper or switch mode", async () => {
  reset();
  const f = fixture(); const { outbox, runner } = await ready(f);
  cycle(runner); await runner.flush();
  const key = [...f.data.keys()][0];
  const good = JSON.parse(f.data.get(key));
  const corrupt = (mutate) => { const r = structuredClone(good); mutate(r); f.data.set(key, JSON.stringify(r)); return outbox.read(); };
  await assert.rejects(corrupt((r) => { [r.events[4], r.events[5]] = [r.events[5], r.events[4]]; }), /RECOVERY_RECORD_INVALID/);
  await assert.rejects(corrupt((r) => { r.events[5].payload.cycle_index = 9; }), /RECOVERY_RECORD_INVALID/);
  await assert.rejects(corrupt((r) => { r.events[5].execution_mode = "camera"; }), /RECOVERY_RECORD_INVALID/);
  await assert.rejects(corrupt((r) => { r.events = r.events.slice(0, 3).concat(r.events.slice(4)); }), /RECOVERY_RECORD_INVALID/);
  f.data.set(key, JSON.stringify(good));
  assert.equal((await outbox.read()).events.length, good.events.length);
});

test("dispatcher sends capture streams in contiguous chunks; a lost response keeps the exact prefix and ids", async () => {
  reset();
  const f = fixture(rx({ target_sets: 10, target_repetitions: 10 })); const { runner, outbox } = await ready(f);
  for (let i = 0; i < 130; i++) cycle(runner, "left"); // 130 rejected candidates (incompatible side)
  await runner.flush();
  const rec = await outbox.read();
  assert.ok(rec.events.length > 130);
  const ledger = new Map(); let calls = 0; const sizes = [];
  const transport = async (events) => {
    calls += 1; sizes.push(events.length);
    const results = events.map((e) => { const dup = ledger.has(e.event_id); ledger.set(e.event_id, e); return { event_id: e.event_id, status: dup ? "duplicate" : "stored" }; });
    if (calls === 2) throw new TypeError("response lost");
    return { data: { results } };
  };
  const d = new EventDispatcher(outbox, transport);
  const r1 = await d.dispatch();
  assert.equal(r1.status, "pending"); assert.ok(sizes.every((n) => n <= 100));
  const ids1 = (await outbox.read()).events.map((e) => e.event_id);
  const r2 = await d.dispatch();
  assert.equal(r2.status, "synced");
  assert.deepEqual((await outbox.read()).events.map((e) => e.event_id), ids1, "ids preserved");
  assert.equal(ledger.size, rec.events.length);
});

test("dose above the technical limits is refused before any cycle exists", async () => {
  reset();
  const f = fixture(rx({ target_sets: 10, target_repetitions: 11 })); const a = f.open();
  await a.runner.begin({ width: 640, height: 480 });
  await assert.rejects(a.runner.calibrate(simulateCalibrationSamples()), /Invalid prescribed dose/);
});

test("new capture session is blocked until the report is done; dismissal needs full confirmation", async () => {
  reset();
  const f = fixture(); const { runner, controller, outbox } = await ready(f);
  await assert.rejects(controller.begin({ prescriptionId: "rx_fixture01", prescriptionRevision: 1 }), /INVALID_SESSION_TRANSITION/);
  await runner.finish({ action: "end" });
  await assert.rejects(controller.begin({ prescriptionId: "rx_fixture01", prescriptionRevision: 1 }), /INVALID_SESSION_TRANSITION/);
  await assert.rejects(controller.begin({ prescriptionId: "rx_fixture01", prescriptionRevision: 1 }, { dismissReport: true }), /RECOVERY_STREAM_UNRESOLVED/);
  const rec = await outbox.read();
  await outbox.reconcile(rec.events, rec.events.map((e) => ({ event_id: e.event_id, status: "stored" })));
  await controller.begin({ prescriptionId: "rx_fixture01", prescriptionRevision: 1 }, { dismissReport: true });
  assert.equal((await outbox.read()).events.length, 1);
});
