// Synthetic tests for web/counter.js. Run: node web/test_counter.js  (exit code 1 if any check fails)
const { createCounter, thresholdsFrom, markAtypical } = require("./counter.js");
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (!u) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function run(fn, durMs, seed, opts) {
  const r = rng(seed), c = createCounter(opts), evs = []; let t = 0;
  while (t < durMs) { const v = fn(t, r); if (v === null) c.lost(t); else { const e = c.feed(t, v, 0.9); if (e) evs.push(e); } t += 20 + r() * 25; }
  return { reps: c.reps, evs };
}
const cyc = (P, lo, hi, sd) => (t, r) => (lo + hi) / 2 + (hi - lo) / 2 * Math.cos(2 * Math.PI * t / P) + sd * gauss(r);
let fails = 0;
function expectAll(name, expected, vals, minExact) {
  const exact = vals.filter((v) => v === expected).length, ok = exact >= minExact;
  if (!ok) fails++;
  console.log((ok ? "ok   " : "FAIL ") + name + "  exact " + exact + "/" + vals.length + " (need " + minExact + ")");
}
const seeds = Array.from({ length: 100 }, (_, i) => i + 1);

// A. clean cycles on the range real hands gave (0.6 closed, 1.65 open)
// Known limit: at 700 ms per cycle (1.4 reps/s) it undercounts in ~19% of runs; tested from 800 ms.
for (const P of [800, 1500, 3000, 5000]) expectAll("clean cycles, period " + P + " ms", 10, seeds.map((s) => run(cyc(P, 0.6, 1.65, 0.05), 10 * P + 1, s).reps), 98);
// B. tremor and a still hand must not count
expectAll("tremor on a half-closed hand", 0, seeds.map((s) => run((t, r) => 1.15 + 0.1 * Math.sin(2 * Math.PI * 5 * t / 1000) + 0.05 * gauss(r), 20000, s).reps), 100);
expectAll("still open hand with noise", 0, seeds.map((s) => run((t, r) => 1.65 + 0.15 * gauss(r), 20000, s).reps), 100);
// C. tracking lost in the middle of a cycle: the partial cycle is discarded
expectAll("5 cycles, one with tracking loss", 4, seeds.map((s) => { const b = cyc(3000, 0.6, 1.65, 0.05); return run((t, r) => (t > 7200 && t < 8800 ? null : b(t, r)), 15001, s).reps; }), 98);
// D. small amplitude: defaults miss it, 10 s calibration fixes it
const cal = seeds.map((s) => { const r = rng(1000 + s), vals = []; for (let t = 0; t < 10000; t += 33) vals.push(cyc(3000, 1.0, 1.4, 0.03)(t, r)); const th = thresholdsFrom(vals); return th ? run(cyc(3000, 1.0, 1.4, 0.03), 30001, s, th).reps : -99; });
expectAll("small amplitude after calibration", 10, cal, 95);
// E. calibration without movement is refused
{ const r = rng(7), v = []; for (let i = 0; i < 300; i++) v.push(1.65 + 0.03 * gauss(r)); const ok = thresholdsFrom(v) === null; if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + "calibration with a still hand is refused"); }
// F. atypical marking
{ const mk = (d, a) => ({ duration_ms: d, amplitude: a });
  const evs = [mk(3000, 1), mk(3100, 1.05), mk(2900, 0.95), mk(3000, 1), mk(9000, 1), mk(3000, 0.3)];
  const n = markAtypical(evs); const ok = n === 2 && evs[4].atypical && evs[5].atypical && !evs[0].atypical; if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + "atypical: slow and low-amplitude reps flagged (" + n + ")");
  const few = [mk(1000, 1), mk(5000, 1)]; const ok2 = markAtypical(few) === 0; if (!ok2) fails++; console.log((ok2 ? "ok   " : "FAIL ") + "atypical: fewer than 4 reps -> none flagged"); }
console.log(fails ? fails + " check(s) failed" : "all checks passed");
process.exit(fails ? 1 : 0);
