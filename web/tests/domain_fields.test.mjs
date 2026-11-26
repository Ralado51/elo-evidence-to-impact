import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { goalTargetSpec, buildGoalTarget, goalTargetViolations } from "../v3/domain_fields.mjs";

const rules = JSON.parse(readFileSync(new URL("../v3/catalogs/goal-target-rules.v1.json", import.meta.url), "utf8"));
const vec = JSON.parse(readFileSync(new URL("../../contracts/CL06_3-A2/contracts/fixtures/a2-vectors.json", import.meta.url), "utf8"));

test("JS-A2-01: shared goal vectors give the same verdict and rule id as the server", () => {
  for (const v of vec.goal) {
    const got = goalTargetViolations(rules, v.target).map((x) => x.rule);
    if (v.ok) assert.deepEqual(got, [], v.id);
    else assert.equal(got[0], v.rule === "goal.count_floor" && v.target.value < 0 ? "goal.count_floor" : v.rule, v.id);
  }
});

test("JS-A2-02: unit is derived by kind; descriptive has no value/unit; measure_value is legacy-free", () => {
  assert.equal(goalTargetSpec(rules, "session_count").unit, "sessions");
  assert.equal(goalTargetSpec(rules, "repetitions").unit, "reps");
  assert.deepEqual(buildGoalTarget(rules, "descriptive_text", "9"), { kind: "descriptive_text", value: null, unit: null });
  assert.deepEqual(buildGoalTarget(rules, "session_count", "3"), { kind: "session_count", value: 3, unit: "sessions" });
  assert.deepEqual(buildGoalTarget(rules, "repetitions", ""), { kind: "repetitions", value: null, unit: "reps" });
  assert.equal(goalTargetSpec(rules, "measure_value").legacy, true);
});

test("JS-A2-03: invalid raw text is reported, never fixed", () => {
  for (const raw of ["2.5", "abc", "0", "-3", ""]) {
    assert.ok(goalTargetViolations(rules, buildGoalTarget(rules, "session_count", raw)).length > 0, raw);
  }
  assert.deepEqual(goalTargetViolations(rules, buildGoalTarget(rules, "session_count", "100000")), []);
});
