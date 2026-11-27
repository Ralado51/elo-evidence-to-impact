// ARQ-04 Phase 6 BLOCKING suite: I-01 (unit labels follow the language), I-02/I-05 (no raw keys in the UI), feedback ownership. SYNTHETIC data.
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
await t.waitForFunction(() => document.querySelectorAll("#assessment-item-unit option").length > 1);
const units = () => t.$$eval("#assessment-item-unit option", (o) => o.map((x) => [x.value, x.textContent.trim()]));
const setLang = async (code) => { await t.click(`[data-lang-option="${code}"]`); await t.waitForTimeout(500); };

await check("I18N-01 I-01: unit options are retranslated on language switch, values unchanged", async () => {
  await setLang("en"); const en = await units();
  await setLang("pt-BR"); const pt = await units();
  assert.deepEqual(en.map((x) => x[0]), pt.map((x) => x[0]), "option VALUES must never change with the language");
  const withValue = (arr) => arr.filter((x) => x[0]);
  assert.ok(withValue(en).length >= 2, "catalog units present");
  for (let i = 0; i < withValue(en).length; i++) assert.notEqual(withValue(en)[i][1], withValue(pt)[i][1], `unit ${withValue(en)[i][0]} must change text between EN and PT`);
  await setLang("en"); const en2 = await units();
  assert.deepEqual(en2, en, "EN again equals first EN (round trip)");
});
await check("I18N-02 I-02: no raw i18n key or 'enum.' leaks into visible text in either language", async () => {
  for (const code of ["en", "pt-BR"]) {
    await setLang(code);
    const txt = await t.evaluate(() => document.body.innerText);
    assert.doesNotMatch(txt, /\b(th|pa|pn|shared)\.[a-z_.-]+\b|enum\.[a-z_]+\./, `raw key visible in ${code}`);
  }
});
await check("I18N-03 selected unit survives a language switch (user input is never reset)", async () => {
  await setLang("en");
  await t.selectOption("#assessment-item-value-type", "number");
  await t.selectOption("#assessment-item-unit", "deg");
  await setLang("pt-BR");
  assert.equal(await t.inputValue("#assessment-item-unit"), "deg");
});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ phase: "arq04-i18n-blocking", passed: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
