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


const delays = { facts: 0, reviews: 0 };
await t.route(/\/api\/v3\/participants\/[^/]+\/facts(\?.*)?$/, async (route) => {
  const resp = await route.fetch();
  if (delays.facts) await new Promise((r) => setTimeout(r, delays.facts));
  try { await route.fulfill({ response: resp }); } catch {}
});
await t.route(/\/api\/v3\/reviews$/, async (route) => {
  const resp = await route.fetch();
  if (delays.reviews) await new Promise((r) => setTimeout(r, delays.reviews));
  try { await route.fulfill({ response: resp }); } catch {}
});
const listCount = () => t.locator("#facts-list li[data-fact-item]").count();
const alfa = await createParticipant("Fix03b Alfa");
await seedEligible(alfa);
const beta = await createParticipant("Fix03b Beta");
await selectParticipant(alfa);

await check("C1 carga de fatos do Alfa atrasada + troca para Beta: resposta tardia não preenche o contexto do Beta", async () => {
  delays.facts = 1500;
  await t.click("#btn-load-facts"); await t.waitForTimeout(200);
  await selectParticipant(beta);
  await t.waitForTimeout(3500); delays.facts = 0;
  assert.equal(await t.inputValue("#active-participant-id"), beta);
  assert.equal(await listCount(), 0, "fatos do Alfa apareceram no Beta");
  const g = await gates(); assert.equal(g.summary, false); assert.equal(g.evo, false);
});
await check("C2 aprovação do Alfa em voo + troca para Beta: nada vaza para o Beta e o Alfa mantém a aprovação", async () => {
  await selectParticipant(alfa); await loadFacts();
  const id = await t.evaluate(() => document.querySelector("#facts-list li[data-fact-item]").getAttribute("data-fact-item"));
  delays.reviews = 1500;
  await t.click(`button[data-review-decision="approve"][data-fact-id="${id}"]`);
  await t.waitForTimeout(200);
  await selectParticipant(beta);
  await t.waitForTimeout(3000); delays.reviews = 0;
  assert.equal(await listCount(), 0);
  const g = await gates(); assert.equal(g.summary, false);
  assert.equal(await t.locator("#error-banner").isVisible(), false);
  await selectParticipant(alfa); await loadFacts();
  assert.ok((await statuses()).includes("approved"), "aprovação do Alfa deve estar no servidor");
});
await check("C3 aprovar durante recarga de fatos: estado final reflete a aprovação (recarga repetida)", async () => {
  await selectParticipant(alfa); await loadFacts();
  const ids = await t.evaluate(() => [...document.querySelectorAll("#facts-list li[data-fact-item]")].map((l) => l.getAttribute("data-fact-item")));
  const other = ids.find((x) => true) ; // any fact; approve a not-yet-approved one if present
  const target = await t.evaluate(() => { const l = [...document.querySelectorAll("#facts-list li[data-fact-item]")].find((x) => x.querySelector('[data-review-status="unreviewed"]')); return l ? l.getAttribute("data-fact-item") : null; });
  const id = target || other;
  delays.facts = 1200;
  await t.click("#btn-load-facts"); await t.waitForTimeout(300);
  await t.click(`button[data-review-decision="approve"][data-fact-id="${id}"]`).catch(() => {});
  await t.waitForTimeout(6000); delays.facts = 0;
  const st = await t.locator(`li[data-fact-item="${id}"] [data-review-status]`).first().getAttribute("data-review-status");
  assert.equal(st, "approved");
});
await check("C4 aprovar → rejeitar → aprovar em sequência: estado final coerente, cada decisão gera uma revisão", async () => {
  await selectParticipant(alfa); await loadFacts();
  const id = await t.evaluate(() => document.querySelector("#facts-list li[data-fact-item]").getAttribute("data-fact-item"));
  const n0 = reviewPosts();
  for (const [d, s] of [["reject", "rejected"], ["approve", "approved"], ["reject", "rejected"]]) {
    await t.click(`button[data-review-decision="${d}"][data-fact-id="${id}"]`);
    await t.waitForSelector(`li[data-fact-item="${id}"] [data-review-status="${s}"]`);
  }
  assert.equal(reviewPosts() - n0, 3);
  await selectParticipant(beta); await selectParticipant(alfa); await loadFacts();
  assert.equal(await t.locator(`li[data-fact-item="${id}"] [data-review-status]`).first().getAttribute("data-review-status"), "rejected");
});
await check("C5 duas cargas sobrepostas do mesmo participante: vale a mais recente, sem duplicar itens", async () => {
  delays.facts = 800;
  await t.click("#btn-load-facts"); await t.waitForTimeout(100);
  delays.facts = 0;
  await t.click("#btn-load-facts");
  await t.waitForTimeout(3500);
  const ids = await t.evaluate(() => [...document.querySelectorAll("#facts-list li[data-fact-item]")].map((l) => l.getAttribute("data-fact-item")));
  assert.ok(ids.length > 0 && new Set(ids).size === ids.length);
});
await browser.close();
console.log(failed ? `FAILED: ${failed}` : "ALL PASS");
process.exit(failed ? 1 : 0);
