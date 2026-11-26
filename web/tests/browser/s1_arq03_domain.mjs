// ARQ-03 domain fields in a real browser (SYNTHETIC data). Usage: node s1_arq03_domain.mjs [--origin URL] [--only goals|...]
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const origin = args.origin || "http://127.0.0.1:8080";
const pwDir = process.env.ELO_PLAYWRIGHT_DIR || path.join(os.homedir(), "hackathons/elo-platform/workspace/tools/playwright");
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ headless: true });
const results = [];
const check = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); console.error("FAIL", id, String(e.message).split("\n").slice(0, 3).join(" / ")); } };
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
await ctx.addInitScript(() => { try { localStorage.setItem("elo_lang", "en"); } catch {} });
const t = await ctx.newPage();
const writes = [];
t.on("request", (r) => { if (/\/api\/v3\//.test(r.url()) && r.method() !== "GET") writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
const count = (re) => writes.filter((w) => re.test(w)).length;

await t.goto(origin + "/v3/therapist.html");
await t.fill("#signin-username", "terapeuta_demo");
await t.fill("#signin-password", "senha-sintetica-demo");
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
await t.fill("#participant-alias", "Dominio Teste");
await t.click("#btn-create-participant");
await t.waitForSelector("#participant-result:not([hidden])");
const pid = await t.inputValue("#active-participant-id");
const login = await ctx.request.post(origin + "/api/v3/auth/therapist", { data: { username: "terapeuta_demo", password: "senha-sintetica-demo" } });
const H = { Authorization: `Bearer ${(await login.json()).token}` };
const goals = async () => { const b = await (await ctx.request.get(`${origin}/api/v3/participants/${pid}/goals`, { headers: H })).json(); return b.items ?? b.entities ?? b; };
await t.waitForFunction(() => document.getElementById("goal-target-unit").value === "sessions");

await check("BR-A2-01 meta: padrão válido, unidade derivada somente leitura, medida livre (measure_value) fora das opções", async () => {
  assert.equal(await t.getAttribute("#goal-target-unit", "readonly"), "");
  assert.equal(await t.inputValue("#goal-target-unit"), "sessions");
  const kinds = await t.$$eval("#goal-target-kind option", (o) => o.map((x) => x.value));
  assert.deepEqual(kinds, ["session_count", "repetitions", "descriptive_text"]);
});
await check("BR-A2-02 trocar o tipo muda a unidade derivada; descritivo desabilita o valor", async () => {
  await t.selectOption("#goal-target-kind", "repetitions");
  assert.equal(await t.inputValue("#goal-target-unit"), "reps");
  await t.selectOption("#goal-target-kind", "descriptive_text");
  assert.equal(await t.isDisabled("#goal-target-value"), true);
  assert.equal(await t.inputValue("#goal-target-unit"), "");
  await t.selectOption("#goal-target-kind", "session_count");
  assert.equal(await t.isDisabled("#goal-target-value"), false);
  assert.equal(await t.inputValue("#goal-target-unit"), "sessions");
});
await check("BR-A2-03 valor fracionário/zero: erro no campo, foco, nenhuma escrita, nada persiste", async () => {
  await t.fill("#goal-text", "Meta sintética A2");
  const base = (await goals()).length;
  for (const bad of ["2.5", "0"]) {
    await t.fill("#goal-target-value", bad);
    const before = count(/goals/);
    await t.click("#btn-create-goal");
    await t.waitForSelector("#goal-target-value-error:not([hidden])");
    assert.equal(await t.getAttribute("#goal-target-value", "aria-invalid"), "true");
    assert.equal(await t.evaluate(() => document.activeElement.id), "goal-target-value");
    assert.equal(count(/goals/), before);
  }
  assert.equal((await goals()).length, base);
});
await check("BR-A2-04 meta válida (3 sessões) é gravada com unidade derivada", async () => {
  await t.fill("#goal-target-value", "3");
  await t.click("#btn-create-goal");
  await t.waitForSelector("#goal-result:not([hidden])");
  const g = (await goals()).at(-1);
  assert.deepEqual(g.payload.target, { kind: "session_count", value: 3, unit: "sessions" });
});
await check("BR-A2-05 o servidor continua autoridade: POST direto com unidade incompatível é recusado com details.rule", async () => {
  const r = await ctx.request.post(`${origin}/api/v3/participants/${pid}/goals`, { headers: H, data: { goal_text: "x", body_segment: "hand", target: { kind: "session_count", value: 3, unit: "kg" }, status: "active", confirmed_by: null, confirmed_at: null } });
  assert.equal(r.status(), 400);
  assert.equal((await r.json()).error.details.rule, "goal.count_unit_compatible");
});

const assessments = async () => { const b = await (await ctx.request.get(`${origin}/api/v3/participants/${pid}/assessments`, { headers: H })).json(); return b.items ?? b.entities ?? b; };
await check("BR-A2-06 instrumento: seletor do registro; versão e situação derivadas e não editáveis", async () => {
  assert.equal(await t.evaluate(() => document.getElementById("assessment-instrument-id").tagName), "SELECT");
  assert.deepEqual(await t.$$eval("#assessment-instrument-id option", (o) => o.map((x) => x.value)), ["custom_unvalidated"]);
  assert.equal(await t.getAttribute("#assessment-instrument-version", "readonly"), "");
  assert.equal(await t.inputValue("#assessment-instrument-version"), "0");
  assert.equal(await t.isDisabled("#assessment-instrument-status"), true);
  assert.equal(await t.inputValue("#assessment-instrument-status"), "unvalidated_custom");
});
await check("BR-A2-07 avaliação com os padrões do registro é gravada; POST direto fora do registro é recusado e nada persiste", async () => {
  await t.fill("#assessment-date", "2026-03-10");
  await t.click("#btn-create-assessment");
  await t.waitForSelector("#assessment-result:not([hidden])");
  const base = (await assessments()).length;
  assert.deepEqual((await assessments()).at(-1).payload.instrument, { instrument_id: "custom_unvalidated", instrument_version: "0", status: "unvalidated_custom" });
  const r = await ctx.request.post(`${origin}/api/v3/participants/${pid}/assessments`, { headers: H, data: { assessment_date: "2026-03-10", body_segment: "hand", side: "right", instrument: { instrument_id: "custom_unvalidated", instrument_version: "0", status: "validated_with_therapists" }, items: [{ item_key: "grip_check", value_type: "category", value: "parcial", unit: null, source: "therapist_observed", assistance: "none", not_assessed: false }], therapist_note: null } });
  assert.equal(r.status(), 400);
  assert.equal((await r.json()).error.details.rule, "instrument.registry_mismatch");
  assert.equal((await assessments()).length, base);
});

await check("BR-A2-08 item: tipo numérico habilita unidade do registro; não avaliado desabilita valor; texto numérico inválido é bloqueado no campo", async () => {
  assert.equal(await t.isDisabled("#assessment-item-unit"), true);
  await t.selectOption("#assessment-item-value-type", "integer");
  assert.equal(await t.isDisabled("#assessment-item-unit"), false);
  assert.deepEqual(await t.$$eval("#assessment-item-unit option", (o) => o.map((x) => x.value)), ["", "1", "deg"]);
  await t.fill("#assessment-item-value", "2.5");
  const before = count(/assessments/);
  await t.click("#btn-create-assessment");
  await t.waitForSelector("#assessment-item-value-error:not([hidden])");
  assert.equal(await t.evaluate(() => document.activeElement.id), "assessment-item-value");
  assert.equal(count(/assessments/), before);
  await t.check("#assessment-item-not-assessed");
  assert.equal(await t.isDisabled("#assessment-item-value"), true);
});
await check("BR-A2-09 item não avaliado é gravado com valor nulo e flag; zero observado é gravado como 0", async () => {
  const base = (await assessments()).length;
  await t.selectOption("#assessment-item-value-type", "number");
  await t.selectOption("#assessment-item-unit", "deg");
  await t.click("#btn-create-assessment");
  await t.waitForFunction((n) => true, base);
  await t.waitForTimeout(800);
  let last = (await assessments()).at(-1).payload.items[0];
  assert.deepEqual([last.value, last.not_assessed, last.unit], [null, true, "deg"]);
  await t.uncheck("#assessment-item-not-assessed");
  await t.fill("#assessment-item-key", "wrist_flexion");
  await t.fill("#assessment-item-value", "0");
  await t.click("#btn-create-assessment");
  await t.waitForTimeout(800);
  last = (await assessments()).at(-1).payload.items[0];
  assert.deepEqual([last.value, last.not_assessed, last.unit], [0, false, "deg"]);
});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
