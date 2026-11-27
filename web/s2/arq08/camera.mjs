/** Owns the video tracks. The caller owns the video element and the local detector. */
export function createCameraPort(mediaDevices) {
  let epoch = 0;
  let stream = null;
  let pending = false;
  const release = (value) => value?.getTracks().forEach((track) => track.stop());
  function stop() {
    epoch += 1;
    pending = false;
    release(stream);
    stream = null;
  }
  return {
    async start({ consent } = {}) {
      if (consent !== true) return { status: "consent_required" };
      if (pending || stream) return { status: "busy" };
      if (!mediaDevices?.getUserMedia) return { status: "report_only" };
      const ticket = ++epoch;
      pending = true;
      try {
        const acquired = await mediaDevices.getUserMedia({ video: true, audio: false });
        if (ticket !== epoch) {
          release(acquired);
          return { status: "cancelled" };
        }
        if (!acquired.getVideoTracks().some((track) => track.readyState === "live")) {
          release(acquired);
          return { status: "report_only" };
        }
        stream = acquired;
        return { status: "ready", stream };
      } catch {
        return { status: ticket === epoch ? "report_only" : "cancelled" };
      } finally {
        if (ticket === epoch) pending = false;
      }
    },
    stop,
    revoke: stop,
  };
}

/** Adapt a caller-provided MediaPipe Hand Landmarker without retaining frames or landmarks.
 *  The caller declares how the detector labels its input, independently of CSS preview mirroring.
 */
export function createHandDetector({ landmarker, openness, swapDetectorLabels }) {
  if (typeof swapDetectorLabels !== "boolean") throw new TypeError("Declare detector label orientation");
  return {
    sample(video, timeMs) {
      const { landmarks, handedness } = landmarker.detectForVideo(video, timeMs);
      if (!landmarks?.length) return { timeMs, status: "absent" };
      const hand = landmarks[0];
      if (landmarks.length !== 1 || hand?.length !== 21 ||
          !hand.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y)) ||
          !(video.videoWidth > 0 && video.videoHeight > 0)) return { timeMs, status: "insufficient" };
      const value = openness(hand, video.videoWidth / video.videoHeight);
      if (!Number.isFinite(value)) return { timeMs, status: "insufficient" };
      const { categoryName, score } = handedness?.[0]?.[0] ?? {};
      const label = typeof categoryName === "string" ? categoryName.toLowerCase() : null;
      const side = label === "left" || label === "right" ? label : null;
      return {
        timeMs, status: "detected", value,
        handedness: side && Number.isFinite(score) && score >= 0 && score <= 1
          ? { label: swapDetectorLabels ? (side === "left" ? "right" : "left") : side, score }
          : null,
      };
    },
  };
}
