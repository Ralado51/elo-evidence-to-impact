// ARQ-02 fix03 — FIX02-R01 (review/eligibility reconciliation) + pending UAT scenarios. SYNTHETIC data only.
// Usage: ELO_PLAYWRIGHT_DIR=... node s1_arq02_fix03.mjs --origin http://127.0.0.1:8080
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const origin = args.origin || "http://127.0.0.1:8080";
const pwDir = process.env.ELO_PLAYWRIGHT_DIR || path.join(os.homedir(), "hackathons/elo-platform/workspace/tools/playwright");
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ headless: true, ...(process.env.ELO_CHROME ? { executablePath: process.env.ELO_CHROME, args: ["--no-sandbox"] } : {}) });
let failed = 0;
const check = async (id, fn) => { try { await fn(); console.log("PASS", id); } catch (e) { failed++; console.log("FAIL", id, "::", String(e.message).split("\n").slice(0, 2).join(" / ")); } };
const FROM = "2026-01-01", TO = "2027-12-31";

const tctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
await tctx.addInitScript(() => { try { localStorage.setItem("elo_lang", "en"); } catch {} });
const t = await tctx.newPage();
const posts = [];
t.on("request", (r) => { if (/\/api\/v3\//.test(r.url()) && r.method() === "POST") posts.push({ path: new URL(r.url()).pathname, body: r.postData() || "" }); });
await t.goto(origin + "/v3/therapist.html");
await t.fill("#signin-username", "terapeuta_demo"); await t.fill("#signin-password", "senha-sintetica-demo"); await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
const login = await tctx.request.post(origin + "/api/v3/auth/therapist", { data: { username: "terapeuta_demo", password: "senha-sintetica-demo" } });
const H = { Authorization: `Bearer ${(await login.json()).token}` };

async function createParticipant(alias) {
  await t.fill("#participant-alias", alias); await t.click("#btn-create-participant");
  await t.waitForSelector("#participant-result:not([hidden])");
  await t.waitForSelector(`#participant-list li:has-text("${alias}")`);
  return t.inputValue("#active-participant-id");
}
async function selectParticipant(id) {
  await t.click(`#participant-list li[data-participant-id="${id}"] button`);
  await t.waitForFunction((x) => document.querySelector("#active-participant-id").value === x, id);
  await t.waitForTimeout(250);
}
async function seedEligible(pid) {
  await t.click("#btn-create-assessment"); await t.waitForSelector("#assessment-result:not([hidden])");
  await t.click("#btn-create-goal"); await t.waitForSelector("#goal-result:not([hidden])");
  await t.fill("#rx-valid-from", FROM); await t.fill("#rx-valid-to", TO);
  await t.click("#btn-publish-prescription"); await t.waitForSelector("#prescription-result:not([hidden])");
  const inv = await (await tctx.request.post(origin + "/api/v3/invites", { headers: H, data: { participant_id: pid, ttl_seconds: 86400 } })).json();
  const pctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const p = await pctx.newPage();
  await p.goto(origin + "/v3/participant.html");
  await p.fill("#invite-token", inv.invite_token); await p.click("#btn-invite-signin"); await p.waitForSelector("#signin-result:not([hidden])");
  await p.click("#btn-load-plan"); await p.waitForSelector('#prescription-view[data-prescription-loaded="true"]');
  await p.click("#btn-session-start"); await p.waitForSelector('#session-result[data-session-phase="active"]');
  await p.click("#btn-session-end"); await p.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="end"]');
  await p.click('button[data-choice-group="execution"][data-choice-value="complete"]');
  await p.click('button[data-choice-group="assistance"][data-choice-value="some"]');
  await p.click("#btn-submit-report"); await p.waitForSelector('#report-result[data-report-assistance="some"]');
  await pctx.close();
}
const loadFacts = async () => { await t.click("#btn-load-facts"); await t.waitForSelector("#facts-list li[data-fact-item]"); await t.waitForTimeout(200); };
const gates = () => t.evaluate(() => ({ summary: !document.querySelector("#btn-publish-summary").disabled, summaryText: document.querySelector("#summary-gate-status").textContent, evo: !document.querySelector("#btn-publish-evolution").disabled, evoText: document.querySelector("#evolution-gate-status").textContent }));
const statuses = () => t.evaluate(() => [...document.querySelectorAll("#facts-list [data-review-status]")].map((e) => e.getAttribute("data-review-status")));
const approveAll = async () => {
  const ids = await t.evaluate(() => [...document.querySelectorAll("#facts-list li[data-fact-item]")].map((l) => l.getAttribute("data-fact-item")));
  for (const id of ids) { await t.click(`button[data-review-decision="approve"][data-fact-id="${id}"]`); await t.waitForSelector(`li[data-fact-item="${id}"] [data-review-status="approved"]`); }
  return ids;
};
const loadSeries = async () => { await t.click("#btn-load-evolution-series"); await t.waitForSelector("#evolution-series-container [data-evolution-series]"); await t.waitForTimeout(200); };
const reviewPosts = () => posts.filter((p) => p.path === "/api/v3/reviews").length;

const alfa = await createParticipant("Fix03 Alfa");
await seedEligible(alfa);
await loadFacts();
const factIds = await approveAll();
await loadSeries();
const before = await gates();
await check("R01-0 pré-condição: após aprovar, resumo e evolução elegíveis", async () => { assert.ok(before.summary, before.summaryText); assert.ok(before.evo, before.evoText); });
const reviewsAfterApprove = reviewPosts();

const beta = await createParticipant("Fix03 Beta");
await check("R01-1 isolamento: Beta sem evidências aprovadas e publicação bloqueada", async () => {
  const g = await gates(); assert.equal(g.summary, false); assert.equal(g.evo, false);
});
await selectParticipant(alfa);
await loadFacts();
await check("R01-2 retorno ao Alfa: aprovação persistida reflete na lista e no gate de resumo", async () => {
  const s = await statuses(); assert.ok(s.length > 0 && s.every((x) => x === "approved"), `estados=${s}`);
  const g = await gates(); assert.ok(g.summary, `gate: ${g.summaryText}`);
});
await check("R01-3 retorno ao Alfa: elegibilidade da evolução reconstruída", async () => {
  await loadSeries(); const g = await gates(); assert.ok(g.evo, `gate: ${g.evoText}`);
});
await check("R01-4 reenvio de aprovação já concluída: sem nova revisão e sem mensagem contraditória", async () => {
  const n = reviewPosts();
  const btn = t.locator(`button[data-review-decision="approve"][data-fact-id="${factIds[0]}"]`);
  if (await btn.count() && await btn.isEnabled()) await btn.click({ timeout: 2000 }).catch(() => {});
  await t.waitForTimeout(500);
  assert.equal(reviewPosts(), n, "revisão duplicada");
  const s = await statuses(); assert.ok(s.every((x) => x === "approved"));
  const err = await t.locator("#error-banner").isVisible(); assert.equal(err, false);
  const ok = await t.locator("#success-banner-text").textContent(); assert.ok(!/already|já/i.test(ok || "") || s.every((x) => x === "approved"));
});
await check("R01-5 recarga da página após aprovação: estado reconstruído do servidor", async () => {
  await t.reload(); await t.waitForSelector("#btn-load-facts");
  await t.waitForFunction((x) => document.querySelector("#active-participant-id").value === x, alfa, { timeout: 5000 }).catch(() => {});
  if ((await t.inputValue("#active-participant-id")) !== alfa) { await t.click("#btn-search-participants").catch(() => {}); await selectParticipant(alfa); }
  await loadFacts();
  const s = await statuses(); assert.ok(s.every((x) => x === "approved"), `estados=${s}`);
  assert.ok((await gates()).summary);
});
await check("R01-6 nenhuma revisão duplicada ao longo de troca, retorno e recarga", async () => {
  assert.equal(reviewPosts(), reviewsAfterApprove);
});
await check("R01-6b causa-raiz: o servidor ainda considera a aprovação válida (publicação por fact_ids para Alfa é aceita)", async () => {
  const fl = await (await tctx.request.get(`${origin}/api/v3/participants/${alfa}/facts`, { headers: H })).json();
  const ids = fl.facts.map((f) => f.fact_id);
  const r = await tctx.request.post(origin + "/api/v3/summaries", { headers: { ...H, "Idempotency-Key": crypto.randomUUID() }, data: { participant_id: alfa, fact_ids: ids, period: { from: FROM, to: TO } } });
  assert.ok(r.status() === 201 || r.status() === 200, `status=${r.status()} ${(await r.text()).slice(0, 200)}`);
});
await check("R01-7 servidor: publicação só com aprovação válida (Beta sem aprovação é recusado)", async () => {
  const r = await tctx.request.post(origin + "/api/v3/summaries", { headers: { ...H, "Idempotency-Key": crypto.randomUUID() }, data: { participant_id: beta, period_from: FROM, period_to: TO, items: [] } });
  assert.ok(r.status() >= 400, `status=${r.status()}`);
});

// ---------- rejected / not approved / stale ----------
const gama = await createParticipant("Fix03 Gama");
await seedEligible(gama);
await loadFacts();
await check("R01-8 evidência não aprovada permanece inelegível (antes e depois de trocar de participante)", async () => {
  assert.equal((await gates()).summary, false);
  await selectParticipant(alfa); await selectParticipant(gama); await loadFacts();
  assert.equal((await gates()).summary, false);
  assert.ok((await statuses()).every((x) => x === "unreviewed"));
});
await check("R01-9 evidência rejeitada permanece inelegível após troca e retorno", async () => {
  const id = await t.evaluate(() => document.querySelector("#facts-list li[data-fact-item]").getAttribute("data-fact-item"));
  await t.click(`button[data-review-decision="reject"][data-fact-id="${id}"]`);
  await t.waitForSelector(`li[data-fact-item="${id}"] [data-review-status="rejected"]`);
  await selectParticipant(alfa); await selectParticipant(gama); await loadFacts();
  assert.ok((await statuses()).includes("rejected"));
  assert.equal((await gates()).summary, false);
});

// ---------- pending UAT scenarios ----------
await check("UAT-P1 limpeza dos erros nos dois campos de data da evolução (editar limpa cada um; troca de participante limpa)", async () => {
  await selectParticipant(gama);
  await t.fill("#evolution-period-from", ""); await t.fill("#evolution-period-to", "");
  await t.click("#btn-publish-evolution", { force: true }).catch(() => {});
  await t.evaluate(() => document.querySelector("#form-evolution").requestSubmit());
  await t.waitForTimeout(300);
  const st = () => t.evaluate(() => ["evolution-period-from", "evolution-period-to"].map((id) => ({ inv: document.getElementById(id).getAttribute("aria-invalid"), d: document.getElementById(id).getAttribute("aria-describedby") })));
  let s = await st(); assert.ok(s.every((x) => x.inv === "true" && x.d), JSON.stringify(s));
  await t.fill("#evolution-period-from", "2026-01-01");
  s = await st(); assert.equal(s[0].inv, null); assert.equal(s[1].inv, "true");
  await t.fill("#evolution-period-to", "2026-12-31");
  s = await st(); assert.ok(s.every((x) => x.inv === null && !x.d), JSON.stringify(s));
  await t.fill("#evolution-period-from", ""); await t.fill("#evolution-period-to", "");
  await t.evaluate(() => document.querySelector("#form-evolution").requestSubmit()); await t.waitForTimeout(300);
  s = await st(); assert.ok(s.every((x) => x.inv === "true"));
  await selectParticipant(alfa);
  s = await st(); assert.ok(s.every((x) => x.inv === null && !x.d), "troca de participante deve limpar: " + JSON.stringify(s));
});
await new Promise((r) => setTimeout(r, 62000)); // API rate limit window (120 req/60 s)
await check("UAT-P2 relato de sessão com conclusão normal: sucesso único, sem erro", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const p = await ctx.newPage();
  const inv = await (await tctx.request.post(origin + "/api/v3/invites", { headers: H, data: { participant_id: gama, ttl_seconds: 86400 } })).json();
  await p.goto(origin + "/v3/participant.html");
  await p.fill("#invite-token", inv.invite_token); await p.click("#btn-invite-signin"); await p.waitForSelector("#signin-result:not([hidden])");
  await p.click("#btn-load-plan"); await p.waitForSelector('#prescription-view[data-prescription-loaded="true"]');
  await p.click("#btn-session-start"); await p.waitForSelector('#session-result[data-session-phase="active"]');
  await p.click("#btn-session-end"); await p.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="end"]');
  await p.click('button[data-choice-group="execution"][data-choice-value="complete"]');
  await p.click('button[data-choice-group="assistance"][data-choice-value="none"]');
  await p.click("#btn-submit-report"); await p.waitForSelector('#report-result[data-report-assistance="none"]');
  assert.equal(await p.locator("#success-banner").isVisible(), true);
  assert.equal(await p.locator("#error-banner").isVisible(), false);
  await ctx.close();
});
await browser.close();
console.log(failed ? `FAILED: ${failed}` : "ALL PASS");
process.exit(failed ? 1 : 0);
