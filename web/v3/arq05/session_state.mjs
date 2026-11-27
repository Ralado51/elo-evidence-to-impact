export const SESSION_PHASE = Object.freeze({
  IDLE: "idle", ACTIVE: "active", ENDED: "ended", REPORTED: "reported",
});

export const isStopAction = action => ["end", "pain", "fatigue"].includes(action);

export function transition(phase, action) {
  const P = SESSION_PHASE;
  if (phase === P.IDLE && action === "start") return P.ACTIVE;
  if (phase === P.ACTIVE && isStopAction(action)) return P.ENDED;
  if (phase === P.ENDED && action === "report") return P.REPORTED;
  throw new Error("INVALID_SESSION_TRANSITION");
}
