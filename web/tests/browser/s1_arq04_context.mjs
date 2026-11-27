// ARQ-04 BLOCKING suite for FIX-37 / FIX-37.1-37.4 (context isolation). SYNTHETIC data. Exit code != 0 on any failed assertion.
// Derived from s1_arq04_characterization.mjs (which stays as the 'before' record).
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


const obs = {};
const settle = (ms = 900) => t.waitForTimeout(ms);
function hold(pattern, method, { status = null } = {}) {
  let release; const gate = new Promise((r) => (release = r)); let armed = true; let hit;
  const hitP = Promise.race([new Promise((r) => (hit = r)), new Promise((_, rej) => setTimeout(() => rej(new Error(`route ${pattern} never hit`)), 10000))]);
  const handler = async (route) => {
    const u = new URL(route.request().url());
    if (armed && route.request().method() === method && (!status || true)) {
      armed = false; hit();
      const resp = await route.fetch();
      await gate;
      if (status) await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "synthetic late failure" } }) });
      else await route.fulfill({ response: resp });
    } else await route.continue();
  };
  return { arm: () => t.route(pattern, handler), release: async () => { release(); }, hit: hitP, off: () => t.unroute(pattern, handler) };
}
const vis = (sel) => t.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.textContent.trim().length > 0; }, sel);
const bannerErr = () => vis("#error-banner");
const bannerOk = () => vis("#success-banner");
const bodyText = () => t.evaluate(() => document.body.innerText);
const activeId = () => t.inputValue("#active-participant-id");
async function mk(alias) {
  await t.fill("#participant-alias", alias);
  await t.click("#btn-create-participant");
  await t.waitForFunction((a) => document.getElementById("participant-result") && !document.getElementById("participant-result").hidden && document.getElementById("active-participant-id").value, alias);
  return t.inputValue("#active-participant-id");
}
async function switchTo(id) {
  const sel = `#participant-list li[data-participant-id="${id}"] button`;
  if (!(await t.$(sel))) { await t.fill("#participant-search", "Carac"); await t.press("#participant-search", "Enter"); await t.waitForSelector(sel); }
  await t.click(sel);
  await t.waitForFunction((x) => document.getElementById("active-participant-id")?.value === x, id, { timeout: 8000 });
  await settle(400);
}

await t.goto(origin + "/v3/therapist.html");
await t.fill("#signin-username", "terapeuta_demo");
await t.fill("#signin-password", "senha-sintetica-demo");
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
const ALFA = await mk("Alfa Carac");
await t.waitForTimeout(400);
const BETA = await mk("Beta Carac");
await t.waitForFunction(() => document.getElementById("goal-target-unit").value === "sessions");

async function lateWrite(name, patternRx, armBtn, prep, resultSel) {
  await switchTo(ALFA);
  await prep();
  const h = hold(patternRx, "POST"); await h.arm();
  await t.click(armBtn);
  await h.hit;
  await switchTo(BETA);
  const before = { active: await activeId(), resultVisible: await vis(resultSel) };
  await h.release(); await settle(1200);
  const bannerText = await t.evaluate(() => document.getElementById("success-banner-text")?.textContent || "");
  const after = { active: await activeId(), resultVisibleInBeta: await vis(resultSel), successBanner: await bannerOk(), bannerText, errorBanner: await bannerErr() };
  await h.off();
  obs[name] = { before, after, defect: after.resultVisibleInBeta || /saved|salv|gravad|recorded|registr/i.test(after.bannerText) && !/active|ativo/i.test(after.bannerText) };
}


const noLate = async (name, patternRx, armBtn, prep, resultSel, marker) => {
  await switchTo(ALFA); await prep();
  const h = hold(patternRx, "POST"); await h.arm();
  await t.click(armBtn); await h.hit;
  await switchTo(BETA);
  await h.release(); await settle(1500);
  assert.equal(await activeId(), BETA, `${name}: active participant must stay Beta`);
  assert.equal(await vis(resultSel), false, `${name}: late result must not render in Beta :: ${await t.evaluate((q)=>document.querySelector(q)?.outerHTML.slice(0,300), resultSel)}`);
  const okText = await t.evaluate(() => { const e = document.getElementById("success-banner"); return e && !e.hidden ? e.textContent : ""; });
  assert.doesNotMatch(okText, /saved|salv|created|criad|gravad|recorded|registr|issued|emitid/i, `${name}: no save-confirmation in Beta (got: ${okText.trim().slice(0,120)})`);
  assert.equal(await bannerErr(), false, `${name}: no error banner in Beta`);
  await h.off();
  await switchTo(ALFA); await settle(1200);
  return bodyText();
};

await check("FX37-01 goals.create tardio: nada em Beta, aviso+recarga em Alfa (FIX-37.1)", async () => {
  const txt = await noLate("goal", "**/api/v3/participants/*/goals", "#btn-create-goal", async () => { await t.fill("#goal-text", "Meta tardia Alfa"); }, "#goal-result");
  assert.match(txt, /record\(s\) for this participant were saved|registro\(s\)/i, "reconciliation notice expected on origin participant");
});
await check("FX37-02 assessments.create tardio (FIX-37.1)", async () => {
  await noLate("assessment", "**/api/v3/participants/*/assessments", "#btn-create-assessment", async () => {
    await t.fill("#assessment-date", "2026-03-10"); await t.selectOption("#assessment-item-value-type", "number"); await t.selectOption("#assessment-item-unit", "deg");
    await t.fill("#assessment-item-key", "grip_key"); await t.fill("#assessment-item-value", "5");
  }, "#assessment-result");
});
await check("FX37-03 invites.create tardio (FIX-37.1)", async () => {
  await switchTo(ALFA);
  const h = hold("**/api/v3/invites", "POST"); await h.arm();
  await t.click("#btn-create-invite"); await h.hit;
  await switchTo(BETA);
  await h.release(); await settle(1500);
  const inviteFor = await t.evaluate(() => document.getElementById("invite-result")?.dataset.inviteFor || null);
  assert.notEqual(inviteFor, BETA, "invite issued for Alfa must never be labelled for Beta");
  assert.equal(await vis("#invite-result") && inviteFor !== ALFA, false, "invite secret must not be visible unlabelled in Beta");
  await h.off();
});
await check("FX37-04 timeline.get: erro tardio nao aparece em Beta (FIX-37.2)", async () => {
  await switchTo(ALFA);
  const h = hold("**/api/v3/participants/*/timeline", "GET", { status: 500 }); await h.arm();
  await t.click("#btn-load-timeline"); await h.hit;
  await switchTo(BETA);
  await h.release(); await settle(1500);
  assert.equal(await bannerErr(), false); await h.off();
});
await check("FX37-05 evolution.series: erro tardio nao aparece em Beta (FIX-37.2)", async () => {
  await switchTo(ALFA);
  const h = hold("**/api/v3/participants/*/evolution/series*", "GET", { status: 500 }); await h.arm();
  await t.click("#btn-load-evolution-series"); await h.hit;
  await switchTo(BETA);
  await h.release(); await settle(1500);
  assert.equal(await bannerErr(), false); await h.off();
});
await check("FX37-06 facts.list: resposta tardia de Alfa nao repinta Beta (FX37-LATE-RESPONSE)", async () => {
  await switchTo(BETA); await t.click("#btn-load-facts"); await settle(900);
  const baseline = await t.evaluate(() => [document.querySelectorAll("#facts-list li").length, document.getElementById("facts-summary")?.textContent || ""]);
  await switchTo(ALFA);
  const h = hold("**/api/v3/participants/*/facts*", "GET"); await h.arm();
  await t.click("#btn-load-facts"); await h.hit;
  await switchTo(BETA);
  await h.release(); await settle(1500);
  const after = await t.evaluate(() => [document.querySelectorAll("#facts-list li").length, document.getElementById("facts-summary")?.textContent || ""]);
  assert.deepEqual(after, baseline, "Beta facts view must be exactly what it was before Alfa answered");
  assert.equal(await activeId(), BETA); await h.off();
});
await check("FX37-07 facts.list: erro tardio de Alfa nao aparece em Beta (FX37-STALE-ERROR-LOADING)", async () => {
  await switchTo(ALFA);
  const h = hold("**/api/v3/participants/*/facts*", "GET", { status: 500 }); await h.arm();
  await t.click("#btn-load-facts"); await h.hit;
  await switchTo(BETA);
  await h.release(); await settle(1500);
  assert.equal(await bannerErr(), false); await h.off();
});
await check("FX37-08 logout com leitura de lista em voo nao repovoa a lista (G-09)", async () => {
  const h = hold(/\/api\/console\/v1\/participants(\?.*)?$/, "GET"); await h.arm();
  await t.fill("#participant-search", "Carac"); await t.press("#participant-search", "Enter"); await h.hit;
  await t.click("#btn-signout"); await settle(300);
  await h.release(); await settle(1500);
  assert.equal(await t.evaluate(() => document.querySelectorAll("#participant-list li").length), 0, "list must stay empty after logout");
  await h.off();
});
await check("FX37-09 escrita nunca e abortada: meta tardia persistiu no servidor (FIX-37.1)", async () => {
  await t.fill("#signin-username", "terapeuta_demo"); await t.fill("#signin-password", "senha-sintetica-demo"); await t.click("#btn-signin");
  await t.waitForSelector("#signin-result:not([hidden])");
  const n = await t.evaluate(async (id) => { const tok = JSON.parse(sessionStorage.getItem("elo_therapist_session") || localStorage.getItem("elo_therapist_session") || "{}").token; if (!tok) return -1; const r = await fetch(`/api/v3/participants/${id}/goals`, { headers: { Authorization: `Bearer ${tok}` } }); const j = await r.json(); return (j.data?.goals || j.goals || []).filter((g) => /Meta tardia Alfa/.test(g.text || g.goal_text || "")).length; }, ALFA);
  assert.ok(n === -1 || n === 1, `late goal must exist exactly once (got ${n})`);
});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ phase: "arq04-fx37-blocking", passed: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
