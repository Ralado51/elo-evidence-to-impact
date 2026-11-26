// S1 Etapa E (FIX-25..FIX-32): language switch in all journeys, persistence, data kept on switch,
// friendly errors, and no internal codes visible. SYNTHETIC data, real pages.
// Usage: node web/tests/browser/s1_stab_e.mjs --origin http://127.0.0.1:8080   (stack from scripts/demo_up.sh)
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const origin = args.origin || "http://127.0.0.1:8080";
const pwDir = process.env.ELO_PLAYWRIGHT_DIR || path.join(os.homedir(), "hackathons/elo-platform/workspace/tools/playwright");
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ headless: true, ...(process.env.ELO_CHROME ? { executablePath: process.env.ELO_CHROME, args: ["--no-sandbox"] } : {}) });
const results = [];
const check = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); } };

// Browser language is English on purpose: the product default must still be pt-BR (FIX-30).
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
const PAGES = ["therapist", "participant", "painel"];
const CODE_RE = [/\([a-z0-9]+(?:_[a-z0-9]+)+\)/, /\bcmp-v\d\b/i, /\bunvalidated_custom\b/, /\breport_only\b/, /\bRULE_VIOLATION\b/];

async function visibleText(page) {
  // Technical areas (audit details, technical error block, monospace audit lines, hidden nodes) are excluded on purpose.
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    for (const n of clone.querySelectorAll("details, .mono, [hidden], script, style, option[value]")) n.remove();
    return clone.innerText || clone.textContent || "";
  });
}
async function optionTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll("option")].map((o) => ({ value: o.value, text: o.textContent.trim() })));
}

const t = await ctx.newPage();
await t.goto(`${origin}/v3/therapist.html`);

await check("E1 padrão é pt-BR mesmo com navegador em inglês", async () => {
  assert.equal(await t.evaluate(() => document.documentElement.lang), "pt-BR");
  assert.match(await t.textContent("h1"), /Terapeuta|terapeuta/);
});
await check("E2 seletor de idioma existe nas três telas", async () => {
  for (const p of PAGES) {
    const page = await ctx.newPage();
    await page.goto(`${origin}/v3/${p}.html`);
    assert.equal(await page.locator("[data-lang-switch] [data-lang-option]").count(), 2, p);
    assert.equal(await page.getAttribute('[data-lang-option="pt-BR"]', "aria-pressed"), "true", p);
    await page.close();
  }
});
await check("E3 trocar para inglês traduz a tela e preserva o que foi digitado", async () => {
  await t.fill("#signin-username", "terapeuta_demo");
  await t.fill("#signin-password", "senha-sintetica-demo");
  const before = await t.textContent("h1");
  await t.click('[data-lang-option="en"]');
  assert.equal(await t.evaluate(() => document.documentElement.lang), "en");
  assert.notEqual(await t.textContent("h1"), before);
  assert.equal(await t.inputValue("#signin-username"), "terapeuta_demo");
  assert.equal(await t.inputValue("#signin-password"), "senha-sintetica-demo");
});
await check("E4 preferência persiste após recarregar e vale para as outras telas", async () => {
  await t.reload();
  assert.equal(await t.evaluate(() => document.documentElement.lang), "en");
  const p = await ctx.newPage();
  await p.goto(`${origin}/v3/participant.html`);
  assert.equal(await p.evaluate(() => document.documentElement.lang), "en");
  await p.close();
});
await check("E5 erro de login é uma mensagem compreensível, sem código técnico visível", async () => {
  await t.fill("#signin-username", "terapeuta_demo");
  await t.fill("#signin-password", "senha-errada");
  await t.click("#btn-signin");
  await t.waitForSelector("#error-banner:not([hidden])");
  const msg = await t.textContent("#error-banner-text");
  assert.ok(msg.trim().length > 10);
  assert.ok(!/[A-Z]{4,}_[A-Z_]+|HTTP \d{3}/.test(msg), `mensagem mostra código: ${msg}`);
  assert.ok((await t.getAttribute("#error-banner", "data-error-code")).length > 0);
  assert.equal(await t.locator("#error-banner details[data-error-tech]").count(), 1);
});
await check("E6 jornada em inglês e troca no meio do fluxo mantém contexto e campos", async () => {
  await t.fill("#signin-password", "senha-sintetica-demo");
  await t.click("#btn-signin");
  await t.waitForSelector("#signin-result:not([hidden])");
  const alias = `Lang ${String(Date.now()).slice(-6)}`;
  await t.fill("#participant-alias", alias);
  await t.click("#btn-create-participant");
  await t.waitForSelector(`#participant-list li:has-text("${alias}")`);
  const statusEn = await t.textContent("#participant-list-status");
  assert.match(statusEn, /participant/i);
  await t.fill("#participant-search", "abc");
  await t.click('[data-lang-option="pt-BR"]');
  await t.waitForFunction(() => /participante/i.test(document.querySelector("#participant-list-status").textContent));
  assert.equal(await t.inputValue("#participant-search"), "abc");
  assert.ok(await t.locator(`#participant-list li:has-text("${alias}")`).count(), "lista de participantes mantida");
  assert.match(await t.textContent("#active-participant-summary"), new RegExp(alias));
  assert.equal(await t.inputValue("#active-participant-id").then((v) => v.length > 5), true);
});
for (const lang of ["pt-BR", "en"]) {
  await check(`E7 sem códigos internos visíveis nas três telas (${lang})`, async () => {
    for (const p of PAGES) {
      const page = await ctx.newPage();
      await page.goto(`${origin}/v3/${p}.html`);
      await page.click(`[data-lang-option="${lang}"]`);
      const text = await visibleText(page);
      for (const re of CODE_RE) assert.ok(!re.test(text), `${p}/${lang} mostra ${re}`);
      for (const o of await optionTexts(page)) {
        if (/_/.test(o.value) && !o.value.includes("/")) assert.notEqual(o.text, o.value, `${p}/${lang}: opção mostra o código ${o.value}`);
        assert.ok(!/\(.*_.*\)/.test(o.text), `${p}/${lang}: opção com código entre parênteses: ${o.text}`);
      }
      await page.close();
    }
  });
}
await check("E8 rótulos pedidos pelo PO na tela do terapeuta (pt-BR)", async () => {
  await t.click('[data-lang-option="pt-BR"]');
  const texts = (await optionTexts(t)).map((o) => o.text);
  for (const want of ["Direito", "Esquerdo", "Mão", "Punho", "Com alguma ajuda", "Com ajuda total", "Sem ajuda", "Não avaliado", "Número de sessões", "Repetições", "Ativa", "Descontinuada", "Abrir e fechar a mão", "Instrumento personalizado não validado"]) {
    assert.ok(texts.includes(want), `faltou a opção "${want}"`);
  }
  const body = await t.evaluate(() => document.body.innerText);
  assert.ok(body.includes("Publicar evolução funcional"));
  assert.ok(body.includes("Consultar evidências"));
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
