// Pure helpers for the hand counter page (no DOM, no camera). Synthetic signal
// generator used by the demonstration mode and by the tests.
export function syntheticOpenness(tMs, { periodMs = 3000, lo = 0.6, hi = 1.65, tremor = 0.03 } = {}) {
  const base = (lo + hi) / 2 + ((hi - lo) / 2) * Math.cos((2 * Math.PI * tMs) / periodMs);
  return base + tremor * Math.sin((2 * Math.PI * 7.3 * tMs) / 1000);
}

export function summarize(events) {
  if (!events.length) return { reps: 0, atypical: 0, meanDurationS: null, meanAmplitude: null };
  const mean = (k) => events.reduce((a, e) => a + e[k], 0) / events.length;
  return {
    reps: events.length,
    atypical: events.filter((e) => e.atypical).length,
    meanDurationS: +(mean("duration_ms") / 1000).toFixed(1),
    meanAmplitude: +mean("amplitude").toFixed(2),
  };
}

export const STATE_LABEL_PTBR = { waiting: "aguardando mão aberta", open: "mão aberta", closed: "mão fechada" };
