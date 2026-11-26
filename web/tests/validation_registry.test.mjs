import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry, violationFromApiError } from "../v3/validation_registry.mjs";

test("JS-A2-REG: registry evaluates registered rules in order; empty scope is no-op", () => {
  const r = createRegistry();
  assert.deepEqual(r.evaluate("goal", {}), []);
  r.register("goal", () => [{ rule: "a", path: "$.x" }]);
  r.register("goal", () => [{ rule: "b", path: "$.y" }]);
  assert.deepEqual(r.evaluate("goal", {}).map((v) => v.rule), ["a", "b"]);
});

test("JS-A2-REG: violationFromApiError reads structured details only", () => {
  assert.deepEqual(violationFromApiError({ details: { rule: "goal.count_floor", path: "$.p" } }), { rule: "goal.count_floor", path: "$.p" });
  assert.equal(violationFromApiError({ details: ["TYPE"] }), null);
  assert.equal(violationFromApiError(null), null);
});
