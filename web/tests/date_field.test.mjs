// ARQ-01 / CMP-04: civil-date rules shared with the backend (same vectors as api/tests/test_v3_civil_date.py).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { civilDateKey, isCivilDate, isRangeInverted, parseCivilDate } from "../v3/civil_date.mjs";
import { dateFieldProblem } from "../v3/date_field.mjs";
import { formatIsoDate, setLang } from "../v3/i18n.mjs";

const V = JSON.parse(readFileSync(new URL("./fixtures/civil_date_vectors.json", import.meta.url), "utf8"));

test("valid vectors parse and keep their exact text", () => {
  for (const v of V.valid) {
    const p = parseCivilDate(v);
    assert.ok(p, v);
    const text = `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    assert.equal(text, v);
  }
});

test("invalid and non-string vectors are rejected (no normalization to another day)", () => {
  for (const v of [...V.invalid, ...V.non_string]) {
    assert.equal(parseCivilDate(v), null, JSON.stringify(v));
    assert.equal(isCivilDate(v), false, JSON.stringify(v));
  }
});

test("leap years follow the Gregorian rule", () => {
  assert.ok(isCivilDate("2024-02-29") && isCivilDate("2000-02-29") && isCivilDate("2400-02-29"));
  assert.ok(!isCivilDate("2026-02-29") && !isCivilDate("1900-02-29") && !isCivilDate("2100-02-29"));
});

test("range vectors: inverted only when both bounds are real and end < start", () => {
  for (const [a, b] of V.ranges.ok) assert.equal(isRangeInverted(a, b), false, `${a}..${b}`);
  for (const [a, b] of V.ranges.inverted) assert.equal(isRangeInverted(a, b), true, `${a}..${b}`);
  assert.equal(isRangeInverted("2026-02-30", "2026-01-01"), false, "an invalid bound is an invalid date, not an inverted range");
  assert.equal(civilDateKey("2026-02-30"), null);
});

test("DateField problems: required, incomplete native entry, impossible text, inverted range, ok", () => {
  const field = (value, badInput = false) => ({ value, validity: { badInput } });
  assert.equal(dateFieldProblem(field(""), { required: true }).key, "date.err.required");
  assert.equal(dateFieldProblem(field(""), { required: false }), null, "optional and empty is fine");
  assert.equal(dateFieldProblem(field("", true), { required: false }).key, "date.err.invalid", "typed-but-impossible leaves value empty with badInput");
  assert.equal(dateFieldProblem(field("2026-02-30")).key, "date.err.invalid");
  assert.equal(dateFieldProblem(field("2026-01-01"), { notBefore: field("2026-01-02") }).key, "date.err.range");
  assert.equal(dateFieldProblem(field("2026-01-02"), { notBefore: field("2026-01-02") }), null, "same day is a valid interval");
  assert.equal(dateFieldProblem(field("2024-02-29"), { required: true }), null);
});

test("formatIsoDate never shifts an impossible date to a real one", () => {
  setLang("pt-BR");
  assert.equal(formatIsoDate("2026-02-30"), "2026-02-30");
  assert.equal(formatIsoDate("2026-10-01"), "01/10/2026");
  assert.equal(formatIsoDate("2024-02-29"), "29/02/2024");
  setLang("en");
  assert.equal(formatIsoDate("2026-04-31"), "2026-04-31");
});
