// Local camera capture for the experimental activity (S2). MediaPipe 0.10.21 + Hand Landmarker float16 v1 run from ./vendor on the same origin.
// Nothing from the image leaves the browser: frames are read by the local detector and dropped; only the derived openness value and the
// handedness label/score of each frame are handed to the ActivityRunner. The page never draws, encodes, records or copies the frames.
import { createCameraPort, createHandDetector } from "./camera.mjs";

const VENDOR = new URL("../vendor/", import.meta.url);
// MediaPipe labels hands assuming a mirrored (selfie) input. The raw, unmirrored stream is given to the detector, so labels are swapped here
// once; the on-screen preview is mirrored by CSS only and does not affect detection. To be confirmed on a physical camera (manual test).
const SWAP_DETECTOR_LABELS = true;

let opennessPromise = null;
/** Reuse the existing experimental counter's openness measure (counter script, classic UMD) without copying or altering it. */
function loadOpenness(doc) {
  if (globalThis.EloCounter?.openness) return Promise.resolve(globalThis.EloCounter.openness);
  opennessPromise ??= new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = new URL("../counter.js", import.meta.url).href;
    script.onload = () => (globalThis.EloCounter?.openness ? resolve(globalThis.EloCounter.openness) : reject(new Error("OPENNESS_UNAVAILABLE")));
    script.onerror = () => { opennessPromise = null; reject(new Error("OPENNESS_UNAVAILABLE")); };
    doc.head.append(script);
  });
  return opennessPromise;
}

async function loadLandmarker() {
  const mod = await import(new URL("vision_bundle.mjs", VENDOR).href);
  const fileset = await mod.FilesetResolver.forVisionTasks(new URL("wasm", VENDOR).href);
  let error;
  for (const delegate of ["GPU", "CPU"]) {
    try {
      return await mod.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: new URL("hand_landmarker.task", VENDOR).href, delegate }, runningMode: "VIDEO", numHands: 1,
        minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
    } catch (e) { error = e; }
  }
  throw error;
}

/** @returns session with start()/collect()/watch()/stop(). `video` is a hidden-by-default element owned by the page. */
export function createCameraSession({ video, doc = globalThis.document, mediaDevices = globalThis.navigator?.mediaDevices,
  clock = () => performance.now(), loadDetector = null, onInterrupted = () => {} } = {}) {
  const port = createCameraPort(mediaDevices);
  let detector = null;
  let stream = null;
  let handle = null; // current frame loop
  let listener = null; // current frame consumer
  let base = 0;
  let live = false;
  let generation = 0;
  let finishCollection = null;
  let starting = false; // failures while starting are reported by start()'s return value, not by onInterrupted
  const interrupt = (reason) => { if (!starting) onInterrupted(reason); };

  const release = () => {
    generation += 1;
    live = false;
    finishCollection?.();
    if (handle?.cancel) handle.cancel();
    handle = null;
    listener = null;
    port.stop();
    if (video && stream && video.srcObject === stream) {
      try { video.pause?.(); } catch { /* ignore */ }
      video.srcObject = null;
      video.hidden = true;
    }
    stream = null;
  };

  function schedule() {
    const tick = () => {
      if (!live) return;
      if (video.readyState >= 2) {
        const now = clock();
        let frame;
        try { frame = detector.sample(video, now); } catch { release(); interrupt("model_execution"); return; }
        listener?.({ ...frame, timeMs: Math.max(1, Math.round(now - base)) });
      }
      if (live) handle = video.requestVideoFrameCallback
        ? { cancel: ((id) => () => video.cancelVideoFrameCallback?.(id))(video.requestVideoFrameCallback(tick)) }
        : { cancel: ((id) => () => cancelAnimationFrame(id))(requestAnimationFrame(tick)) };
    };
    tick();
  }

  return {
    get active() { return live; },
    /** Requires consent === true. Returns { status: "ready" } or a fallback status (consent_required|report_only|busy|cancelled|model_unavailable). */
    async start({ consent } = {}) {
      if (consent !== true) return { status: "consent_required" };
      const ticket = ++generation;
      try {
        if (!detector) {
          const [landmarker, openness] = await Promise.all([(loadDetector ?? loadLandmarker)(), loadOpenness(doc)]);
          if (ticket !== generation) return { status: "cancelled" };
          detector = createHandDetector({ landmarker, openness, swapDetectorLabels: SWAP_DETECTOR_LABELS });
        }
      } catch { return { status: ticket === generation ? "model_unavailable" : "cancelled" }; }
      const out = await port.start({ consent: true });
      if (ticket !== generation) return { status: "cancelled" };
      if (out.status !== "ready") return out;
      stream = out.stream;
      video.srcObject = stream;
      try { await video.play(); } catch {
        if (ticket !== generation) return { status: "cancelled" };
        release();
        return { status: "report_only" };
      }
      if (ticket !== generation) return { status: "cancelled" };
      const tracks = stream.getVideoTracks();
      for (const track of tracks) track.addEventListener("ended", () => { if (live) { release(); interrupt("track_ended"); } });
      base = clock();
      live = true;
      video.hidden = false;
      starting = true;
      const settings = tracks[0]?.getSettings?.() ?? {};
      schedule();
      starting = false;
      if (!live) return { status: "model_unavailable" };
      return { status: "ready", frame: { width: video.videoWidth || settings.width || 640, height: video.videoHeight || settings.height || 480 } };
    },
    /** Collect detected openness values for `ms`; resolves with the samples (derived numbers only). */
    collect(ms) {
      if (!live) return Promise.resolve([]);
      finishCollection?.();
      return new Promise((resolve) => {
        const values = [];
        const end = clock() + ms;
        const previous = listener;
        finishCollection = () => {
          finishCollection = null;
          listener = previous;
          resolve(values);
        };
        listener = (frame) => {
          if (frame.status === "detected") values.push(frame.value);
          if (clock() >= end || !live) finishCollection?.();
        };
      });
    },
    /** Deliver every frame (including absent) to `fn(frame)`. */
    watch(fn) { listener = fn; },
    unwatch() { listener = null; },
    stop: release,
    revoke: release,
  };
}
