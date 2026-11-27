import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { itemStateViolations, createDomainRegistry, goalTargetSpec, buildGoalTarget, goalTargetViolations } from "../v3/domain_fields.mjs";

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

import { instrumentEntries, instrumentFromSelection, instrumentViolations } from "../v3/domain_fields.mjs";
const registry = JSON.parse(readFileSync(new URL("../v3/catalogs/instrument-registry.json", import.meta.url), "utf8"));

test("JS-A2-04: InstrumentSelector derives version/status from the registry; vectors agree with the server", () => {
  assert.deepEqual(instrumentFromSelection(registry, "custom_unvalidated"), { instrument_id: "custom_unvalidated", instrument_version: "0", status: "unvalidated_custom" });
  assert.equal(instrumentFromSelection(registry, "inventado"), null);
  assert.equal(instrumentEntries(registry).length, 1);
  for (const v of vec.instrument) {
    const got = instrumentViolations(registry, v.instrument).map((x) => x.rule);
    assert.deepEqual(got, v.ok ? [] : [v.rule], v.id);
  }
});

import { buildItem, itemViolations, parseItemValue } from "../v3/domain_fields.mjs";

test("JS-A2-06: item vectors give the same first rule as the server", () => {
  for (const v of vec.items) {
    const got = itemViolations(v.items).map((x) => x.rule);
    if (v.ok) assert.deepEqual(got, [], v.id);
    else assert.ok(got.includes(v.rule), `${v.id}: ${got}`);
  }
});

test("JS-A2-07: MeasurementField keeps zero, unknown and not-assessed apart; unit only on numeric", () => {
  const base = { key: "grip_key", assistance: "none" };
  assert.equal(buildItem({ ...base, valueType: "number", rawValue: "0", unit: "deg" }).value, 0);
  assert.equal(buildItem({ ...base, valueType: "number", rawValue: "", unit: "deg", state: "unknown" }).value, null);
  assert.equal(buildItem({ ...base, valueType: "number", rawValue: "", unit: "deg", state: "unknown" }).not_assessed, false);
  const na = buildItem({ ...base, valueType: "number", rawValue: "7", unit: "deg", state: "not_assessed" });
  assert.deepEqual([na.value, na.not_assessed], [null, true]);
  assert.equal(buildItem({ ...base, valueType: "category", rawValue: "x", unit: "deg" }).unit, null);
  assert.equal(parseItemValue("boolean", "true"), true);
  assert.equal(itemViolations([buildItem({ ...base, valueType: "integer", rawValue: "2.5" })])[0].rule, "item.value_type_mismatch");
  assert.equal(itemViolations([buildItem({ ...base, valueType: "boolean", rawValue: "talvez" })])[0].rule, "item.value_type_mismatch");
});

import { doseViolations } from "../v3/domain_fields.mjs";
const limits = JSON.parse(readFileSync(new URL("../v3/catalogs/limits.v1.json", import.meta.url), "utf8"));

test("JS-A2-08: DoseField guard mirrors limits.v1 (10/100/product 100) and weekly 1..14; never adjusts", () => {
  const ok = { sets: 2, reps: 10, perWeek: 3 };
  assert.deepEqual(doseViolations(limits, ok), []);
  assert.deepEqual(doseViolations(limits, { sets: 10, reps: 10, perWeek: 14 }), []);
  assert.equal(doseViolations(limits, { ...ok, sets: 11 })[0].rule, "dose.sets_range");
  assert.equal(doseViolations(limits, { ...ok, reps: 101 })[0].rule, "dose.reps_range");
  assert.equal(doseViolations(limits, { sets: 10, reps: 11, perWeek: 3 })[0].rule, "dose.product_max");
  assert.equal(doseViolations(limits, { ...ok, perWeek: 15 })[0].rule, "dose.sessions_week_range");
  assert.equal(doseViolations(limits, { ...ok, sets: 2.5 })[0].rule, "dose.sets_range");
  assert.equal(doseViolations(limits, { ...ok, reps: NaN })[0].rule, "dose.reps_range");
});

test("JS-FIX39: an empty observed value is a violation; absence must be chosen explicitly; zero stays valid", () => {
  assert.equal(itemStateViolations({ state: "observed", rawValue: "" })[0].rule, "item.observed_requires_value");
  assert.equal(itemStateViolations({ state: "observed", rawValue: "0" }).length, 0);
  assert.equal(itemStateViolations({ state: "unknown", rawValue: "" }).length, 0);
  assert.equal(itemStateViolations({ state: "not_assessed", rawValue: "" }).length, 0);
});

test("JS-FIX38/40: ceiling comes from the catalog; empty goal text is a field violation", () => {
  const max = goalTargetSpec(rules, "session_count").max;
  assert.equal(max, 100000);
  const hi = goalTargetViolations(rules, buildGoalTarget(rules, "session_count", String(max + 1)));
  assert.deepEqual([hi[0].rule, hi[0].params.max], ["goal.count_ceiling", max]);
  const reg = createDomainRegistry({ goalRules: rules });
  const t = buildGoalTarget(rules, "session_count", "3");
  assert.equal(reg.evaluate("goal", { goal_text: "   ", target: t })[0].rule, "goal.text_required");
  assert.deepEqual(reg.evaluate("goal", { goal_text: "ok", target: t }), []);
});

import { legacyFindings } from "../v3/domain_fields.mjs";
const unitsCat = JSON.parse(readFileSync(new URL("../v3/catalogs/units.json", import.meta.url), "utf8"));

test("I-05/P-08: legacyFindings marks stored goals outside current rules, never corrects them", () => {
  assert.deepEqual(legacyFindings(rules, { kind: "session_count", value: 3, unit: "sessions" }), []);
  assert.deepEqual(legacyFindings(rules, { kind: "descriptive_text", value: null, unit: null }), []);
  assert.equal(legacyFindings(rules, { kind: "measure_value", value: 7.5, unit: "kg" })[0].code, "legacy_kind");
  assert.equal(legacyFindings(rules, { kind: "session_count", value: 3, unit: "kg" })[0].rule, "goal.count_unit_compatible");
  assert.equal(legacyFindings(rules, { kind: "session_count", value: 100001, unit: "sessions" })[0].rule, "goal.count_ceiling");
  assert.equal(legacyFindings(rules, { kind: "inexistente", value: 1, unit: null })[0].code, "unknown_kind");
  assert.deepEqual(legacyFindings(null, { kind: "session_count", value: 1, unit: "kg" }), []); // no rules loaded: never guess
  const t0 = { kind: "session_count", value: 3, unit: "kg" }; const copy = JSON.stringify(t0);
  legacyFindings(rules, t0); assert.equal(JSON.stringify(t0), copy);
});

test("I-01: every unit in the catalog has a PT and an EN label (no fallback to 'unknown')", async () => {
  const { default: pt } = await import("../v3/i18n_pt.mjs").then((m) => ({ default: Object.values(m).find((v) => v && typeof v === "object" && "enum.unit.1" in v) }));
  const { default: en } = await import("../v3/i18n_en.mjs").then((m) => ({ default: Object.values(m).find((v) => v && typeof v === "object" && "enum.unit.1" in v) }));
  for (const u of unitsCat.units) {
    assert.ok(pt[`enum.unit.${u.unit}`], `PT label for ${u.unit}`);
    assert.ok(en[`enum.unit.${u.unit}`], `EN label for ${u.unit}`);
    assert.notEqual(pt[`enum.unit.${u.unit}`], en[`enum.unit.${u.unit}`], `unit ${u.unit} must differ between languages`);
  }
});
