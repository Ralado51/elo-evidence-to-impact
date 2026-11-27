import { createMotionSession } from "./motion.mjs";
import { contadorExp1, MIN_SPAN } from "./protocol.mjs";

/** Minimal ActivityRunner (PO B5): prescribed activity -> calibration -> accepted-cycle counter -> dose progress -> closing.
 *  Orchestrates only: persistence/transmission belong to CaptureController/EventOutbox/EventDispatcher. No gamification. */
export function createActivityRunner({ controller, scope, prescription, limits, clock = () => performance.now(), mode = "simulation", protocol = contadorExp1, minSpan: defaultMinSpan = MIN_SPAN, validateCalibration = null }) {
  if (mode !== "simulation" && mode !== "camera") throw new TypeError("Invalid activity mode");
  const rx = prescription;
  const target = rx.target_sets * rx.target_repetitions;
  let motion = null;
  let t0 = null;
  let chain = Promise.resolve();
  const stats = { frames: 0, usable: 0, lost: 0, inLost: false, firstMs: null, lastMs: null, gapMax: null };
  // Derived rates only (no frame, image or landmark is kept). Simulation reports null.
  const fps = () => {
    const span = stats.lastMs - stats.firstMs;
    const clamp = (v) => (Number.isFinite(v) ? Math.min(240, Math.max(0, Math.round(v * 100) / 100)) : null);
    return mode === "camera" && stats.frames > 1 && span > 0
      ? { fps_mean: clamp(((stats.frames - 1) * 1000) / span), fps_min: clamp(1000 / stats.gapMax) }
      : { fps_mean: null, fps_min: null };
  };
  const elapsed = () => (t0 === null ? 0 : Math.max(0, Math.round(clock() - t0)));

  const enqueue = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };

  return {
    target,
    progress: () => ({ ...(motion ? motion.snapshot() : { accepted: 0, candidates: 0 }), target }),
    begin: (frame, opts, deviceHint) => controller.begin({ prescriptionId: rx.prescription_id, prescriptionRevision: rx.revision, exerciseId: rx.exercise_id, frame, mode, algorithmVersion: protocol.version, ...(deviceHint ? { deviceHint } : {}) }, opts),

    async calibrate({ open, closed }) {
      t0 = clock();
      const minSpan = Number.isFinite(rx.min_calibration_span) ? rx.min_calibration_span : defaultMinSpan;
      if (validateCalibration && !validateCalibration({ open, closed })) return { status: "invalid_span" };
      const out = await controller.calibrate({ open, closed, minSpan });
      if (out.status !== "ready") return out;
      const state = await controller.restore();
      motion = createMotionSession({
        scope: { ...scope, session_id: state.sessionId, prescription_id: rx.prescription_id, prescription_revision: rx.revision, exercise_id: rx.exercise_id },
        prescription: { targetSets: rx.target_sets, targetRepetitions: rx.target_repetitions, prescribedSide: rx.side, limitsVersion: rx.limits_version },
        limits, protocol, calibration: out.calibration, executionMode: mode, dataOrigin: mode === "camera" ? "experimental_capture" : "synthetic_fixture",
      });
      return out;
    },

    start: () => controller.start(elapsed()),

    /** Feed one frame. Cycle candidates are persisted locally (in order) before anything is transmitted. */
    feed(frame) {
      if (!motion) return { status: "uncalibrated" };
      const r = motion.sample(frame);
      stats.frames += 1;
      if (Number.isFinite(frame.timeMs)) {
        if (stats.firstMs === null) stats.firstMs = frame.timeMs;
        if (stats.lastMs !== null && frame.timeMs > stats.lastMs) stats.gapMax = Math.max(stats.gapMax ?? 0, frame.timeMs - stats.lastMs);
        stats.lastMs = Math.max(stats.lastMs ?? 0, frame.timeMs);
      }
      if (r.status === "observed" || r.status === "accepted" || r.status === "rejected") stats.usable += 1;
      const lost = ["absent", "insufficient", "unknown_side", "unknown_pose"].includes(r.status);
      if (lost && !stats.inLost) stats.lost += 1; // a "lost event" = the sequence entering a lost state (incl. indeterminate side)
      if (r.status !== "ignored_frame" && r.status !== "limit_reached") stats.inLost = lost;
      if (r.candidate) enqueue(() => controller.recordCycles([r.candidate], { target }));
      return { status: r.status, progress: this.progress() };
    },

    flush: () => chain,

    /** Closing: stop (unless the dose already completed the capture), capture summary and the participant's report. */
    async finish({ action = "end", report, interruptReason = null } = {}) {
      await chain;
      let state = await controller.restore();
      if (state.phase === "active" || state.phase === "calibrated" || state.phase === "created") state = await controller.stop(action, { interruptReason, tMonoMs: elapsed() });
      await controller.captureSummary({
        frames_total: stats.frames, ...fps(),
        usable_fraction: stats.frames ? stats.usable / stats.frames : null, lost_events: stats.lost,
      }, elapsed());
      if (report) return controller.submitReport(report);
      return controller.restore();
    },
  };
}
