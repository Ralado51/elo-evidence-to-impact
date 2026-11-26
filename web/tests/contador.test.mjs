import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { syntheticOpenness, summarize } from "../v3/contador_model.mjs";
const { createCounter, markAtypical } = createRequire(import.meta.url)("../v3/counter.js");

test("v3/counter.js is identical to web/counter.js", () => {
  assert.equal(readFileSync(new URL("../v3/counter.js", import.meta.url), "utf8"), readFileSync(new URL("../counter.js", import.meta.url), "utf8"));
});
test("synthetic 3 s cycle counts 10 reps in ~30 s", () => {
  const c = createCounter(), evs = [];
  for (let t = 0; t < 30001; t += 33) { const e = c.feed(t, syntheticOpenness(t), 0.9); if (e) evs.push(e); }
  assert.ok(c.reps >= 9 && c.reps <= 10, "reps " + c.reps);
  markAtypical(evs);
  assert.equal(summarize(evs).atypical, 0);
});
test("summarize empty", () => assert.deepEqual(summarize([]), { reps: 0, atypical: 0, meanDurationS: null, meanAmplitude: null }));
