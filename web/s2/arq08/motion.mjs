// This experimental core requires a supplied protocol. There is no default classification policy.
const MAX_TIME_MS = 1_000_000_000; // v3 envelope
const MIN_SAMPLES = 8; // calibration.applied schema
const MIN_SPAN = 0.22; // calibration.applied schema
const side = (value) => value === "left" || value === "right";

export function evaluateCalibration({ id, open, closed, method, version, minSpan }) {
  if (!/^cal_[A-Za-z0-9-]{8,64}$/.test(id) || !method || !version ||
      !Number.isFinite(minSpan) || minSpan < MIN_SPAN || minSpan > 3) throw new TypeError("Invalid calibration configuration");
  const valid = (samples) => Array.isArray(samples) && samples.length >= MIN_SAMPLES &&
    samples.length <= 10_000 && Array.from(samples).every((v) => Number.isFinite(v) && Math.abs(v) <= 10);
  if (!valid(open) || !valid(closed)) return { status: "insufficient" };
  const median = (samples) => {
    const ordered = samples.toSorted((a, b) => a - b);
    const mid = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
  };
  const openValue = median(open);
  const closedValue = median(closed);
  const span = openValue - closedValue;
  if (span < minSpan) return { status: "invalid_span" };
  return Object.freeze({
    status: "ready", id, method, version, open: openValue, closed: closedValue,
    span, openSamples: open.length, closedSamples: closed.length, minSpan,
  });
}

export function createMotionSession({ scope, prescription, limits, protocol, calibration, executionMode, dataOrigin }) {
  if (executionMode !== "simulation" || dataOrigin !== "synthetic_fixture")
    throw new TypeError("The motion core is limited to synthetic simulation");
  const { targetSets, targetRepetitions, prescribedSide, limitsVersion } = prescription;
  const target = targetSets * targetRepetitions;
  if (!side(prescribedSide) || !Number.isInteger(targetSets) || !Number.isInteger(targetRepetitions) ||
      limitsVersion !== "limits-v1" || limits?.limits_version !== limitsVersion ||
      !Number.isInteger(limits.max_sets) || !Number.isInteger(limits.max_repetitions) ||
      !Number.isInteger(limits.max_product) ||
      targetSets < 1 || targetSets > Math.min(10, limits.max_sets) ||
      targetRepetitions < 1 || targetRepetitions > Math.min(100, limits.max_repetitions) ||
      target > Math.min(100, limits.max_product)) throw new TypeError("Invalid prescribed dose or side");
  const { classify, isUsable, maxGapMs, version } = protocol;
  if (typeof classify !== "function" || typeof isUsable !== "function" ||
      !Number.isFinite(maxGapMs) || maxGapMs <= 0 || !/^[a-z0-9][a-z0-9.-]{1,40}$/.test(version))
    throw new TypeError("Explicit versioned protocol required");
  const context = Object.freeze({
    org_id: scope.org_id, participant_id: scope.participant_id, session_id: scope.session_id,
    prescription_id: scope.prescription_id, prescription_revision: scope.prescription_revision,
    exercise_id: scope.exercise_id,
  });
  const ids = { org_id: "o_", participant_id: "p_", session_id: "s_", prescription_id: "rx_" };
  if (Object.entries(ids).some(([key, prefix]) => !new RegExp("^" + prefix + "[A-Za-z0-9-]{8,64}$").test(context[key])) ||
      !Number.isInteger(context.prescription_revision) || context.prescription_revision < 1 || context.prescription_revision > 1000 ||
      context.exercise_id !== "organizar-a-mesa") throw new TypeError("Invalid session scope");
  const cal = calibration ? Object.freeze({ ...calibration }) : null;
  const calibrated = cal?.status === "ready" && /^cal_[A-Za-z0-9-]{8,64}$/.test(cal.id) &&
    Number.isFinite(cal.closed) && Number.isFinite(cal.open) && Math.abs(cal.closed) <= 10 &&
    Math.abs(cal.open) <= 10 && cal.span === cal.open - cal.closed && cal.span >= MIN_SPAN;

  let previous = -Infinity;
  let motion = null;
  let accepted = 0;
  let index = 0;
  return {
    snapshot: () => ({ accepted, target, candidates: index }),
    sample(frame) {
      const { timeMs } = frame;
      if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > MAX_TIME_MS || timeMs <= previous)
        return { status: "ignored_frame" };
      if (timeMs - previous > maxGapMs) motion = null;
      previous = timeMs;
      if (!calibrated) return { status: "uncalibrated" };
      if (accepted === target || index === 10_000) return { status: "limit_reached" };

      const normalized = (frame.value - cal.closed) / cal.span;
      if (frame.status !== "detected" || !Number.isFinite(normalized) ||
          Math.abs(normalized) > 5 || !isUsable(frame)) {
        motion = null;
        return { status: frame.status === "absent" ? "absent" : "insufficient" };
      }
      const { handedness } = frame;
      if (!side(handedness?.label) || !Number.isFinite(handedness.score) ||
          handedness.score < 0 || handedness.score > 1) {
        motion = null;
        return { status: "unknown_side" };
      }
      const pose = classify(normalized);
      if (pose !== "open" && pose !== "closed" && pose !== "transition") {
        motion = null;
        return { status: "unknown_pose" };
      }
      const begin = () => ({
        started: timeMs, peak: normalized, trough: null, frames: 1,
        mismatch: handedness.label !== prescribedSide ? { ...handedness } : null,
      });
      if (!motion) {
        if (pose === "open") motion = begin();
        return { status: "observed" };
      }
      if (timeMs - motion.started > 600_000 || motion.frames === 100_000) {
        motion = pose === "open" ? begin() : null;
        return { status: "insufficient" };
      }

      motion.frames += 1;
      if (handedness.label !== prescribedSide) motion.mismatch ??= { ...handedness };
      if (motion.trough === null) {
        if (pose === "open") motion = begin();
        if (pose === "closed") {
          motion.trough = normalized;
          motion.closeTime = timeMs;
        }
        return { status: "observed" };
      }
      if (pose !== "open") {
        if (pose === "closed") motion.trough = Math.min(motion.trough, normalized);
        return { status: "observed" };
      }

      const rejected = motion.mismatch !== null;
      const payload = {
        cycle_index: ++index, calibration_id: cal.id, open_peak_n: motion.peak,
        closed_trough_n: motion.trough, armed_to_close_ms: motion.closeTime - motion.started,
        frames: motion.frames, usable_frames: motion.frames,
        handedness: motion.mismatch ?? { ...handedness },
        ...(rejected ? { reason: "handedness_incompatible" } : {}),
      };
      motion = begin();
      if (!rejected) accepted += 1;
      return {
        status: rejected ? "rejected" : "accepted",
        candidate: {
          type: rejected ? "cycle.rejected" : "cycle.accepted", scope: context,
          execution_mode: executionMode, data_origin: dataOrigin,
          algorithm_version: version, t_mono_ms: timeMs, payload,
        },
      };
    },
  };
}
