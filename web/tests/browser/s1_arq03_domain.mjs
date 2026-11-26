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
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
