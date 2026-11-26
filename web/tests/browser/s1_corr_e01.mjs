// S1 E-01: dynamic messages (banners, live region, painel status) must re-translate on language switch,
// without repeating business requests and preserving typed text. SYNTHETIC data. Usage: node s1_corr_e01.mjs --origin URL
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
const check = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); console.error("FAIL", id, String(e.message).split("\n").slice(0, 2).join(" / ")); } };
const suffix = String(Date.now()).slice(-4);

// Clean browser context: default language must be pt-BR even with an English browser.
const clean = await browser.newContext({ locale: "en-US" });
const cp = await clean.newPage();
await check("E01-D0 contexto limpo (sem localStorage): idioma padrão pt-BR em todas as páginas", async () => {
  for (const u of ["/v3/therapist.html", "/v3/participant.html", "/v3/painel.html", "/s2/contador.html"]) {
    await cp.goto(origin + u);
    assert.equal(await cp.evaluate(() => document.documentElement.lang), "pt-BR", u);
  }
});
await clean.close();

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", permissions: ["clipboard-read", "clipboard-write"] });
const visibleMsgs = (p) => p.evaluate(() => ["error-banner-text", "success-banner-text", "elo-live-region"].map((id) => document.getElementById(id)?.textContent || "").join(" | "));
const t = await ctx.newPage();
await t.goto(origin + "/v3/therapist.html");
await t.click('[data-lang-option="en"]');
await t.fill("#signin-username", "terapeuta_demo");
await t.fill("#signin-password", "senha-sintetica-demo");
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
await t.fill("#participant-alias", `QA ${suffix} Alfa`);
await t.click("#btn-create-participant");
await t.waitForSelector("#participant-result:not([hidden])");
const pid = await t.inputValue("#active-participant-id");
let inviteLink = "";

const api = [];
t.on("request", (r) => { if (/\/api\//.test(r.url())) api.push(`${r.method()} ${r.url()}`); });

await check("E01-D1 convite copiado: mensagem retraduzida EN→PT→EN; link e uso do convite preservados", async () => {
  await t.click("#btn-create-invite");
  await t.waitForSelector("#invite-link");
  inviteLink = await t.inputValue("#invite-link");
  await t.click("#btn-copy-invite");
  await t.waitForFunction(() => /Invitation link copied/.test(document.getElementById("success-banner-text").textContent));
  const before = api.length;
  await t.click('[data-lang-option="pt-BR"]');
  let m = await visibleMsgs(t);
  assert.ok(!/Invitation link copied/.test(m), `permaneceu em inglês: ${m}`);
  assert.match(m, /Link do convite copiado/);
  await t.click('[data-lang-option="en"]');
  assert.match(await visibleMsgs(t), /Invitation link copied/);
  assert.equal(api.length, before, `requisições de negócio na troca: ${api.slice(before)}`);
  assert.equal(await t.inputValue("#invite-link"), inviteLink);
});
await check("E01-D2 participante inexistente: erro retraduzido EN→PT→EN, sem requisição extra, campo preservado", async () => {
  await t.evaluate(() => { document.getElementById("technical-select").open = true; });
  await t.fill("#active-participant-id", "p_naoexiste0001");
  await t.click("#btn-select-participant");
  await t.waitForSelector('#error-banner[data-error-code="NOT_FOUND"]:not([hidden])');
  assert.match(await visibleMsgs(t), /Record not found/);
  const before = api.length;
  await t.click('[data-lang-option="pt-BR"]');
  const m = await visibleMsgs(t);
  assert.ok(!/Record not found/.test(m), `permaneceu em inglês: ${m}`);
  assert.match(await t.textContent("#error-banner-text"), /não encontrado|não foi encontrado|sem acesso|acesso/i);
  assert.equal(await t.locator("#error-banner").isVisible(), true, "erro deve continuar visível");
  await t.click('[data-lang-option="en"]');
  assert.match(await t.textContent("#error-banner-text"), /Record not found/);
  assert.equal(api.length, before);
});
await check("E01-D4 valor-padrão 'parcial' é amostra editável localizada; valor digitado é preservado", async () => {
  assert.equal(await t.inputValue("#assessment-item-value"), "partial");
  await t.click('[data-lang-option="pt-BR"]');
  assert.equal(await t.inputValue("#assessment-item-value"), "parcial");
  await t.fill("#assessment-item-value", "texto digitado");
  await t.click('[data-lang-option="en"]');
  assert.equal(await t.inputValue("#assessment-item-value"), "texto digitado");
});
await check("E01-D1b convite usado após alternância de idioma", async () => {
  const p = await ctx.newPage();
  await p.goto(inviteLink);
  await p.click('[data-lang-option="pt-BR"]');
  await p.click('[data-lang-option="en"]');
  await p.click("#btn-invite-signin");
  await p.waitForSelector("#signin-result:not([hidden])");
  const en = await visibleMsgs(p);
  await p.click('[data-lang-option="pt-BR"]');
  const pt = await visibleMsgs(p);
  assert.ok(en.trim().length > 3 && pt !== en, `mensagem de entrada não retraduzida: ${en} / ${pt}`);
  assert.ok(!/signed in|access granted/i.test(pt), pt);
  await p.close();
});
await check("E01-D3 painel: 'carregado' PT→EN→PT sem nova requisição; alias preservado", async () => {
  const q = await ctx.newPage();
  await q.goto(origin + "/v3/painel.html");
  await q.click('[data-lang-option="pt-BR"]');
  await q.fill("#signin-username", "terapeuta_demo");
  await q.fill("#signin-password", "senha-sintetica-demo");
  await q.click("#btn-signin");
  await q.waitForSelector("#form-open:not([hidden])");
  await q.fill("#participant-id", pid);
  await q.click("#btn-open");
  await q.waitForFunction(() => /carregado/.test(document.getElementById("elo-live-region").textContent));
  const reqs = []; q.on("request", (r) => { if (/\/api\//.test(r.url())) reqs.push(r.url()); });
  await q.click('[data-lang-option="en"]');
  let m = await q.textContent("#elo-live-region");
  assert.ok(!/carregado/.test(m), `permaneceu em português: ${m}`);
  assert.match(m, /QA \d{4} Alfa loaded/);
  await q.click('[data-lang-option="pt-BR"]');
  assert.match(await q.textContent("#elo-live-region"), /QA \d{4} Alfa carregado/);
  assert.equal(reqs.length, 0, `requisições na troca: ${reqs}`);
  await q.close();
});
await check("E01-D5 (coberto em D1b)", async () => {});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
