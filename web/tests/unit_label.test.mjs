// FIX-44 / I-01: unit display. Known units are translated; units outside the catalog are shown literally; absent is empty.
import test from "node:test";
import assert from "node:assert/strict";
import { setLang, unitLabel } from "../v3/i18n.mjs";

test("UL-01 derived units are translated in both languages (I-01)", () => {
  setLang("pt", { persist: false });
  assert.equal(unitLabel("sessions"), "sessões");
  assert.equal(unitLabel("reps"), "repetições");
  setLang("en", { persist: false });
  assert.equal(unitLabel("sessions"), "sessions");
  assert.equal(unitLabel("reps"), "repetitions");
});

test("UL-02 unit unknown to the catalog is literal, never 'Not informed' (FIX-44)", () => {
  for (const lang of ["pt", "en"]) {
    setLang(lang, { persist: false });
    assert.equal(unitLabel("cm"), "cm");
    assert.equal(unitLabel("<b>x</b>"), "<b>x</b>", "returned verbatim as plain text; callers use textContent");
  }
});

test("UL-03 absent unit is empty and distinct from an unknown unit", () => {
  setLang("pt", { persist: false });
  for (const v of [null, undefined, ""]) assert.equal(unitLabel(v), "");
  assert.notEqual(unitLabel("cm"), unitLabel(null));
});

test("UL-04 existing catalog units keep their labels", () => {
  setLang("pt", { persist: false });
  assert.equal(unitLabel("deg"), "graus");
  assert.equal(unitLabel("cycles"), "ciclos");
});
