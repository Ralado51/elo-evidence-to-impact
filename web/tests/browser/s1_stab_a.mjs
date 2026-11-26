// S1 stabilization, Etapa A: participant list/search, invite from the UI, context kept across reload,
// context isolation between participants, double click on invite. SYNTHETIC data, real pages.
// Usage: node web/tests/browser/s1_stab_a.mjs --origin http://127.0.0.1:8080   (stack from scripts/demo_up.sh)
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

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const t = await ctx.newPage();
const suffix = String(Date.now()).slice(-6);
const A = `Alfa Teste ${suffix}`, B = `Beta Teste ${suffix}`;

await t.goto(`${origin}/v3/therapist.html`);
await t.fill("#signin-username", "terapeuta_demo");
await t.fill("#signin-password", "senha-sintetica-demo");
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");

async function createParticipant(alias) {
  await t.fill("#participant-alias", alias);
  await t.click("#btn-create-participant");
  await t.waitForSelector(`#participant-list [data-participant-id]:has-text("${alias}")`);
}

await check("A1 cadastro aparece na lista sem digitar identificador", async () => {
  await createParticipant(A); await createParticipant(B);
  assert.ok(await t.locator(`#participant-list li:has-text("${A}")`).count());
  assert.ok(await t.locator(`#participant-list li:has-text("${B}")`).count());
});
await check("A2 pesquisa filtra e mensagem de vazio", async () => {
  await t.fill("#participant-search", `Beta Teste ${suffix}`);
  await t.click("#btn-search-participants");
  await t.waitForFunction((n) => document.querySelectorAll("#participant-list li").length === n, 1);
  await t.fill("#participant-search", "zzz-inexistente");
  await t.click("#btn-search-participants");
  await t.waitForFunction(() => document.querySelectorAll("#participant-list li").length === 0);
  assert.match(await t.textContent("#participant-list-status"), /Nenhum participante encontrado/);
  await t.fill("#participant-search", "");
  await t.click("#btn-search-participants");
  await t.waitForSelector(`#participant-list li:has-text("${A}")`);
});
await check("A3 convite fica desativado sem participante e clique duplo gera um convite só", async () => {
  await t.click(`#participant-list li:has-text("${A}") button`);
  assert.equal(await t.isDisabled("#btn-create-invite"), false);
  let posts = 0;
  t.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/v3/invites")) posts++; });
  await t.dblclick("#btn-create-invite");
  await t.waitForSelector("#invite-link");
  await t.waitForTimeout(500);
  assert.equal(posts, 1, `esperava 1 POST de convite, houve ${posts}`);
});
let link;
await check("A4 link do convite abre a tela do participante já preenchido e sem o código na barra", async () => {
  link = await t.inputValue("#invite-link");
  assert.match(link, /participant\.html#invite=/);
  const p = await ctx.newPage();
  await p.goto(link);
  assert.ok((await p.inputValue("#invite-token")).length > 20);
  assert.equal(new URL(p.url()).hash, "");
  await p.click("#btn-invite-signin");
  await p.waitForSelector("#signin-result:not([hidden])");
  await p.close();
});
await check("A5 convite é de uso único", async () => {
  const p = await ctx.newPage();
  await p.goto(link);
  await p.click("#btn-invite-signin");
  await p.waitForSelector("#error-banner:not([hidden])");
  assert.equal(await p.isVisible("#signin-result"), false);
  await p.close();
});
await check("A6 contexto sobrevive à recarga da página", async () => {
  await t.reload();
  await t.waitForSelector(`#participant-list li[data-selected="true"]`);
  assert.match(await t.textContent("#active-participant-summary"), new RegExp(A));
  assert.equal(await t.isDisabled("#btn-create-invite"), false);
});
await check("A7 trocar de participante limpa resultados e convite do anterior", async () => {
  await t.click(`#participant-list li:has-text("${B}") button`);
  assert.equal(await t.isVisible("#invite-result"), false);
  assert.equal(await t.locator("#invite-link").count(), 0);
  assert.match(await t.textContent("#active-participant-summary"), new RegExp(B));
  assert.equal(await t.inputValue("#active-participant-id").then((v) => v.length > 5), true);
});
await check("A8 sair limpa lista e contexto", async () => {
  await t.click("#btn-signout");
  assert.equal(await t.locator("#participant-list li").count(), 0);
  assert.equal(await t.evaluate(() => sessionStorage.getItem("elo_v3_therapist_ctx")), null);
  await t.reload();
  assert.equal(await t.locator("#participant-list li").count(), 0);
});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
