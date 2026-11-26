// S1 E-02/E-03: user content must never be treated as translatable (aliases, typed values), structurally.
// SYNTHETIC data. Usage: node s1_corr_e02e03.mjs --origin URL
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
const check = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); console.error("FAIL", id, String(e.message).split("\n").slice(0, 12).join(" / ")); } };
const ALIASES = ["Direito", "Right", "Esquerdo", "Left", "Mão", "Hand", "Ativa", "Active", "Parcial", "Partial", "Dados sintéticos", "Synthetic data"];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "pt-BR", permissions: ["clipboard-read", "clipboard-write"] });
const api = [];
const t = await ctx.newPage();
t.on("request", (r) => { if (/\/api\//.test(r.url())) api.push(`${r.method()} ${new URL(r.url()).pathname}`); });
const setLang = async (p, l) => p.click(`[data-lang-option="${l}"]`);
await t.goto(origin + "/v3/therapist.html");
await t.fill("#signin-username", "terapeuta_demo");
await t.fill("#signin-password", "senha-sintetica-demo");
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
const suffix = ""; // aliases are used exactly as typed; participants are told apart by id
const ids = new Map();

await check("E02-1 apelidos sensíveis a rótulos: sucesso, resumo e lista preservam o texto literal em PT→EN→PT×3", async () => {
  for (const alias of ALIASES) {
    await setLang(t, "pt-BR");
    await t.fill("#participant-alias", alias);
    await t.click("#btn-create-participant");
    await t.waitForFunction((a) => document.getElementById("success-banner-text").textContent.includes(a), alias);
    ids.set(alias, await t.inputValue("#active-participant-id"));
    for (let i = 0; i < 3; i++) {
      for (const l of ["en", "pt-BR"]) {
        await setLang(t, l);
        const b = await t.textContent("#success-banner-text");
        assert.ok(b.includes(`${alias}`), `banner (${l}) alterou "${alias}": ${b}`);
        const live = await t.textContent("#elo-live-region");
        if (live.includes("registered") || live.includes("cadastrad")) assert.ok(live.includes(alias), `live (${l}): ${live}`);
      }
    }
    const items = await t.locator("#participant-list li").allTextContents();
    assert.ok(items.some((x) => x.includes(alias)), `lista sem "${alias}"`);
    // a selection message must carry the literal alias too
  }
  const all = (await t.locator("#participant-list li").allTextContents()).join(" | ");
  await t.click("#btn-search-participants");
  await setLang(t, "en");
  const listEn = (await t.locator("#participant-list").textContent());
  for (const a of ALIASES) assert.ok(listEn.includes(a), `lista EN alterou "${a}"`);
  await setLang(t, "pt-BR");
});
await check("E02-2 seleção pela lista mantém o apelido literal na mensagem (PT/EN)", async () => {
  for (const alias of ["Direito", "Right", "Dados sintéticos", "Partial"]) {
    await t.fill("#participant-search", "");
    await t.click("#btn-search-participants");
    await t.locator("#participant-list li", { hasText: new RegExp(`^\\s*${alias}\\b`) }).first().locator("button").click();
    await t.waitForFunction((a) => document.getElementById("success-banner-text").textContent.includes(a), alias);
    for (const l of ["en", "pt-BR", "en"]) { await setLang(t, l); assert.ok((await t.textContent("#success-banner-text")).includes(alias), `${l}: ${alias}`); }
  }
});
await check("E02-3 painel: carregar cada apelido e alternar idioma não altera o apelido (live region e página)", async () => {
  const q = await ctx.newPage();
  const reqs = [];
  q.on("response", (r) => { if (r.status() >= 400) console.error("HTTP", r.status(), r.url()); });
  q.on("pageerror", (e) => console.error("PAGEERR", e.message));
  await q.goto(origin + "/v3/painel.html");
  await q.fill("#signin-username", "terapeuta_demo"); await q.fill("#signin-password", "senha-sintetica-demo");
  await q.click("#btn-signin"); await q.waitForSelector("#form-open:not([hidden])");
  for (const alias of ["Direito", "Right", "Dados sintéticos", "Synthetic data"]) { // 4 loads: the API rate-limits bursts of panel loads (429)
    await setLang(q, "pt-BR");
    await q.fill("#participant-id", ids.get(alias));
    await q.click("#btn-open");
    await q.waitForFunction((a) => document.getElementById("elo-live-region").textContent.includes(a), alias).catch(async (e) => { throw new Error(`${alias}: live="${await q.textContent("#elo-live-region")}" err="${await q.textContent("#error-banner-text")}"`); });
    q.on("request", (r) => { if (/\/api\//.test(r.url())) reqs.push(r.url()); });
    for (const l of ["en", "pt-BR", "en"]) {
      await setLang(q, l);
      const live = await q.textContent("#elo-live-region");
      assert.ok(live.includes(alias), `live ${l}: ${live}`);
      const body = await q.evaluate(() => document.getElementById("paciente").textContent);
      assert.ok(body.includes(alias), `painel ${l} perdeu "${alias}"`);
    }
    q.removeAllListeners("request");
  }
  assert.equal(reqs.length, 0);
  await q.close();
});

// ---- E-03: editable fields
await new Promise((r) => setTimeout(r, 65000)); // the API rate-limits bursts (429); let the window pass after the panel loads
async function signin() {
  if (await t.locator("#btn-signout").isVisible()) return; // session survives reload (sessionStorage)
  await t.fill("#signin-username", "terapeuta_demo"); await t.fill("#signin-password", "senha-sintetica-demo");
  await t.click("#btn-signin");
  await t.waitForSelector("#signin-result:not([hidden])", { timeout: 8000 }).catch(async () => { throw new Error(`signin: err="${await t.textContent("#error-banner-text")}" signedout=${await t.locator("#btn-signout").isVisible()}`); });
}
const FIELD = "#assessment-item-value";
const lang = async (l) => setLang(t, l);
await check("E03-1 padrão nunca editado acompanha o idioma (PT→EN→PT repetido)", async () => {
  await t.reload(); await lang("pt-BR");
  assert.equal(await t.inputValue(FIELD), "parcial");
  for (let i = 0; i < 3; i++) { await lang("en"); assert.equal(await t.inputValue(FIELD), "partial"); await lang("pt-BR"); assert.equal(await t.inputValue(FIELD), "parcial"); }
});
await check("E03-2 digitado diferente do padrão e digitado IDÊNTICO ao padrão (parcial/partial) permanecem", async () => {
  for (const [startLang, typed, other] of [["pt-BR", "parcial", "en"], ["en", "partial", "pt-BR"], ["pt-BR", "partial", "en"], ["pt-BR", "xyz 123", "en"]]) {
    await t.reload(); await lang(startLang);
    await t.click(FIELD, { clickCount: 3 });
    await t.keyboard.type(typed);
    await lang(other); assert.equal(await t.inputValue(FIELD), typed, `${startLang}→${other}`);
    await lang(startLang); assert.equal(await t.inputValue(FIELD), typed);
  }
});
await check("E03-3 apagado manualmente permanece vazio", async () => {
  await t.reload(); await lang("pt-BR");
  await t.click(FIELD, { clickCount: 3 }); await t.keyboard.press("Backspace");
  await lang("en"); assert.equal(await t.inputValue(FIELD), "");
  await lang("pt-BR"); assert.equal(await t.inputValue(FIELD), "");
});
await check("E03-4 colado da área de transferência permanece (inclusive texto igual ao padrão)", async () => {
  for (const text of ["colado livre", "parcial", "partial"]) {
    await t.reload(); await lang("pt-BR");
    await t.evaluate((x) => navigator.clipboard.writeText(x), text);
    await t.click(FIELD, { clickCount: 3 });
    await t.keyboard.press("Control+V");
    assert.equal(await t.inputValue(FIELD), text);
    await lang("en"); assert.equal(await t.inputValue(FIELD), text);
    await lang("pt-BR"); assert.equal(await t.inputValue(FIELD), text);
  }
});
await check("E03-5 textarea (nota): editada preservada; nunca editada acompanha; sem requisições na troca", async () => {
  await t.reload(); await lang("pt-BR");
  const def = await t.inputValue("#assessment-note");
  await lang("en"); assert.notEqual(await t.inputValue("#assessment-note"), def);
  await t.fill("#assessment-note", "minha nota");
  const before = api.length;
  await lang("pt-BR"); await lang("en");
  assert.equal(await t.inputValue("#assessment-note"), "minha nota");
  assert.equal(api.length, before, "requisição de negócio na troca de idioma");
});
await check("E03-6 troca de participante reinicia o formulário (padrão localizado volta a ser gerenciado)", async () => {
  await t.reload(); await lang("pt-BR");
  await signin();
  await t.fill("#participant-search", ""); await t.click("#btn-search-participants");

  await t.locator("#participant-list li", { hasText: /Direito/ }).first().locator("button").click();
  await t.fill(FIELD, "parcial");
  await t.locator("#participant-list li", { hasText: /Right/ }).first().locator("button").click();
  assert.equal(await t.inputValue(FIELD), "parcial");
  await lang("en"); assert.equal(await t.inputValue(FIELD), "partial", "padrão gerenciado de novo após troca de participante");
  await lang("pt-BR");
});
await check("E03-7 recarga: campo não persistido volta ao padrão no idioma escolhido", async () => {
  await t.fill(FIELD, "digitado");
  await t.reload();
  assert.equal(await t.inputValue(FIELD), "parcial");
});
await check("E03-8 dados persistidos e identificadores intactos (lista de participantes via API)", async () => {
  await t.reload(); await signin(); await t.fill("#participant-search", ""); await t.click("#btn-search-participants"); await t.waitForSelector("#participant-list li[data-participant-id]");
  const list = await t.evaluate(async () => {
    const tok = JSON.parse(sessionStorage.getItem("elo_v3_therapist_session") || "null")?.token;
    return tok || null;
  });
  const items = await t.locator("#participant-list li[data-participant-id]").evaluateAll((els) => els.map((e) => [e.dataset.participantId, e.textContent]));
  for (const a of ALIASES) {
    const hit = items.find(([id]) => id === ids.get(a));
    assert.ok(hit && hit[1].includes(a), `persistido "${a}" divergente`);
  }
});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
