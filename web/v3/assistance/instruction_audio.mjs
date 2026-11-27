/**
 * Controls optional local playback. The injected port plays the same text and
 * must honor its abort signal. No speech engine or fetch is selected here.
 */
export function createInstructionAudio(text, playback) {
  if (typeof text !== "string" || !text.trim()) throw new TypeError("Instruction text is required");
  const available = typeof playback?.play === "function";
  let active = null;
  let enabled = false;
  let status = available ? "disabled" : "unavailable";

  function stop() {
    const current = active;
    active = null;
    status = available ? (enabled ? "idle" : "disabled") : "unavailable";
    current?.abort();
  }

  return {
    text,
    snapshot: () => ({ text, enabled, status }),
    enable() {
      if (available && !enabled) {
        enabled = true;
        status = "idle";
      }
    },
    disable() {
      enabled = false;
      stop();
    },
    stop,
    async start() {
      if (!enabled || active) return status;
      const controller = new AbortController();
      active = controller;
      status = "playing";
      try {
        await playback.play(text, { signal: controller.signal });
        if (active === controller) status = "idle";
      } catch {
        if (active === controller) status = "unavailable";
      } finally {
        if (active === controller) active = null;
      }
      return controller.signal.aborted ? "stopped" : status;
    },
  };
}
