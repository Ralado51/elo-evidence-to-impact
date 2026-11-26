// Hand counter page controller. Camera frames are read in the browser by MediaPipe and
// only a skeleton is drawn. No MediaRecorder, toDataURL, toBlob or getImageData; nothing
// of the image is stored or sent. Only derived numbers (reps, duration, amplitude) remain.
import { announce } from "../v3/a11y.mjs";
import { initI18n, t, label, formatNumber } from "../v3/i18n.mjs";
import { syntheticOpenness, summarize } from "./contador_model.mjs";

const C = globalThis.EloCounter;
const MP = { url: "./vendor/vision_bundle.mjs", wasm: "./vendor/wasm", model: "./vendor/hand_landmarker.task" };
const $ = (id) => document.getElementById(id);

const cv = $("skeleton"), ctx = cv.getContext("2d"), vid = $("cam");
const btn = { start: $("btn-start"), demo: $("btn-demo"), cal: $("btn-calibrate"), reset: $("btn-reset"), stop: $("btn-stop") };

let counter = C.createCounter(), events = [], mode = null; // "camera" | "demo" | null
let landmarker = null, HL = null, stream = null, raf = null, t0 = 0, wake = null;
let calibrating = false, calValues = [], calEnd = 0;

let msg = { key: "ct.msg.off", params: undefined };
function say(key, params) { msg = { key, params }; $("counter-msg").textContent = t(key, params); }
function setRunning(on) {
  btn.start.disabled = on; btn.demo.disabled = on;
  btn.stop.disabled = !on; btn.reset.disabled = !on; btn.cal.disabled = !on;
}

function renderResult() {
  const n = C.markAtypical(events);
  const sum = summarize(events);
  const box = $("result-box"), table = $("rep-table"), tbody = table.querySelector("tbody");
  tbody.textContent = "";
  box.dataset.resultReady = String(sum.reps > 0);
  if (!sum.reps) { box.textContent = t("ct.result.none"); table.hidden = true; return; }
  const dec = (x, d) => formatNumber(x, { minimumFractionDigits: d, maximumFractionDigits: d });
  box.textContent = t("ct.result.summary", { n: sum.reps, mean: dec(sum.meanDurationS, 1) }) + " " +
    (n ? t("ct.result.atypical", { n }) : t("ct.result.no_atypical"));
  box.dataset.reps = String(sum.reps); box.dataset.atypical = String(n);
  for (const e of events) {
    const tr = document.createElement("tr");
    tr.dataset.atypical = String(Boolean(e.atypical));
    for (const v of [e.rep, dec(e.duration_ms / 1000, 1), dec(e.amplitude, 2), e.atypical ? t("ct.row.atypical") : t("ct.row.normal")]) {
      const td = document.createElement("td"); td.textContent = String(v); tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.hidden = false;
}

function ui(v) {
  const reps = $("rep-count"); reps.textContent = String(counter.reps); reps.dataset.reps = String(counter.reps);
  $("live-state").textContent = t("ct.state", { state: label("counter_state", counter.state) }) + (calibrating ? " · " + t("ct.state.calibrating") : "");
}

function onSample(rel, v, score) {
  if (calibrating && v != null) calValues.push(v);
  const prev = counter.reps;
  const ev = v == null ? (counter.lost(rel), null) : counter.feed(rel, v, score);
  if (ev) { events.push(ev); renderResult(); }
  if (counter.reps !== prev) announce(t("ct.announce.reps", { n: counter.reps }));
  if (calibrating && performance.now() > calEnd) finishCalibration();
  ui(v);
}

function finishCalibration() {
  calibrating = false; btn.cal.disabled = false;
  const th = C.thresholdsFrom(calValues);
  if (th) { counter.set(th); say("ct.msg.calibrated"); announce(t("ct.announce.calibrated")); }
  else { say("ct.msg.calib_fail"); announce(t("ct.announce.calib_fail")); }
}

function draw(lm) {
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!lm || !HL) return;
  const W = cv.width, H = cv.height;
  ctx.lineWidth = 3; ctx.strokeStyle = "#34a37f"; ctx.beginPath();
  for (const c of HL.HAND_CONNECTIONS || []) { const a = lm[c.start], b = lm[c.end]; ctx.moveTo(a.x * W, a.y * H); ctx.lineTo(b.x * W, b.y * H); }
  ctx.stroke(); ctx.fillStyle = "#e8eaed";
  for (const p of lm) { ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 4, 0, 6.2832); ctx.fill(); }
}

function drawDemoHand(v) {
  // Abstract bar showing synthetic openness (no camera, no hand model).
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
  const frac = Math.max(0, Math.min(1, (v - 0.5) / 1.3));
  ctx.fillStyle = "#34a37f"; ctx.fillRect(40, cv.height - 40 - frac * (cv.height - 80), cv.width - 80, frac * (cv.height - 80));
}

function resetAll() { counter.clear(); events = []; ui(null); renderResult(); }

async function loadModel() {
  if (landmarker) return;
  say("ct.msg.loading");
  const mod = await import(MP.url);
  HL = mod.HandLandmarker;
  const fileset = await mod.FilesetResolver.forVisionTasks(MP.wasm);
  let err;
  for (const delegate of ["GPU", "CPU"]) {
    try {
      landmarker = await HL.createFromOptions(fileset, { baseOptions: { modelAssetPath: MP.model, delegate }, runningMode: "VIDEO", numHands: 1,
        minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
      return;
    } catch (e) { err = e; }
  }
  throw err;
}

function cameraLoop() {
  if (mode !== "camera") return;
  const now = performance.now();
  if (vid.readyState >= 2) {
    const res = landmarker.detectForVideo(vid, now), lm = res.landmarks && res.landmarks[0];
    if (lm) {
      draw(lm);
      const sc = res.handedness?.[0]?.[0]?.score ?? null;
      onSample(now - t0, C.openness(lm, cv.width / cv.height), sc);
    } else { draw(null); onSample(now - t0, null, null); }
  }
  if (vid.requestVideoFrameCallback) vid.requestVideoFrameCallback(cameraLoop); else raf = requestAnimationFrame(cameraLoop);
}

async function startCamera() {
  btn.start.disabled = btn.demo.disabled = true;
  try {
    await loadModel();
    say("ct.msg.opening");
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    vid.srcObject = stream; await vid.play();
    cv.width = vid.videoWidth || 640; cv.height = vid.videoHeight || 480;
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request("screen"); } catch { /* optional */ }
    resetAll(); mode = "camera"; t0 = performance.now(); setRunning(true);
    say("ct.msg.on"); announce(t("ct.announce.on"));
    cameraLoop();
  } catch (e) {
    say("ct.msg.fail", { err: String(e?.message || e) });
    announce(t("ct.announce.fail"));
    btn.start.disabled = btn.demo.disabled = false;
  }
}

function startDemo() {
  resetAll(); mode = "demo"; t0 = performance.now(); setRunning(true);
  say("ct.msg.demo");
  const tick = () => {
    if (mode !== "demo") return;
    const rel = performance.now() - t0, v = syntheticOpenness(rel);
    drawDemoHand(v); onSample(rel, v, 0.9);
    raf = requestAnimationFrame(tick);
  };
  tick();
}

function stop() {
  const was = mode; mode = null;
  if (raf) cancelAnimationFrame(raf);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; vid.srcObject = null;
  try { wake?.release(); } catch { /* ignore */ }
  setRunning(false); renderResult();
  say(was ? "ct.msg.stopped" : "ct.msg.off");
  if (was) announce(t("ct.announce.stopped"));
}

btn.start.addEventListener("click", startCamera);
btn.demo.addEventListener("click", startDemo);
btn.stop.addEventListener("click", stop);
btn.reset.addEventListener("click", resetAll);
btn.cal.addEventListener("click", () => { calibrating = true; calValues = []; calEnd = performance.now() + 10000; btn.cal.disabled = true; say("ct.msg.calibrating"); });
ui(null);

function rerender() {
  say(msg.key, msg.params);
  ui(null);
  renderResult();
}
initI18n();
document.addEventListener("elo:lang", rerender);
rerender();
