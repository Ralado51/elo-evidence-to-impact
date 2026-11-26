// S1 post-homologation fixes (A: participant selection/isolation, E: unified language, EN authenticated journey,
// dynamic messages). SYNTHETIC data, real pages. Usage: node web/tests/browser/s1_corr_ae.mjs --origin http://127.0.0.1:8080
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
const check = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); console.error("FAIL", id, String(e.message).split("\n").slice(0,3).join(" / ")); } };

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", permissions: ["clipboard-read", "clipboard-write"] });
const suffix = String(Date.now()).slice(-6);
const A = `Alice Test ${suffix}`, B = `Bruno Test ${suffix}`;
const langOf = (p) => p.evaluate(() => document.documentElement.lang);

// Portuguese leaking into the English UI. Contract-generated clinical texts are tagged data-clinical-text
// (pt-BR only until the controlled-translation proposal is approved); audit blocks (.mono) are excluded.
const PT_RE = /[áàâãéêíóôõúç]|\b(não|você|para|sem|ainda|nenhum|nenhuma|seu|sua|uma|dos|das|pela|pelo|então)\b/i;
async function ptLeaks(page) {
  const items = await page.evaluate(() => {
    const out = [];
    const skip = "[data-clinical-text],script,style,[hidden],.mono,#elo-live-region";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.tagName === "TEXTAREA" || el.closest(skip)) continue;
      const tx = n.textContent.trim();
      if (tx) out.push(tx);
    }
    for (const el of document.querySelectorAll("[aria-label],[title],[placeholder]")) {
      if (el.closest(skip)) continue;
      for (const a of ["aria-label", "title", "placeholder"]) { const v = el.getAttribute(a); if (v) out.push(`${a}=${v}`); }
    }
    for (const ta of document.querySelectorAll("textarea[data-i18n-value],input[data-i18n-value]")) if (!ta.closest(skip) && ta.value && ta.value === ta.getAttribute("data-i18n-last")) out.push(`value=${ta.value}`);
    out.push(document.title);
    return out;
  });
  return items.filter((x) => PT_RE.test(x));
}
const noPt = async (page, where) => { const l = await ptLeaks(page); assert.deepEqual(l, [], `PT no inglês (${where}): ${l.slice(0, 3).join(" | ")}`); };

// ---------------- E: one language preference across every page ----------------
const landing = await ctx.newPage();
await landing.goto(`${origin}/`);
await check("E-U1 landing abre em pt-BR (navegador em inglês) e usa a mesma preferência elo_lang", async () => {
  assert.equal(await landing.evaluate(() => document.documentElement.getAttribute("data-lang")), "pt");
  await landing.click('.lang button[data-set="en"]');
  assert.equal(await landing.evaluate(() => localStorage.getItem("elo_lang")), "en");
});
const PAGES = { therapist: "/v3/therapist.html", participant: "/v3/participant.html", painel: "/v3/painel.html", contador: "/s2/contador.html" };
await check("E-U2 inglês escolhido na landing vale em terapeuta, participante, painel e contador", async () => {
  for (const [name, url] of Object.entries(PAGES)) {
    const p = await ctx.newPage();
    await p.goto(`${origin}${url}`);
    assert.equal(await langOf(p), "en", name);
    assert.equal(await p.getAttribute('[data-lang-option="en"]', "aria-pressed"), "true", name);
    await noPt(p, name);
    await p.close();
  }
});
await check("E-U3 escolher português no painel vale na landing e nas demais", async () => {
  const p = await ctx.newPage();
  await p.goto(`${origin}/v3/painel.html`);
  await p.click('[data-lang-option="pt-BR"]');
  await landing.reload();
  assert.equal(await landing.evaluate(() => document.documentElement.getAttribute("data-lang")), "pt");
  const c = await ctx.newPage();
  await c.goto(`${origin}/s2/contador.html`);
  assert.equal(await langOf(c), "pt-BR");
  await c.close(); await p.close();
});
await check("E-U4 contador: tradução completa, estados dinâmicos e rota oficial documentada", async () => {
  const c = await ctx.newPage();
  await c.goto(`${origin}/s2/contador.html`);
  await c.click('[data-lang-option="en"]');
  await noPt(c, "contador");
  await c.click("#btn-demo");
  await c.waitForFunction(() => Number(document.getElementById("rep-count").dataset.reps) >= 1, null, { timeout: 30000 });
  await noPt(c, "contador em uso");
  assert.match(await c.textContent("#live-state"), /State:/);
  await c.click('[data-lang-option="pt-BR"]');
  assert.match(await c.textContent("#live-state"), /Estado:/);
  assert.match(await c.textContent("#counter-msg"), /Demonstração/);
  await c.click("#btn-stop");
  await c.close();
  const old = await ctx.request.get(`${origin}/v3/contador.html`, { maxRedirects: 0 });
  assert.equal(old.status(), 301);
  assert.equal(old.headers().location, "/s2/contador.html");
});
await check("E-U5 revisão da aplicação visível nas informações técnicas", async () => {
  const p = await ctx.newPage();
  await p.goto(`${origin}/v3/therapist.html`);
  await p.waitForFunction(() => /[0-9a-f]{7}/.test(document.querySelector("[data-build-commit]")?.textContent || ""));
  const commit = await p.getAttribute("[data-build-info]", "data-commit");
  assert.match(commit, /^[0-9a-f]{40}$/);
  await p.close();
});

// ---------------- Authenticated English journey ----------------
await ctx.addInitScript(() => { try { localStorage.setItem("elo_lang", "en"); } catch {} });
const t = await ctx.newPage();
await t.goto(`${origin}/v3/therapist.html`);
await t.fill("#signin-username", "terapeuta_demo");
await t.fill("#signin-password", "senha-sintetica-demo");
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
let inviteLink = "";
await check("E-A1 estado autenticado do terapeuta em inglês (sessão, lista vazia/cheia, resultados)", async () => {
  await noPt(t, "terapeuta autenticado");
  await t.fill("#participant-alias", A);
  await t.click("#btn-create-participant");
  await t.waitForSelector("#participant-result:not([hidden])");
  await noPt(t, "participante cadastrado");
  assert.match(await t.textContent("#active-participant-summary"), /Active participant/);
});
await check("E-A2 convite: controles dinâmicos (resultado, link, copiar, nome acessível) em inglês e retraduzidos ao trocar", async () => {
  await t.click("#btn-create-invite");
  await t.waitForSelector("#invite-link");
  assert.match(await t.getAttribute("#invite-link", "aria-label"), /Invitation link/);
  assert.equal((await t.textContent("#btn-copy-invite")).trim(), "Copy link");
  await noPt(t, "convite");
  inviteLink = await t.inputValue("#invite-link");
  await t.click("#btn-copy-invite");
  await t.waitForSelector("#success-banner:not([hidden]), #error-banner:not([hidden])");
  await noPt(t, "após copiar");
  await t.click('[data-lang-option="pt-BR"]');
  assert.equal((await t.textContent("#btn-copy-invite")).trim(), "Copiar link");
  assert.match(await t.getAttribute("#invite-link", "aria-label"), /Link do convite/);
  assert.equal(await t.inputValue("#invite-link"), inviteLink, "o link do convite não pode mudar na troca de idioma");
  await t.click('[data-lang-option="en"]');
});
await check("E-A3 avaliação, meta, prescrição: retornos operacionais em inglês e conteúdo digitado preservado", async () => {
  await t.fill("#assessment-note", "Texto livre digitado pelo terapeuta: observação original.");
  await t.click("#btn-create-assessment");
  await t.waitForSelector("#assessment-result:not([hidden])");
  await t.click("#btn-create-goal");
  await t.waitForSelector("#goal-result:not([hidden])");
  await t.fill("#rx-valid-from", "2026-01-01");
  await t.fill("#rx-valid-to", "2027-12-31");
  await t.click("#btn-publish-prescription");
  await t.waitForSelector("#prescription-result:not([hidden])");
  await noPt(t, "avaliação/meta/prescrição");
  await t.click('[data-lang-option="pt-BR"]');
  assert.equal(await t.inputValue("#assessment-note"), "Texto livre digitado pelo terapeuta: observação original.");
  assert.match(await t.textContent("#assessment-result"), /Avaliação funcional registrada/);
  await t.click('[data-lang-option="en"]');
  assert.match(await t.textContent("#assessment-result"), /Functional assessment recorded/);
});

const p = await ctx.newPage();
await p.goto(inviteLink);
await check("E-A4 participante autenticado em inglês: entrada, plano, sessão, relato", async () => {
  await p.click("#btn-invite-signin");
  await p.waitForSelector("#signin-result:not([hidden])");
  await noPt(p, "participante entrou");
  assert.match(await p.textContent("#publication-status"), /not shared|nothing|yet/i);
  await p.click("#btn-load-plan");
  await p.waitForSelector('#prescription-view[data-prescription-loaded="true"]');
  await noPt(p, "plano");
  await p.click("#btn-session-start");
  await p.waitForSelector('#session-result[data-session-phase="active"]');
  await noPt(p, "sessão ativa");
  await p.click("#btn-session-end");
  await p.waitForSelector('#session-result[data-session-phase="ended"]');
  await noPt(p, "sessão encerrada");
  await p.click('button[data-choice-group="execution"][data-choice-value="complete"]');
  await p.click('button[data-choice-group="assistance"][data-choice-value="some"]');
  await p.click("#btn-submit-report");
  await p.waitForSelector("#report-result[data-report-assistance]");
  await noPt(p, "relato enviado");
  await p.click('[data-lang-option="pt-BR"]');
  assert.match(await p.textContent("#report-result"), /Relato registrado/);
  await p.click('[data-lang-option="en"]');
});
await check("E-A5 terapeuta: evidências, revisão e publicação em inglês; participante vê publicações em inglês", async () => {
  await t.click("#btn-load-facts");
  await t.waitForSelector("#facts-list li[data-fact-item]");
  const ids = await t.evaluate(() => [...document.querySelectorAll("#facts-list li[data-fact-item]")].map((li) => li.getAttribute("data-fact-item")));
  for (const id of ids) {
    await t.click(`button[data-review-decision="approve"][data-fact-id="${id}"]`);
    await t.waitForSelector(`li[data-fact-item="${id}"] [data-review-status="approved"]`);
  }
  await noPt(t, "evidências revisadas");
  await t.fill("#summary-period-from", "2026-01-01");
  await t.fill("#summary-period-to", "2027-12-31");
  await t.click("#btn-publish-summary");
  await t.waitForSelector("#summary-result [data-published-summary]");
  await t.click("#btn-load-evolution-series");
  await t.waitForSelector("#evolution-series-container [data-evolution-series]");
  await noPt(t, "séries");
  await t.fill("#evolution-period-from", "2026-01-01");
  await t.fill("#evolution-period-to", "2027-12-31");
  await t.click("#btn-publish-evolution");
  await t.waitForSelector("#evolution-result [data-published-evolution]");
  await noPt(t, "publicações");
  await t.click("#btn-load-timeline");
  await t.waitForSelector("#timeline-list li");
  await noPt(t, "linha do tempo");
  await p.reload();
  await p.waitForFunction(() => document.querySelectorAll("#publication-list button").length >= 2);
  await noPt(p, "publicações do participante");
  await p.click("#publication-list button");
  await p.waitForSelector("#summary-view:not([hidden]), #evolution-view:not([hidden])");
  await noPt(p, "resumo aberto");
});
await check("E-A6 mensagens de erro e estados vazios em inglês (login inválido, busca sem resultado)", async () => {
  await t.fill("#participant-search", "zzz-none");
  await t.click("#btn-search-participants");
  await t.waitForFunction(() => /No participant found/.test(document.getElementById("participant-list-status").textContent));
  await noPt(t, "estado vazio");
  const q = await ctx.newPage();
  await q.goto(`${origin}/v3/therapist.html`);
  await q.fill("#signin-username", "x"); await q.fill("#signin-password", "y");
  await q.click("#btn-signin");
  await q.waitForSelector("#error-banner:not([hidden])");
  await noPt(q, "erro de login");
  await q.close();
});

// ---------------- A: participant selection and isolation ----------------
async function selectFromList(alias) { await t.fill("#participant-search", ""); await t.click("#btn-search-participants"); await t.click(`#participant-list li:has-text("${alias}") button`); }
await check("A-1 id inexistente não vira participante ativo e preserva o último contexto válido", async () => {
  await t.fill("#participant-search", ""); await t.click("#btn-search-participants");
  const before = await t.evaluate(() => sessionStorage.getItem("elo_v3_therapist_ctx"));
  const pidBefore = await t.inputValue("#active-participant-id");
  assert.ok(pidBefore.length > 5);
  await t.click("#technical-select > summary");
  await t.fill("#active-participant-id", "p_doesnotexist0001");
  await t.click("#btn-select-participant");
  await t.waitForSelector('#error-banner[data-error-code="NOT_FOUND"]:not([hidden])');
  assert.equal(await t.inputValue("#active-participant-id"), pidBefore, "campo volta ao último contexto válido");
  assert.equal(await t.evaluate(() => sessionStorage.getItem("elo_v3_therapist_ctx")), before, "contexto armazenado não muda");
  assert.match(await t.textContent("#active-participant-summary"), /Active participant/);
  assert.equal(await t.locator("#success-banner").isHidden(), true);
});
await check("A-2 id autorizado é aceito (positivo) e o rótulo mostra o apelido, não o código", async () => {
  await createParticipant(B);
  const aId = await t.evaluate(() => document.querySelector('#participant-list li[data-participant-id]').dataset.participantId);
  await t.fill("#active-participant-id", aId);
  await t.click("#btn-select-participant");
  await t.waitForSelector("#success-banner:not([hidden])");
  assert.equal(await t.inputValue("#active-participant-id"), aId);
  assert.ok(!(await t.textContent("#active-participant-summary")).includes(aId), "resumo da jornada não mostra o código");
});
async function createParticipant(alias) {
  await t.fill("#participant-alias", alias);
  await t.click("#btn-create-participant");
  await t.waitForSelector(`#participant-list li:has-text("${alias}")`);
}
await check("A-3 jornada operacional completa sem digitar identificadores (lista e pesquisa)", async () => {
  await selectFromList(A);
  assert.match(await t.textContent("#active-participant-summary"), new RegExp(A));
  await t.evaluate(() => document.getElementById("technical-select").removeAttribute("open"));
  await t.waitForFunction(() => !document.getElementById("technical-select").open);
  const typed = await t.evaluate(() => [...document.querySelectorAll("input[type=text]")].filter((i) => /participant-id|pid/i.test(i.id) && i.offsetParent !== null && !i.closest("details:not([open])")).map((i) => i.id));
  assert.deepEqual(typed, [], `campos de id visíveis na jornada operacional: ${typed}`);
});
await check("A-4 isolamento: trocar de A para B limpa todas as seções, rascunhos e convite", async () => {
  await selectFromList(A);
  await t.fill("#assessment-note", "rascunho do participante A");
  await t.click("#btn-create-invite");
  await t.waitForSelector("#invite-link");
  await t.click("#btn-load-facts");
  await t.waitForSelector("#facts-list li[data-fact-item]");
  await t.click("#btn-load-timeline");
  await t.waitForSelector("#timeline-list li");
  await selectFromList(B);
  assert.match(await t.textContent("#active-participant-summary"), new RegExp(B));
  for (const id of ["participant-result", "assessment-result", "goal-result", "prescription-result", "summary-result", "evolution-result", "invite-result"]) {
    assert.equal(await t.locator(`#${id}`).isHidden(), true, `${id} deveria estar oculto`);
  }
  assert.equal(await t.locator("#facts-list li").count(), 0);
  assert.equal(await t.locator("#timeline-list li").count(), 0);
  assert.equal(await t.locator("#evolution-series-container [data-evolution-series]").count(), 0);
  assert.ok(!(await t.inputValue("#assessment-note")).includes("rascunho"), "rascunho de A não pode ir para B");
  assert.equal(await t.locator("#invite-link").count(), 0);
  assert.equal(await t.isDisabled("#btn-publish-summary"), true);
  assert.equal(await t.isDisabled("#btn-publish-evolution"), true);
  await t.reload();
  await t.waitForFunction(() => document.getElementById("active-participant-summary").textContent.length > 0);
  assert.match(await t.textContent("#active-participant-summary"), new RegExp(B));
  await selectFromList(A);
  assert.equal(await t.locator("#facts-list li").count(), 0, "dados de A não reaparecem sem nova consulta");
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
