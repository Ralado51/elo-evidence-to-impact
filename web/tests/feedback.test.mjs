import test from "node:test";
import assert from "node:assert/strict";
import { createFeedback, mapErrorDetails } from "../v3/feedback.mjs";

function mk() {
  const mkEl = () => ({ hidden: true, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });
  const e = mkEl(), s = mkEl(), et = { text: "" }, st = { text: "" };
  const spoken = [];
  let clock = 0;
  const fb = createFeedback({
    errorBanner: e, errorBannerText: et, successBanner: s, successBannerText: st,
    bindText: (n, m) => { n.text = m; }, renderErrorTechnical: () => {}, announce: (m, o) => spoken.push([m, o.politeness]),
    now: () => clock,
  });
  return { fb, e, s, et, st, spoken, tick: (n) => { clock += n; } };
}

test("FB-01 states are exclusive: error clears success and success clears error", () => {
  const { fb, e, s } = mk();
  fb.showSuccess("ok"); assert.equal(s.hidden, false);
  fb.showError("X", "bad"); assert.equal(s.hidden, true); assert.equal(e.hidden, false); assert.equal(e.attrs.role, "alert");
  fb.showSuccess("ok2"); assert.equal(e.hidden, true); assert.equal(s.hidden, false);
});

test("FB-02 identical message is announced once within the dedup window, again after it", () => {
  const { fb, spoken, tick } = mk();
  fb.showError("X", "same"); fb.showError("X", "same");
  assert.equal(spoken.length, 1);
  tick(1000); fb.showError("X", "same");
  assert.equal(spoken.length, 2);
});

test("FB-03 participant-owned feedback is cleared on participant switch; global survives it", () => {
  const { fb, e, s } = mk();
  fb.showSuccess("saved for Alfa"); fb.onContextChange("switch");
  assert.equal(s.hidden, true);
  fb.showError("UNAUTHENTICATED", "sign in", "", { scope: "global" }); fb.onContextChange("switch");
  assert.equal(e.hidden, false);
  fb.onContextChange("logout"); assert.equal(e.hidden, true);
});

test("FB-04 ErrorMapper accepts details object, code list and absence", () => {
  assert.deepEqual(mapErrorDetails({ code: "RULE_VIOLATION", details: { rule: "goal.count_ceiling", path: "$.target" } }).rules, [{ rule: "goal.count_ceiling", path: "$.target" }]);
  assert.deepEqual(mapErrorDetails({ code: "X", details: ["a", { rule: "b", path: "$.p" }] }).rules, [{ rule: "a" }, { rule: "b", path: "$.p" }]);
  assert.deepEqual(mapErrorDetails({ code: "X" }).rules, []);
});
