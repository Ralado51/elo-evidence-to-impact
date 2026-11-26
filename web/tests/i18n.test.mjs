// S1 Etapa E — FIX-25/26/27/28/29/30/31/32: translation coverage and absence of technical codes in the UI.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PT } from "../v3/i18n_pt.mjs";
import { EN } from "../v3/i18n_en.mjs";
import { t, label, setLang, getLang, normalizeLang, formatIsoDate, formatNumber } from "../v3/i18n.mjs";
import { describeApiError, formatExecutionMode } from "../v3/therapist_model.mjs";

const V3 = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "v3");
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
// Internal contract codes that must never be visible to a person in an operational label.
const CODE_PATTERNS = [/\([a-z0-9]+(?:_[a-z0-9]+)+\)/, /\bcmp-v\d\b/i, /\bcontent_hash\b/, /\breport_only\b/, /\bunvalidated_custom\b/, /\b[A-Z]{3,}(?:_[A-Z]+)+\b/];

test("FIX-26: pt-BR and en catalogs have exactly the same keys and placeholders", () => {
  assert.deepEqual(Object.keys(PT).sort(), Object.keys(EN).sort());
  for (const k of Object.keys(PT)) {
    assert.equal(placeholders(PT[k]), placeholders(EN[k]), `placeholder mismatch in ${k}`);
    assert.ok(PT[k].trim() && EN[k].trim(), `empty text in ${k}`);
  }
});

test("FIX-25: no internal code appears in any catalog text", () => {
  for (const [lang, cat] of [["pt", PT], ["en", EN]]) {
    for (const [k, v] of Object.entries(cat)) {
      if (k.startsWith("err.tech")) continue; // technical block is the audit/diagnostic area
      for (const re of CODE_PATTERNS) assert.ok(!re.test(v), `${lang}:${k} shows a technical code: "${v}"`);
    }
  }
});

test("FIX-27: every key used by the pages and scripts exists in both catalogs", () => {
  const files = fs.readdirSync(V3).filter((f) => /\.(html|mjs)$/.test(f) && !f.startsWith("i18n"));
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(V3, f), "utf8");
    for (const m of src.matchAll(/data-i18n(?:-value)?="([^"]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(";")) used.add(pair.split(":")[1]);
    for (const m of src.matchAll(/\bt\(\s*"([\w.]+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 150, "scan found too few keys");
  for (const k of used) {
    assert.ok(k in PT, `missing pt-BR key ${k}`);
    assert.ok(k in EN, `missing en key ${k}`);
  }
});

test("FIX-27: pages have no visible operational text outside the catalog (no code in parentheses)", () => {
  for (const f of ["therapist.html", "participant.html", "painel.html"]) {
    const html = fs.readFileSync(path.join(V3, f), "utf8");
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
    assert.ok(!/\([a-z]+_[a-z_]+\)/.test(text), `${f} shows a code in parentheses`);
    assert.ok(!/cmp-v1|content_hash/.test(text), `${f} shows an internal term`);
  }
});

test("FIX-31: label mapping requested by the PO (pt-BR)", () => {
  setLang("pt-BR", { persist: false });
  const expected = [
    ["side", "right", "Direito"], ["side", "left", "Esquerdo"], ["segment", "hand", "Mão"], ["segment", "wrist", "Punho"],
    ["assistance", "some", "Com alguma ajuda"], ["assistance", "full", "Com ajuda total"], ["assistance", "none", "Sem ajuda"], ["assistance", "not_assessed", "Não avaliado"],
    ["goal_kind", "session_count", "Número de sessões"], ["goal_kind", "repetitions", "Repetições"],
    ["goal_status", "active", "Ativa"], ["goal_status", "discontinued", "Descontinuada"],
    ["movement", "hand_open_close", "Abrir e fechar a mão"],
    ["instrument_status", "unvalidated_custom", "Instrumento personalizado não validado"],
    ["exec_mode", "report_only", "Prática por autorrelato"],
  ];
  for (const [g, v, want] of expected) assert.equal(label(g, v), want, `${g}.${v}`);
  assert.equal(t("th.btn-publish-evolution"), "Publicar evolução funcional");
  assert.equal(t("th.btn-load-facts"), "Consultar evidências");
});

test("FIX-28: RULE_VIOLATION and other API errors become specific messages; technical details stay separate", () => {
  setLang("pt-BR", { persist: false });
  const rule = describeApiError({ code: "RULE_VIOLATION", status: 400, message: "valid_to must not be earlier than valid_from." });
  assert.match(rule.message, /data final/i);
  assert.ok(!/RULE_VIOLATION|valid_to|400/.test(rule.message));
  assert.match(rule.technical, /RULE_VIOLATION/);
  const cal = describeApiError({ code: "RULE_VIOLATION", status: 400, message: "valid_from '2026-02-31' is not a valid calendar date." });
  assert.match(cal.message, /não existe no calendário/);
  assert.ok(describeApiError({ code: "SOMETHING_NEW", status: 500 }).message.length > 10);
  setLang("en", { persist: false });
  assert.match(describeApiError({ code: "CONTENT_HASH_STALE", status: 409 }).message, /changed/i);
  setLang("pt-BR", { persist: false });
});

test("FIX-29/30: language switch, normalization, localized dates and numbers; canonical values unchanged", () => {
  assert.equal(normalizeLang("en-US"), "en");
  assert.equal(normalizeLang("pt"), "pt-BR");
  assert.equal(normalizeLang("fr"), "pt-BR");
  setLang("pt-BR", { persist: false });
  assert.equal(formatIsoDate("2026-11-26"), "26/11/2026");
  assert.equal(formatNumber(1234.5), "1.234,5");
  setLang("en", { persist: false });
  assert.equal(getLang(), "en");
  assert.match(formatIsoDate("2026-11-26"), /11\/26\/2026/);
  assert.equal(formatNumber(1234.5), "1,234.5");
  assert.equal(formatExecutionMode("report_only"), "Self-reported practice");
  setLang("pt-BR", { persist: false });
});

test("FIX-32: unknown enum values never leak the raw code", () => {
  setLang("pt-BR", { persist: false });
  assert.equal(label("side", "diagonal"), PT["enum.unknown"]);
});
